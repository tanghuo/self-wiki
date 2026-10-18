export function migrateImageDimensions(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=38").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`ALTER TABLE element_images ADD COLUMN width INTEGER;
      ALTER TABLE element_images ADD COLUMN height INTEGER;
      INSERT INTO wiki_schema VALUES(38); COMMIT`);
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
