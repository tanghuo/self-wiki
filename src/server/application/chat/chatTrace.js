import { createHash } from "node:crypto";

// Store inspectable text, not image payloads, provider credentials or unbounded
// command output. Every transformation is reported alongside the saved value.
export function captureChatTrace(value) {
  const omissions = [];
  let remaining = 2 * 1024 * 1024;
  function visit(item, path, depth = 0) {
    if (typeof item === "string") {
      if (/^data:[^,]*;base64,/i.test(item)) {
        const bytes = Buffer.from(item.slice(item.indexOf(",") + 1), "base64");
        omissions.push({ path, reason: "二进制附件仅保存类型、字节数和摘要" });
        return { mediaType: item.slice(5, item.indexOf(";")), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      }
      const limit = Math.min(512 * 1024, Math.max(0, remaining));
      remaining -= Math.min(item.length, limit);
      if (item.length > limit) { omissions.push({ path, reason: "超过记录长度上限", originalChars: item.length, savedChars: limit }); return item.slice(0, limit); }
      return item;
    }
    if (item === null || typeof item !== "object") return item;
    if (depth > 16 || remaining <= 0) { omissions.push({ path, reason: "超过记录大小或嵌套上限" }); return "[未保存]"; }
    if (Array.isArray(item)) {
      if (item.length > 1000) omissions.push({ path, reason: "仅保存前 1000 项", originalItems: item.length });
      return item.slice(0, 1000).map((entry, i) => visit(entry, `${path}[${i}]`, depth + 1));
    }
    const result = Object.create(null);
    for (const [key, entry] of Object.entries(item)) {
      if (entry === undefined) continue;
      remaining -= key.length;
      const child = `${path}.${key}`;
      if (/^(authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)$/i.test(key)) {
        result[key] = "[凭据已隐藏]"; omissions.push({ path: child, reason: "凭据字段已隐藏" });
      } else if (key === "data" && ["image", "audio"].includes(item.type) && typeof entry === "string") {
        result[key] = visit(`data:${item.mimeType || "application/octet-stream"};base64,${entry}`, child, depth + 1);
      } else result[key] = visit(entry, child, depth + 1);
    }
    return result;
  }
  return { value: visit(value, "$"), omissions };
}

export function mergeChatToolTrace(update, previous = {}) {
  const record = { ...previous, ...update, input: { ...previous.input }, output: { ...previous.output } };
  for (const [key, value] of Object.entries(update.input)) {
    if (record.input[key] === undefined) record.input[key] = value;
    else if (JSON.stringify(record.input[key]) !== JSON.stringify(value)) record.output.reportedInput = { ...record.output.reportedInput, [key]: value };
  }
  Object.assign(record.output, update.output);
  return record;
}
