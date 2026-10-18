export function migrateChatModels(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=11").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE chat_sessions ADD COLUMN model TEXT NOT NULL DEFAULT '';
      ALTER TABLE chat_turns ADD COLUMN model TEXT NOT NULL DEFAULT '';
      INSERT INTO wiki_schema VALUES (11);
    `);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
