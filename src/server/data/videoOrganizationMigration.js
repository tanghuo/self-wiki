export function migrateVideoOrganization(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=37").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TRIGGER organization_new_video AFTER INSERT ON element_videos BEGIN
        INSERT OR IGNORE INTO organization_jobs(element_id,content_version,created_at)
          SELECT e.id,e.content_version,unixepoch()*1000 FROM elements e,organization_state s
          WHERE e.id=NEW.element_id AND e.local_only=0 AND e.deleted_at IS NULL AND s.enabled=1;
      END;
      CREATE TRIGGER organization_publish_video AFTER UPDATE OF local_only ON elements
        WHEN OLD.local_only=1 AND NEW.local_only=0 AND NEW.kind=5 AND NEW.deleted_at IS NULL BEGIN
        INSERT OR IGNORE INTO organization_jobs(element_id,content_version,created_at)
          SELECT NEW.id,NEW.content_version,unixepoch()*1000 FROM organization_state WHERE enabled=1;
      END;
    `);
    for (const event of ["INSERT", "UPDATE", "DELETE"]) {
      db.exec(`CREATE TRIGGER organization_clock_element_videos_${event} AFTER ${event} ON element_videos BEGIN
        UPDATE organization_state SET epoch=epoch+1 WHERE id=1; END;`);
    }
    db.exec("INSERT INTO wiki_schema VALUES(37); COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
