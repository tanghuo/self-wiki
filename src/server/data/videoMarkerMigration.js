export function migrateVideoMarkers(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=31").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE video_markers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id INTEGER NOT NULL REFERENCES elements(id) ON DELETE CASCADE,
        start_ms INTEGER NOT NULL CHECK(start_ms BETWEEN 0 AND 604800000),
        end_ms INTEGER CHECK(end_ms > start_ms AND end_ms <= 604800000),
        body TEXT NOT NULL DEFAULT '' CHECK(length(body)<=2000),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
        request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(video_id,request_key)
      );
      CREATE INDEX idx_video_markers_time ON video_markers(video_id,start_ms,id);
      CREATE TABLE video_marker_tags (
        marker_id INTEGER NOT NULL REFERENCES video_markers(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id), PRIMARY KEY(marker_id,tag_id)
      );
      CREATE INDEX idx_video_marker_tags_tag ON video_marker_tags(tag_id,marker_id);
      CREATE TABLE video_marker_links (
        marker_id INTEGER NOT NULL REFERENCES video_markers(id) ON DELETE CASCADE,
        target_id INTEGER NOT NULL REFERENCES elements(id) ON DELETE CASCADE,
        PRIMARY KEY(marker_id,target_id)
      );
      CREATE INDEX idx_video_marker_links_target ON video_marker_links(target_id,marker_id);
      CREATE VIEW canonical_video_marker_tags AS
        SELECT DISTINCT mt.marker_id,t.canonical_id AS tag_id FROM video_marker_tags mt JOIN resolved_tags t ON t.id=mt.tag_id;
      CREATE VIEW content_tag_usage AS
        SELECT element_id,tag_id FROM element_tags UNION
        SELECT m.video_id,mt.tag_id FROM video_marker_tags mt JOIN video_markers m ON m.id=mt.marker_id;
      CREATE VIEW canonical_content_tag_usage AS
        SELECT DISTINCT u.element_id,t.canonical_id AS tag_id FROM content_tag_usage u JOIN resolved_tags t ON t.id=u.tag_id;
      CREATE TRIGGER video_marker_owner BEFORE INSERT ON video_markers
        WHEN NOT EXISTS(SELECT 1 FROM elements WHERE id=NEW.video_id AND kind=5 AND deleted_at IS NULL)
        BEGIN SELECT RAISE(ABORT,'Video marker owner must be an active video'); END;
      INSERT INTO wiki_schema VALUES(31);
    `);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Video marker migration foreign key check failed");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
