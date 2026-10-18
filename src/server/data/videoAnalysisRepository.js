import { createHash, randomUUID } from "node:crypto";
import { elementError, elementTags } from "../../shared/domain/elements.js";
import { embeddingVector } from "../../shared/domain/embedding.js";

const states = ["pending", "running", "ready", "partial", "failed", "cancelled"];
const vectorKinds = { frame: 0, observation: 1, image: 2, marker: 3 };
const vectorIds = { frame: "frame_id", observation: "observation_id", image: "image_id", marker: "marker_id" };
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Called inside the marker edit/delete transaction. Original observations remain an audit record.
export function suppressVideoObservation(db, observationId, reason = 0) {
  if (!observationId) return;
  const row = db.prepare(`SELECT o.*,r.video_id,r.source_hash FROM video_analysis_observations o
    JOIN video_analysis_runs r ON r.id=o.run_id WHERE o.id=?`).get(observationId);
  if (!row || row.decision >= 2) return;
  recordSuppression(db, row, observationId, reason);
}

export function suppressCorrectedVideoMarker(db, markerId, reason = 0) {
  const row = db.prepare(`SELECT m.video_id,v.content_hash AS source_hash,m.start_ms,m.end_ms,m.body,
    (SELECT json_group_array(t.name) FROM canonical_video_marker_tags mt JOIN tags t ON t.id=mt.tag_id WHERE mt.marker_id=m.id) AS tags,
    m.observation_id FROM video_markers m JOIN element_videos v ON v.element_id=m.video_id WHERE m.id=? AND m.origin=2`).get(markerId);
  if (row) recordSuppression(db, row, row.observation_id, reason);
}

