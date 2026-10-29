import { mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { withExternalResource } from './resourceGate.js';
import { comfyuiRequest as request, comfyuiJson as json } from "./comfyuiApi.js";
import { comfyuiConfig, configuredComfyuiWorkflow, maxComfyOutputImages } from "../../shared/domain/comfyui.js";
import { maxImageBytes } from "../../shared/domain/elements.js";
import { loadComfyuiWorkflow } from './comfyuiWorkflows.js';

async function restoreSeedControls(config, workflow, signal) {
  const missing = Object.entries(workflow).filter(([, node]) => ['seed', 'noise_seed'].some((key) => typeof node.inputs[key] === 'number' && !node._meta?.seedControls?.[key]));
  // Older imports discarded the UI controls. Recover only controls from the
  // original saved graph; never replace the user's prompt or parameter values.
  if (missing.length && config.workflowName) {
    signal?.throwIfAborted();
    let saved;
    try { saved = (await loadComfyuiWorkflow(config, { path: config.workflowName })).workflow; }
    catch (error) { if (error.httpStatus !== 404) throw new Error(`无法恢复旧工作流的种子模式，请重新选择已保存的工作流：${error.message}`); }
    for (const [id, node] of missing) if (saved?.[id]?.class_type === node.class_type && saved[id]._meta?.seedControls) {
      node._meta = { ...node._meta, seedControls: saved[id]._meta.seedControls };
    }
  }
  signal?.throwIfAborted();
}

async function prepareSeeds(config, workflow, signal) {
  await restoreSeedControls(config, workflow, signal);
  const seeds = [];
  for (const [nodeId, node] of Object.entries(workflow)) for (const input of ['seed', 'noise_seed']) {
    if (typeof node.inputs[input] !== 'number') continue;
    const control = node._meta?.seedControls?.[input] || { mode: 'fixed' };
    if (!['fixed', 'randomize'].includes(control.mode)) throw new Error(`种子模式 ${control.mode} 暂不支持，请在生图参数中选择每次随机或固定`);
    if (control.mode === 'randomize') {
      const min = Math.max(0, Math.ceil(control.min ?? 0)), max = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(control.max ?? Number.MAX_SAFE_INTEGER));
      if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) throw new Error('种子范围无效');
      const span = BigInt(max) - BigInt(min) + 1n, limit = (1n << 64n) / span * span;
      let sample;
      do { sample = randomBytes(8).readBigUInt64BE(); } while (sample >= limit);
      node.inputs[input] = Number(BigInt(min) + sample % span);
    }
    seeds.push({ nodeId, input, mode: control.mode, value: node.inputs[input] });
  }
  return seeds;
}

export const comfyuiImageExecutor = {
  tool: {
    type: "function", name: "generate_image",
    description: "运行用户配置的 ComfyUI 工作流，每次返回一张图片。prompt 留空沿用工作流提示词；可传一张参考图，接到所选输出依赖的唯一 LoadImage 节点。尺寸、种子、模型和采样参数沿用工作流。",
    inputSchema: { type: "object", additionalProperties: false, required: ["prompt"], properties: {
      prompt: { type: "string", minLength: 0, maxLength: 12000 },
      referencePaths: { type: "array", maxItems: 1, items: { type: "string" } },
    } },
  },
  instructions: "用户已选择 ComfyUI 工作流。生成图片调用 generate_image；用户要求沿用工作流提示词时传空字符串 prompt，否则传入用户要求。参考图使用附件列表中的本地路径，通过 referencePaths 传入，最多一张，要求所选输出依赖中只有一个 LoadImage 节点；没有图片入口或存在多个入口时会报错。工作流的模型、负面提示词、尺寸、种子和采样参数由用户预设，工具不能更改。不支持选区蒙版。失败时说明错误，不切换其他生图入口。提交状态未知或查询连接失败时，不自动再次调用生图工具，以免重复生成；应保留任务 ID 供用户到 ComfyUI 查看。每次调用返回一张图片，应用会展示，回复不用重复嵌入。",
  probe: probeComfyui,
  generate: generateComfyui,
};


function outputImages(record, config, multiple) {
  const images = record.outputs?.[config.outputNodeId]?.images;
  if (!Array.isArray(images) || !images.length) throw new Error("ComfyUI 所选输出节点没有返回图片，请检查输出节点和工作流");
  if (!multiple && images.length !== 1) throw new Error(`ComfyUI 返回了 ${images.length} 张图片；当前入口只接受单张结果，请使用工作流生图接收多张图片`);
  if (images.length > maxComfyOutputImages) throw new Error(`ComfyUI 单次最多接收 ${maxComfyOutputImages} 张图片，请降低生成数量`);
  return images;
}

