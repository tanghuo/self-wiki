import { elementError, elementTags, relationName, relationSemantics } from "./elements.js";

export function vocabularyKind(value) {
  if (!["tag", "relation"].includes(value)) throw elementError("请选择标签或关联名称");
  return value;
}

export function vocabularyAlias(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !["kind", "alias", "canonical"].includes(k))) throw elementError("无效的别名规则");
  const kind = vocabularyKind(value.kind);
  function term(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((k) => !(kind === "tag" ? ["name"] : ["name", "reverseName", "direction"]).includes(k))) throw elementError("请填写完整的名称");
    if (kind === "tag") return { name: elementTags([input.name])[0] };
    const name = relationName(input.name);
    if (!name || !["symmetric", "forward"].includes(input.direction)) throw elementError("请填写关联名称并选择双向同名或有向名称对");
    return { name, ...relationSemantics(input) };
  }
  const alias = term(value.alias), canonical = term(value.canonical);
  if (kind === "relation" && alias.direction !== canonical.direction) throw elementError("别名与主名称必须具有相同的方向类型");
  return { kind, alias, canonical };
}