function recordSuppression(db, row, observationId, reason) {
  const suppression = db.prepare(`INSERT INTO video_analysis_suppressions(video_id,source_hash,start_ms,end_ms,tags,body,reason,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(row.video_id, row.source_hash, row.start_ms, row.end_ms ?? row.start_ms, row.tags, row.body, reason, new Date().toISOString());
  db.prepare(`UPDATE video_analysis_observations AS o SET decision=?,revision=revision+1 WHERE decision IN(0,1)
    AND (o.id=? OR o.id IN(SELECT observation_id FROM video_analysis_suppression_matches WHERE suppression_id=?))`)
    .run(reason ? 3 : 2, observationId ?? 0, Number(suppression.lastInsertRowid));
  db.prepare(`DELETE FROM video_markers WHERE origin=1 AND observation_id!=? AND observation_id IN(
    SELECT o.id FROM video_analysis_observations o JOIN video_analysis_runs r ON r.id=o.run_id
    WHERE r.video_id=? AND o.decision IN(2,3))`).run(observationId ?? 0, row.video_id);
}

export function createVideoAnalysisRepository(db, { wiki }) {
  function transaction(work) {
    if (db.isTransaction) return work();
    db.exec("BEGIN IMMEDIATE");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function video(id) {
    if (wiki.get(id).kind !== "video") throw elementError("只有视频可以分析");
    return db.prepare("SELECT * FROM element_videos WHERE element_id=?").get(id);
  }
  function presentRun(row) {
    if (!row) return null;
    const counts = db.prepare(`SELECT (SELECT count(*) FROM video_analysis_frames WHERE run_id=?) AS frames,
      (SELECT count(*) FROM video_analysis_batches WHERE run_id=?) AS batches,
      (SELECT count(*) FROM video_analysis_observations WHERE run_id=?) AS observations`).get(row.id, row.id, row.id);
    const batches = allBatches(row.id);
    const completed = new Set(db.prepare("SELECT batch_key FROM video_analysis_batches WHERE run_id=?").all(row.id).map((batch) => batch.batch_key));
    const pending = batches.filter((batch) => !completed.has(batch.key));
    const nextTime = pending.length ? Math.min(...pending.flatMap((batch) => batch.frames.map((frame) => frame.timestampMs))) : Infinity;
    const completedTimes = batches.filter((batch) => completed.has(batch.key)).flatMap((batch) => batch.frames.map((frame) => frame.timestampMs)).filter((time) => time <= nextTime);
    const analyzedUntilMs = pending.length ? Math.max(0, ...completedTimes) : counts.batches ? row.covered_until_ms : 0;
    return { id: row.id, videoId: row.video_id, generation: row.generation, sourceHash: row.source_hash,
      configKey: row.config_key, status: states[row.state], token: row.token, attempts: row.attempts,
      durationMs: row.duration_ms, coveredUntilMs: row.covered_until_ms, extractionComplete: Boolean(row.extraction_complete),
      auto: Boolean(row.auto_apply), applicationPending: Boolean(row.application_pending), error: row.error, createdAt: row.created_at, updatedAt: row.updated_at,
      completedBatches: counts.batches, totalBatches: batches.length, analyzedUntilMs, ...counts };
  }
  function leased(id, token) {
    const row = db.prepare(`SELECT r.* FROM video_analysis_runs r JOIN video_analysis_state s ON s.current_run_id=r.id
      JOIN elements e ON e.id=r.video_id JOIN element_videos v ON v.element_id=e.id
      WHERE r.id=? AND r.token=? AND r.state=1 AND r.lease_until>? AND e.deleted_at IS NULL AND v.content_hash=r.source_hash`)
      .get(id, token, Date.now());
    if (!row) throw elementError("视频分析任务已取消、过期或被替换", 409);
    return row;
  }
  function presentFrame(row) {
    return { id: row.id, key: row.frame_key, runId: row.run_id, videoId: row.video_id,
      timestampMs: row.timestamp_ms, shotId: row.shot_id, windowId: row.window_id, path: row.path };
  }
  function runFrames(id) {
    return db.prepare(`SELECT f.*,r.video_id FROM video_analysis_frames f JOIN video_analysis_runs r ON r.id=f.run_id
      WHERE f.run_id=? ORDER BY timestamp_ms,f.id`).all(id).map(presentFrame);
  }
  function allBatches(id) {
    const rows = db.prepare(`SELECT f.*,r.video_id FROM video_analysis_frames f JOIN video_analysis_runs r ON r.id=f.run_id
      WHERE f.run_id=? ORDER BY f.id`).all(id), groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.batch_key)) groups.set(row.batch_key, []);
      groups.get(row.batch_key).push(presentFrame(row));
    }
    return [...groups].map(([key, frames]) => ({ key, frames }));
  }
  function canonicalTags(tags) {
    return [...new Set(tags.map((name) => wiki.vocabulary.tag(name)?.name || name))];
  }
  function mergeBatchObservations(observations, batchFrames, sampleIntervalMs) {
    const groups = new Map();
    for (const observation of observations) {
      const first = observation.frames[0], tags = canonicalTags(observation.tags);
      const key = JSON.stringify([observation.body, tags.map((tag) => tag.toLowerCase()).sort(), first.shotId, first.windowId]);
      if (!groups.has(key)) groups.set(key, { body: observation.body, tags, frames: new Map() });
      for (const frame of observation.frames) groups.get(key).frames.set(frame.id, frame);
    }
    const merged = [];
    for (const [, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
      const frames = [...group.frames.values()].sort((left, right) => left.timestampMs - right.timestampMs || left.id - right.id);
      const first = frames[0];
      const positions = new Map(batchFrames.filter((frame) => frame.shotId === first.shotId && frame.windowId === first.windowId)
        .sort((left, right) => left.timestampMs - right.timestampMs || left.id - right.id).map((frame, index) => [frame.id, index]));
      let segment;
      for (const frame of frames) {
        const previous = segment?.frames.at(-1);
        // Only merge neighboring sampled evidence. Missing label evidence or a decode gap splits the span.
        if (!previous || positions.get(frame.id) !== positions.get(previous.id) + 1 || frame.timestampMs - previous.timestampMs > sampleIntervalMs + 250) {
          segment = { body: group.body, tags: group.tags, frames: [] }; merged.push(segment);
        }
        segment.frames.push(frame);
      }
    }
    return merged.sort((left, right) => left.frames[0].timestampMs - right.frames[0].timestampMs);
  }
  function presentObservation(row) {
    const marker = db.prepare("SELECT id,origin FROM video_markers WHERE observation_id=?").get(row.id);
    return { id: row.id, runId: row.run_id, videoId: row.video_id, startMs: row.start_ms, endMs: row.end_ms,
      shotId: row.shot_id, windowId: row.window_id, body: row.body, tags: canonicalTags(JSON.parse(row.tags)),
      frameIds: JSON.parse(row.frame_ids), revision: row.revision, status: ["suggested", "accepted", "rejected", "corrected"][row.decision],
      markerId: marker?.id ?? null, approximate: row.end_ms !== null, createdAt: row.created_at,
      contentHash: db.prepare("SELECT content_hash FROM video_analysis_text_documents WHERE kind=1 AND id=?").get(row.id).content_hash };
  }
  function presentManualMarker(row) {
    const marker = wiki.markers.get(row.id);
    return { ...marker, markerId: marker.id, observationId: null, source: "marker", frameIds: [], status: "manual", approximate: false,
      contentHash: db.prepare("SELECT content_hash FROM video_analysis_text_documents WHERE kind=3 AND id=?").get(marker.id).content_hash };
  }
  function effective(id) {
    const row = db.prepare("SELECT * FROM effective_video_observations WHERE id=?").get(id);
    if (!row) throw elementError("分析结果已失效、被纠正或已拒绝", 409);
    video(row.video_id);
    return row;
  }
  function applyObservation(id) {
    const row = effective(id), content = presentObservation(row);
    if (content.markerId) return content;
    const manual = db.prepare(`SELECT m.id FROM video_markers m
      JOIN video_analysis_text_documents existing ON existing.kind=3 AND existing.id=m.id
      JOIN video_analysis_text_documents incoming ON incoming.kind=1 AND incoming.id=? AND incoming.concept_key=existing.concept_key
      WHERE m.video_id=? AND m.origin!=1
      AND m.start_ms<=? AND coalesce(m.end_ms,m.start_ms)>=?
      LIMIT 1`).get(id, row.video_id, (row.end_ms ?? row.start_ms) + 2000, row.start_ms - 2000);
    if (manual) return { ...content, applied: false, reason: "manual-overlap", existingMarkerId: manual.id };
    if (db.prepare("SELECT count(*) AS n FROM video_markers WHERE video_id=?").get(row.video_id).n >= 500) {
      return { ...content, applied: false, reason: "marker-limit" };
    }
    const marker = wiki.markers.create(row.video_id, { startMs: row.start_ms, endMs: row.end_ms,
      body: row.body, tags: content.tags, targetIds: [], requestKey: `video-analysis-${id}` });
    db.prepare("UPDATE video_markers SET origin=1,analysis_run_id=?,observation_id=? WHERE id=?").run(row.run_id, id, marker.id);
    db.prepare("UPDATE video_analysis_observations SET decision=1,revision=revision+1 WHERE id=? AND decision=0").run(id);
    return { ...presentObservation(effective(id)), applied: true };
  }
  function vectorSelect(kind) {
    if (kind === "text") return `SELECT x.embedding,o.video_id AS elementId,NULL AS frameId,o.id AS observationId,NULL AS markerId,
      o.start_ms AS startMs,o.end_ms AS endMs,o.body,'video' AS kind,o.revision,x.content_hash AS contentHash
      FROM video_analysis_vectors x JOIN effective_video_observations o ON o.id=x.observation_id
      JOIN video_analysis_text_documents d ON d.kind=1 AND d.id=o.id AND d.content_hash=x.content_hash
      WHERE x.kind=1 AND x.space_key=? AND x.revision=o.revision
      UNION ALL SELECT x.embedding,m.video_id,NULL,NULL,m.id,m.start_ms,m.end_ms,m.body,'video',m.revision,x.content_hash
      FROM video_analysis_vectors x JOIN video_markers m ON m.id=x.marker_id JOIN elements e ON e.id=m.video_id
      JOIN video_analysis_text_documents d ON d.kind=3 AND d.id=m.id AND d.content_hash=x.content_hash
      WHERE x.kind=3 AND x.space_key=? AND x.revision=m.revision AND m.origin!=1 AND e.deleted_at IS NULL`;
    return `SELECT x.embedding,r.video_id AS elementId,f.id AS frameId,NULL AS observationId,NULL AS markerId,
      f.timestamp_ms AS startMs,NULL AS endMs,'' AS body,'video' AS kind,NULL AS revision,r.source_hash AS contentHash
      FROM video_analysis_vectors x JOIN video_analysis_frames f ON f.id=x.frame_id
      JOIN video_analysis_runs r ON r.id=f.run_id JOIN video_analysis_state s ON s.active_run_id=r.id
      JOIN elements e ON e.id=r.video_id JOIN element_videos v ON v.element_id=e.id AND v.content_hash=r.source_hash
      WHERE x.kind=0 AND x.space_key=? AND e.deleted_at IS NULL
      UNION ALL SELECT x.embedding,e.id,NULL,NULL,NULL,NULL,NULL,e.body,'image',NULL,x.content_hash
      FROM video_analysis_vectors x JOIN elements e ON e.id=x.image_id JOIN element_images i ON i.element_id=e.id
      WHERE x.kind=2 AND x.space_key=? AND e.deleted_at IS NULL AND i.content_hash=x.content_hash`;
  }
  const repository = {
    available() { try { db.prepare("SELECT vec_version()").get(); return true; } catch { return false; } },
    initialize(configKey) {
      return transaction(() => {
        db.prepare("UPDATE video_analysis_runs SET state=5,token=NULL,lease_until=0,error='分析配置已更改' WHERE state IN(0,1) AND config_key!=?").run(configKey);
        return db.prepare("UPDATE video_analysis_runs SET state=CASE WHEN attempts<3 THEN 0 ELSE 4 END,token=NULL,lease_until=0,error='上次分析中断' WHERE state=1 AND config_key=?").run(configKey).changes;
      });
    },
    pendingVideos(configKey, limit = 8) {
      return db.prepare(`SELECT e.id FROM elements e JOIN element_videos v ON v.element_id=e.id
        WHERE e.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM video_analysis_runs r
          WHERE r.video_id=e.id AND r.config_key=? AND r.source_hash=v.content_hash) ORDER BY e.id LIMIT ?`)
        .all(configKey, limit).map((row) => row.id);
    },
    enqueue(videoId, { restart = false, configKey, auto = false }) {
      return transaction(() => {
        const source = video(videoId);
        const previous = db.prepare(`SELECT r.* FROM video_analysis_state s JOIN video_analysis_runs r ON r.id=s.current_run_id WHERE s.video_id=?`).get(videoId);
        if (!restart && previous?.config_key === configKey && previous.source_hash === source.content_hash) {
          if ([0, 1, 2].includes(previous.state)) return presentRun(previous);
          db.prepare("UPDATE video_analysis_runs SET state=0,token=NULL,lease_until=0,attempts=0,error='',auto_apply=?,updated_at=? WHERE id=?")
            .run(Number(auto), new Date().toISOString(), previous.id);
          return presentRun(db.prepare("SELECT * FROM video_analysis_runs WHERE id=?").get(previous.id));
        }
        db.prepare("UPDATE video_analysis_runs SET state=5,token=NULL,lease_until=0 WHERE video_id=? AND state IN(0,1)").run(videoId);
        const generation = db.prepare("SELECT coalesce(max(generation),0)+1 AS n FROM video_analysis_runs WHERE video_id=?").get(videoId).n;
        const now = new Date().toISOString();
        const id = Number(db.prepare(`INSERT INTO video_analysis_runs(video_id,generation,source_hash,config_key,auto_apply,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?)`).run(videoId, generation, source.content_hash, configKey, Number(auto), now, now).lastInsertRowid);
        db.prepare(`INSERT INTO video_analysis_state(video_id,current_run_id) VALUES(?,?)
          ON CONFLICT(video_id) DO UPDATE SET current_run_id=excluded.current_run_id`).run(videoId, id);
        return presentRun(db.prepare("SELECT * FROM video_analysis_runs WHERE id=?").get(id));
      });
    },
    claim(configKey) {
      return transaction(() => {
        db.prepare("UPDATE video_analysis_runs SET state=4,token=NULL,lease_until=0,error='分析连续中断，请手动重试' WHERE state=1 AND lease_until<=? AND attempts>=3")
          .run(Date.now());
        const row = db.prepare(`SELECT r.* FROM video_analysis_runs r JOIN video_analysis_state s ON s.current_run_id=r.id
          JOIN elements e ON e.id=r.video_id JOIN element_videos v ON v.element_id=e.id AND v.content_hash=r.source_hash
          WHERE r.config_key=? AND (r.state=0 OR (r.state=1 AND r.lease_until<=?)) AND e.deleted_at IS NULL ORDER BY r.id LIMIT 1`)
          .get(configKey, Date.now());
        if (!row) return null;
        const token = randomUUID();
        if (!db.prepare("UPDATE video_analysis_runs SET state=1,token=?,lease_until=?,attempts=attempts+1,error='',updated_at=? WHERE id=? AND (state=0 OR lease_until<=?)")
          .run(token, Date.now() + 90000, new Date().toISOString(), row.id, Date.now()).changes) return null;
        return presentRun(db.prepare("SELECT * FROM video_analysis_runs WHERE id=?").get(row.id));
      });
    },
    heartbeat(id, token) { leased(id, token); return Boolean(db.prepare("UPDATE video_analysis_runs SET lease_until=? WHERE id=? AND token=?").run(Date.now() + 90000, id, token).changes); },
    saveExtraction(id, token, { durationMs, frames, coveredUntilMs, complete }) {
      if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 604800000 || !Number.isSafeInteger(coveredUntilMs) || coveredUntilMs < 0 || coveredUntilMs > durationMs || (complete && coveredUntilMs !== durationMs) || !Array.isArray(frames) || frames.length > 2048) throw elementError("视频抽帧结果无效");
      for (const frame of frames) {
        if (typeof frame.key !== "string" || !frame.key || !Number.isSafeInteger(frame.timestampMs) || frame.timestampMs < 0 || frame.timestampMs > durationMs || typeof frame.path !== "string" || !frame.path || frame.shotId === undefined || frame.windowId === undefined) throw elementError("视频抽帧证据无效");
      }
      return transaction(() => {
        const run = leased(id, token);
        if (coveredUntilMs < run.covered_until_ms) throw elementError("抽帧覆盖不能倒退", 409);
        const insert = db.prepare("INSERT INTO video_analysis_frames(run_id,frame_key,timestamp_ms,shot_id,window_id,path) VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,frame_key) DO NOTHING"), added = [];
        for (const frame of frames) {
          const prior = db.prepare("SELECT * FROM video_analysis_frames WHERE run_id=? AND frame_key=?").get(id, frame.key);
          if (prior && (prior.timestamp_ms !== frame.timestampMs || prior.path !== frame.path || prior.shot_id !== String(frame.shotId) || prior.window_id !== String(frame.windowId))) throw elementError("重复帧标识的内容发生变化", 409);
          const saved = insert.run(id, frame.key, frame.timestampMs, String(frame.shotId), String(frame.windowId), frame.path);
          if (saved.changes) added.push(Number(saved.lastInsertRowid));
        }
        for (let start = 0; start < added.length; start += 8) {
          const ids = added.slice(start, start + 8), key = hash(ids);
          db.prepare("UPDATE video_analysis_frames SET batch_key=? WHERE id IN(SELECT value FROM json_each(?))").run(key, JSON.stringify(ids));
        }
        db.prepare("UPDATE video_analysis_runs SET duration_ms=?,covered_until_ms=?,extraction_complete=?,updated_at=? WHERE id=? AND token=?")
          .run(durationMs, coveredUntilMs, Number(Boolean(complete)), new Date().toISOString(), id, token);
        return runFrames(id);
      });
    },
    batches(id, token) {
      leased(id, token);
      const completed = new Set(db.prepare("SELECT batch_key FROM video_analysis_batches WHERE run_id=?").all(id).map((row) => row.batch_key));
      return allBatches(id).filter((batch) => !completed.has(batch.key));
    },
    completeBatch(id, token, { batchKey, observations, execution, frameIntervalMs = 2000 }, auto) {
      if (!Array.isArray(observations) || observations.length > 32) throw elementError("视频分析结果数量无效");
      if (!Number.isSafeInteger(frameIntervalMs) || frameIntervalMs < 250 || frameIntervalMs > 30000) throw elementError("视频采样间隔无效");
      const requestHash = hash(observations);
      return transaction(() => {
        leased(id, token);
        const prior = db.prepare("SELECT * FROM video_analysis_batches WHERE run_id=? AND batch_key=?").get(id, batchKey);
        if (prior) {
          if (prior.request_hash !== requestHash) throw elementError("分析批次已提交不同结果", 409);
          return db.prepare("SELECT o.*,r.video_id FROM video_analysis_observations o JOIN video_analysis_runs r ON r.id=o.run_id WHERE batch_id=?").all(prior.id).map(presentObservation);
        }
        const batch = allBatches(id).find((item) => item.key === batchKey);
        if (!batch) throw elementError("分析批次证据已改变", 409);
        const frameMap = new Map(batch.frames.map((frame) => [frame.id, frame]));
        const normalized = observations.flatMap((observation) => {
          if (!Array.isArray(observation.frameIds) || !observation.frameIds.length || observation.frameIds.length > 8 || observation.frameIds.some((frameId) => !frameMap.has(frameId)) || typeof observation.body !== "string" || observation.body.length > 2000) throw elementError("分析结果引用了无效帧或说明");
          const tags = elementTags(observation.tags);
          if (!observation.body.trim() && !tags.length) throw elementError("分析观察须包含说明或标签");
          const groups = new Map();
          for (const frameId of new Set(observation.frameIds)) {
            const frame = frameMap.get(frameId), group = `${frame.shotId}:${frame.windowId}`;
            if (!groups.has(group)) groups.set(group, []);
            groups.get(group).push(frame);
          }
          return [...groups.values()].map((frames) => {
            frames.sort((a, b) => a.timestampMs - b.timestampMs);
            return { frames, tags, body: observation.body.trim() };
          });
        });
        const now = new Date().toISOString();
        const batchId = Number(db.prepare("INSERT INTO video_analysis_batches(run_id,batch_key,request_hash,execution,raw_observations,sample_interval_ms,created_at) VALUES(?,?,?,?,?,?,?)")
          .run(id, batchKey, requestHash, JSON.stringify(execution ?? {}), JSON.stringify(observations), frameIntervalMs, now).lastInsertRowid);
        const insert = db.prepare(`INSERT INTO video_analysis_observations(run_id,batch_id,start_ms,end_ms,shot_id,window_id,body,tags,frame_ids,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);
        for (const item of mergeBatchObservations(normalized, batch.frames, frameIntervalMs)) {
          const first = item.frames[0], end = item.frames.at(-1).timestampMs;
          insert.run(id, batchId, first.timestampMs, end > first.timestampMs ? end : null, first.shotId, first.windowId,
            item.body, JSON.stringify(item.tags), JSON.stringify(item.frames.map((frame) => frame.id)), now);
        }
        if (auto !== undefined) db.prepare("UPDATE video_analysis_runs SET auto_apply=? WHERE id=?").run(Number(Boolean(auto)), id);
        return db.prepare("SELECT o.*,r.video_id FROM video_analysis_observations o JOIN video_analysis_runs r ON r.id=o.run_id WHERE batch_id=?").all(batchId).map(presentObservation);
      });
    },
    finish(id, token) {
      transaction(() => {
        const row = leased(id, token);
        if (row.application_pending) return;
        if (!runFrames(id).length) throw elementError("视频分析没有可用帧", 409);
        if (repository.batches(id, token).length) throw elementError("尚有视频帧批次未完成", 409);
        db.prepare("DELETE FROM video_markers WHERE video_id=? AND origin=1 AND analysis_run_id!=?").run(row.video_id, id);
        if (!db.prepare("UPDATE video_analysis_state SET active_run_id=? WHERE video_id=? AND current_run_id=?").run(id, row.video_id, id).changes) {
          throw elementError("视频分析任务已被替换", 409);
        }
        if (!db.prepare("UPDATE video_analysis_runs SET application_pending=1,updated_at=? WHERE id=? AND token=? AND state=1")
          .run(new Date().toISOString(), id, token).changes) throw elementError("视频分析任务已被替换", 409);
      });
      const run = leased(id, token);
      // Applying each editable marker is a small consistency boundary; un-applied observations stay searchable.
      if (run.auto_apply) {
        const ids = db.prepare("SELECT id FROM effective_video_observations WHERE run_id=? AND decision=0 ORDER BY start_ms,id").all(id);
        for (const item of ids) {
          const applied = transaction(() => { leased(id, token); return applyObservation(item.id); });
          if (applied.reason === "marker-limit") break;
        }
      }
      return transaction(() => {
        leased(id, token);
        if (!db.prepare("UPDATE video_analysis_runs SET state=?,application_pending=0,token=NULL,lease_until=0,error='',updated_at=? WHERE id=? AND token=? AND state=1")
          .run(run.extraction_complete ? 2 : 3, new Date().toISOString(), id, token).changes) throw elementError("视频分析任务已被替换", 409);
        return presentRun(db.prepare("SELECT * FROM video_analysis_runs WHERE id=?").get(id));
      });
    },
    fail(id, token, error) {
      try { leased(id, token); } catch { return false; }
      return Boolean(db.prepare("UPDATE video_analysis_runs SET state=4,token=NULL,lease_until=0,error=?,updated_at=? WHERE id=? AND token=?")
        .run(String(error?.message || error).slice(0, 1000), new Date().toISOString(), id, token).changes);
    },
    pause(id, token) {
      leased(id, token);
      if (!db.prepare("UPDATE video_analysis_runs SET state=3,token=NULL,lease_until=0,error='本次分析达到批次预算，可继续分析',updated_at=? WHERE id=? AND token=?")
        .run(new Date().toISOString(), id, token).changes) throw elementError("视频分析任务已被替换", 409);
      return presentRun(db.prepare("SELECT * FROM video_analysis_runs WHERE id=?").get(id));
    },
    suspend(id, token) {
      try { leased(id, token); } catch { return false; }
      return Boolean(db.prepare("UPDATE video_analysis_runs SET state=0,token=NULL,lease_until=0,error='等待继续分析',updated_at=? WHERE id=? AND token=?")
        .run(new Date().toISOString(), id, token).changes);
    },
    cancel(videoId) {
      video(videoId);
      db.prepare("UPDATE video_analysis_runs SET state=5,token=NULL,lease_until=0,error='已取消',updated_at=? WHERE video_id=? AND state IN(0,1)")
        .run(new Date().toISOString(), videoId);
      return repository.status(videoId);
    },
    status(videoId) {
      if (videoId !== undefined) {
        video(videoId);
        const state = db.prepare("SELECT * FROM video_analysis_state WHERE video_id=?").get(videoId);
        return { run: presentRun(db.prepare("SELECT * FROM video_analysis_runs WHERE id=?").get(state?.current_run_id ?? 0)),
          activeRun: presentRun(db.prepare("SELECT * FROM video_analysis_runs WHERE id=?").get(state?.active_run_id ?? 0)) };
      }
      const counts = Object.fromEntries(states.map((state) => [state, 0]));
      for (const row of db.prepare(`SELECT r.state,count(*) AS n FROM video_analysis_runs r JOIN video_analysis_state s ON s.current_run_id=r.id
        JOIN elements e ON e.id=r.video_id WHERE e.deleted_at IS NULL GROUP BY r.state`).all()) counts[states[row.state]] = row.n;
      const runs = db.prepare(`SELECT r.* FROM video_analysis_runs r JOIN video_analysis_state s ON s.current_run_id=r.id
        JOIN elements e ON e.id=r.video_id WHERE e.deleted_at IS NULL ORDER BY r.id DESC LIMIT 20`).all().map(presentRun);
      return { counts, runs };
    },
    results(videoId) {
      video(videoId);
      return { ...repository.status(videoId), observations: db.prepare("SELECT * FROM effective_video_observations WHERE video_id=? ORDER BY start_ms,id").all(videoId).map(presentObservation) };
    },
    history(videoId) {
      video(videoId);
      return db.prepare(`SELECT o.*,r.video_id,
        (SELECT max(2+x.reason) FROM video_analysis_suppression_matches sm
          JOIN video_analysis_suppressions x ON x.id=sm.suppression_id WHERE sm.observation_id=o.id) AS suppression_decision
        FROM video_analysis_observations o JOIN video_analysis_runs r ON r.id=o.run_id
        JOIN video_analysis_state s ON s.active_run_id=r.id
        JOIN element_videos v ON v.element_id=r.video_id AND v.content_hash=r.source_hash
        WHERE r.video_id=? ORDER BY o.start_ms,o.id`).all(videoId)
        .map((row) => presentObservation({ ...row, decision: row.decision >= 2 ? row.decision : row.suppression_decision ?? row.decision }));
    },
    accept(id, { revision } = {}) {
      return transaction(() => {
        const row = effective(id);
        if (row.revision !== revision) throw elementError("分析结果已变化，请刷新后重试", 409);
        return applyObservation(id);
      });
    },
    reject(id, { revision } = {}) {
      return transaction(() => {
        const row = effective(id);
        if (row.revision !== revision) throw elementError("分析结果已变化，请刷新后重试", 409);
        suppressVideoObservation(db, id);
        db.prepare("DELETE FROM video_markers WHERE observation_id=? AND origin=1").run(id);
        return { id, revision: revision + 1, status: "rejected" };
      });
    },
    search(query, { limit = 30, excludeId = 0, excludedIds = [], perVideo = 3 } = {}) {
      if (typeof query !== "string" || !query.trim()) return [];
      const value = `%${query.trim().replace(/[\\%_]/g, "\\$&")}%`;
      const hits = db.prepare(`WITH candidates AS (
        SELECT 1 AS source,o.id,o.video_id,o.start_ms FROM effective_video_observations o WHERE o.body LIKE ? ESCAPE '\\'
        OR EXISTS(SELECT 1 FROM json_each(o.tags) t WHERE t.value LIKE ? ESCAPE '\\')
        OR EXISTS(SELECT 1 FROM json_each(o.tags) t JOIN tags raw ON raw.normalized_name=lower(t.value)
          JOIN resolved_tags actual ON actual.id=raw.id JOIN resolved_tags alias ON alias.canonical_id=actual.canonical_id
          JOIN tags name ON name.id=alias.id WHERE name.name LIKE ? ESCAPE '\\')
        UNION ALL
        SELECT 0,m.id,m.video_id,m.start_ms FROM video_markers m JOIN elements e ON e.id=m.video_id
        WHERE m.origin!=1 AND e.deleted_at IS NULL AND (m.body LIKE ? ESCAPE '\\' OR EXISTS(
          SELECT 1 FROM video_marker_tags mt JOIN resolved_tags actual ON actual.id=mt.tag_id
          JOIN resolved_tags alias ON alias.canonical_id=actual.canonical_id JOIN tags name ON name.id=alias.id
          WHERE mt.marker_id=m.id AND name.name LIKE ? ESCAPE '\\'))
      ), ranked AS (
        SELECT *,row_number() OVER(PARTITION BY video_id ORDER BY source,start_ms,id) AS rank
        FROM candidates WHERE video_id!=? AND video_id NOT IN(SELECT value FROM json_each(?))
      ) SELECT * FROM ranked WHERE rank<=? ORDER BY source,video_id,start_ms,id LIMIT ?`)
        .all(value, value, value, value, value, excludeId, JSON.stringify(excludedIds), perVideo, limit);
      return hits.map((hit) => hit.source === 0 ? presentManualMarker(hit) : presentObservation(effective(hit.id)));
    },
    frame(id) {
      const row = db.prepare(`SELECT f.*,r.video_id FROM video_analysis_frames f JOIN video_analysis_runs r ON r.id=f.run_id
        JOIN video_analysis_state s ON (s.active_run_id=r.id OR s.current_run_id=r.id)
        JOIN elements e ON e.id=r.video_id JOIN element_videos v ON v.element_id=e.id AND v.content_hash=r.source_hash
        WHERE f.id=? AND e.deleted_at IS NULL`).get(id);
      if (!row) throw elementError("视频帧不存在或已失效", 404);
      video(row.video_id); return presentFrame(row);
    },
    frames(videoId, limit = 8) {
      const source = video(videoId);
      const state = db.prepare("SELECT * FROM video_analysis_state WHERE video_id=?").get(videoId);
      const runId = state?.active_run_id ?? state?.current_run_id ?? 0;
      if (!db.prepare("SELECT 1 FROM video_analysis_runs WHERE id=? AND source_hash=?").get(runId, source.content_hash)) return [];
      const frames = runFrames(runId);
      const count = Math.max(1, Math.min(16, Math.trunc(limit)));
      if (frames.length <= count) return frames;
      if (count === 1) return [frames[Math.floor(frames.length / 2)]];
      const first = frames[0].timestampMs, span = frames.at(-1).timestampMs - first;
      const picked = Array.from({ length: count }, (_, index) => {
        const target = first + index * span / (count - 1);
        return frames.reduce((nearest, frame) => Math.abs(frame.timestampMs - target) < Math.abs(nearest.timestampMs - target) ? frame : nearest);
      });
      return [...new Map(picked.map((frame) => [frame.id, frame])).values()];
    },
    pendingVisualImages(space, limit = 8, excludedIds = []) {
      return db.prepare(`SELECT i.element_id AS id,i.element_id AS elementId,i.storage_key AS storageKey,i.content_hash AS contentHash
        FROM element_images i JOIN elements e ON e.id=i.element_id WHERE e.deleted_at IS NULL AND NOT EXISTS(
          SELECT 1 FROM video_analysis_vectors v WHERE v.kind=2 AND v.image_id=e.id AND v.space_key=? AND v.content_hash=i.content_hash)
          AND e.id NOT IN(SELECT value FROM json_each(?)) ORDER BY e.id LIMIT ?`).all(space, JSON.stringify(excludedIds), limit);
    },
    indexStatus(space) {
      const indexed = space ? db.prepare(`SELECT count(*) AS n FROM (${vectorSelect("visual")})`).get(space, space).n : 0;
      const pendingImages = db.prepare(`SELECT count(*) AS n FROM element_images i JOIN elements e ON e.id=i.element_id
        WHERE e.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM video_analysis_vectors v
          WHERE v.kind=2 AND v.image_id=e.id AND v.space_key=? AND v.content_hash=i.content_hash)`).get(space ?? "").n;
      const pendingFrames = db.prepare(`SELECT count(*) AS n FROM video_analysis_frames f JOIN video_analysis_runs r ON r.id=f.run_id
        JOIN video_analysis_state s ON (s.active_run_id=r.id OR s.current_run_id=r.id) JOIN elements e ON e.id=r.video_id
        JOIN element_videos source ON source.element_id=e.id AND source.content_hash=r.source_hash
        WHERE e.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM video_analysis_vectors v
          WHERE v.kind=0 AND v.frame_id=f.id AND v.space_key=?)`).get(space ?? "").n;
      return { indexed, pending: pendingImages + pendingFrames, pendingImages, pendingFrames };
    },
    pendingVectors(runId, kind, space, excludedIds = []) {
      if (kind === "marker") return db.prepare(`SELECT m.id FROM video_markers m JOIN elements e ON e.id=m.video_id
        JOIN video_analysis_text_documents d ON d.kind=3 AND d.id=m.id
        WHERE m.origin!=1 AND e.deleted_at IS NULL AND (? IS NULL OR m.video_id=(SELECT video_id FROM video_analysis_runs WHERE id=?))
        AND (length(trim(m.body))>0 OR EXISTS(SELECT 1 FROM video_marker_tags mt WHERE mt.marker_id=m.id))
        AND NOT EXISTS(SELECT 1 FROM video_analysis_vectors v WHERE v.kind=3 AND v.marker_id=m.id AND v.space_key=? AND v.revision=m.revision AND v.content_hash=d.content_hash)
        AND m.id NOT IN(SELECT value FROM json_each(?))
        ORDER BY m.id LIMIT 16`).all(runId ?? null, runId ?? null, space, JSON.stringify(excludedIds)).map(presentManualMarker);
      if (kind === "frame") return db.prepare(`SELECT f.*,r.video_id FROM video_analysis_frames f JOIN video_analysis_runs r ON r.id=f.run_id
        JOIN video_analysis_state s ON (s.active_run_id=r.id OR s.current_run_id=r.id) JOIN elements e ON e.id=r.video_id
        JOIN element_videos source ON source.element_id=e.id AND source.content_hash=r.source_hash
        WHERE e.deleted_at IS NULL AND (? IS NULL OR f.run_id=?) AND NOT EXISTS(
          SELECT 1 FROM video_analysis_vectors v WHERE v.kind=0 AND v.frame_id=f.id AND v.space_key=?)
          AND f.id NOT IN(SELECT value FROM json_each(?)) ORDER BY f.id LIMIT 16`)
        .all(runId ?? null, runId ?? null, space, JSON.stringify(excludedIds)).map(presentFrame);
      if (kind !== "observation") throw elementError("视频向量类型无效");
      // Current unpublished observations can be encoded; query-time projection still guards publication/corrections.
      return db.prepare(`SELECT o.*,r.video_id FROM video_analysis_observations o JOIN video_analysis_runs r ON r.id=o.run_id
        JOIN video_analysis_text_documents d ON d.kind=1 AND d.id=o.id
        JOIN video_analysis_state s ON (s.active_run_id=r.id OR s.current_run_id=r.id) JOIN elements e ON e.id=r.video_id
        JOIN element_videos source ON source.element_id=e.id AND source.content_hash=r.source_hash
        WHERE e.deleted_at IS NULL AND o.decision IN(0,1)
          AND (o.id IN(SELECT id FROM effective_video_observations) OR (s.current_run_id=r.id AND coalesce(s.active_run_id,0)!=r.id))
          AND (? IS NULL OR o.run_id=?) AND NOT EXISTS(
          SELECT 1 FROM video_analysis_vectors v WHERE v.kind=1 AND v.observation_id=o.id AND v.space_key=? AND v.revision=o.revision AND v.content_hash=d.content_hash)
        AND o.id NOT IN(SELECT value FROM json_each(?))
        ORDER BY o.id LIMIT 16`).all(runId ?? null, runId ?? null, space, JSON.stringify(excludedIds)).map(presentObservation);
    },
    putVectors(kind, space, items) {
      if (!(kind in vectorKinds) || typeof space !== "string" || !space || !Array.isArray(items) || items.length > 32) throw elementError("视频向量批次无效");
      const data = items.map((item) => ({ ...item, embedding: new Uint8Array(embeddingVector(Array.from(item.vector), item.vector.length).buffer) }));
      return transaction(() => {
        let saved = 0;
        for (const item of data) {
          if (kind === "image") {
            if (!item.contentHash || !db.prepare(`SELECT 1 FROM element_images i JOIN elements e ON e.id=i.element_id WHERE i.element_id=? AND i.content_hash=? AND e.deleted_at IS NULL`).get(item.id, item.contentHash)) continue;
          } else if (kind === "observation") {
            if (!db.prepare(`SELECT 1 FROM video_analysis_observations o JOIN video_analysis_runs r ON r.id=o.run_id
              JOIN video_analysis_text_documents d ON d.kind=1 AND d.id=o.id AND d.content_hash=?
              JOIN elements e ON e.id=r.video_id JOIN video_analysis_state s ON (s.active_run_id=r.id OR s.current_run_id=r.id)
              JOIN element_videos source ON source.element_id=e.id AND source.content_hash=r.source_hash
              WHERE o.id=? AND o.revision=? AND o.decision IN(0,1) AND e.deleted_at IS NULL`).get(item.contentHash ?? "", item.id, item.revision)) continue;
          } else if (kind === "marker") {
            if (!db.prepare(`SELECT 1 FROM video_markers m JOIN elements e ON e.id=m.video_id
              JOIN video_analysis_text_documents d ON d.kind=3 AND d.id=m.id AND d.content_hash=?
              WHERE m.id=? AND m.revision=? AND m.origin!=1 AND e.deleted_at IS NULL`).get(item.contentHash ?? "", item.id, item.revision)) continue;
          } else { try { repository.frame(item.id); } catch { continue; } }
          const column = vectorIds[kind];
          db.prepare(`DELETE FROM video_analysis_vectors WHERE kind=${vectorKinds[kind]} AND ${column}=? AND space_key=?`).run(item.id, space);
          db.prepare(`INSERT INTO video_analysis_vectors(kind,${column},space_key,revision,content_hash,embedding) VALUES(?,?,?,?,?,?)`)
            .run(vectorKinds[kind], item.id, space, item.revision ?? 1, item.contentHash ?? "", item.embedding);
          saved++;
        }
        return saved;
      });
    },
    vectors(kind, space, id) {
      const queryKind = ["observation", "marker"].includes(kind) ? "text" : "visual";
      const field = kind === "image" ? "elementId" : kind === "frame" ? "frameId" : kind === "marker" ? "markerId" : "observationId";
      return db.prepare(`SELECT embedding FROM (${vectorSelect(queryKind)}) WHERE ${field}=?${kind === "image" ? " AND kind='image'" : ""}`)
        .all(space, space, id);
    },
    searchVectors(kind, space, vector, { excludeId = 0, excludedIds = [], limit = 12, perVideo = 3, imagesOnly = false } = {}) {
      if (!["visual", "text"].includes(kind)) throw elementError("视频搜索空间类型无效");
      const query = new Uint8Array(embeddingVector(Array.from(vector), vector.length).buffer);
      const rows = db.prepare(`SELECT *,vec_distance_cosine(embedding,?) AS distance FROM (${vectorSelect(kind)})
        WHERE elementId!=? AND elementId NOT IN(SELECT value FROM json_each(?)) AND length(embedding)=?
        AND (?=0 OR (kind='image' AND elementId IN(SELECT id FROM elements WHERE local_only=0)))
        ORDER BY distance,elementId,startMs`).iterate(query, space, space, excludeId, JSON.stringify(excludedIds), query.byteLength, Number(imagesOnly));
      const counts = new Map(), result = [];
      for (const row of rows) {
        const count = counts.get(row.elementId) || 0;
        if (count >= (row.kind === "video" ? perVideo : 1)) continue;
        counts.set(row.elementId, count + 1);
        const { embedding, ...hit } = row; result.push(hit);
        if (result.length >= limit) break;
      }
      return result;
    },
    resolveSearchHit(hit) {
      try {
        if (hit.observationId) {
          const row = effective(hit.observationId);
          if (row.revision !== hit.revision || row.video_id !== hit.elementId) return null;
          const observation = presentObservation(row);
          if (hit.contentHash !== observation.contentHash) return null;
          return { ...hit, ...observation, elementId: row.video_id, observationId: row.id };
        }
        if (hit.markerId) {
          const marker = wiki.markers.get(hit.markerId);
          if (marker.revision !== hit.revision || marker.videoId !== hit.elementId || marker.origin === "ai") return null;
          const current = presentManualMarker(marker);
          if (hit.contentHash !== current.contentHash) return null;
          return { ...hit, ...current, elementId: marker.videoId };
        }
        if (hit.frameId) {
          const frame = repository.frame(hit.frameId);
          if (frame.videoId !== hit.elementId) return null;
          const active = db.prepare("SELECT active_run_id FROM video_analysis_state WHERE video_id=?").get(frame.videoId);
          if (active?.active_run_id !== frame.runId) return null;
          return { ...hit, startMs: frame.timestampMs, endMs: null, body: "", tags: [] };
        }
        const element = wiki.get(hit.elementId);
        if (element.kind !== "image") return null;
        const image = db.prepare("SELECT content_hash FROM element_images WHERE element_id=?").get(element.id);
        if (!hit.contentHash || image.content_hash !== hit.contentHash) return null;
        return { ...hit, body: element.body };
      } catch { return null; }
    },
    cachePaths() { return db.prepare("SELECT path FROM video_analysis_frames").all().map((row) => row.path); },
    rejectMatch(sourceId, targetId) {
      wiki.get(sourceId); wiki.get(targetId);
      if (sourceId === targetId) throw elementError("不能拒绝自身推荐");
      db.prepare("INSERT OR IGNORE INTO video_visual_rejections(source_id,target_id) VALUES(?,?)").run(sourceId, targetId);
      return { ok: true };
    },
    rejectedMatches(sourceId) {
      wiki.get(sourceId);
      return db.prepare("SELECT target_id FROM video_visual_rejections WHERE source_id=? ORDER BY target_id").all(sourceId).map((row) => row.target_id);
    },
  };
  return repository;
}
