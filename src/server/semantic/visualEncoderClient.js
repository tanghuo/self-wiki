import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { embeddingVector } from "../../shared/domain/embedding.js";

async function request(config, route, body, signal) {
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(config.timeoutMs)]);
  const payload = body ? JSON.stringify(body) : undefined;
  let response, busy = false, attempt = 0;
  try {
    while (true) {
      requestSignal.throwIfAborted();
      try {
        response = await fetch(`${config.baseUrl}${route}`, { method: body ? "POST" : "GET", redirect: "error",
          headers: body ? { "content-type": "application/json" } : {}, body: payload, signal: requestSignal });
      } catch { throw new Error("无法连接本地视觉编码服务，请检查启动状态、地址和超时设置"); }
      busy = response.status === 429;
      if (!busy) break;
      await response.body?.cancel();
      await delay(Math.min(1000, 250 * ++attempt), undefined, { signal: requestSignal });
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`视觉编码服务返回 HTTP ${response.status}，请检查服务日志与模型依赖`); }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw new Error("视觉编码响应超过 8 MiB");
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new Error("视觉编码服务响应不是有效 JSON"); }
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (requestSignal.aborted && busy) throw Object.assign(new Error("视觉编码服务繁忙，已达到本次等待时限，请稍后重试"), { code: "VISUAL_ENCODER_BUSY" });
    if (requestSignal.aborted) throw new Error("视觉编码请求超时，请检查服务状态和超时设置");
    throw error;
  }
}

export async function probeVisualEncoder(config, signal) {
  const value = await request(config, "/health", null, signal);
  if (value.model !== config.model || value.revision !== config.revision) throw new Error("视觉服务模型或修订版本与设置不一致");
  if (!value.ready) throw new Error(value.diagnostic || "视觉编码依赖或模型未就绪");
  return value;
}

export async function encodeVisual(config, { images, texts }, signal) {
  const count = images?.length || texts?.length;
  if (!count || count > 8 || Boolean(images) === Boolean(texts)) throw new Error("视觉编码每批需要 1–8 张图片或文本");
  if (images?.some((bytes) => !bytes.length || bytes.length > 4 * 1024 * 1024)) throw new Error("每张视觉编码图片须为非空文件且不超过 4 MiB");
  if (texts?.some((text) => typeof text !== "string" || !text.trim() || text.length > 2000)) throw new Error("视觉查询须为 1–2000 字");
  const body = { model: config.model, revision: config.revision,
    ...(images ? { images: images.map((bytes) => Buffer.from(bytes).toString("base64")) } : { texts }) };
  if (Buffer.byteLength(JSON.stringify(body)) > 16 * 1024 * 1024) throw new Error("视觉编码整批请求超过 16 MiB，请减少图片数量或分辨率");
  const value = await request(config, "/encode", body, signal);
  if (value.model !== config.model || value.revision !== config.revision || typeof value.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.fingerprint) || !Number.isSafeInteger(value.dimensions) || value.dimensions < 1 || value.dimensions > 4096 ||
      !Array.isArray(value.embeddings) || value.embeddings.length !== count) throw new Error("视觉编码响应的模型、空间或数量不匹配");
  const vectors = value.embeddings.map((vector) => Array.from(embeddingVector(vector, value.dimensions)));
  const space = createHash("sha256").update(JSON.stringify(["visual-v1", config.baseUrl, config.model, config.revision, value.fingerprint, value.dimensions])).digest("hex");
  return { vectors, space, dimensions: value.dimensions };
}
