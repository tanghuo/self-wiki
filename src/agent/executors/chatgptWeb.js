import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { mkdtemp, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";

const script = path.join(import.meta.dirname, "chatgptWeb.py");
let browserBusy = false;
const waiting = [];

export const chatgptWebImageExecutor = {
  tool: {
    type: "function", name: "generate_image",
    description: "使用用户选择的 ChatGPT 网页版生成或编辑一张图片，并保存到当前工作目录。改图时 referencePaths 必须包含待编辑原图的本地路径；可额外传参考图。每次调用返回一张图片；需要多张时分别调用。",
    inputSchema: { type: "object", additionalProperties: false, required: ["prompt", "referencePaths", "size"], properties: {
      prompt: { type: "string", minLength: 1, maxLength: 12000 },
      referencePaths: { type: "array", maxItems: 8, items: { type: "string" } },
      size: { type: "string", enum: ["auto", "1024x1024", "1024x1536", "1536x1024"] },
    } },
  },
  instructions: `用户已选择 ChatGPT 网页版生图。出图和改图统一调用 generate_image；调用失败时说明错误，不自行切换生图入口。工具调用开始只表示执行器接收了请求；未收到成功返回前，不声称 ChatGPT 网页已接收提示词或已开始生成，应用会显示实际执行进度。参考图使用附件列表中给出的本地路径。每次工具调用生成一张图片，应用会显示结果，回复中不用重复嵌入同一图片。网页端尺寸仅作为构图要求，实际尺寸以返回结果为准。`,
  probe: probeChatgptWeb,
  generate: generateChatgptWeb,
};

function acquireBrowser(signal, onProgress) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    function release() {
      const next = waiting.shift();
      if (next) next.start(); else browserBusy = false;
    }
    const job = { start() { signal?.removeEventListener("abort", abort); resolve(release); } };
    function abort() { waiting.splice(waiting.indexOf(job), 1); reject(new Error("网页版生图已取消排队")); }
    if (!browserBusy) { browserBusy = true; job.start(); }
    else {
      waiting.push(job); signal?.addEventListener("abort", abort, { once: true });
      try { onProgress?.({ type: "progress", message: "等待前一张网页生图完成" }); }
      catch (error) { waiting.splice(waiting.indexOf(job), 1); signal?.removeEventListener("abort", abort); reject(error); }
    }
  });
}

function runPython(config, request, { workspace, signal, onProgress }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(config.python, ["-u", script], { cwd: workspace, shell: false, windowsHide: true,
      env: { ...childEnvironment(), PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1", SELF_WIKI_NODE: process.execPath }, stdio: ["pipe", "pipe", "pipe"] });
    const decoder = new StringDecoder("utf8");
    let buffer = "", stderr = "", result, error, killTimer;
    function kill() {
      if (!child.pid || child.exitCode !== null) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
        killer.on("error", () => child.kill());
      } else child.kill();
    }
    function abort() {
      error ||= new Error("网页版生图已停止；已提交的网页任务可能仍会完成");
      child.stdin.end("cancel\n");
      killTimer ||= setTimeout(kill, 1500);
    }
    const timeout = setTimeout(() => { error = new Error(request.operation === "probe" ? "网页版连接检测超时" : "网页版生图等待超过 30 分钟，请检查 ChatGPT 网页"); abort(); }, request.operation === "probe" ? 30000 : 1800000);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdin.on("error", () => {});
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-2000); });
    child.stdout.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      if (buffer.length > 80000) { error = new Error("网页版执行器输出超过限制"); kill(); return; }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "result") result = event;
          else if (event.type === "error") error = new Error(String(event.message).slice(0, 2000));
          else if (!error && !signal?.aborted) onProgress?.(event);
        } catch (failure) { error = new Error(`网页版执行器返回无效结果：${failure.message}`); kill(); }
      }
    });
    child.once("error", () => { error = new Error("无法启动 Python，请在网页版生图设置中填写 Python 3.10+ 的程序路径"); });
    child.once("close", (code) => {
      clearTimeout(timeout); clearTimeout(killTimer); signal?.removeEventListener("abort", abort);
      if (signal?.aborted) error = new Error("网页版生图已停止；已提交的网页任务可能仍会完成");
      if (error) reject(error);
      else if (code !== 0 || !result) reject(new Error(`网页版执行器未返回图片结果${stderr ? `：${stderr}` : ""}`));
      else resolve(result);
    });
    child.stdin.write(`${JSON.stringify({ ...request, browser: config.browser, profile: config.profile })}\n`);
    if (signal?.aborted) abort();
  });
}

