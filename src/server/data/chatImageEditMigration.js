export function migrateChatImageEdits(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=13").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE chat_turns ADD COLUMN image_edit TEXT; INSERT INTO wiki_schema VALUES (13);");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
