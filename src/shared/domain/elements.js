export const elementKinds = ["text", "image", "session", "video"];
export const elementKindLabels = { text: "文字", image: "图片", session: "会话", video: "视频" };
export const maxElementBody = 12000;
export const maxImageBytes = 25 * 1024 * 1024;
export const maxVideoBytes = 1024 * 1024 * 1024;
export const imagePreviewWidths = [400, 800, 1200, 1600];
export const maxElementTags = 30;
export const maxTagLength = 60;

export function elementTags(value, { existing = [] } = {}) {
  if (!Array.isArray(value)) throw elementError("标签必须是文字列表");
  const tags = new Map();
  for (const entry of value) {
    if (typeof entry !== "string") throw elementError("标签必须是文字");
    const name = entry.trim().normalize("NFC");
    if (!name || name.length > maxTagLength || /[\u0000-\u001f\u007f]/.test(name)) throw elementError("标签须为 1–60 字的单行文字");
    const key = name.toLowerCase();
    if (!tags.has(key)) tags.set(key, name);
  }
  // Removing an alias can expose more historical tags than the normal limit.
  // Preserve or reduce those bindings without permitting additional tags.
  if (tags.size > maxElementTags) {
    const retained = new Set(existing.map((name) => name.trim().normalize("NFC").toLowerCase()));
    if ([...tags.keys()].some((name) => !retained.has(name))) throw elementError("最多设置 30 个标签");
  }
  return [...tags.values()];
}

export function elementError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function elementId(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw elementError("无效的内容编号");
  }
  return Number(value);
}

export function elementContent(payload, previous = { body: "", kind: "text" }) {
  if (Object.keys(payload).some((key) => !["body", "tags"].includes(key))) throw elementError("元素只保存自身内容；标题请通过独立文字和关联设置");
  const body = payload.body ?? previous.body;
  if (typeof body !== "string" || body.length > maxElementBody) throw elementError("文字最多 12000 字");
  if (payload.body === null) throw elementError("内容必须是文字");
  if (previous.kind === "image" && body !== "") throw elementError("图片说明请保存为关联文字");
  if (previous.kind === "video" && body !== "") throw elementError("视频说明请保存为关联文字");
  if (previous.kind === "session" && body !== previous.body) throw elementError("会话内容在 Agent 中查看，可编辑标签或添加关联");
  if (previous.kind === "text" && !body.trim()) throw elementError("请填写文字");
  return { body, tags: elementTags(payload.tags === undefined ? previous.tags || [] : payload.tags, { existing: previous.tags || [] }) };
}

export function elementLabel(element) {
  return (element.body || element.summary || "").slice(0, 60) || element.image?.originalName || element.video?.originalName || elementKindLabels[element.kind] || "内容";
}

export function relationLabel(relation, elementId) {
  const atSource = relation.sourceId === Number(elementId);
  let name = relation.name || "普通关联";
  if (relation.direction === "unknown") name += "（方向待确认）";
  if (relation.direction === "forward" || relation.direction === "reverse") {
    name = atSource === (relation.direction === "forward") ? relation.name : relation.reverseName;
  }
  if (relation.targetTag) return `${name} · ${atSource ? "作用于" : "来自"} tag：${relation.targetTag}`;
  if (relation.name || relation.direction && relation.direction !== "symmetric") return name;
  if (relation.type !== "title") return "普通关联";
  return relation.sourceId === Number(elementId) ? "当前文字是其标题" : "是当前内容的标题";
}

export const relationPresets = [
  { label: "相关", name: "相关", reverseName: "", direction: "symmetric" },
  { label: "相似", name: "相似", reverseName: "", direction: "symmetric" },
  { label: "提示词匹配", name: "提示词匹配", reverseName: "", direction: "symmetric" },
  { label: "参考", name: "参考了", reverseName: "被参考", direction: "forward" },
  { label: "改写", name: "改写自", reverseName: "被改写为", direction: "forward" },
  { label: "生成", name: "生成自", reverseName: "生成了", direction: "forward" },
  { label: "包含", name: "包含", reverseName: "属于", direction: "forward" },
];

export function relationSemantics(payload, { partial = false } = {}) {
  if (partial && payload.direction === undefined && payload.reverseName === undefined) return {};
  const direction = payload.direction ?? "symmetric", reverseName = relationName(payload.reverseName);
  if (!["symmetric", "forward", "reverse"].includes(direction)) throw elementError("请选择双向同名或明确的关联方向");
  if (direction === "symmetric" ? Boolean(reverseName) : !relationName(payload.name) || !reverseName) {
    throw elementError("有方向的关联需要正向和反向名称；双向同名关系不填反向名称");
  }
  return { direction, reverseName };
}