async function downloadImage(config, image, signal) {
  if (!image || typeof image.filename !== 'string' || !image.filename || image.filename.length > 1000
      || image.subfolder !== undefined && typeof image.subfolder !== 'string'
      || ![undefined, 'output', 'temp'].includes(image.type)) throw new Error('ComfyUI 返回了无效的图片文件信息');
  const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: image.type || 'output' });
  const bytes = await request(config, `/view?${query}`, { signal, maxBytes: maxImageBytes });
  try {
    const info = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
    if (!['png', 'jpeg', 'webp'].includes(info.format) || (info.pages || 1) !== 1) throw new Error('Unsupported image');
    return { bytes, format: info.format };
  } catch { throw new Error('ComfyUI 返回的文件不是有效的单张 PNG、JPEG 或 WebP 图片，或超过 4000 万像素'); }
}

// Query only an already recorded task. This path never POSTs /prompt.
export async function recoverComfyuiImage(settings, ticket, { signal, multiple = false } = {}) {
  const config = comfyuiConfig(settings);
  const sequential = typeof ticket !== 'string';
  const promptIds = sequential ? ticket?.promptIds : [ticket];
  if (sequential && (!multiple || !Number.isSafeInteger(ticket?.count) || ticket.count < 2 || ticket.count > maxComfyOutputImages
      || !Array.isArray(promptIds) || promptIds.length !== ticket.count)) throw new Error('单张生成请求尚未全部提交，不能将部分结果作为全部结果取回；请先核对已生成的图片，再明确重新运行，不会自动补交请求');
  if (!Array.isArray(promptIds) || promptIds.some((id) => typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id))
      || new Set(promptIds).size !== promptIds.length) throw new Error('缺少已确认的 ComfyUI 任务 ID，不能安全取回');
  return withExternalResource(`comfyui:${new URL(config.baseUrl).origin}`, signal, async () => {
    const images = [];
    for (const promptId of promptIds) {
      const history = await json(config, `/history/${encodeURIComponent(promptId)}`, { signal });
      const record = history[promptId];
      if (!record) throw new Error('远端尚无此任务的完成记录；保留未知状态，请稍后核查');
      if (record.status?.status_str === 'error') throw new Error('远端记录确认任务失败；保留未知事实，可明确重新执行');
      images.push(...outputImages(record, config, sequential ? false : multiple));
    }
    const results = [];
    for (const image of images) results.push(await downloadImage(config, image, signal));
    return multiple ? { images: results } : results[0];
  });
}

export async function probeComfyui(value) {
  try {
    const config = comfyuiConfig(value);
    const signal = AbortSignal.timeout(30000);
    const stats = await json(config, "/system_stats", { signal });
    if (!stats.system || !Array.isArray(stats.devices)) throw new Error("此地址未返回 ComfyUI 服务信息");
    return { available: true, message: "ComfyUI 已连接。请在会话中选择已保存的工作流。" };
  } catch (error) { return { available: false, message: `ComfyUI 检测失败：${error.message}` }; }
}

// Newer servers support atomic cancellation by id. Older servers can only
// safely delete our queued item; a global interrupt could stop somebody else.
async function cancelComfyui(config, promptId) {
  const signal = AbortSignal.timeout(5000);
  try {
    await json(config, `/api/jobs/${encodeURIComponent(promptId)}/cancel`, { method: "POST", signal });
    return "已向 ComfyUI 请求取消本任务";
  } catch (error) {
    if (![404, 405].includes(error.httpStatus)) return "未能确认远端取消，请到 ComfyUI 查看任务";
  }
  try {
    await request(config, "/queue", { method: "POST", body: { delete: [promptId] }, signal });
    return "已移除本任务的排队项；旧版 ComfyUI 中已运行的任务可能继续完成";
  } catch { return "未能确认远端取消，请到 ComfyUI 查看任务"; }
}

