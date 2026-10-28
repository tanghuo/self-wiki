import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { codexEnvironment, codexMcpOverrides } from "./codexEnvironment.js";
import { organizationOutputSchema, organizationOutput } from "../../shared/domain/organization.js";
import { imageDescriptionOutputSchema, imageDescriptionOutput } from "../../shared/domain/embedding.js";
import { videoAnalysisOutputSchema, videoAnalysisOutput } from "../../shared/domain/videoAnalysisOutput.js";
import { startCodexAppServer } from "./codexAppServer.js";
import { resolveCodexCommand } from "./codexCommand.js";
import { localCodexAuth, codexAuthError, isCodexAuthError } from "./codexLocalAuth.js";
import { codexStructured } from "./codexStructured.js";

function failure(message, code = "EXECUTOR_ERROR", retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

export function runCodexProcess(cmd, args, options) { return run(cmd, args, options); }

function run(cmd, args, { env, cwd, input = "", signal, onLine }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(failure("执行已取消", "CANCELLED")); return; }
    const child = spawn(cmd.executable, [...cmd.prefix, ...args], { env, cwd, shell: false, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    // Decode across chunk boundaries so multi-byte (e.g. Chinese) characters are never split.
    const out = new StringDecoder("utf8"), err = new StringDecoder("utf8");
    let stdout = "", stderr = "", pending = "", stopped;
    function stop(error) {
      if (stopped) return;
      stopped = error;
      if (!child.pid || child.exitCode !== null) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
        killer.on("error", () => child.kill());
        killer.on("close", (code) => { if (code) child.kill(); });
      } else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    }
    const abort = () => stop(failure("执行已取消或超时", signal?.reason?.name === "TimeoutError" ? "TIMEOUT" : "CANCELLED", signal?.reason?.name === "TimeoutError"));
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => { signal?.removeEventListener("abort", abort); reject(failure(`无法启动 Codex CLI：${error.code || "进程错误"}`)); });
    child.stdout.on("data", (chunk) => {
      const text = out.write(chunk); stdout += text; pending += text;
      if (stdout.length > 4 * 1024 * 1024) { stop(failure("Codex 输出超过限制", "INVALID_OUTPUT")); return; }
      const lines = pending.split("\n"); pending = lines.pop();
      for (const line of lines) onLine?.(line);
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + err.write(chunk)).slice(-8000); });
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") stop(failure("无法传入整理内容")); });
    child.stdin.end(input);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      const tail = out.end(); stdout += tail; pending += tail; stderr = (stderr + err.end()).slice(-8000);
      if (pending) onLine?.(pending);
      if (stopped) reject(stopped); else resolve({ code, stdout, stderr });
    });
  });
}

