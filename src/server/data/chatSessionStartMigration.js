export function migrateChatSessionStarts(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=23").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE chat_session_starts (
        request_key TEXT PRIMARY KEY,
        session_id INTEGER NOT NULL UNIQUE REFERENCES chat_sessions(id)
      );
      INSERT INTO wiki_schema VALUES (23);
    `);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