async function waitForImages(config, promptId, signal, report, multiple) {
  let poll = 0, failures = 0, missing = 0, lastProgress = "";
  function progress(message) {
    if (message !== lastProgress) { lastProgress = message; report({ type: "progress", message }); }
  }
  while (true) {
    signal.throwIfAborted();
    let history, queue;
    try {
      history = await json(config, `/history/${encodeURIComponent(promptId)}`, { signal });
      if (!history[promptId] && poll++ % 3 === 0) queue = await json(config, "/queue", { signal });
      failures = 0;
    } catch (error) {
      signal.throwIfAborted();
      if (++failures >= 3 || error.httpStatus && error.httpStatus < 500) throw new Error(`无法查询 ComfyUI 任务 ${promptId}：${error.message}。任务可能仍在运行，请先到 ComfyUI 查看，勿重复提交`);
      progress("ComfyUI 连接暂时中断，正在重新查询原任务");
      await sleep(1000, undefined, { signal }); continue;
    }
    const record = history[promptId];
    if (record) {
      const error = record.status?.messages?.findLast((entry) => ["execution_error", "execution_interrupted"].includes(entry?.[0]));
      if (record.status?.status_str === "error" || error) throw new Error(`ComfyUI 执行失败：${String(error?.[1]?.exception_message || error?.[0] || "请检查 ComfyUI 执行记录").slice(0, 1500)}`);
      return outputImages(record, config, multiple);
    }
    if (queue) {
      if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) throw new Error("ComfyUI 返回了无效队列信息");
      const running = queue.queue_running.some((item) => item[1] === promptId), position = queue.queue_pending.findIndex((item) => item[1] === promptId);
      if (!running && position < 0) {
        if (++missing >= 2) throw new Error(`ComfyUI 任务 ${promptId} 已不在队列或历史中，可能被取消或服务已重启；请检查后再决定是否重试`);
      } else {
        missing = 0;
        progress(running ? "ComfyUI 正在执行工作流" : `ComfyUI 排队中，前方 ${position} 个任务`);
      }
    }
    await sleep(1000, undefined, { signal });
  }
}

async function uploadReference(config, entry, workspace, signal) {
  const root = await realpath(workspace), file = await realpath(path.resolve(root, entry));
  const relative = path.relative(root, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("ComfyUI 只能读取当前会话工作目录内的参考图");
  if ((await stat(file)).size > maxImageBytes) throw new Error("参考图超过 25 MiB");
  const bytes = await readFile(file);
  if (bytes.length > maxImageBytes) throw new Error("参考图超过 25 MiB");
  let format;
  try {
    const info = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
    if (!["png", "jpeg", "webp"].includes(info.format) || (info.pages || 1) !== 1) throw new Error("Unsupported image");
    format = info.format;
  } catch { throw new Error("参考图必须是单张 PNG、JPEG 或 WebP 图片，且不超过 4000 万像素"); }
  signal.throwIfAborted();
  const body = new FormData(), name = `self-wiki-${randomUUID()}.${format}`;
  body.set("image", new Blob([bytes], { type: `image/${format}` }), name);
  body.set("type", "input"); body.set("subfolder", "self-wiki");
  const uploaded = await json(config, "/upload/image", { method: "POST", body, signal });
  if (uploaded.type !== "input" || uploaded.subfolder !== "self-wiki" || uploaded.name !== name) {
    throw new Error("ComfyUI 返回的参考图路径与本次上传不符；未提交生成任务");
  }
  return { filename: `${uploaded.subfolder}/${uploaded.name}`, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function generateComfyui(value, options) {
  return withExternalResource(`comfyui:${new URL(options.config.baseUrl).origin}`, options.signal, () => generateComfyuiUnlocked(value, options));
}

async function generateComfyuiUnlocked(value, options) {
  if (!options.multiple || typeof value?.prompt !== 'string') return generateComfyuiRequest(value, options);
  const config = comfyuiConfig(options.config), workflow = configuredComfyuiWorkflow(config, { requirePrompt: !!value.prompt.trim() });
  const counts = Object.values(workflow).map((node) => node.inputs.batch_size).filter((count) => typeof count === 'number');
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 1 || count > maxComfyOutputImages)) throw new Error(`生成数量须为 1–${maxComfyOutputImages} 的整数`);
  const count = Math.max(1, ...counts);
  if (count === 1) return generateComfyuiRequest(value, options);
  if (counts.some((value) => value !== 1 && value !== count)) throw new Error('多个 batch_size 的生成数量不一致，请设置相同数量或保留为 1');
  for (const node of Object.values(workflow)) if (typeof node.inputs.batch_size === 'number') node.inputs.batch_size = 1;
  const settings = { ...config, workflow }, requests = [], images = [];
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(1800000 * count)]);
  let dispatched = false;
  try {
    await restoreSeedControls(settings, workflow, signal);
    for (let index = 0; index < count; index++) {
      signal.throwIfAborted();
      const result = await generateComfyuiRequest(index === 0 ? value : { ...value, referencePaths: undefined }, {
        ...options, config: settings, signal, multiple: false, deferDownload: true,
        onDispatch() { if (!dispatched) { options.onDispatch?.(); dispatched = true; } },
        onProgress(event) {
          if (event.type === 'metadata' && event.metadata.comfyui) {
            requests[index] = event.metadata.comfyui;
            // Persist the entire ordered set on each update; recovery must not
            // mistake the latest task's single image for the complete result.
            options.onProgress?.({ ...event, metadata: { comfyui: {
              ...event.metadata.comfyui, sequence: structuredClone({ count, requests }),
            } } });
          } else if (event.type === 'prepared_prompt') {
            if (index === 0) options.onProgress?.(event);
          } else options.onProgress?.({ ...event, ...(event.message && { message: `第 ${index + 1} / ${count} 张：${event.message}` }) });
        },
      });
      images.push(...result.images);
      // Reuse uploaded references; later requests still run seed preparation
      // independently, respecting fixed versus randomize controls.
      for (const reference of requests[index].referenceImages || []) workflow[reference.nodeId].inputs[reference.input] = reference.filename;
    }
    const results = await saveOutputImages(config, images, options.workspace, signal, (event) => options.onProgress?.(event));
    return { images: results };
  } catch (error) {
    if (signal.aborted && !/ComfyUI 生图已停止|ComfyUI 生图等待超过/.test(error.message)) throw new Error('ComfyUI 生图已停止或等待超时；已提交任务的记录仍保留，未提交的请求不会继续生成');
    throw error;
  }
}

