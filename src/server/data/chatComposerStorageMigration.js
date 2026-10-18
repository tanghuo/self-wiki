export function migrateChatComposerStorage(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=29").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE chat_new_draft (
      id INTEGER PRIMARY KEY CHECK(id=1),
      data TEXT NOT NULL,
      revision INTEGER NOT NULL
    );
    ALTER TABLE chat_sessions ADD COLUMN draft_attachments TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE chat_sessions ADD COLUMN draft_attachments_revision INTEGER NOT NULL DEFAULT 0;
    INSERT INTO wiki_schema VALUES(29);`);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