export async function probeChatgptWeb(config, workspace) {
  try { const result = await runPython(config, { operation: "probe" }, { workspace }); return { available: true, ...result }; }
  catch (error) { return { available: false, message: error.message }; }
}

export async function generateChatgptWeb(value, options) {
  const release = await acquireBrowser(options.signal, options.onProgress);
  try {
    options.signal?.throwIfAborted();
    // Resolve only after acquiring the queue: the previous image may have
    // created and persisted this conversation while this request was waiting.
    return await generateImage(value, { ...options, conversationUrl: options.continuation?.read() || "",
      onProgress(update) {
        options.signal?.throwIfAborted();
        if (update.type === "conversation") {
          options.continuation?.save(update.url);
          options.onProgress?.({ type: "metadata", metadata: { conversationUrl: update.url } });
        } else if (["progress", "submitted"].includes(update.type)) {
          const labels = { "submitting prompt": "正在输入并提交提示词", generating: "ChatGPT 正在生成图片", "receiving image": "已发现图片，等待生成完成", "downloading image bytes": "正在取回图片" };
          const message = labels[update.message] || (update.message?.startsWith("opening ChatGPT via") ? "正在打开 ChatGPT 页面"
            : update.message?.startsWith("using ") ? "ChatGPT 页面已就绪" : String(update.message || "").slice(0, 500));
          options.onProgress?.({ type: update.type, message });
        } else if (update.type === "prepared_prompt") options.onProgress?.({ type: "prepared_prompt", prompt: update.prompt });
      },
    });
  }
  finally { release(); }
}

async function generateImage(value, { config, workspace, signal, onProgress, verbatim = false, conversationUrl = "" }) {
  const inputs = chatgptWebImageExecutor.tool.inputSchema.properties;
  if (!value || typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > inputs.prompt.maxLength || !Array.isArray(value.referencePaths)
      || value.referencePaths.length > inputs.referencePaths.maxItems || !inputs.size.enum.includes(value.size)) throw new Error("无效的网页生图提示词、参考图或尺寸");
  if (conversationUrl && !/^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(conversationUrl)) throw new Error("无效的网页会话地址");
  const root = await realpath(workspace), references = [];
  for (const entry of value.referencePaths) {
    if (typeof entry !== "string" || !entry || entry.includes("\0")) throw new Error("无效的参考图路径");
    const file = await realpath(path.resolve(root, entry));
    const relative = path.relative(root, file);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("网页版生图只能读取当前会话工作目录内的参考图");
    if ((await stat(file)).size > 25 * 1024 * 1024) throw new Error("参考图超过 25 MiB");
    const info = await sharp(file, { limitInputPixels: 40_000_000 }).metadata();
    if (!["png", "jpeg", "webp"].includes(info.format)) throw new Error("参考图必须是 PNG、JPEG 或 WebP");
    references.push(file);
  }
  signal?.throwIfAborted();
  const directory = await mkdtemp(path.join(root, "web-image-")), output = path.join(directory, "output.png");
  // Serialized calls reuse one daemon for this application's data directory.
  const session = `self-wiki-${createHash("sha256").update(path.dirname(root)).digest("hex").slice(0, 20)}`;
  const result = await runPython(config, { prompt: value.prompt, size: value.size, referencePaths: references, verbatim, conversationUrl, output, session }, { workspace: root, signal, onProgress });
  signal?.throwIfAborted();
  if (result.path !== output || (await stat(output)).size > 25 * 1024 * 1024) throw new Error("网页版执行器返回了无效的图片路径或大小");
  return { bytes: await readFile(output), savedPath: output };
}
import { childEnvironment } from '../../shared/runtime/childEnvironment.js';
