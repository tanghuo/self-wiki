export function migrateChatAttachments(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=26").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE chat_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL
    );
    ALTER TABLE chat_turns ADD COLUMN input_attachments TEXT NOT NULL DEFAULT '[]';
    INSERT INTO wiki_schema VALUES(26);`);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
