export function migrateElementLifecycle(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=14").get()) return;
  const foreignKeys = db.prepare("PRAGMA foreign_keys").get().foreign_keys;
  const schema = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND (type IN ('trigger','view') OR (type='index' AND tbl_name='elements'))").all();
  const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='elements'").get()?.seq || 0;
  db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    for (const item of schema) db.exec(`DROP ${item.type} "${item.name.replaceAll('"', '""')}"`);
    db.exec(`
      CREATE TABLE elements_v14 (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind INTEGER NOT NULL CHECK(kind IN(1,2,3,4)),
        body TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
        content_version INTEGER NOT NULL DEFAULT 1, local_only INTEGER NOT NULL DEFAULT 0 CHECK(local_only IN(0,1)),
        CHECK((kind=2 AND body='') OR (kind IN(1,3,4) AND length(trim(body))>0))
      );
      INSERT INTO elements_v14(id,kind,body,created_at,updated_at,deleted_at,content_version)
        SELECT id,kind,body,created_at,updated_at,deleted_at,content_version FROM elements;
      DROP TABLE elements;
      ALTER TABLE elements_v14 RENAME TO elements;
      CREATE TABLE element_records (
        element_id INTEGER PRIMARY KEY REFERENCES elements(id) ON DELETE CASCADE,
        session_id INTEGER NOT NULL, turn_id INTEGER, data TEXT NOT NULL
      );
      CREATE TABLE chat_element_bindings (
        turn_id INTEGER NOT NULL, output_key TEXT NOT NULL,
        element_id INTEGER REFERENCES elements(id) ON DELETE SET NULL,
        PRIMARY KEY(turn_id,output_key)
      );
      CREATE INDEX chat_element_owner ON chat_element_bindings(element_id);
      CREATE TABLE chat_session_elements (
        session_id INTEGER PRIMARY KEY, element_id INTEGER REFERENCES elements(id) ON DELETE SET NULL
      );
      CREATE TABLE element_provenance (
        relation_id INTEGER PRIMARY KEY REFERENCES element_relations(id) ON DELETE CASCADE
      );
      CREATE TABLE chat_file_cleanup (name TEXT PRIMARY KEY);
    `);
    db.prepare("UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name='elements'").run(sequence);
    for (const item of schema) {
      let sql = item.sql;
      if (item.name === "organization_new_text") sql = sql.replace("WHEN NEW.kind=1", "WHEN NEW.kind=1 AND NEW.local_only=0");
      if (item.name === "organization_new_image") sql = sql.replace("AND s.enabled=1", "AND s.enabled=1 AND e.local_only=0");
      if (item.name === "organization_changed_text") sql = sql.replace("WHEN NEW.body", "WHEN NEW.kind=1 AND NEW.body").replace("AND s.enabled=1", "AND s.enabled=1 AND e.local_only=0");
      if (item.name === "semantic_new_element") sql = sql.replace("ON elements BEGIN", "ON elements WHEN NEW.kind IN(1,2) AND NEW.local_only=0 BEGIN");
      db.exec(sql);
    }
    db.exec(`CREATE TRIGGER lifecycle_publish AFTER UPDATE OF local_only ON elements WHEN OLD.local_only=1 AND NEW.local_only=0 AND NEW.kind IN(1,2) BEGIN
      INSERT OR IGNORE INTO semantic_documents(element_id) VALUES(NEW.id);
      INSERT OR IGNORE INTO organization_jobs(element_id,content_version,created_at)
        SELECT NEW.id,NEW.content_version,unixepoch()*1000 FROM organization_state WHERE enabled=1;
    END;
    INSERT INTO wiki_schema VALUES(14);`);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Lifecycle migration foreign key check failed");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  finally { db.exec(`PRAGMA foreign_keys=${foreignKeys ? "ON" : "OFF"}`); }
}

// The first lifecycle schema may already be open in a running development app.
// Registering managed file copies is additive and does not rebuild its elements.
export function migrateChatFileCopies(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=15").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("CREATE TABLE IF NOT EXISTS chat_file_copies (artifact TEXT NOT NULL, path TEXT NOT NULL UNIQUE); INSERT INTO wiki_schema VALUES(15); COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
