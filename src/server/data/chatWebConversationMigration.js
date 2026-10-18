export function migrateChatWebConversations(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=28").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE chat_web_conversations (
      session_id INTEGER PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
      branch_revision INTEGER NOT NULL,
      conversation_url TEXT NOT NULL
    ); INSERT INTO wiki_schema VALUES(28);`);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
