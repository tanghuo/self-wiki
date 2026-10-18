import { elementError, elementId, elementQuery } from "./elements.js";

export const maxCanvasNodes = 300;
export const maxCanvasEdges = 1200;
export const canvasBatchSize = 100;

export function canvasQuery(params) {
  const { q, tags } = elementQuery(params);
  const tag = tags[0] || "";
  const view = params.get("view") || "flat";
  if (!["flat", "tags"].includes(view)) throw elementError("无效的画布视图");
  const ids = params.get("ids") ? params.get("ids").split(",").map(elementId) : [];
  const groupIds = params.get("groupIds") ? params.get("groupIds").split(",").map(elementId) : [];
  if (ids.length + groupIds.length > maxCanvasNodes || new Set(ids).size !== ids.length || new Set(groupIds).size !== groupIds.length) throw elementError("画布最多展开 300 张不同卡片");
  if (groupIds.length && (view !== "tags" || tag)) throw elementError("仅标签总览可以加载分组");
  if (params.has("expand") && view === "tags" && !tag) throw elementError("请在平铺视图展开关联");
  const rawLimit = params.get("limit") ?? String(canvasBatchSize);
  if (!/^\d+$/.test(rawLimit) || Number(rawLimit) > canvasBatchSize) throw elementError("无效的画布加载数量");
  return { q, tag, ids, groupIds, view, limit: Number(rawLimit), expand: params.has("expand") ? elementId(params.get("expand")) : null };
}

export function canvasPositions(payload) {
  if (!payload || !Array.isArray(payload.positions) || !payload.positions.length || payload.positions.length > maxCanvasNodes) {
    throw elementError("每次须保存 1–300 个元素的位置");
  }
  const ids = new Set();
  return payload.positions.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw elementError("无效的画布位置");
    let { id, x, y } = entry;
    id = elementId(id);
    if (ids.has(id) || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1_000_000 || Math.abs(y) > 1_000_000) {
      throw elementError("无效或重复的画布位置");
    }
    ids.add(id);
    return { id, x, y };
  });
}
