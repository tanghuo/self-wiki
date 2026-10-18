export function migrateVideoAnalysisConsistency(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=33").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE video_analysis_suppressions ADD COLUMN body TEXT NOT NULL DEFAULT '';
      DROP VIEW effective_video_observations;
      CREATE VIEW video_analysis_text_documents AS
        WITH raw_documents AS (
          SELECT 1 AS kind,o.id,o.body,o.revision,o.tags FROM video_analysis_observations o
          UNION ALL
          SELECT 3,m.id,m.body,m.revision,
            (SELECT json_group_array(t.name) FROM video_marker_tags mt JOIN tags t ON t.id=mt.tag_id WHERE mt.marker_id=m.id)
          FROM video_markers m WHERE m.origin!=1
          UNION ALL SELECT 4,x.id,x.body,1,x.tags FROM video_analysis_suppressions x
        ), tag_names AS (
          SELECT DISTINCT d.kind,d.id,coalesce(t.name,j.value) AS name,
            coalesce(t.normalized_name,lower(j.value)) AS normalized_name
          FROM raw_documents d JOIN json_each(d.tags) j
          LEFT JOIN tags raw ON raw.normalized_name=lower(j.value) LEFT JOIN resolved_tags t ON t.id=raw.id
        ), documents AS (
          SELECT d.kind,d.id,d.body,d.revision,
            (SELECT json_group_array(name) FROM (
              SELECT DISTINCT name FROM tag_names t WHERE t.kind=d.kind AND t.id=d.id ORDER BY name COLLATE BINARY
            )) AS tags,
            (SELECT json_group_array(normalized_name) FROM (
              SELECT DISTINCT normalized_name FROM tag_names t WHERE t.kind=d.kind AND t.id=d.id ORDER BY normalized_name COLLATE BINARY
            )) AS normalized_tags
          FROM raw_documents d
        )
        SELECT *,json_array(body,json(tags)) AS content_hash,
          json_array(trim(body),json(normalized_tags)) AS concept_key FROM documents;
      CREATE VIEW video_analysis_suppression_matches AS
        SELECT x.id AS suppression_id,o.id AS observation_id FROM video_analysis_suppressions x
        JOIN video_analysis_text_documents source ON source.kind=4 AND source.id=x.id
        JOIN video_analysis_runs r ON r.video_id=x.video_id AND r.source_hash=x.source_hash
        JOIN video_analysis_observations o ON o.run_id=r.id
        JOIN video_analysis_text_documents target ON target.kind=1 AND target.id=o.id AND target.concept_key=source.concept_key
        WHERE x.start_ms<=coalesce(o.end_ms,o.start_ms)+2000 AND x.end_ms>=o.start_ms-2000;
      CREATE VIEW effective_video_observations AS
        SELECT o.*,r.video_id FROM video_analysis_observations o
        JOIN video_analysis_runs r ON r.id=o.run_id
        JOIN video_analysis_state s ON s.active_run_id=o.run_id
        JOIN elements e ON e.id=r.video_id
        JOIN element_videos v ON v.element_id=e.id AND v.content_hash=r.source_hash
        WHERE e.deleted_at IS NULL AND o.decision IN(0,1) AND NOT EXISTS(
          SELECT 1 FROM video_analysis_suppression_matches x WHERE x.observation_id=o.id
        );
      INSERT INTO wiki_schema VALUES(33);
    `);
    for (const event of ["INSERT", "DELETE"]) db.exec(`
      CREATE TRIGGER video_analysis_alias_${event.toLowerCase()} AFTER ${event} ON tag_aliases BEGIN
        UPDATE video_analysis_observations SET decision=0,revision=revision+1 WHERE decision=1 AND id IN(
          SELECT m.observation_id FROM video_markers m JOIN video_analysis_suppression_matches x ON x.observation_id=m.observation_id
          WHERE m.origin=1
        );
        DELETE FROM video_markers WHERE origin=1 AND observation_id IN(SELECT observation_id FROM video_analysis_suppression_matches);
      END;
    `);
    // Legacy suppressions have no original description. Retain their recorded decisions,
    // but do not let an unknown identity suppress unrelated observations in future runs.
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Video analysis consistency migration foreign key check failed");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
