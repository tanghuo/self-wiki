import { elementError, elementId, elementTags } from "./elements.js";

export const maxMarkerTime = 7 * 24 * 60 * 60 * 1000;
export const maxMarkerBody = 2000;

export function markerRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw elementError("请提供有效的标注版本");
  return value;
}

export function videoMarkerInput(value, { update = false, existingTags = [] } = {}) {
  const allowed = ["startMs", "endMs", "body", "tags", "targetIds", update ? "revision" : "requestKey"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw elementError("无效的视频标注");
  const { startMs, endMs = null, body = "", tags = [], targetIds = [] } = value;
  if (!Number.isSafeInteger(startMs) || startMs < 0 || startMs > maxMarkerTime) throw elementError("开始时间须为 0–7 天内的整数毫秒");
  if (endMs !== null && (!Number.isSafeInteger(endMs) || endMs <= startMs || endMs > maxMarkerTime)) throw elementError("结束时间须晚于开始时间，且不超过 7 天");
  if (typeof body !== "string" || body.length > maxMarkerBody) throw elementError("标注说明最多 2000 字");
  if (!Array.isArray(targetIds) || targetIds.length > 12) throw elementError("每条标注最多关联 12 份内容");
  const content = { startMs, endMs, body, tags: elementTags(tags, { existing: existingTags }), targetIds: [...new Set(targetIds.map(elementId))] };
  if (update) return { ...content, revision: markerRevision(value.revision) };
  if (typeof value.requestKey !== "string" || !/^[\w-]{8,100}$/.test(value.requestKey)) throw elementError("请提供有效的标注请求标识");
  return { ...content, requestKey: value.requestKey };
}

export function formatMarkerTime(ms) {
  const value = Math.max(0, Math.round(ms));
  const seconds = Math.floor(value / 1000), hours = Math.floor(seconds / 3600);
  const base = `${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const fraction = value % 1000 ? `.${String(value % 1000).padStart(3, "0").replace(/0+$/, "")}` : "";
  return `${hours ? `${hours}:` : ""}${base}${fraction}`;
}

export function parseMarkerTime(value) {
  const parts = value.trim().split(":");
  if (parts.length > 3 || !parts.every((part, index) => (index === parts.length - 1 ? /^\d+(?:\.\d{1,3})?$/ : /^\d+$/).test(part))) throw elementError("时间格式为 秒、分:秒 或 时:分:秒，可精确到毫秒");
  if (parts.slice(1).some((part) => Number(part) >= 60)) throw elementError("冒号后的分、秒须小于 60");
  const milliseconds = Math.round(parts.reduce((total, part) => total * 60 + Number(part), 0) * 1000);
  if (!Number.isSafeInteger(milliseconds) || milliseconds > maxMarkerTime) throw elementError("标注时间不能超过 7 天");
  return milliseconds;
}

export function markerTimeLabel(marker) {
  return formatMarkerTime(marker.startMs) + (marker.endMs === null ? "" : `–${formatMarkerTime(marker.endMs)}`);
}
