// Explicit symmetric links join text with text, or media with media, never across them.
// Build components before filtering/pagination so a chain never splits across pages.
export function similarStacks(db, { publicOnly = false } = {}) {
  const edges = db.prepare(`SELECT r.source_id, r.target_id FROM visible_element_relations r
    JOIN elements a ON a.id=r.source_id JOIN elements b ON b.id=r.target_id
    WHERE r.kind=1 AND r.direction=0 AND r.name='相似'
      AND ((a.kind=1 AND b.kind=1) OR (a.kind IN(2,5) AND b.kind IN(2,5)))
      AND a.deleted_at IS NULL AND b.deleted_at IS NULL
      ${publicOnly ? "AND a.local_only=0 AND b.local_only=0" : ""}`).all();
  const parents = new Map();
  function root(id) {
    if (!parents.has(id)) parents.set(id, id);
    let current = id;
    while (parents.get(current) !== current) current = parents.get(current);
    while (id !== current) {
      const next = parents.get(id);
      parents.set(id, current);
      id = next;
    }
    return current;
  }
  for (const edge of edges) {
    const a = root(edge.source_id), b = root(edge.target_id);
    if (a !== b) parents.set(Math.max(a, b), Math.min(a, b));
  }
  const groups = new Map();
  for (const id of parents.keys()) {
    const key = root(id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(id);
  }
  return new Map([...groups.values()].flatMap((members) => members.map((id) => [id, members])));
}
