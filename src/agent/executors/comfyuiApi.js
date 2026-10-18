export async function comfyuiRequest(config, route, { method = "GET", body, signal, maxBytes = 8 * 1024 * 1024 } = {}) {
  const response = await fetch(`${config.baseUrl}${route}`, { method, redirect: "error",
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]),
    ...(body instanceof FormData ? { body } : body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("ComfyUI 返回的数据超过大小限制");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (!response.ok) {
    let detail = "";
    try {
      const value = JSON.parse(bytes.toString("utf8"));
      detail = [typeof value.error === "string" ? value.error : value.error?.message,
        ...Object.entries(value.node_errors || {}).map(([id, node]) => `节点 ${id}：${(node.errors || []).map((error) => error.details || error.message).join("；")}`)]
        .filter(Boolean).join("；").slice(0, 1500);
    } catch { /* A proxy's HTML does not explain a ComfyUI error. */ }
    throw Object.assign(new Error(`ComfyUI HTTP ${response.status}${detail ? `：${detail}` : ""}`), { httpStatus: response.status });
  }
  return bytes;
}

export async function comfyuiJson(config, route, options) {
  const bytes = await comfyuiRequest(config, route, options);
  if (!bytes.length) return {};
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("ComfyUI 返回了无效 JSON，请检查服务地址"); }
  if (!value || typeof value !== "object") throw new Error("ComfyUI 返回了无效的响应对象");
  return value;
}