async function saveOutputImages(config, images, workspace, signal, report) {
  const folder = await mkdtemp(path.join(workspace, 'comfyui-image-')), results = [];
  for (const [index, image] of images.entries()) {
    report({ type: 'progress', message: `正在取回 ComfyUI 图片 ${index + 1} / ${images.length}` });
    const { bytes, format } = await downloadImage(config, image, signal);
    signal.throwIfAborted();
    const savedPath = path.join(folder, `result-${index + 1}.${format}`);
    await writeFile(savedPath, bytes, { flag: 'wx' });
    results.push({ bytes, savedPath });
  }
  signal.throwIfAborted();
  return results;
}

async function generateComfyuiRequest(value, { config: settings, workspace, signal: callerSignal, onProgress, onDispatch, multiple = false, deferDownload = false }) {
  callerSignal?.throwIfAborted();
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["prompt", "referencePaths"].includes(key))
      || typeof value.prompt !== "string" || value.prompt.length > 12000
      || value.referencePaths !== undefined && (!Array.isArray(value.referencePaths) || (value.referencePaths.length > (Array.isArray(settings?.imageInputs) ? settings.imageInputs.length : 1) || value.referencePaths.length > 8)
        || value.referencePaths.some((entry) => typeof entry !== "string" || !entry.trim() || entry.includes("\0")))) {
    throw new Error(Array.isArray(settings?.imageInputs) ? `ComfyUI 只接受不超过 12000 字的 prompt 和最多 ${settings.imageInputs.length} 张已映射参考图；prompt 留空沿用工作流提示词` : "ComfyUI 只接受不超过 12000 字的 prompt 和最多一张参考图；prompt 留空沿用工作流提示词");
  }
  const config = comfyuiConfig(settings), workflow = configuredComfyuiWorkflow(config, { requirePrompt: !!value.prompt.trim() });
  for (const node of Object.values(workflow)) {
    const count = node.inputs.batch_size;
    if (typeof count === 'number' && (!Number.isSafeInteger(count) || count < 1 || count > maxComfyOutputImages)) throw new Error(`生成数量须为 1–${maxComfyOutputImages} 的整数`);
  }
  const workflowSha256 = createHash("sha256").update(JSON.stringify(workflow)).digest("hex");
  const seeds = await prepareSeeds(config, workflow, callerSignal);
  const promptSource = value.prompt.trim() ? "message" : "workflow";
  if (promptSource === "message") workflow[config.prompt.nodeId].inputs[config.prompt.input] = value.prompt;
  const prompt = config.prompt ? workflow[config.prompt.nodeId].inputs[config.prompt.input] : '';
  if (prompt.length > 12000) throw new Error("工作流提示词超过 12000 字，请在 ComfyUI 中缩短后更新工作流");
  let imageMappings = [];
  if (value.referencePaths?.length) {
    if (config.imageInputs !== undefined) {
      if (config.imageInputs.length !== value.referencePaths.length) throw new Error(`参考图数量 ${value.referencePaths.length} 与映射数量 ${config.imageInputs.length} 不一致`);
      imageMappings = config.imageInputs;
    } else {
      const inputs = Object.entries(workflow).filter(([, node]) => node.class_type === 'LoadImage');
      if (inputs.length !== 1) throw new Error(inputs.length ? '所选输出依赖多个 LoadImage 图片入口，无法确定附件应替换哪张图；请配置参考图映射' : '所选输出没有 LoadImage 图片入口，请选择支持图片输入的工作流');
      const [nodeId, node] = inputs[0];
      if (typeof node.inputs.image !== 'string') throw new Error('工作流的 LoadImage 图片字段不是可替换的文件名');
      imageMappings = [{ nodeId, input: 'image' }];
    }
  }
  const signal = AbortSignal.any([...(callerSignal ? [callerSignal] : []), AbortSignal.timeout(1800000)]);
  const clientId = randomUUID(), requestedPromptId = randomUUID();
  let promptId, remoteFinished = false, submissionAttempted = false;
  const report = (event) => { if (!signal.aborted) onProgress?.(event); };
  const metadata = { baseUrl: config.baseUrl, workflowName: config.workflowName, workflowSha256, clientId, requestedPromptId,
    prompt: config.prompt, promptSource, outputNodeId: config.outputNodeId, seeds };
  report({ type: "metadata", metadata: { comfyui: metadata } });
  report({ type: "prepared_prompt", prompt });
  try {
    signal.throwIfAborted();
    for (const [index, mapping] of imageMappings.entries()) {
      report({ type: 'progress', message: `正在上传第 ${index + 1} 张参考图到 ComfyUI` });
      const referenceImage = await uploadReference(config, value.referencePaths[index], workspace, signal);
      workflow[mapping.nodeId].inputs[mapping.input] = referenceImage.filename;
      metadata.referenceImages ||= [];
      metadata.referenceImages.push({ index, nodeId: mapping.nodeId, input: mapping.input, ...referenceImage });
      if (index === 0) metadata.referenceImage = { nodeId: mapping.nodeId, ...referenceImage };
      report({ type: 'metadata', metadata: { comfyui: { ...metadata } } });
    }
    signal.throwIfAborted();
    let submitted;
    try {
      // Never retry a submission. Keep reading its bounded response even if the
      // caller stops, so old servers' generated ids can still be cancelled.
      submissionAttempted = true;
      onDispatch?.();
      submitted = await json(config, "/prompt", { method: "POST", body: { prompt: workflow, client_id: clientId, prompt_id: requestedPromptId } });
      if (typeof submitted.prompt_id !== "string" || !/^[\w-]{1,128}$/.test(submitted.prompt_id)) throw new Error("服务未返回有效任务 ID");
    } catch (error) {
      if (error.httpStatus && error.httpStatus < 500) throw error;
      throw new Error(`ComfyUI 提交状态未知：${error.message}。请先到 ComfyUI 查看，勿重复提交。请求关联 ID：${clientId}`);
    }
    promptId = submitted.prompt_id;
    signal.throwIfAborted();
    report({ type: "metadata", metadata: { comfyui: { ...metadata, promptId } } });
    report({ type: "submitted", message: "ComfyUI 已接收工作流，等待生成" });
    const images = await waitForImages(config, promptId, signal, report, multiple); remoteFinished = true;
    if (deferDownload) return { images };
    const results = await saveOutputImages(config, images, workspace, signal, report);
    return multiple ? { images: results } : results[0];
  } catch (error) {
    if (signal.aborted) {
      const cancellation = promptId && !remoteFinished ? await cancelComfyui(config, promptId) : submissionAttempted ? "已提交的远端任务可能仍会完成" : "未提交生成任务";
      throw new Error(`${callerSignal?.aborted ? "ComfyUI 生图已停止" : "ComfyUI 生图等待超过 30 分钟"}；${cancellation}`);
    }
    throw error;
  }
}
