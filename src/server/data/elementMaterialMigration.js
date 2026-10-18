export function migrateElementMaterial(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=39").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`ALTER TABLE elements ADD COLUMN is_material INTEGER NOT NULL DEFAULT 0 CHECK(is_material IN(0,1));
      CREATE INDEX idx_elements_material ON elements(updated_at DESC,id DESC) WHERE is_material=1 AND deleted_at IS NULL;
      INSERT INTO wiki_schema VALUES(39); COMMIT`);
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
