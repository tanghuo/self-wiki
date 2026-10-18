// Only traverse the selected turn's ancestors. IDs increase along each path,
// including copied histories; sibling branches never enter this result.
export function chatPathIds(db, sessionId, turnId) {
  if (!turnId) return [];
  return db.prepare(`WITH RECURSIVE path(id,parent_turn_id,internal) AS (
    SELECT id,parent_turn_id,internal FROM chat_turns WHERE id=? AND session_id=?
    UNION ALL SELECT t.id,t.parent_turn_id,t.internal FROM chat_turns t JOIN path p ON t.id=p.parent_turn_id
      WHERE t.session_id=? AND t.id<p.id
  ) SELECT id FROM path WHERE internal=0 ORDER BY id`).all(turnId, sessionId, sessionId).map((r) => r.id);
}
