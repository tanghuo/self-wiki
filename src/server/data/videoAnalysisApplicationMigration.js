export function migrateVideoAnalysisApplication(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=34").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE video_analysis_runs ADD COLUMN application_pending INTEGER NOT NULL DEFAULT 0 CHECK(application_pending IN(0,1));
      UPDATE video_analysis_runs AS r SET state=0,application_pending=1,attempts=0,token=NULL,lease_until=0,
        error='等待补齐上次未完成的自动标注'
      WHERE r.state IN(2,3) AND r.auto_apply=1
        AND EXISTS(SELECT 1 FROM video_analysis_state s WHERE s.current_run_id=r.id AND s.active_run_id=r.id)
        AND NOT EXISTS(SELECT 1 FROM video_analysis_frames f WHERE f.run_id=r.id AND NOT EXISTS(
          SELECT 1 FROM video_analysis_batches b WHERE b.run_id=r.id AND b.batch_key=f.batch_key))
        AND (SELECT count(*) FROM video_markers m WHERE m.video_id=r.video_id)<500
        AND EXISTS(SELECT 1 FROM effective_video_observations o
          JOIN video_analysis_text_documents d ON d.kind=1 AND d.id=o.id
          WHERE o.run_id=r.id AND o.decision=0 AND NOT EXISTS(SELECT 1 FROM video_markers m WHERE m.observation_id=o.id)
          AND NOT EXISTS(SELECT 1 FROM video_markers m
            JOIN video_analysis_text_documents existing ON existing.kind=3 AND existing.id=m.id AND existing.concept_key=d.concept_key
            WHERE m.video_id=r.video_id AND m.origin!=1
            AND m.start_ms<=coalesce(o.end_ms,o.start_ms)+2000 AND coalesce(m.end_ms,m.start_ms)>=o.start_ms-2000
          ))
      ;
      INSERT INTO wiki_schema VALUES(34);
    `);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Video analysis application migration foreign key check failed");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
