export function migrateNeutralText(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version = 4").get()) return;
  const foreignKeys = db.prepare("PRAGMA foreign_keys").get().foreign_keys;
  db.exec("PRAGMA foreign_keys = OFF");
  let transaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transaction = true;
    if (db.prepare("SELECT 1 FROM wiki_schema WHERE version = 4").get()) {
      db.exec("COMMIT");
      transaction = false;
      return;
    }
    const rows = db.prepare(`SELECT e.*, i.original_name FROM elements e
      LEFT JOIN element_images i ON i.element_id = e.id ORDER BY e.id`).all();
    let nextId = Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'elements'").get()?.seq || 0);
    const relationSequence = Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'element_relations'").get()?.seq || 0);
    db.exec(`
      CREATE TABLE elements_v4 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind INTEGER NOT NULL CHECK (kind IN (1, 2)),
        body TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        CHECK ((kind = 1 AND length(trim(body)) > 0) OR (kind = 2 AND body = ''))
      );
      CREATE TABLE relations_v4 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL REFERENCES elements(id),
        target_id INTEGER NOT NULL REFERENCES elements(id),
        kind INTEGER NOT NULL CHECK (kind IN (1, 2)),
        created_at TEXT NOT NULL,
        CHECK (source_id != target_id AND (kind != 1 OR source_id < target_id)),
        UNIQUE (source_id, target_id, kind)
      );
      INSERT INTO relations_v4 (id, source_id, target_id, kind, created_at)
        SELECT id, left_id, right_id, 1, created_at FROM element_relations;
    `);
    db.prepare("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = 'relations_v4'").run(relationSequence);
    db.prepare("INSERT INTO sqlite_sequence (name, seq) SELECT 'relations_v4', ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'relations_v4')").run(relationSequence);
    const insert = db.prepare("INSERT INTO elements_v4 (id, kind, body, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)");
    for (const row of rows) {
      const body = row.kind === 1 ? (row.body.trim() ? row.body : row.title) : "";
      insert.run(row.id, row.kind, body, row.created_at, row.updated_at, row.deleted_at);
    }
    for (const row of rows) {
      if (!row.title.trim() || (row.kind === 1 ? !row.body.trim() : row.title === row.original_name)) continue;
      const titleId = ++nextId;
      insert.run(titleId, 1, row.title, row.created_at, row.updated_at, row.deleted_at);
      db.prepare("INSERT INTO relations_v4 (source_id, target_id, kind, created_at) VALUES (?, ?, 2, ?)").run(titleId, row.id, row.created_at);
    }
    db.prepare("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = 'elements_v4'").run(nextId);
    db.prepare("INSERT INTO sqlite_sequence (name, seq) SELECT 'elements_v4', ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'elements_v4')").run(nextId);
    db.exec(`
      DROP TABLE element_relations;
      DROP TABLE elements;
      ALTER TABLE elements_v4 RENAME TO elements;
      ALTER TABLE relations_v4 RENAME TO element_relations;
      CREATE INDEX idx_elements_updated ON elements(deleted_at, updated_at DESC, id DESC);
      CREATE INDEX idx_relations_target ON element_relations(target_id, source_id);
      INSERT INTO wiki_schema VALUES (4);
    `);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Neutral text migration foreign key check failed");
    db.exec("COMMIT");
    transaction = false;
  } catch (error) { if (transaction) db.exec("ROLLBACK"); throw error; }
  finally { db.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`); }
}
