// These terms describe meanings relative to each end, independently of the
// names chosen for their confirmed vocabulary aliases.
export const relationRoleTerms = [
  { name: "提示词", reverseName: "使用提示词", direction: "forward", forwardRole: "", reverseRole: "prompt" },
  { name: "生成自", reverseName: "生成了", direction: "forward", forwardRole: "generation", reverseRole: "" },
  { name: "参考资料", reverseName: "参考自", direction: "forward", forwardRole: "", reverseRole: "reference" },
  { name: "参考了", reverseName: "被参考", direction: "forward", forwardRole: "reference", reverseRole: "referencedBy" },
  { name: "改写自", reverseName: "被改写为", direction: "forward", forwardRole: "rewrite", reverseRole: "" },
  { name: "产出", reverseName: "来自会话", direction: "forward", forwardRole: "", reverseRole: "session" },
  ...["提示词匹配", "相似"].map((name) => ({ name, reverseName: "", direction: "symmetric", forwardRole: "match", reverseRole: "match" })),
  ...[["使用提示词", "prompt"], ["生成自", "generation"], ["参考自", "reference"], ["参考了", "reference"], ["改写自", "rewrite"], ["来自会话", "session"], ["被参考", "referencedBy"]]
    .map(([name, role]) => ({ name, reverseName: "", direction: "symmetric", forwardRole: role, reverseRole: role })),
];

export const sourceRelationRoles = ["prompt", "generation", "reference", "rewrite", "session"];

export function relationRole(relation, currentId, terms = relationRoleTerms) {
  if (relation.type === "title" || relation.direction === "unknown") return "";
  const directed = relation.direction === "forward" || relation.direction === "reverse";
  const atForwardEnd = !directed || (relation.sourceId === Number(currentId)) === (relation.direction === "forward");
  const roles = new Set(terms.filter((term) => term.name === relation.name
    && term.reverseName === (relation.reverseName || "") && (term.direction !== "symmetric") === directed)
    .map((term) => atForwardEnd ? term.forwardRole : term.reverseRole));
  // Aliases can join distinct concepts. Do not invent a meaning when their
  // endpoint roles disagree, or infer direction for historical unknown edges.
  return roles.size === 1 ? [...roles][0] : "";
}
