export function migrateVideos(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=30").get()) return;
  const foreignKeys = db.prepare("PRAGMA foreign_keys").get().foreign_keys;
  db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    // Rebuilding the referenced table requires recreating dependent views and triggers.
    const schema = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND (type IN('trigger','view') OR (type='index' AND tbl_name='elements'))").all();
    const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='elements'").get()?.seq || 0;
    for (const item of schema) db.exec(`DROP ${item.type} "${item.name.replaceAll('"', '""')}"`);
    db.exec(`
      CREATE TABLE elements_v30 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind INTEGER NOT NULL CHECK(kind IN(1,2,3,4,5)),
        body TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
        content_version INTEGER NOT NULL DEFAULT 1,
        local_only INTEGER NOT NULL DEFAULT 0 CHECK(local_only IN(0,1)),
        creation_source INTEGER NOT NULL DEFAULT 0 CHECK(creation_source IN(0,1,2)),
        CHECK((kind IN(2,5) AND body='') OR (kind IN(1,3,4) AND length(trim(body))>0))
      );
      INSERT INTO elements_v30(id,kind,body,created_at,updated_at,deleted_at,content_version,local_only,creation_source)
        SELECT id,kind,body,created_at,updated_at,deleted_at,content_version,local_only,creation_source FROM elements;
      DROP TABLE elements;
      ALTER TABLE elements_v30 RENAME TO elements;
      CREATE TABLE element_videos (
        element_id INTEGER PRIMARY KEY REFERENCES elements(id),
        storage_key TEXT NOT NULL UNIQUE,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK(byte_size>0),
        original_name TEXT NOT NULL,
        content_hash TEXT NOT NULL
      );
      CREATE INDEX idx_video_hash ON element_videos(content_hash);
    `);
    db.prepare("UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name='elements'").run(sequence);
    for (const item of schema) db.exec(item.sql);
    // Kind 4 stays reserved for retired operation records; their rejecting triggers
    // and the text/image-only AI triggers are restored unchanged above.
    db.exec("INSERT INTO wiki_schema VALUES(30)");
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Video migration foreign key check failed");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  finally { db.exec(`PRAGMA foreign_keys=${foreignKeys ? "ON" : "OFF"}`); }
}
