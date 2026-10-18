import { elementError } from "./elements.js";

export const imageDescriptionOutputSchema = {
  type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string" } },
};

export function imageDescriptionOutput(value) {
  if (!value || typeof value.summary !== "string" || !value.summary.trim() || value.summary.length > 2000 || Object.keys(value).some((key) => key !== "summary")) {
    throw elementError("图片描述结果无效");
  }
  return { summary: value.summary.trim() };
}

export function defaultEmbeddingConfig() {
  return { enabled: false, provider: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3-embedding:0.6b",
    modelRevision: "1", dimensions: 1024, apiKeyEnv: null, timeoutMs: 60000, topK: 12 };
}

export function embeddingConfig(value) {
  const keys = Object.keys(defaultEmbeddingConfig());
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !keys.includes(k)) ||
      typeof value.enabled !== "boolean" || value.provider !== "openai-compatible" ||
      typeof value.baseUrl !== "string" || value.baseUrl.length > 1000 ||
      typeof value.model !== "string" || !value.model.trim() || value.model.length > 160 || /[\r\n\0]/.test(value.model) ||
      typeof value.modelRevision !== "string" || !value.modelRevision.trim() || value.modelRevision.length > 80 ||
      !Number.isInteger(value.dimensions) || value.dimensions < 1 || value.dimensions > 8192 ||
      !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 300000 ||
      !Number.isInteger(value.topK) || value.topK < 1 || value.topK > 20 ||
      !(value.apiKeyEnv === null || typeof value.apiKeyEnv === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(value.apiKeyEnv))) {
    throw elementError("语义检索配置无效，请检查模型、维数、超时和密钥环境变量名");
  }
  let url;
  try { url = new URL(value.baseUrl); } catch { throw elementError("向量服务地址无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw elementError("向量服务地址须为不含认证信息、查询或片段的 HTTP(S) 地址");
  return { ...value, baseUrl: url.href.replace(/\/+$/, ""), model: value.model.trim(), modelRevision: value.modelRevision.trim() };
}

// Keep every part of the 12,000-character body searchable, including its tail.
export function embeddingChunks(text) {
  const chars = Array.from(text.trim()), chunks = [];
  for (let start = 0; start < chars.length; start += 850) {
    chunks.push(chars.slice(start, start + 1000).join(""));
    if (start + 1000 >= chars.length) break;
  }
  return chunks;
}

export function embeddingVector(value, dimensions) {
  if (!Array.isArray(value) || value.length !== dimensions || value.some((n) => typeof n !== "number" || !Number.isFinite(n))) throw elementError("向量服务返回的维数或数值无效");
  const vector = new Float32Array(value), norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm <= 0) throw elementError("向量服务返回了无效或全零向量");
  for (let i = 0; i < vector.length; i++) vector[i] /= norm;
  return vector;
}
