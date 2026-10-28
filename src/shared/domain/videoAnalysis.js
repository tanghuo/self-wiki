import { elementError } from "./elements.js";
import { validExecutable } from "./executablePath.js";

export function defaultVideoAnalysisConfig() {
  return { enabled: false, applyMode: "suggest", ffmpeg: "ffmpeg", ffprobe: "ffprobe", frameIntervalMs: 2000,
    maxFrames: 120, maxBatches: 20, timeoutMs: 120000,
    visual: { enabled: false, baseUrl: "http://127.0.0.1:8767", model: "google/siglip2-base-patch16-224", revision: "1", timeoutMs: 60000 } };
}

export function videoAnalysisConfig(input) {
  const defaults = defaultVideoAnalysisConfig();
  function object(value, keys) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw elementError("视频分析配置含未知字段");
  }
  object(input, Object.keys(defaults));
  if (input.visual !== undefined) object(input.visual, Object.keys(defaults.visual));
  const value = { ...defaults, ...input, visual: { ...defaults.visual, ...input.visual } };
  if (typeof value.enabled !== "boolean" || typeof value.visual.enabled !== "boolean" || !["suggest", "auto"].includes(value.applyMode)) throw elementError("视频分析模式无效");
  for (const name of ["ffmpeg", "ffprobe"]) {
    if (!validExecutable(value[name], 2048)) throw elementError("请填写有效的本机 FFmpeg/ffprobe 可执行文件路径（不支持网络路径）");
    value[name] = value[name].trim();
  }
  for (const [name, min, max] of [["frameIntervalMs", 250, 10000], ["maxFrames", 8, 1000], ["maxBatches", 1, 200], ["timeoutMs", 1000, 600000]]) {
    if (!Number.isSafeInteger(value[name]) || value[name] < min || value[name] > max) throw elementError(`${name} 须为 ${min}–${max} 的整数`);
  }
  const visual = value.visual;
  for (const name of ["model", "revision"]) if (typeof visual[name] !== "string" || !visual[name].trim() || visual[name].length > 200) throw elementError("请填写视觉模型名称和修订版本");
  if (!Number.isSafeInteger(visual.timeoutMs) || visual.timeoutMs < 1000 || visual.timeoutMs > 1800000) throw elementError("视觉服务超时无效");
  try {
    const url = new URL(visual.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
    visual.baseUrl = url.origin;
  } catch { throw elementError("视觉服务地址须为不含路径和认证信息的 HTTP(S) 地址"); }
  return value;
}
