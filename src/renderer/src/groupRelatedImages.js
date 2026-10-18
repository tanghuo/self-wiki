// Group only the loaded page; keep each relationship and its actions exactly once.
export function groupRelatedImages(relations) {
  const candidates = new Map();
  for (const relation of relations) {
    if (relation.tagRelationId || relation.element.kind !== "image") continue;
    for (const tag of new Set(relation.element.tags || [])) {
      if (!candidates.has(tag)) candidates.set(tag, []);
      candidates.get(tag).push(relation);
    }
  }
  const assigned = new Map();
  const groups = [...candidates].sort(([a, left], [b, right]) => right.length - left.length || a.localeCompare(b));
  for (const [tag, members] of groups) {
    const available = members.filter((relation) => !assigned.has(relation.id));
    if (new Set(available.map((relation) => relation.element.id)).size < 2) continue;
    const group = { tag, relations: available };
    for (const relation of available) assigned.set(relation.id, group);
  }
  const emitted = new Set();
  return relations.flatMap((relation) => {
    const group = assigned.get(relation.id);
    if (!group) return [{ relations: [relation] }];
    if (emitted.has(group)) return [];
    emitted.add(group);
    return [group];
  });
}
