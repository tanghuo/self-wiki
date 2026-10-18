import { mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { comfyuiRequest as request, comfyuiJson as json } from "./comfyuiApi.js";
import { comfyuiConfig, configuredComfyuiWorkflow } from "../../shared/domain/comfyui.js";
import { maxImageBytes } from "../../shared/domain/elements.js";

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

async function waitForImage(config, promptId, signal, report) {
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
      const images = record.outputs?.[config.outputNodeId]?.images;
      if (!Array.isArray(images) || !images.length) throw new Error("ComfyUI 所选输出节点没有返回图片，请检查输出节点和工作流");
      if (images.length !== 1) throw new Error(`ComfyUI 返回了 ${images.length} 张图片；第一版要求单张结果，请将工作流批量数设为 1`);
      return images[0];
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

export async function generateComfyui(value, { config: settings, workspace, signal: callerSignal, onProgress }) {
  callerSignal?.throwIfAborted();
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["prompt", "referencePaths"].includes(key))
      || typeof value.prompt !== "string" || value.prompt.length > 12000
      || value.referencePaths !== undefined && (!Array.isArray(value.referencePaths) || value.referencePaths.length > 1
        || value.referencePaths.some((entry) => typeof entry !== "string" || !entry.trim() || entry.includes("\0")))) {
    throw new Error("ComfyUI 只接受不超过 12000 字的 prompt 和最多一张参考图；prompt 留空沿用工作流提示词");
  }
  const config = comfyuiConfig(settings), workflow = configuredComfyuiWorkflow(config);
  const workflowSha256 = createHash("sha256").update(JSON.stringify(workflow)).digest("hex");
  const promptSource = value.prompt.trim() ? "message" : "workflow";
  if (promptSource === "message") workflow[config.prompt.nodeId].inputs[config.prompt.input] = value.prompt;
  const prompt = workflow[config.prompt.nodeId].inputs[config.prompt.input];
  if (prompt.length > 12000) throw new Error("工作流提示词超过 12000 字，请在 ComfyUI 中缩短后更新工作流");
  let imageNodeId;
  if (value.referencePaths?.length) {
    const inputs = Object.entries(workflow).filter(([, node]) => node.class_type === "LoadImage");
    if (inputs.length !== 1) throw new Error(inputs.length ? "所选输出依赖多个 LoadImage 图片入口，无法确定附件应替换哪张图；请在 ComfyUI 中保留一个图片入口后更新工作流" : "所选输出没有 LoadImage 图片入口，请选择支持图片输入的工作流");
    [imageNodeId] = inputs[0];
    if (typeof workflow[imageNodeId].inputs.image !== "string") throw new Error("工作流的 LoadImage 图片字段不是可替换的文件名");
  }
  const signal = AbortSignal.any([...(callerSignal ? [callerSignal] : []), AbortSignal.timeout(1800000)]);
  const clientId = randomUUID(), requestedPromptId = randomUUID();
  let promptId, remoteFinished = false, submissionAttempted = false;
  const report = (event) => { if (!signal.aborted) onProgress?.(event); };
  const metadata = { baseUrl: config.baseUrl, workflowName: config.workflowName, workflowSha256, clientId, requestedPromptId,
    prompt: config.prompt, promptSource, outputNodeId: config.outputNodeId };
  report({ type: "metadata", metadata: { comfyui: metadata } });
  report({ type: "prepared_prompt", prompt });
  try {
    signal.throwIfAborted();
    if (imageNodeId) {
      report({ type: "progress", message: "正在上传本轮图片到 ComfyUI" });
      const referenceImage = await uploadReference(config, value.referencePaths[0], workspace, signal);
      workflow[imageNodeId].inputs.image = referenceImage.filename;
      metadata.referenceImage = { nodeId: imageNodeId, ...referenceImage };
      report({ type: "metadata", metadata: { comfyui: metadata } });
    }
    signal.throwIfAborted();
    let submitted;
    try {
      // Never retry a submission. Keep reading its bounded response even if the
      // caller stops, so old servers' generated ids can still be cancelled.
      submissionAttempted = true;
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
    const image = await waitForImage(config, promptId, signal, report); remoteFinished = true;
    if (!image || typeof image.filename !== "string" || !image.filename || image.filename.length > 1000
        || image.subfolder !== undefined && typeof image.subfolder !== "string"
        || ![undefined, "output", "temp"].includes(image.type)) throw new Error("ComfyUI 返回了无效的图片文件信息");
    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || "", type: image.type || "output" });
    report({ type: "progress", message: "正在取回 ComfyUI 图片" });
    const bytes = await request(config, `/view?${query}`, { signal, maxBytes: maxImageBytes });
    let format;
    try {
      const info = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
      if (!["png", "jpeg", "webp"].includes(info.format) || (info.pages || 1) !== 1) throw new Error("Unsupported image");
      format = info.format;
    } catch { throw new Error("ComfyUI 返回的文件不是有效的单张 PNG、JPEG 或 WebP 图片，或超过 4000 万像素"); }
    signal.throwIfAborted();
    const folder = await mkdtemp(path.join(workspace, "comfyui-image-")), savedPath = path.join(folder, `result.${format}`);
    await writeFile(savedPath, bytes, { flag: "wx" });
    signal.throwIfAborted();
    return { bytes, savedPath };
  } catch (error) {
    if (signal.aborted) {
      const cancellation = promptId && !remoteFinished ? await cancelComfyui(config, promptId) : submissionAttempted ? "已提交的远端任务可能仍会完成" : "未提交生成任务";
      throw new Error(`${callerSignal?.aborted ? "ComfyUI 生图已停止" : "ComfyUI 生图等待超过 30 分钟"}；${cancellation}`);
    }
    throw error;
  }
}
