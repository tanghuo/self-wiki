export function migrateChatBranches(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=19").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE chat_turns ADD COLUMN parent_turn_id INTEGER REFERENCES chat_turns(id);
      ALTER TABLE chat_turns ADD COLUMN selected_child_id INTEGER REFERENCES chat_turns(id);
      ALTER TABLE chat_sessions ADD COLUMN active_turn_id INTEGER REFERENCES chat_turns(id);
      ALTER TABLE chat_sessions ADD COLUMN branch_revision INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX idx_chat_turns_parent ON chat_turns(session_id,parent_turn_id,internal);
      CREATE TABLE chat_forks (
        request_key TEXT PRIMARY KEY,
        source_turn_id INTEGER NOT NULL REFERENCES chat_turns(id),
        session_id INTEGER NOT NULL UNIQUE REFERENCES chat_sessions(id)
      );
      UPDATE chat_turns SET parent_turn_id=(SELECT max(p.id) FROM chat_turns p
        WHERE p.session_id=chat_turns.session_id AND p.id<chat_turns.id AND p.internal=0);
      UPDATE chat_turns SET selected_child_id=(SELECT min(c.id) FROM chat_turns c
        WHERE c.parent_turn_id=chat_turns.id AND c.internal=0) WHERE internal=0;
      UPDATE chat_sessions SET active_turn_id=(SELECT max(t.id) FROM chat_turns t WHERE t.session_id=chat_sessions.id AND t.internal=0);
      INSERT INTO wiki_schema VALUES (19);
    `);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
