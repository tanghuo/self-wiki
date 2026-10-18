export function migrateChatEffort(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=20").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN effort TEXT NOT NULL DEFAULT ''; ALTER TABLE chat_turns ADD COLUMN effort TEXT NOT NULL DEFAULT ''; INSERT INTO wiki_schema VALUES (20)");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
