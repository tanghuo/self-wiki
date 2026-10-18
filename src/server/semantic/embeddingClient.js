import { embeddingVector } from "../../shared/domain/embedding.js";
import { randomUUID } from "node:crypto";

export async function embedTexts(config, input, signal, onUsage) {
  if (!input.length || input.length > 16) throw new Error("索引分段数量无效");
  const key = config.apiKeyEnv ? process.env[config.apiKeyEnv] : null;
  if (config.apiKeyEnv && !key) throw Object.assign(new Error(`未设置向量服务密钥环境变量 ${config.apiKeyEnv}`), { retryable: false });
  const startedAt = Date.now(), id = randomUUID();
  let usage = null, state = "running";
  const report = () => onUsage?.({ id, startedAt, elapsedMs: Date.now() - startedAt, model: config.model, state, usage,
    context: { promptChars: input.reduce((n, s) => n + s.length, 0), segments: input.length } });
  report();
  try {
    let response;
    try {
      response = await fetch(`${config.baseUrl}/embeddings`, {
        method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: config.model, input, encoding_format: "float" }),
      });
    } catch { throw Object.assign(new Error("无法连接向量服务，或请求已取消/超时；请检查服务地址"), { retryable: true }); }
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error(`向量服务返回 HTTP ${response.status}；请检查模型名称、认证及服务状态`), { retryable: response.status === 429 || response.status >= 500 });
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw Object.assign(new Error("向量响应超过 8 MiB"), { retryable: false });
      chunks.push(chunk);
    }
    try {
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      usage = result.usage ? { ...result.usage, output_tokens: 0 } : null;
      if (!Array.isArray(result.data) || result.data.length !== input.length) throw new Error();
      const ordered = [...result.data].sort((a, b) => a.index - b.index);
      const vectors = ordered.map((entry, i) => {
        if (entry.index !== i) throw new Error();
        return Array.from(embeddingVector(entry.embedding, config.dimensions));
      });
      state = "completed";
      return vectors;
    } catch { throw Object.assign(new Error(`向量响应无效：需要 ${input.length} 个非零向量，每个 ${config.dimensions} 维`), { retryable: false }); }
  } finally {
    if (state === "running") state = signal?.aborted ? "interrupted" : "failed";
    report();
  }
}
