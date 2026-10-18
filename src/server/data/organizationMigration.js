export function migrateOrganization(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version = 7").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE elements ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1;
      CREATE TABLE organization_state (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0);
      INSERT INTO organization_state(id) VALUES(1);
      CREATE TABLE organization_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        element_id INTEGER NOT NULL REFERENCES elements(id) ON DELETE CASCADE,
        content_version INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
        manual INTEGER NOT NULL DEFAULT 0, state INTEGER NOT NULL DEFAULT 0 CHECK(state BETWEEN 0 AND 4),
        attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0,
        lease_token TEXT, lease_until INTEGER, context TEXT, error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, finished_at INTEGER,
        UNIQUE(element_id, content_version, generation)
      );
      CREATE INDEX organization_pending ON organization_jobs(state, available_at, id);
      CREATE TABLE organization_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL UNIQUE REFERENCES organization_jobs(id) ON DELETE CASCADE,
        request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
        summary TEXT NOT NULL, actions TEXT NOT NULL, changes TEXT NOT NULL DEFAULT '[]',
        context TEXT NOT NULL, epoch INTEGER NOT NULL, execution TEXT NOT NULL,
        undone INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE organization_rejections (
        element_id INTEGER NOT NULL REFERENCES elements(id) ON DELETE CASCADE,
        action_key TEXT NOT NULL, PRIMARY KEY(element_id, action_key)
      );
      CREATE INDEX organization_result_epoch ON organization_results(epoch);
      CREATE TRIGGER organization_new_text AFTER INSERT ON elements WHEN NEW.kind=1 BEGIN
        INSERT OR IGNORE INTO organization_jobs(element_id,content_version,created_at)
        SELECT NEW.id,NEW.content_version,unixepoch()*1000 FROM organization_state WHERE enabled=1;
      END;
      CREATE TRIGGER organization_changed_text AFTER UPDATE OF body ON elements WHEN NEW.body != OLD.body BEGIN
        UPDATE elements SET content_version=content_version+1 WHERE id=NEW.id;
        UPDATE organization_jobs SET state=4,lease_token=NULL,error='内容已更新' WHERE element_id=NEW.id AND state IN(0,1);
        INSERT OR IGNORE INTO organization_jobs(element_id,content_version,created_at)
        SELECT NEW.id,e.content_version,unixepoch()*1000 FROM elements e,organization_state s WHERE e.id=NEW.id AND e.deleted_at IS NULL AND s.enabled=1;
      END;
      CREATE TRIGGER organization_new_image AFTER INSERT ON element_images BEGIN
        INSERT OR IGNORE INTO organization_jobs(element_id,content_version,created_at)
        SELECT NEW.element_id,e.content_version,unixepoch()*1000 FROM elements e,organization_state s WHERE e.id=NEW.element_id AND s.enabled=1;
      END;
      CREATE TRIGGER organization_trashed AFTER UPDATE OF deleted_at ON elements WHEN NEW.deleted_at IS NOT NULL BEGIN
        UPDATE organization_jobs SET state=4,lease_token=NULL,error='内容已移入回收站' WHERE element_id=NEW.id AND state IN(0,1);
      END;
    `);
    // A conservative library clock also covers changes to dynamic tag membership and all existing write paths.
    for (const table of ["elements", "element_images", "element_tags", "tags", "element_relations", "tag_relations"]) {
      for (const event of ["INSERT", "UPDATE", "DELETE"]) {
        db.exec(`CREATE TRIGGER organization_clock_${table}_${event} AFTER ${event} ON ${table} BEGIN
          UPDATE organization_state SET epoch=epoch+1 WHERE id=1; END;`);
      }
    }
    db.exec("INSERT INTO wiki_schema VALUES(7); COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