export const codexCli = {
  async probe(config) {
    try {
      const cmd = await resolveCodexCommand(config), env = await codexEnvironment(config), signal = AbortSignal.timeout(10000);
      const version = await run(cmd, ["--version"], { env, signal });
      if (version.code !== 0) throw failure("Codex CLI 版本探测失败");
      if (await localCodexAuth(config)) {
        const client = await startCodexAppServer(config, { configurationOnly: true, signal, onNotification() {}, onExit() {} });
        try {
          if (!client.account.account) throw codexAuthError();
          return { available: true, version: version.stdout.trim().slice(0, 100), path: cmd.path, code: "READY", diagnostic: "Codex 已就绪，使用本机当前登录" };
        } finally { await client.close(); }
      }
      const help = await run(cmd, ["exec", "--help"], { env, signal });
      if (help.code || ["--image", "--output-schema", "--ephemeral"].some((flag) => !help.stdout.includes(flag))) {
        throw failure("当前 Codex CLI 缺少所需的非交互能力，请升级", "UNSUPPORTED");
      }
      const login = await run(cmd, ["login", "status"], { env, signal });
      return { available: login.code === 0, version: version.stdout.trim().slice(0, 100), path: cmd.path,
        code: login.code === 0 ? "READY" : "AUTH_REQUIRED", diagnostic: login.code === 0 ? "Codex CLI 已就绪" : "此执行环境需要登录 Codex CLI；请使用所配置的认证目录登录后重新检测" };
    } catch (error) { return { available: false, code: error.code || "EXECUTOR_ERROR", diagnostic: error.message }; }
  },
  async execute(request, { config, signal, onEvent, onUsage }) {
    const cmd = await resolveCodexCommand(config);
    const env = await codexEnvironment(config), mcpOverrides = await codexMcpOverrides(env);
    const sharedLogin = await localCodexAuth(config);
    // A stable cwd keeps per-request random paths out of Codex's environment context.
    // Files remain isolated and are removed independently after each execution.
    const workspace = path.join(os.tmpdir(), "self-wiki-organization");
    await mkdir(workspace, { recursive: true });
    const root = await mkdtemp(path.join(workspace, "request-"));
    const startedAt = Date.now(), id = randomUUID();
    let usage = null, state = "running", model = config.codexCli.model;
    const report = () => onUsage?.({ id, model, startedAt, elapsedMs: Date.now() - startedAt, state, usage,
      context: { promptChars: request.prompt.length, imageCount: request.images.length } });
    report();
    try {
      if (!model) {
        // Ask Codex to resolve its configuration and built-in default, then pin that
        // choice for exec so the recorded name and the submitted model cannot drift.
        signal?.throwIfAborted();
        const server = await startCodexAppServer(config, { cwd: workspace, configurationOnly: true, signal, onNotification() {}, onExit() {} });
        try {
          model = server.defaultModel || (await server.models()).find((entry) => entry.isDefault)?.id;
          if (!model) throw failure("无法确定 Codex 默认模型，请在设置中选择模型", "MODEL_UNKNOWN");
        } finally { await server.close(); }
        signal?.throwIfAborted();
        report();
      }
      const schemaPath = path.join(root, "schema.json"), outputPath = path.join(root, "result.json");
      const schema = request.kind === "video-analysis" ? videoAnalysisOutputSchema : request.kind === "image-description" ? imageDescriptionOutputSchema : organizationOutputSchema;
      const validate = request.kind === "video-analysis" ? videoAnalysisOutput : request.kind === "image-description" ? imageDescriptionOutput : organizationOutput;
      await writeFile(schemaPath, JSON.stringify(schema));
      if (request.kind === "video-analysis" && (!request.images.length || request.images.length > 8)) throw failure("视频分析每批需要 1 至 8 张帧图片", "INVALID_INPUT");
      const images = [];
      const attachmentNames = new Set();
      for (const attachment of request.images) {
        const name = attachment.attachmentId === undefined ? `element-${attachment.elementId}` : `attachment-${attachment.attachmentId}`;
        if (!/^(element|attachment)-[A-Za-z0-9_-]{1,100}$/.test(name) || attachmentNames.has(name)) throw failure("图片附件标识无效或重复", "INVALID_INPUT");
        attachmentNames.add(name);
        const bytes = Buffer.from(attachment.bytes);
        const extension = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png" : bytes[0] === 255 && bytes[1] === 216 ? "jpg" : "webp";
        const file = path.join(root, `${name}.${extension}`);
        await writeFile(file, attachment.bytes); images.push(file);
      }
      const args = ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only",
        "-c", "approval_policy=\"never\"", "-c", "web_search=\"disabled\"", "-c", "project_doc_max_bytes=0", ...mcpOverrides, "--json", "--output-schema", schemaPath, "-o", outputPath, "-C", workspace];
      // Model sees only provided content. Retrieval and mutations belong to the host worker.
      for (const feature of ["shell_tool", "unified_exec", "apps", "plugins", "hooks", "multi_agent", "browser_use", "in_app_browser", "image_generation", "skill_search", "view_image"]) args.push("--disable", feature);
      args.push("--model", model);
      for (const file of images) args.push("--image", file);
      // With no positional prompt, exec reads stdin; do not let a variadic --image consume a '-' path.
      const started = Date.now();
      let executionError = "";
      const structured = sharedLogin ? await codexStructured({ config, signal, cwd: workspace, prompt: request.prompt,
        images, schema, model, onEvent, onUsage(value) { usage = value; report(); } }) : null;
      const response = structured ? { code: 0 } : await run(cmd, args, { env, cwd: workspace, input: request.prompt, signal, onLine(line) {
        try {
          const event = JSON.parse(line);
          if (event.type === "turn.failed") executionError = event.error?.message || "";
          if (event.type === "item.completed" && event.item?.type === "error") {
            const rerouted = /^model rerouted: \S+ -> (\S+) \(/.exec(event.item.message || "");
            if (rerouted) { model = rerouted[1]; report(); }
          }
          if (event.type === "turn.completed") { usage = event.usage || null; report(); }
          onEvent?.({ type: event.type });
        } catch { /* Unrecognized progress is not a final result. */ }
      } });
      if (response.code !== 0) {
        if (isCodexAuthError(executionError || response.stderr)) throw codexAuthError();
        throw failure(`Codex CLI 执行失败（退出码 ${response.code}），请检查 CLI 登录、模型与网络`, "EXECUTOR_ERROR", true);
      }
      let output;
      try {
        if (!structured && (await stat(outputPath)).size > 60000) throw new Error("too large");
        const text = structured ? structured.text : await readFile(outputPath, "utf8");
        if (text.length > 60000) throw new Error("too large");
        output = validate(JSON.parse(text));
      } catch { throw failure("Codex 未返回有效的整理 JSON", "INVALID_OUTPUT"); }
      state = "completed";
      return { output, execution: { executor: "codex-cli", model, elapsedMs: Date.now() - started, usage } };
    } finally {
      if (state === "running") state = signal?.aborted ? "interrupted" : "failed";
      report();
      if (path.dirname(root) !== path.resolve(workspace) || !path.basename(root).startsWith("request-")) throw new Error("Invalid temporary directory");
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  },
};
