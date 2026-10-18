export function migrateChatDrafts(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=18").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE chat_sessions ADD COLUMN draft_text TEXT NOT NULL DEFAULT '';
      ALTER TABLE chat_sessions ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 0;
      INSERT INTO wiki_schema VALUES (18);
    `);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
