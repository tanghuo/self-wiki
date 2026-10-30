import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { grokCommand } from "./grokProcess.js";
import { grokEnvironment } from "./grokEnvironment.js";
import { describeGrokWorkbench } from "../engines/grokWorkbench.js";
import { callRestrictedGrok } from "../engines/grokRestricted.js";
import { organizationOutputSchema, organizationOutput } from "../../shared/domain/organization.js";
import { imageDescriptionOutputSchema, imageDescriptionOutput } from "../../shared/domain/embedding.js";
import { videoAnalysisOutputSchema, videoAnalysisOutput } from "../../shared/domain/videoAnalysisOutput.js";

function failure(message, code = "EXECUTOR_ERROR", retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function schemaFor(kind) {
  if (kind === "video-analysis") return { schema: videoAnalysisOutputSchema, validate: videoAnalysisOutput };
  if (kind === "image-description") return { schema: imageDescriptionOutputSchema, validate: imageDescriptionOutput };
  return { schema: organizationOutputSchema, validate: organizationOutput };
}

function parseModelJson(text) {
  const trimmed = String(text).trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const body = (fenced ? fenced[1] : trimmed).trim();
  try { return JSON.parse(body); } catch { /* The model may add a short preface around the object. */ }
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no json");
  return JSON.parse(body.slice(start, end + 1));
}

function mapError(error, signal) {
  if (signal?.aborted) {
    const timeout = signal.reason?.name === "TimeoutError";
    return failure(timeout ? "Grok 整理超时" : "执行已取消", timeout ? "TIMEOUT" : "CANCELLED", timeout);
  }
  const message = String(error?.message || "Grok 整理失败");
  if (/登录/.test(message)) return failure(message, "AUTH_REQUIRED");
  if (/拒绝工具|出现可调用工具/.test(message)) return failure(message, "EXECUTOR_ERROR");
  return failure(message, "EXECUTOR_ERROR", true);
}

export const grokOrganization = {
  async probe(config) {
    try {
      const settings = config.grokBuild;
      if (!settings?.executable || !settings.model) throw failure("请先填写 Grok 程序路径和整理模型");
      const command = await grokCommand(settings.executable);
      const version = (await promisify(execFile)(command.executable, [...command.prefix, "--version"], {
        windowsHide: true, timeout: 10000, env: grokEnvironment(),
      })).stdout.trim();
      if (!/^grok 1\.0\.70 \(f50904eaee6c\)/.test(version)) {
        return { available: false, code: "UNSUPPORTED", version: version.slice(0, 100), path: command.executable,
          diagnostic: "整理需要已验证的 Grok 1.0.70 (f50904eaee6c)" };
      }
      const listed = await describeGrokWorkbench(settings, { cwd: os.tmpdir(), signal: AbortSignal.timeout(20000) });
      if (!listed.models.some((entry) => entry.id === settings.model)) {
        const names = listed.models.slice(0, 8).map((entry) => entry.id).join("、");
        return { available: false, code: "MODEL_UNKNOWN", version: version.slice(0, 100), path: command.executable,
          diagnostic: `当前 Grok 登录没有模型 ${settings.model}。可选：${names}` };
      }
      return { available: true, version: version.slice(0, 100), path: command.executable, code: "READY",
        diagnostic: `Grok 已就绪，整理模型 ${settings.model}` };
    } catch (error) {
      const auth = /登录/.test(error.message || "");
      return { available: false, code: auth ? "AUTH_REQUIRED" : (error.code || "EXECUTOR_ERROR"), diagnostic: error.message || "无法检测 Grok" };
    }
  },
  async execute(request, { config, signal, onEvent, onUsage }) {
    const settings = config.grokBuild, model = settings.model;
    const startedAt = Date.now(), id = randomUUID();
    let state = "running";
    const imagesIn = request.images || [];
    const report = () => onUsage?.({ id, model, startedAt, elapsedMs: Date.now() - startedAt, state, usage: null,
      context: { promptChars: request.prompt.length, imageCount: imagesIn.length } });
    report();
    const workspace = path.join(os.tmpdir(), "self-wiki-grok-organization");
    await mkdir(workspace, { recursive: true });
    const root = await mkdtemp(path.join(workspace, "request-"));
    try {
      signal?.throwIfAborted();
      if (request.kind === "video-analysis" && (imagesIn.length < 1 || imagesIn.length > 8)) throw failure("视频分析每批需要 1 至 8 张帧图片", "INVALID_INPUT");
      if (imagesIn.length > 8) throw failure("整理图片超过 8 张", "INVALID_INPUT");
      const images = [];
      const names = new Set();
      for (const attachment of imagesIn) {
        const name = attachment.attachmentId === undefined ? `element-${attachment.elementId}` : `attachment-${attachment.attachmentId}`;
        if (!/^(element|attachment)-[A-Za-z0-9_-]{1,100}$/.test(name) || names.has(name)) throw failure("图片附件标识无效或重复", "INVALID_INPUT");
        names.add(name);
        const bytes = Buffer.from(attachment.bytes);
        const extension = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png" : bytes[0] === 255 && bytes[1] === 216 ? "jpg" : "webp";
        const file = path.join(root, `${name}.${extension}`);
        await writeFile(file, bytes);
        images.push(file);
      }
      const { schema, validate } = schemaFor(request.kind);
      const prompt = `${request.prompt}\n\n只输出一个 JSON 对象，不要 Markdown。必须符合此 JSON Schema：\n${JSON.stringify(schema)}`;
      const result = await callRestrictedGrok({ settings }, {
        prompt, images, workspace: root, signal, onRequest() {},
        onProgress(event) { onEvent?.({ type: event.metadata?.progress?.phase || "progress" }); },
      });
      let output;
      try {
        const text = result.text || "";
        if (text.length > 60000) throw new Error("too large");
        output = validate(parseModelJson(text));
      } catch (error) { if (error.code) throw error; throw failure("Grok 未返回有效的整理 JSON", "INVALID_OUTPUT"); }
      state = "completed";
      return { output, execution: { executor: "grok-build", model, elapsedMs: Date.now() - startedAt, usage: null } };
    } catch (error) {
      throw error.code ? error : mapError(error, signal);
    } finally {
      if (state === "running") state = signal?.aborted ? "interrupted" : "failed";
      report();
      if (path.dirname(root) !== path.resolve(workspace) || !path.basename(root).startsWith("request-")) throw new Error("Invalid temporary directory");
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  },
};
