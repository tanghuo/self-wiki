export function migrateChatModelPreference(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=22").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE chat_model_preferences (
        id INTEGER PRIMARY KEY CHECK (id=1),
        model TEXT NOT NULL,
        effort TEXT NOT NULL
      );
      INSERT INTO wiki_schema VALUES (22);
    `);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