export function relationBatch(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).some((key) => !["sourceId", "targetIds", "targetTags", "name", "direction", "reverseName"].includes(key))) throw elementError("无效的批量关联");
  const sourceId = elementId(payload.sourceId);
  const name = relationName(payload.name);
  if ((payload.targetIds === undefined) === (payload.targetTags === undefined)) throw elementError("请选择内容或标签作为关联目标");
  if (payload.targetTags !== undefined) {
    const targetTags = elementTags(payload.targetTags);
    if (!targetTags.length) throw elementError("请选择至少一个标签");
    return { sourceId, name, targetTags, ...relationSemantics(payload) };
  }
  if (!Array.isArray(payload.targetIds) || !payload.targetIds.length || payload.targetIds.length > 100) throw elementError("请选择 1–100 个内容");
  const targetIds = [...new Set(payload.targetIds.map(elementId))];
  if (targetIds.includes(sourceId)) throw elementError("不能关联内容自身");
  return { sourceId, name, targetIds, ...relationSemantics(payload) };
}

export function relationName(value = "") {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) throw elementError("关系名称须为不超过 60 字的单行文字");
  const name = value.trim().normalize("NFC");
  if (name.length > 60) throw elementError("关系名称最多 60 字");
  return name;
}

export function relationUpdate(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).some((key) => !["name", "direction", "reverseName"].includes(key)) || typeof payload.name !== "string") {
    throw elementError("请提供关联名称");
  }
  return { name: relationName(payload.name), ...relationSemantics(payload, { partial: true }) };
}

export function relationBatchUpdate(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).some((key) => !["ids", "tagRelationIds", "name"].includes(key))) throw elementError("无效的批量重命名");
  const { name } = relationUpdate({ name: payload.name });
  const ids = payload.ids ?? [], tagRelationIds = payload.tagRelationIds ?? [];
  if (!Array.isArray(ids) || !Array.isArray(tagRelationIds) ||
      ids.length + tagRelationIds.length < 1 || ids.length + tagRelationIds.length > 1200 ||
      payload.ids === null || payload.tagRelationIds === null) throw elementError("每次须修改 1–1200 条关联");
  return { name, ids: [...new Set(ids.map(elementId))], tagRelationIds: [...new Set(tagRelationIds.map(elementId))] };
}

export function elementQuery(params) {
  const material = params.get("material");
  if (material !== null && !["0", "1"].includes(material)) throw elementError("无效的素材筛选");
  const q = params.get("q") || "";
  const kind = params.get("kind") || "";
  const scope = params.get("scope") || "library";
  const sort = params.get("sort") || "updated";
  if (!["updated", "usage"].includes(sort) || (sort === "usage" && kind !== "text")) throw elementError("无效的排序条件");
  const tags = elementTags(params.getAll("tag").filter(Boolean)).map((tag) => tag.toLowerCase());
  const tagMatch = params.get("tagMatch") ?? "any";
  if (!["any", "all"].includes(tagMatch)) throw elementError("无效的标签匹配方式");
  if (q.length > maxElementBody || (kind && !elementKinds.includes(kind)) || !["active", "library", "trash"].includes(scope)) {
    throw elementError("无效的筛选条件");
  }
  const page = elementId(params.get("page") || 1);
  const pageSize = elementId(params.get("pageSize") || 36);
  if (pageSize > 100 || !Number.isSafeInteger((page - 1) * pageSize)) throw elementError("无效的分页范围");
  const throughPage = params.has("throughPage") ? elementId(params.get("throughPage")) : page;
  if (throughPage < page || (throughPage - page + 1) * pageSize > 50000) throw elementError("无效的刷新范围");
  const stackSimilar = params.get("stackSimilar"), stackOf = params.get("stackOf");
  if (stackSimilar !== null && !["0", "1"].includes(stackSimilar)) throw elementError("无效的堆叠选项");
  return { q, kind, scope, tags, page, pageSize, ...(params.has("tagMatch") ? { tagMatch } : {}), ...(params.has("throughPage") ? { throughPage } : {}),
    ...(material !== null ? { material: material === "1" } : {}),
    ...(params.has("sort") ? { sort } : {}),
    ...(stackSimilar === "1" ? { stackSimilar: true } : {}), ...(stackOf !== null ? { stackOf: elementId(stackOf) } : {}) };
}
