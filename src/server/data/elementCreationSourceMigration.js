export function migrateElementCreationSource(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=24").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`ALTER TABLE elements ADD COLUMN creation_source INTEGER NOT NULL DEFAULT 0 CHECK(creation_source IN(0,1,2));
      UPDATE elements SET creation_source=2 WHERE kind=1 AND id IN (
        SELECT json_extract(changes,'$.createdId') FROM chat_proposals WHERE state IN(1,3)
      );
      INSERT INTO wiki_schema VALUES(24);`);
    // Output bindings can reuse an imported image; they do not prove how that
    // element was first added. Unrecorded historical imports remain unknown.
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
