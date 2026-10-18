export function migrateVideoAnalysis(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=32").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE video_analysis_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id INTEGER NOT NULL REFERENCES elements(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL, source_hash TEXT NOT NULL, config_key TEXT NOT NULL,
        state INTEGER NOT NULL DEFAULT 0 CHECK(state BETWEEN 0 AND 5),
        auto_apply INTEGER NOT NULL DEFAULT 0 CHECK(auto_apply IN(0,1)),
        token TEXT, lease_until INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER, covered_until_ms INTEGER NOT NULL DEFAULT 0,
        extraction_complete INTEGER NOT NULL DEFAULT 0 CHECK(extraction_complete IN(0,1)),
        error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(video_id,generation)
      );
      CREATE INDEX idx_video_analysis_queue ON video_analysis_runs(state,config_key,id);
      CREATE TABLE video_analysis_state (
        video_id INTEGER PRIMARY KEY REFERENCES elements(id) ON DELETE CASCADE,
        current_run_id INTEGER REFERENCES video_analysis_runs(id) ON DELETE SET NULL,
        active_run_id INTEGER REFERENCES video_analysis_runs(id) ON DELETE SET NULL
      );
      CREATE TABLE video_analysis_frames (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES video_analysis_runs(id) ON DELETE CASCADE,
        frame_key TEXT NOT NULL, timestamp_ms INTEGER NOT NULL CHECK(timestamp_ms BETWEEN 0 AND 604800000),
        shot_id TEXT NOT NULL, window_id TEXT NOT NULL, path TEXT NOT NULL, batch_key TEXT NOT NULL DEFAULT '',
        UNIQUE(run_id,frame_key)
      );
      CREATE TABLE video_analysis_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES video_analysis_runs(id) ON DELETE CASCADE,
        batch_key TEXT NOT NULL, request_hash TEXT NOT NULL, execution TEXT NOT NULL,
        raw_observations TEXT NOT NULL DEFAULT '[]', sample_interval_ms INTEGER NOT NULL DEFAULT 2000,
        created_at TEXT NOT NULL, UNIQUE(run_id,batch_key)
      );
      CREATE TABLE video_analysis_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES video_analysis_runs(id) ON DELETE CASCADE,
        batch_id INTEGER NOT NULL REFERENCES video_analysis_batches(id) ON DELETE CASCADE,
        start_ms INTEGER NOT NULL, end_ms INTEGER, shot_id TEXT NOT NULL, window_id TEXT NOT NULL,
        body TEXT NOT NULL, tags TEXT NOT NULL, frame_ids TEXT NOT NULL,
        decision INTEGER NOT NULL DEFAULT 0 CHECK(decision BETWEEN 0 AND 3),
        revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
      );
      CREATE INDEX idx_video_analysis_observation_run ON video_analysis_observations(run_id,start_ms,id);
      ALTER TABLE video_markers ADD COLUMN origin INTEGER NOT NULL DEFAULT 0 CHECK(origin IN(0,1,2));
      ALTER TABLE video_markers ADD COLUMN analysis_run_id INTEGER REFERENCES video_analysis_runs(id) ON DELETE SET NULL;
      ALTER TABLE video_markers ADD COLUMN observation_id INTEGER REFERENCES video_analysis_observations(id) ON DELETE SET NULL;
      CREATE UNIQUE INDEX idx_video_marker_observation ON video_markers(observation_id) WHERE observation_id IS NOT NULL;
      CREATE TABLE video_analysis_suppressions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id INTEGER NOT NULL REFERENCES elements(id) ON DELETE CASCADE,
        source_hash TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
        tags TEXT NOT NULL, reason INTEGER NOT NULL CHECK(reason IN(0,1)), created_at TEXT NOT NULL
      );
      CREATE INDEX idx_video_analysis_suppressions_video ON video_analysis_suppressions(video_id,start_ms);
      CREATE VIEW effective_video_observations AS
        SELECT o.*,r.video_id FROM video_analysis_observations o
        JOIN video_analysis_runs r ON r.id=o.run_id
        JOIN video_analysis_state s ON s.active_run_id=o.run_id
        JOIN elements e ON e.id=r.video_id
        JOIN element_videos v ON v.element_id=e.id AND v.content_hash=r.source_hash
        WHERE e.deleted_at IS NULL AND o.decision IN(0,1) AND NOT EXISTS(
          SELECT 1 FROM video_analysis_suppressions x
          WHERE x.video_id=r.video_id AND x.source_hash=r.source_hash
            AND x.start_ms<=coalesce(o.end_ms,o.start_ms)+2000 AND x.end_ms>=o.start_ms-2000
            AND (json_array_length(x.tags)=0 OR EXISTS(
              SELECT 1 FROM json_each(x.tags) a JOIN json_each(o.tags) b
              WHERE lower(a.value)=lower(b.value) OR
                (SELECT canonical_id FROM resolved_tags WHERE normalized_name=lower(a.value))=
                (SELECT canonical_id FROM resolved_tags WHERE normalized_name=lower(b.value))
            ))
        );
      CREATE TABLE video_analysis_vectors (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind INTEGER NOT NULL CHECK(kind IN(0,1,2,3)),
        frame_id INTEGER REFERENCES video_analysis_frames(id) ON DELETE CASCADE,
        observation_id INTEGER REFERENCES video_analysis_observations(id) ON DELETE CASCADE,
        image_id INTEGER REFERENCES elements(id) ON DELETE CASCADE,
        marker_id INTEGER REFERENCES video_markers(id) ON DELETE CASCADE,
        space_key TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, content_hash TEXT NOT NULL DEFAULT '',
        embedding BLOB NOT NULL,
        CHECK((kind=0 AND frame_id IS NOT NULL AND observation_id IS NULL AND image_id IS NULL AND marker_id IS NULL) OR
          (kind=1 AND observation_id IS NOT NULL AND frame_id IS NULL AND image_id IS NULL AND marker_id IS NULL) OR
          (kind=2 AND image_id IS NOT NULL AND frame_id IS NULL AND observation_id IS NULL AND marker_id IS NULL) OR
          (kind=3 AND marker_id IS NOT NULL AND frame_id IS NULL AND observation_id IS NULL AND image_id IS NULL))
      );
      CREATE UNIQUE INDEX idx_video_vectors_frame ON video_analysis_vectors(frame_id,space_key) WHERE kind=0;
      CREATE UNIQUE INDEX idx_video_vectors_observation ON video_analysis_vectors(observation_id,space_key) WHERE kind=1;
      CREATE UNIQUE INDEX idx_video_vectors_image ON video_analysis_vectors(image_id,space_key) WHERE kind=2;
      CREATE UNIQUE INDEX idx_video_vectors_marker ON video_analysis_vectors(marker_id,space_key) WHERE kind=3;
      CREATE TABLE video_visual_rejections (
        source_id INTEGER NOT NULL REFERENCES elements(id) ON DELETE CASCADE,
        target_id INTEGER NOT NULL REFERENCES elements(id) ON DELETE CASCADE,
        PRIMARY KEY(source_id,target_id), CHECK(source_id!=target_id)
      );
      CREATE TRIGGER video_analysis_trash AFTER UPDATE OF deleted_at ON elements
        WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
        BEGIN UPDATE video_analysis_runs SET state=5,token=NULL,lease_until=0,error='视频已移入回收站'
          WHERE video_id=NEW.id AND state IN(0,1); END;
      INSERT INTO wiki_schema VALUES(32);
    `);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Video analysis migration foreign key check failed");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
