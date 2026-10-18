export function migrateChatImageOptions(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=36").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE chat_sessions ADD COLUMN image_options TEXT;
      ALTER TABLE chat_sessions ADD COLUMN image_options_revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE chat_turns ADD COLUMN image_options TEXT;
      CREATE TABLE chat_image_preferences (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE chat_image_workflows (id INTEGER PRIMARY KEY, digest TEXT NOT NULL UNIQUE, data TEXT NOT NULL, options TEXT);
      INSERT INTO wiki_schema VALUES (36);
    `);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
