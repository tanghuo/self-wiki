// Repair only untouched archive edges. Human annotations and edges without
// provenance stay intact; direction comes from receipts, never element order.
export function migrateChatReferences(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=25").get()) return;
  const candidates = db.prepare(`SELECT r.*,
    (SELECT json_extract(p.changes,'$.createdId') FROM chat_proposals p
      WHERE p.state IN(1,3) AND r.id IN (SELECT value FROM json_each(p.changes,'$.relationIds'))
        AND json_extract(p.changes,'$.createdId') IN(r.source_id,r.target_id)
        AND CASE WHEN json_extract(p.changes,'$.createdId')=r.source_id THEN r.target_id ELSE r.source_id END
          IN(SELECT value FROM json_each(p.payload,'$.sourceIds')) LIMIT 1) AS output_id
    FROM element_relations r JOIN element_provenance ep ON ep.relation_id=r.id
    WHERE r.kind=1 AND ((r.name='参考来源' AND r.direction=0 AND r.reverse_name='')
      OR (r.name='参考资料' AND abs(r.direction)=1 AND r.reverse_name='参考自'))
    ORDER BY r.name='参考来源' DESC,r.id`).all();
  for (const old of candidates) {
    if (old.name === "参考来源" && !old.output_id) continue;
    const direction = old.name === "参考资料" ? -old.direction : old.output_id === old.source_id ? 1 : -1;
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = db.prepare(`SELECT r.* FROM element_relations r JOIN element_provenance ep ON ep.relation_id=r.id WHERE r.id=?`).get(old.id);
      if (current && current.name === old.name && current.direction === old.direction && current.reverse_name === old.reverse_name) {
        const conflict = db.prepare("SELECT 1 FROM element_relations WHERE source_id=? AND target_id=? AND kind=1 AND name='参考了'").get(old.source_id, old.target_id);
        if (!conflict) {
          // Keep the proposal receipt's relation id when two archive paths
          // wrote the same reference. Its undo metadata remains valid.
          db.prepare(`DELETE FROM element_relations WHERE source_id=? AND target_id=? AND kind=1
            AND name='参考资料' AND direction=? AND reverse_name='参考自' AND id!=?
            AND id IN(SELECT relation_id FROM element_provenance)`).run(old.source_id, old.target_id, -direction, old.id);
          if (!db.prepare("UPDATE element_relations SET name='参考了',direction=?,reverse_name='被参考' WHERE id=?").run(direction, old.id).changes) {
            throw new Error("Archive reference changed during migration");
          }
        }
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  db.exec("INSERT INTO wiki_schema VALUES(25)");
}
