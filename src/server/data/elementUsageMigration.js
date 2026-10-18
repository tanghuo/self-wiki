export function migrateElementUsage(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=35").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE element_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        element_id INTEGER NOT NULL REFERENCES elements(id) ON DELETE CASCADE,
        action INTEGER NOT NULL CHECK(action IN (1,2)),
        occurred_at INTEGER NOT NULL
      );
      CREATE INDEX idx_element_usage_time ON element_usage_events(occurred_at,element_id,action);
      CREATE INDEX idx_element_usage_element ON element_usage_events(element_id);
      INSERT INTO wiki_schema VALUES(35);
    `);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
