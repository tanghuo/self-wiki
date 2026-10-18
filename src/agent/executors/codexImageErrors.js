import { open, stat } from "node:fs/promises";

export const unknownImageError = "图片生成失败，图片工具未提供具体原因。";

export function imageErrorMessage(value) {
  if (value?.type === "usageLimitExceeded") return "图片生成额度已用完，请在额度恢复后重试。";
  const message = typeof value === "string" ? value : value?.message;
  if (!message) return unknownImageError;
  const plain = `${message} ${typeof value === "object" ? JSON.stringify({ code: value.code, ...value.moderation_details }) : ""}`.replace(/\\+"/g, '"').replace(/\\+[nrt]/g, " ");
  if (/moderation_blocked|rejected by the safety system/i.test(plain)) {
    const subject = /"moderation_stage"\s*:\s*"output"/.test(plain) ? "生成结果" : "图片生成请求";
    const category = /safety_violations=\[sexual\]|"categories"\s*:\s*\[\s*"sexual"/.test(plain) ? "：性相关内容" : "";
    return `${subject}被内容审核拦截${category}。`;
  }
  return message.slice(0, 1000);
}

function outputErrors(item) {
  const blocks = typeof item.output === "string" ? [item.output] : Array.isArray(item.output)
    ? item.output.filter((part) => part.type === "input_text").map((part) => part.text) : [];
  const errors = [];
  for (const block of blocks) for (const line of block.split("\n")) {
    let value;
    try { value = JSON.parse(line); } catch { value = { error: line }; }
    if (typeof value?.error !== "string" || !value.error.startsWith("image generation failed:")) continue;
    errors.push({ label: typeof value.view === "string" ? value.view.slice(0, 80) : "", error: imageErrorMessage(value.error) });
  }
  return errors;
}

// Some Codex versions omit image errors from item/completed, but retain them in
// the tool output in the rollout. Read only new bytes and skip large image lines.
export async function openImageErrorLog(file) {
  if (!file) return null;
  let offset;
  try { offset = (await stat(file)).size; } catch (error) {
    // New threads may create their rollout only after turn/start.
    if (error.code !== "ENOENT") return null;
    offset = 0;
  }
  let pending = Buffer.alloc(0), skipping = false;
  return async (turnId) => {
    const batches = [], handle = await open(file, "r");
    try {
      const end = (await handle.stat()).size, chunk = Buffer.alloc(65536);
      while (offset < end) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, end - offset), offset);
        if (!bytesRead) break;
        offset += bytesRead;
        let start = 0;
        while (start < bytesRead) {
          let newline = chunk.indexOf(10, start);
          if (newline >= bytesRead) newline = -1;
          const piece = chunk.subarray(start, newline < 0 ? bytesRead : newline);
          if (!skipping) {
            if (pending.length + piece.length > 256 * 1024) { pending = Buffer.alloc(0); skipping = true; }
            else pending = Buffer.concat([pending, piece]);
          }
          if (newline < 0) break;
          if (!skipping) {
            try {
              const row = JSON.parse(pending.toString("utf8")), item = row.payload;
              if (row.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(item?.type)
                && item.internal_chat_message_metadata_passthrough?.turn_id === turnId) {
                const errors = outputErrors(item);
                if (errors.length) batches.push({ id: item.id || item.call_id, errors });
              }
            } catch { /* Incomplete or unrelated diagnostic records are not chat failures. */ }
          }
          pending = Buffer.alloc(0); skipping = false; start = newline + 1;
        }
      }
    } finally { await handle.close(); }
    return batches;
  };
}
