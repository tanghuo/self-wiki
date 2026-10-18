import { randomUUID } from "./browserCrypto.js";
export function textDraft() {
  return { key: randomUUID(), kind: "text", body: "", tags: { tags: [], draft: "" } };
}

export function appendMediaDrafts(current, files) {
  const draft = current || { entries: [], tags: { tags: [], draft: "" } };
  const entries = [...draft.entries];
  const last = entries.at(-1);
  const trailingText = last?.kind === "text" && !last.body.trim() && !last.saved ? entries.pop() : textDraft();
  return { ...draft, entries: [...entries, ...Array.from(files, (file) => ({
    key: randomUUID(), kind: file.type.startsWith("video/") || /\.(mp4|m4v|webm|mov)$/i.test(file.name) ? "video" : "image", file, tags: { tags: [], draft: "" },
  })), trailingText] };
}

export function clipboardImages(clipboard) {
  if (!clipboard) return [];
  const files = Array.from(clipboard.files || []).filter((file) => file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(file.name));
  if (files.length) return files;
  return Array.from(clipboard.items || []).filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile()).filter(Boolean);
}

export function clipboardMedia(clipboard) {
  if (!clipboard) return [];
  const files = Array.from(clipboard.files || []).filter((file) => /^(image|video)\//.test(file.type) || /\.(png|jpe?g|webp|gif|mp4|m4v|webm|mov)$/i.test(file.name));
  if (files.length) return files;
  return Array.from(clipboard.items || []).filter((item) => item.kind === "file" && /^(image|video)\//.test(item.type))
    .map((item) => item.getAsFile()).filter(Boolean);
}

export function savedContentStatus(element) {
  return element.importStatus === "reused" ? `已复用已有${element.kind === "video" ? "视频" : "图片"}，标签已合并` : element.importStatus === "same-name" ? "同名不同内容，已另存" : "已保存";
}
