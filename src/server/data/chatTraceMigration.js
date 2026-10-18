export function migrateChatTrace(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=21").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE chat_trace_records (
      turn_id INTEGER NOT NULL REFERENCES chat_turns(id),
      record_key TEXT NOT NULL,
      data TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      source_ids TEXT NOT NULL DEFAULT '[]',
      history_turn_ids TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY(turn_id, record_key)
    ); INSERT INTO wiki_schema VALUES (21)`);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
