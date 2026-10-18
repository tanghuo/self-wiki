export function migrateChatDirectImages(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=27").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`ALTER TABLE chat_turns ADD COLUMN direct_image INTEGER NOT NULL DEFAULT 0 CHECK (direct_image IN (0,1));
      INSERT INTO wiki_schema VALUES(27);`);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
