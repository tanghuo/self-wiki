import { test } from "node:test";
import assert from "node:assert/strict";
import { initDb } from "../src/server/data/sqlite.js";
import { migrateWiki } from "../src/server/data/wikiMigrations.js";
import { createElementRepository } from "../src/server/data/elementRepository.js";
import { createVideoAnalysisRepository } from "../src/server/data/videoAnalysisRepository.js";
import { migrateVideoAnalysisConsistency } from "../src/server/data/videoAnalysisConsistencyMigration.js";
import { migrateVideoAnalysisApplication } from "../src/server/data/videoAnalysisApplicationMigration.js";

for (const recovery of ["retry", "restart"]) test(`automatic application resumes after a partial write through ${recovery} without duplicating markers`, (t) => {
  const { db, wiki, repo, video } = fixture(t);
  repo.enqueue(video.id, { configKey: "test-config", auto: true });
  const run = repo.claim("test-config");
  repo.saveExtraction(run.id, run.token, { durationMs: 10000, frames: frames(), coveredUntilMs: 5000, complete: false });
  const batch = repo.batches(run.id, run.token)[0];
  repo.completeBatch(run.id, run.token, { batchKey: batch.key, observations: [
    { body: "first", tags: ["first"], frameIds: [batch.frames[0].id] },
    { body: "second", tags: ["second"], frameIds: [batch.frames[1].id] },
  ] });
  db.exec("CREATE TEMP TRIGGER fail_apply BEFORE INSERT ON video_markers WHEN NEW.body='second' BEGIN SELECT RAISE(ABORT,'application interrupted'); END");
  assert.throws(() => repo.finish(run.id, run.token), /application interrupted/);
  assert.equal(repo.status(video.id).run.status, "running");
  assert.equal(repo.status(video.id).run.applicationPending, true);
  const first = wiki.markers.list(video.id).markers[0];
  assert.equal(first.body, "first");
  if (recovery === "retry") {
    assert.equal(repo.fail(run.id, run.token, "application interrupted"), true);
    assert.equal(repo.status(video.id).run.status, "failed");
    repo.enqueue(video.id, { configKey: "test-config", auto: true });
  } else repo.initialize("test-config");
  db.exec("DROP TRIGGER fail_apply");
  const resumed = repo.claim("test-config");
  assert.equal(resumed.applicationPending, true);
  assert.equal(repo.batches(resumed.id, resumed.token).length, 0);
  assert.throws(() => repo.finish(run.id, run.token), { statusCode: 409 });
  const finished = repo.finish(resumed.id, resumed.token);
  assert.equal(finished.status, "partial");
  assert.equal(finished.applicationPending, false);
  assert.equal(finished.completedBatches, 1);
  assert.equal(wiki.markers.list(video.id).pagination.total, 2);
  assert.equal(wiki.markers.get(first.id).revision, first.revision);
  assert.equal(repo.claim("test-config"), null);
});

test("schema 33 resumes incomplete auto application but preserves deliberate overlaps, limits and suggestions", (t) => {
  const { db, wiki, repo, video } = fixture(t);
  const incomplete = runAnalysis(repo, video.id);
  const makeVideo = (name) => wiki.importVideo({ tags: [] }, { storageKey: `${name}.mp4`, contentHash: name, mimeType: "video/mp4", byteSize: 100, originalName: `${name}.mp4` }).element;
  const overlapVideo = makeVideo("overlap"), limitedVideo = makeVideo("limited"), suggestedVideo = makeVideo("suggested");
  wiki.markers.create(overlapVideo.id, { startMs: 1000, endMs: 3000, body: "猫坐在窗边", tags: ["猫"], targetIds: [], requestKey: "overlap-manual" });
  const overlap = runAnalysis(repo, overlapVideo.id, { auto: true });
  const limited = runAnalysis(repo, limitedVideo.id);
  for (let i = 0; i < 500; i++) wiki.markers.create(limitedVideo.id, { startMs: i, endMs: null, body: `manual ${i}`, tags: [], targetIds: [], requestKey: `limit-${i}` });
  const suggested = runAnalysis(repo, suggestedVideo.id);
  db.prepare("UPDATE video_analysis_runs SET auto_apply=1 WHERE id IN (?,?)").run(incomplete.run.id, limited.run.id);
  db.exec("ALTER TABLE video_analysis_runs DROP COLUMN application_pending; DELETE FROM wiki_schema WHERE version=34");
  const before = db.prepare("SELECT * FROM video_analysis_runs ORDER BY id").all();
  db.exec("CREATE TEMP TRIGGER fail_v34 BEFORE INSERT ON wiki_schema WHEN NEW.version=34 BEGIN SELECT RAISE(ABORT,'fail v34'); END");
  assert.throws(() => migrateVideoAnalysisApplication(db), /fail v34/);
  assert.deepEqual(db.prepare("SELECT * FROM video_analysis_runs ORDER BY id").all(), before);
  assert.equal(db.prepare("PRAGMA table_info(video_analysis_runs)").all().some((column) => column.name === "application_pending"), false);
  db.exec("DROP TRIGGER fail_v34");
  migrateVideoAnalysisApplication(db); migrateVideoAnalysisApplication(db);
  assert.equal(repo.status(video.id).run.applicationPending, true);
  for (const run of [overlap.run, limited.run, suggested.run]) {
    assert.equal(repo.status(run.videoId).run.status, "ready");
    assert.equal(repo.status(run.videoId).run.applicationPending, false);
  }
  const resumed = repo.claim("test-config");
  assert.equal(resumed.id, incomplete.run.id);
  repo.finish(resumed.id, resumed.token);
  assert.equal(wiki.markers.list(video.id).pagination.total, 1);
  assert.equal(repo.status(video.id).run.status, "ready");
  migrateWiki(db);
  assert.equal(repo.claim("test-config"), null);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("analysis history retains rejected and corrected evidence without making it searchable", (t) => {
  const { wiki, repo, video } = fixture(t);
  const observations = [{ body: "一只猫", tags: ["猫"] }, { body: "一棵树", tags: ["树"] }];
  const initial = runAnalysis(repo, video.id, { auto: true, observations });
  const [cat, tree] = initial.observations;
  repo.reject(cat.id, { revision: cat.revision });
  const marker = wiki.markers.get(tree.markerId);
  wiki.markers.update(marker.id, { startMs: marker.startMs, endMs: marker.endMs, body: "人工纠正", tags: ["花"], targetIds: [], revision: marker.revision });
  const history = repo.history(video.id);
  assert.deepEqual(history.map((row) => row.status), ["rejected", "corrected"]);
  assert.deepEqual(history.map((row) => row.frameIds), initial.observations.map((row) => row.frameIds));
  assert.equal(history[1].markerId, marker.id);
  assert.equal(repo.results(video.id).observations.length, 0);
  assert.deepEqual(repo.search("一只猫"), []);
  const next = runAnalysis(repo, video.id, { restart: true, observations });
  assert.deepEqual(repo.history(video.id).map((row) => row.status), ["rejected", "corrected"]);
  assert.ok(repo.history(video.id).every((row) => row.runId === next.run.id));
  assert.equal(repo.results(video.id).observations.length, 0);
  wiki.trash(video.id);
  assert.throws(() => repo.history(video.id), { statusCode: 404 });
  wiki.restore(video.id);
  assert.equal(repo.history(video.id).length, 2);
});

test("pending vector reads use their partial indexes and still discover trailing unindexed items", (t) => {
  const { db, wiki, repo, video } = fixture(t);
  runAnalysis(repo, video.id);
  const image = wiki.importImage({ tags: [] }, { storageKey: "indexed.webp", contentHash: "indexed", mimeType: "image/webp", byteSize: 10, originalName: "indexed.webp" }).element;
  wiki.markers.create(video.id, { startMs: 8000, endMs: null, body: "manual", tags: [], targetIds: [], requestKey: "indexed-manual" });
  let query;
  const traced = createVideoAnalysisRepository(new Proxy(db, { get(target, key) {
    if (key === "prepare") return (sql) => { if (sql.includes("NOT EXISTS(SELECT 1 FROM video_analysis_vectors") || sql.includes("SELECT 1 FROM video_analysis_vectors v")) query = sql; return target.prepare(sql); };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } }), { wiki });
  for (const kind of ["image", "frame", "observation", "marker"]) {
    const items = kind === "image" ? traced.pendingVisualImages("space") : traced.pendingVectors(null, kind, "space");
    const args = kind === "image" ? ["space", "[]", 8] : [null, null, "space", "[]"];
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...args);
    assert.ok(plan.some((row) => row.detail.startsWith("SEARCH v USING ") && row.detail.includes(`INDEX idx_video_vectors_${kind}`)), `${kind}: ${JSON.stringify(plan)}`);
    repo.putVectors(kind, "space", items.map((item) => ({ ...item, vector: [1, 0] })));
    assert.equal((kind === "image" ? repo.pendingVisualImages("space") : repo.pendingVectors(null, kind, "space")).length, 0);
  }
  const trailing = wiki.importImage({ tags: [] }, { storageKey: "trailing.webp", contentHash: "trailing", mimeType: "image/webp", byteSize: 10, originalName: "trailing.webp" }).element;
  assert.deepEqual(repo.pendingVisualImages("space", 1).map((row) => row.id), [trailing.id]);
  assert.equal(repo.pendingVisualImages("space", 1, [trailing.id]).length, 0);
  assert.notEqual(image.id, trailing.id);
});

test("vector exclusions precede limits for both visual and marker text candidates", (t) => {
  const { wiki, repo, video } = fixture(t);
  const excludedIds = [];
  for (let i = 0; i < 14; i++) {
    const target = wiki.importVideo({ tags: [] }, { storageKey: `quota-${i}.mp4`, contentHash: `quota-${i}`, mimeType: "video/mp4", byteSize: 10, originalName: `quota-${i}.mp4` }).element;
    wiki.markers.create(target.id, { startMs: 1000, endMs: null, body: "same", tags: [], targetIds: [], requestKey: `quota-${i}` });
    const image = wiki.importImage({ tags: [] }, { storageKey: `quota-${i}.webp`, contentHash: `image-${i}`, mimeType: "image/webp", byteSize: 10, originalName: `quota-${i}.webp` }).element;
    repo.putVectors("image", "space", [{ id: image.id, contentHash: `image-${i}`, vector: [1, 0] }]);
    if (i < 13) excludedIds.push(target.id, image.id);
  }
  repo.putVectors("marker", "space", repo.pendingVectors(null, "marker", "space").map((item) => ({ ...item, vector: [1, 0] })));
  for (const kind of ["visual", "text"]) {
    assert.equal(repo.searchVectors(kind, "space", [1, 0], { excludeId: video.id }).length, 12);
    const result = repo.searchVectors(kind, "space", [1, 0], { excludeId: video.id, excludedIds });
    assert.equal(result.length, 1);
    assert.ok(!excludedIds.includes(result[0].elementId));
  }
});

function fixture(t) {
  const db = initDb(":memory:"); t.after(() => db.close());
  const wiki = createElementRepository(db), repo = createVideoAnalysisRepository(db, { wiki });
  const video = wiki.importVideo({ tags: [] }, { storageKey: "sample.mp4", contentHash: "video-one", mimeType: "video/mp4", byteSize: 1000, originalName: "sample.mp4" }).element;
  return { db, wiki, repo, video };
}
const frames = (prefix = "a", times = [1000, 3000]) => times.map((timestampMs, i) => ({ key: `${prefix}-${i}`, timestampMs, shotId: "shot-1", windowId: "window-1", path: `D:/cache/${prefix}-${i}.jpg` }));
function runAnalysis(repo, videoId, { restart = false, auto = false, tags = ["猫"], body = "猫坐在窗边", complete = true, frameData = frames(), observations = [{ body, tags }] } = {}) {
  repo.enqueue(videoId, { configKey: "test-config", auto, restart });
  const run = repo.claim("test-config");
  repo.saveExtraction(run.id, run.token, { durationMs: 10000, frames: frameData, coveredUntilMs: complete ? 10000 : 5000, complete });
  for (const batch of repo.batches(run.id, run.token)) {
    repo.completeBatch(run.id, run.token, { batchKey: batch.key,
      observations: observations.map((observation) => ({ ...observation, frameIds: batch.frames.map((frame) => frame.id) })), execution: { model: "fixture-model" } });
  }
  repo.finish(run.id, run.token);
  return repo.results(videoId);
}

test("analysis suggestions publish separately; accepted tags enter marker search with origin", (t) => {
  const { db, wiki, repo, video } = fixture(t);
  assert.deepEqual(repo.pendingVideos("test-config"), [video.id]);
  const result = runAnalysis(repo, video.id);
  assert.equal(result.run.status, "ready");
  assert.equal(result.observations.length, 1);
  const observation = result.observations[0];
  assert.deepEqual([observation.startMs, observation.endMs], [1000, 3000]);
  assert.equal(repo.search("猫").length, 1);
  assert.equal(wiki.list({ q: "猫" }).pagination.total, 0);
  assert.equal(wiki.markers.list(video.id).pagination.total, 0);
  assert.throws(() => repo.accept(observation.id, { revision: 9 }), { statusCode: 409 });
  const accepted = repo.accept(observation.id, { revision: observation.revision });
  assert.equal(wiki.markers.get(accepted.markerId).origin, "ai");
  assert.equal(wiki.list({ tag: "猫" }).pagination.total, 1);
  assert.equal(wiki.get(video.id).tags.length, 0);
  assert.equal(repo.pendingVideos("test-config").length, 0);
  migrateWiki(db);
  assert.equal(repo.results(video.id).observations.length, 1);
});

test("manual correction invalidates old descriptions, rejected tags and stale indexing across reruns", (t) => {
  const { db, wiki, repo, video } = fixture(t);
  const result = runAnalysis(repo, video.id, { auto: true });
  const observation = result.observations[0], marker = wiki.markers.get(observation.markerId);
  repo.putVectors("observation", "text-space", [{ ...observation, vector: [1, 0, 0] }]);
  assert.equal(repo.searchVectors("text", "text-space", [1, 0, 0]).length, 1);
  const corrected = wiki.markers.update(marker.id, { startMs: marker.startMs, endMs: marker.endMs, body: "狗坐在窗边", tags: ["狗"], targetIds: [], revision: marker.revision });
  assert.equal(corrected.origin, "corrected");
  assert.equal(repo.search("猫").length, 0);
  assert.equal(repo.searchVectors("text", "text-space", [1, 0, 0]).length, 0);
  assert.equal(repo.putVectors("observation", "text-space", [{ ...observation, vector: [1, 0, 0] }]), 0);
  assert.equal(wiki.list({ tag: "猫" }).pagination.total, 0);
  assert.equal(wiki.list({ q: "狗坐在窗边" }).pagination.total, 1);
  assert.equal(db.prepare("SELECT body FROM video_analysis_observations WHERE id=?").get(observation.id).body, "猫坐在窗边");
  runAnalysis(repo, video.id, { restart: true, auto: true });
  assert.equal(repo.results(video.id).observations.length, 0, "a new run cannot undo a rejected concept near the same time");
  assert.equal(wiki.markers.list(video.id).pagination.total, 1);
  assert.equal(wiki.markers.get(marker.id).body, "狗坐在窗边");
});

test("deleting AI marker suppresses recreation while an unrelated time remains discoverable", (t) => {
  const { wiki, repo, video } = fixture(t);
  const first = runAnalysis(repo, video.id, { auto: true }).observations[0];
  const marker = wiki.markers.get(first.markerId);
  wiki.markers.remove(marker.id, marker.revision);
  assert.equal(repo.search("猫").length, 0);
  assert.throws(() => repo.reject(first.id, { revision: first.revision }), { statusCode: 409 });
  const later = runAnalysis(repo, video.id, { auto: true, restart: true, frameData: frames("later", [8000, 9000]) });
  assert.equal(later.observations.length, 1);
  assert.equal(wiki.markers.list(video.id).pagination.total, 1);
});

test("partial continuation freezes completed batches and resumes without duplicate inference", (t) => {
  const { repo, video } = fixture(t);
  const partial = runAnalysis(repo, video.id, { complete: false });
  assert.equal(partial.run.status, "partial");
  repo.enqueue(video.id, { configKey: "test-config" });
  const run = repo.claim("test-config");
  assert.equal(run.id, partial.run.id);
  assert.deepEqual(repo.batches(run.id, run.token), []);
  const all = repo.saveExtraction(run.id, run.token, { durationMs: 10000, frames: frames("b", [6000, 8000]), coveredUntilMs: 10000, complete: true });
  assert.equal(all.length, 4);
  const [batch] = repo.batches(run.id, run.token);
  assert.equal(batch.frames.length, 2);
  const payload = { batchKey: batch.key, observations: [{ frameIds: batch.frames.map((frame) => frame.id), body: "树木", tags: ["树"] }], execution: {} };
  const saved = repo.completeBatch(run.id, run.token, payload);
  assert.deepEqual(repo.completeBatch(run.id, run.token, payload), saved);
  assert.throws(() => repo.completeBatch(run.id, run.token, { ...payload, observations: [] }), { statusCode: 409 });
  repo.finish(run.id, run.token);
  assert.equal(repo.results(video.id).observations.length, 2);
  assert.equal(repo.status(video.id).run.status, "ready");
});

test("leases, source lifecycle and failed replacement preserve only eligible published results", (t) => {
  const { db, wiki, repo, video } = fixture(t);
  const active = runAnalysis(repo, video.id, { auto: true });
  repo.enqueue(video.id, { configKey: "test-config", restart: true });
  const stale = repo.claim("test-config");
  repo.initialize("test-config");
  const current = repo.claim("test-config");
  assert.notEqual(current.token, stale.token);
  assert.throws(() => repo.saveExtraction(stale.id, stale.token, { durationMs: 10000, frames: frames("stale"), coveredUntilMs: 10000, complete: true }), { statusCode: 409 });
  assert.equal(repo.fail(stale.id, stale.token, "late failure"), false);
  assert.equal(repo.fail(current.id, current.token, "model unavailable"), true);
  assert.equal(repo.results(video.id).activeRun.id, active.run.id);
  assert.equal(repo.search("猫").length, 1);
  repo.enqueue(video.id, { configKey: "test-config" });
  const beforeTrash = repo.claim("test-config");
  wiki.trash(video.id);
  assert.throws(() => repo.heartbeat(beforeTrash.id, beforeTrash.token), { statusCode: 409 });
  assert.equal(repo.search("猫").length, 0);
  wiki.restore(video.id);
  assert.equal(repo.search("猫").length, 1);
  wiki.trash(video.id); wiki.purge(video.id);
  for (const table of ["video_analysis_runs", "video_analysis_state", "video_analysis_frames", "video_analysis_batches", "video_analysis_observations", "video_markers", "video_analysis_vectors"]) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  }
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("frame evidence is bounded to its supplied batch and split at shot/window boundaries", (t) => {
  const { repo, video } = fixture(t);
  repo.enqueue(video.id, { configKey: "test-config" });
  const run = repo.claim("test-config");
  const frameData = frames(); frameData[1].shotId = "second-shot";
  repo.saveExtraction(run.id, run.token, { durationMs: 10000, frames: frameData, coveredUntilMs: 10000, complete: true });
  const [batch] = repo.batches(run.id, run.token);
  assert.throws(() => repo.completeBatch(run.id, run.token, { batchKey: batch.key, observations: [{ frameIds: [999], body: "伪造", tags: [] }] }), /无效帧/);
  repo.completeBatch(run.id, run.token, { batchKey: batch.key, observations: [{ frameIds: batch.frames.map((frame) => frame.id), body: "猫", tags: ["猫"] }] });
  repo.finish(run.id, run.token);
  assert.equal(repo.results(video.id).observations.length, 2);
  assert.ok(repo.results(video.id).observations.every((item) => item.endMs === null));
});

test("visual retrieval isolates model spaces and preserves frame evidence after text rejection", (t) => {
  const { wiki, repo, video } = fixture(t);
  const result = runAnalysis(repo, video.id);
  const image = wiki.importImage({ tags: [] }, { storageKey: "image.webp", contentHash: "image-one", mimeType: "image/webp", byteSize: 100, originalName: "image.webp" }).element;
  const frame = repo.pendingVectors(null, "frame", "visual-one")[0];
  assert.equal(repo.frame(frame.id).videoId, video.id);
  assert.equal(repo.pendingVisualImages("visual-one")[0].id, image.id);
  repo.putVectors("frame", "visual-one", [{ id: frame.id, vector: [1, 0, 0] }]);
  repo.putVectors("image", "visual-one", [{ id: image.id, contentHash: "image-one", vector: [0.9, 0.1, 0] }]);
  assert.equal(repo.searchVectors("visual", "other-space", [1, 0, 0]).length, 0);
  assert.equal(repo.searchVectors("visual", "visual-one", [1, 0, 0]).length, 2);
  assert.deepEqual(repo.searchVectors("visual", "visual-one", [1, 0, 0], { imagesOnly: true, limit: 1 }).map((hit) => hit.elementId), [image.id]);
  assert.equal(repo.vectors("frame", "visual-one", frame.id).length, 1);
  assert.equal(repo.vectors("image", "visual-one", image.id).length, 1);
  repo.reject(result.observations[0].id, { revision: result.observations[0].revision });
  assert.equal(repo.searchVectors("visual", "visual-one", [1, 0, 0]).length, 2);
  wiki.trash(video.id);
  assert.equal(repo.searchVectors("visual", "visual-one", [1, 0, 0]).length, 1);
  assert.throws(() => repo.frame(frame.id), { statusCode: 404 });
  assert.equal(repo.putVectors("image", "visual-one", [{ id: image.id, contentHash: "stale", vector: [1, 0, 0] }]), 0);
});

test("automatic markers respect manual overlap and the existing per-video marker ceiling", (t) => {
  const { db, wiki, repo, video } = fixture(t);
  const manual = wiki.markers.create(video.id, { startMs: 1000, endMs: 3000, body: "  猫坐在窗边  ", tags: ["猫"], targetIds: [], requestKey: "manual-overlap-001" });
  const result = runAnalysis(repo, video.id, { auto: true });
  assert.equal(wiki.markers.list(video.id).pagination.total, 1);
  assert.equal(wiki.markers.get(manual.id).origin, "manual");
  assert.equal(result.observations[0].markerId, null);
  assert.equal(repo.accept(result.observations[0].id, { revision: result.observations[0].revision }).reason, "manual-overlap");
  db.prepare("UPDATE video_markers SET start_ms=20000,end_ms=21000 WHERE id=?").run(manual.id);
  const insert = db.prepare("INSERT INTO video_markers(video_id,start_ms,body,request_key,request_hash,created_at,updated_at) VALUES(?,20000,'limit',?,'x','now','now')");
  db.exec("BEGIN IMMEDIATE");
  for (let i = 0; i < 499; i++) insert.run(video.id, `limit-${i}`);
  db.exec("COMMIT");
  assert.equal(repo.accept(result.observations[0].id, { revision: result.observations[0].revision }).reason, "marker-limit");
  assert.equal(wiki.markers.list(video.id).pagination.total, 500);
  assert.equal(repo.search("猫").length, 2, "manual markers and the un-applied observation remain searchable");
});

test("manual marker text vectors follow correction revisions and lifecycle", (t) => {
  const { wiki, repo, video } = fixture(t);
  const observation = runAnalysis(repo, video.id, { auto: true }).observations[0];
  const marker = wiki.markers.get(observation.markerId);
  const dog = wiki.markers.update(marker.id, { startMs: marker.startMs, endMs: marker.endMs, body: "狗在庭院里", tags: ["狗"], targetIds: [], revision: marker.revision });
  assert.deepEqual(repo.pendingVectors(null, "marker", "text-space").map((item) => item.id), [dog.id]);
  const dogDocument = repo.pendingVectors(null, "marker", "text-space")[0];
  assert.equal(repo.putVectors("marker", "text-space", [{ ...dogDocument, vector: [1, 0, 0] }]), 1);
  const [hit] = repo.searchVectors("text", "text-space", [1, 0, 0]);
  assert.equal(hit.markerId, dog.id);
  assert.equal(hit.observationId, null);
  assert.equal(hit.body, dog.body);
  assert.equal(repo.search("狗")[0].markerId, dog.id);
  assert.equal(repo.vectors("marker", "text-space", dog.id).length, 1);
  const bird = wiki.markers.update(dog.id, { startMs: dog.startMs, endMs: dog.endMs, body: "小鸟在庭院里", tags: ["鸟"], targetIds: [], revision: dog.revision });
  assert.equal(repo.searchVectors("text", "text-space", [1, 0, 0]).length, 0);
  assert.equal(repo.putVectors("marker", "text-space", [{ ...dogDocument, vector: [1, 0, 0] }]), 0);
  assert.equal(repo.search("狗").length, 0);
  assert.equal(repo.putVectors("marker", "text-space", [{ ...repo.pendingVectors(null, "marker", "text-space")[0], vector: [0, 1, 0] }]), 1);
  wiki.markers.remove(bird.id, bird.revision);
  assert.equal(repo.searchVectors("text", "text-space", [0, 1, 0]).length, 0);
  assert.equal(repo.pendingVectors(null, "marker", "text-space").length, 0);
});

test("explicit similarity rejection persists across trash/restore and cascades on purge", (t) => {
  const { wiki, repo, video } = fixture(t);
  const target = wiki.createText({ body: "候选素材", tags: [] });
  repo.rejectMatch(video.id, target.id);
  repo.rejectMatch(video.id, target.id);
  assert.deepEqual(repo.rejectedMatches(video.id), [target.id]);
  assert.deepEqual(repo.rejectedMatches(target.id), []);
  assert.throws(() => repo.rejectMatch(video.id, video.id));
  wiki.trash(target.id); wiki.restore(target.id);
  assert.deepEqual(repo.rejectedMatches(video.id), [target.id]);
  wiki.trash(target.id); wiki.purge(target.id);
  assert.deepEqual(repo.rejectedMatches(video.id), []);
});

test("batch-budget pauses keep unpublished work separate from analyzed coverage and resume on restart", (t) => {
  const { repo, video } = fixture(t);
  repo.enqueue(video.id, { configKey: "test-config" });
  const run = repo.claim("test-config");
  repo.saveExtraction(run.id, run.token, { durationMs: 10000, frames: frames("budget", [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000]), coveredUntilMs: 10000, complete: true });
  const [first] = repo.batches(run.id, run.token);
  repo.completeBatch(run.id, run.token, { batchKey: first.key, observations: [{ frameIds: first.frames.map((frame) => frame.id), body: "已分析", tags: [] }] });
  const paused = repo.pause(run.id, run.token);
  assert.equal(paused.status, "partial");
  assert.equal(paused.coveredUntilMs, 10000);
  assert.equal(paused.analyzedUntilMs, 7000);
  assert.equal(paused.completedBatches, 1);
  assert.equal(paused.totalBatches, 2);
  assert.equal(repo.results(video.id).activeRun, null);
  assert.equal(repo.search("已分析").length, 0);
  repo.enqueue(video.id, { configKey: "test-config" });
  const resumed = repo.claim("test-config");
  assert.equal(repo.batches(resumed.id, resumed.token).length, 1);
  assert.equal(repo.suspend(resumed.id, resumed.token), true);
  assert.equal(repo.status(video.id).run.status, "pending");
  const restarted = repo.claim("test-config");
  assert.notEqual(restarted.token, resumed.token);
  assert.equal(repo.suspend(resumed.id, resumed.token), false);
  const [remaining] = repo.batches(restarted.id, restarted.token);
  repo.completeBatch(restarted.id, restarted.token, { batchKey: remaining.key, observations: [] });
  repo.finish(restarted.id, restarted.token);
  assert.equal(repo.status(video.id).run.analyzedUntilMs, 10000);
  assert.equal(repo.search("已分析").length, 1);
});

test("deleting a corrected marker also suppresses its corrected concept on a later run", (t) => {
  const { wiki, repo, video } = fixture(t);
  const observation = runAnalysis(repo, video.id, { auto: true }).observations[0];
  const marker = wiki.markers.get(observation.markerId);
  const corrected = wiki.markers.update(marker.id, { startMs: marker.startMs, endMs: marker.endMs, body: "狗", tags: ["狗"], targetIds: [], revision: marker.revision });
  wiki.markers.remove(corrected.id, corrected.revision);
  runAnalysis(repo, video.id, { auto: true, restart: true, body: "狗", tags: ["狗"] });
  assert.equal(repo.results(video.id).observations.length, 0);
  assert.equal(wiki.markers.list(video.id).pagination.total, 0);
});

test("search snapshots are revalidated after corrections, publication changes and source changes", (t) => {
  const { db, wiki, repo, video } = fixture(t);
  const observation = runAnalysis(repo, video.id).observations[0];
  repo.putVectors("observation", "text-space", [{ ...observation, vector: [1, 0] }]);
  const [snapshot] = repo.searchVectors("text", "text-space", [1, 0]);
  assert.equal(snapshot.revision, observation.revision);
  assert.ok(repo.resolveSearchHit(snapshot));
  const frame = repo.pendingVectors(null, "frame", "visual-space")[0];
  repo.putVectors("frame", "visual-space", [{ id: frame.id, vector: [1, 0] }]);
  const [visual] = repo.searchVectors("visual", "visual-space", [1, 0]);
  repo.reject(observation.id, { revision: observation.revision });
  assert.equal(repo.resolveSearchHit(snapshot), null);
  assert.ok(repo.resolveSearchHit(visual), "rejected words do not invalidate the actual visual evidence");
  runAnalysis(repo, video.id, { restart: true });
  assert.equal(repo.resolveSearchHit(visual), null, "a stale run cannot leak frame hits after a new run is published");
  const manual = wiki.markers.create(video.id, { startMs: 1000, endMs: null, body: "原始说明", tags: [], targetIds: [], requestKey: "search-snapshot-manual" });
  repo.putVectors("marker", "text-space", [{ ...repo.pendingVectors(null, "marker", "text-space")[0], vector: [1, 0] }]);
  const markerSnapshot = repo.searchVectors("text", "text-space", [1, 0]).find((item) => item.markerId === manual.id);
  assert.ok(repo.resolveSearchHit(markerSnapshot));
  wiki.markers.update(manual.id, { startMs: 1000, endMs: null, body: "最新说明", tags: [], targetIds: [], revision: manual.revision });
  assert.equal(repo.resolveSearchHit(markerSnapshot), null);
  const image = wiki.importImage({ tags: [] }, { storageKey: "snapshot.webp", contentHash: "snapshot-image", mimeType: "image/webp", byteSize: 100, originalName: "snapshot.webp" }).element;
  repo.putVectors("image", "visual-space", [{ id: image.id, contentHash: "snapshot-image", vector: [1, 0] }]);
  const imageSnapshot = repo.searchVectors("visual", "visual-space", [1, 0]).find((item) => item.elementId === image.id);
  assert.ok(repo.resolveSearchHit(imageSnapshot));
  db.prepare("UPDATE element_images SET content_hash='new-source' WHERE element_id=?").run(image.id);
  assert.equal(repo.resolveSearchHit(imageSnapshot), null);
});

test("batch aggregation merges exact canonical observations only across neighboring evidence", (t) => {
  const { db, wiki, repo, video } = fixture(t);
  wiki.vocabulary.setAlias({ kind: "tag", alias: { name: "猫咪" }, canonical: { name: "猫" } });
  repo.enqueue(video.id, { configKey: "test-config" });
  const run = repo.claim("test-config"), input = frames("merge", [0, 2000, 4000, 6000, 12000, 13000, 14000, 16000]);
  input[6].windowId = "second-window"; input[7].shotId = "second-shot";
  repo.saveExtraction(run.id, run.token, { durationMs: 20000, frames: input, coveredUntilMs: 20000, complete: true });
  const [batch] = repo.batches(run.id, run.token), ids = batch.frames.map((frame) => frame.id);
  const observations = [
    { frameIds: [ids[0]], body: "同一说明", tags: ["猫咪", "室内"] },
    { frameIds: [ids[1]], body: "同一说明", tags: ["室内", "猫"] },
    { frameIds: [ids[0]], body: "同一说明", tags: ["猫", "室内"] },
    { frameIds: [ids[3], ids[4], ids[6], ids[7]], body: "同一说明", tags: ["室内", "猫"] },
    { frameIds: [ids[5]], body: "另一条说明", tags: ["室内", "猫"] },
  ];
  const saved = repo.completeBatch(run.id, run.token, { batchKey: batch.key, observations, frameIntervalMs: 2000 });
  assert.equal(saved.length, 6);
  assert.deepEqual(saved.map((item) => [item.startMs, item.endMs]), [[0, 2000], [6000, null], [12000, null], [13000, null], [14000, null], [16000, null]]);
  assert.deepEqual(saved[0].frameIds, [ids[0], ids[1]]);
  assert.deepEqual(new Set(saved[0].tags), new Set(["猫", "室内"]));
  const audit = db.prepare("SELECT raw_observations,sample_interval_ms FROM video_analysis_batches WHERE run_id=?").get(run.id);
  assert.deepEqual(JSON.parse(audit.raw_observations), observations);
  assert.equal(audit.sample_interval_ms, 2000);
  assert.deepEqual(repo.completeBatch(run.id, run.token, { batchKey: batch.key, observations, frameIntervalMs: 10000 }), saved,
    "retrying a committed batch never changes its published grouping");
});

test("visual index counts are durable and failed-asset exclusions do not block later pending items", (t) => {
  const { db, wiki, repo, video } = fixture(t);
  runAnalysis(repo, video.id);
  const images = ["first", "second"].map((name) => wiki.importImage({ tags: [] }, { storageKey: `${name}.webp`, contentHash: name, mimeType: "image/webp", byteSize: 100, originalName: `${name}.webp` }).element);
  const [first, second] = repo.pendingVectors(null, "frame", "space");
  assert.equal(repo.pendingVisualImages("space", 8, [images[0].id])[0].id, images[1].id);
  assert.deepEqual(repo.pendingVectors(null, "frame", "space", [first.id]).map((item) => item.id), [second.id]);
  const observation = repo.pendingVectors(null, "observation", "text")[0];
  assert.equal(repo.pendingVectors(null, "observation", "text", [observation.id]).length, 0);
  repo.putVectors("frame", "space", [{ id: first.id, vector: [1, 0] }]);
  repo.putVectors("image", "space", [{ id: images[0].id, contentHash: "first", vector: [1, 0] }]);
  assert.deepEqual(repo.indexStatus("space"), { indexed: 2, pending: 2, pendingImages: 1, pendingFrames: 1 });
  assert.deepEqual(createVideoAnalysisRepository(db, { wiki }).indexStatus("space"), repo.indexStatus("space"));
  wiki.trash(video.id);
  assert.deepEqual(repo.indexStatus("space"), { indexed: 1, pending: 1, pendingImages: 1, pendingFrames: 0 });
  assert.deepEqual(repo.indexStatus("different-space"), { indexed: 0, pending: 2, pendingImages: 2, pendingFrames: 0 });
});

test("text indexing skips empty time/link markers and honors explicit marker exclusions", (t) => {
  const { wiki, repo, video } = fixture(t);
  const target = wiki.createText({ body: "资料", tags: [] });
  const marker = (requestKey, body, tags, targetIds = []) => wiki.markers.create(video.id, { startMs: 1000, endMs: null, body, tags, targetIds, requestKey });
  marker("empty-marker-time", "", []);
  marker("empty-marker-links", "  ", [], [target.id]);
  const tagged = marker("search-marker-tags", "", ["标签"]);
  const written = marker("search-marker-text", "说明", []);
  assert.deepEqual(repo.pendingVectors(null, "marker", "space").map((item) => item.id), [tagged.id, written.id]);
  assert.deepEqual(repo.pendingVectors(null, "marker", "space", [tagged.id]).map((item) => item.id), [written.id]);
});

for (const action of ["reject", "correct", "delete"]) test(`tagless observation ${action} preserves unrelated evidence at the same time across reruns`, (t) => {
  const { wiki, repo, video } = fixture(t);
  const observations = [{ body: "错误的猫", tags: [] }, { body: "真实的树", tags: ["树"] }];
  const result = runAnalysis(repo, video.id, { auto: true, observations });
  const cat = result.observations.find((item) => item.body === "错误的猫"), tree = result.observations.find((item) => item.body === "真实的树");
  repo.putVectors("observation", "text", result.observations.map((item, index) => ({ ...item, vector: index ? [0, 1] : [1, 0] })));
  const marker = wiki.markers.get(cat.markerId);
  if (action === "reject") repo.reject(cat.id, { revision: cat.revision });
  else if (action === "delete") wiki.markers.remove(marker.id, marker.revision);
  else wiki.markers.update(marker.id, { startMs: marker.startMs, endMs: marker.endMs, body: "正确的狗", tags: [], targetIds: [], revision: marker.revision });
  assert.equal(wiki.markers.get(tree.markerId).body, "真实的树");
  assert.deepEqual(repo.results(video.id).observations.map((item) => item.id), [tree.id]);
  assert.deepEqual(repo.searchVectors("text", "text", [1, 0]).map((item) => item.observationId), [tree.id]);
  assert.equal(repo.putVectors("observation", "text", [{ ...cat, vector: [1, 0] }]), 0);
  const rerun = runAnalysis(repo, video.id, { auto: true, restart: true, observations });
  assert.deepEqual(rerun.observations.map((item) => item.body), ["真实的树"]);
  assert.equal(repo.search("错误的猫").length, 0);
});

test("successive corrections suppress the prior corrected concept and interval atomically", (t) => {
  const { db, wiki, repo, video } = fixture(t);
  const [cat] = runAnalysis(repo, video.id, { auto: true }).observations;
  const marker = wiki.markers.get(cat.markerId);
  const dog = wiki.markers.update(marker.id, { startMs: 5000, endMs: 6000, body: "狗", tags: ["狗"], targetIds: [], revision: marker.revision });
  const bird = wiki.markers.update(marker.id, { startMs: 8000, endMs: 9000, body: "鸟", tags: ["鸟"], targetIds: [], revision: dog.revision });
  const beforeConflict = db.prepare("SELECT * FROM video_analysis_suppressions ORDER BY id").all();
  assert.throws(() => wiki.markers.update(marker.id, { startMs: 0, endMs: null, body: "冲突", tags: [], targetIds: [], revision: dog.revision }), { statusCode: 409 });
  assert.deepEqual(db.prepare("SELECT * FROM video_analysis_suppressions ORDER BY id").all(), beforeConflict);
  const result = runAnalysis(repo, video.id, { auto: true, restart: true, body: "狗", tags: ["狗"], frameData: frames("dog", [5000, 6000]) });
  assert.equal(result.observations.length, 0);
  assert.deepEqual(wiki.markers.list(video.id).markers.map((item) => item.id), [bird.id]);
  assert.equal(wiki.markers.get(bird.id).body, "鸟");
});

test("alias changes invalidate only changed text documents and reject stale writes and search snapshots", (t) => {
  const { wiki, repo, video } = fixture(t);
  const [observation] = runAnalysis(repo, video.id, { body: "画面", tags: ["水果"] }).observations;
  const marker = wiki.markers.create(video.id, { startMs: 8000, endMs: null, body: "", tags: ["水果"], targetIds: [], requestKey: "alias-fingerprint-marker" });
  const old = {};
  for (const kind of ["marker", "observation"]) {
    old[kind] = repo.pendingVectors(null, kind, "text")[0];
    assert.equal(repo.putVectors(kind, "text", [{ ...old[kind], vector: [1, 0] }]), 1);
  }
  const snapshots = repo.searchVectors("text", "text", [1, 0]);
  const keywordSnapshots = repo.search("水果").map((hit) => ({ ...hit, elementId: hit.videoId, observationId: hit.source === "marker" ? null : hit.id }));
  const alias = wiki.vocabulary.setAlias({ kind: "tag", alias: { name: "水果" }, canonical: { name: "汽车" } });
  assert.equal(repo.search("汽车").length, 2);
  assert.equal(repo.search("水果").length, 2);
  assert.equal(repo.searchVectors("text", "text", [1, 0]).length, 0);
  for (const snapshot of [...snapshots, ...keywordSnapshots]) assert.equal(repo.resolveSearchHit(snapshot), null);
  const changed = {};
  for (const kind of ["marker", "observation"]) {
    assert.equal(repo.putVectors(kind, "text", [{ ...old[kind], vector: [1, 0] }]), 0);
    changed[kind] = repo.pendingVectors(null, kind, "text")[0];
    assert.notEqual(changed[kind].contentHash, old[kind].contentHash);
    assert.deepEqual(changed[kind].tags, ["汽车"]);
    assert.equal(repo.putVectors(kind, "text", [{ ...changed[kind], vector: [0, 1] }]), 1);
  }
  wiki.vocabulary.setAlias({ kind: "tag", alias: { name: "无关旧词" }, canonical: { name: "无关新词" } });
  wiki.vocabulary.setAlias({ kind: "relation", alias: { name: "旁注", reverseName: "", direction: "symmetric" }, canonical: { name: "关联", reverseName: "", direction: "symmetric" } });
  for (const kind of ["marker", "observation"]) assert.equal(repo.pendingVectors(null, kind, "text").length, 0);
  wiki.vocabulary.removeAlias("tag", alias.id);
  assert.deepEqual(wiki.markers.get(marker.id).tags, ["水果"]);
  assert.deepEqual(repo.results(video.id).observations.find((item) => item.id === observation.id).tags, ["水果"]);
  assert.equal(repo.searchVectors("text", "text", [0, 1]).length, 0);
  for (const kind of ["marker", "observation"]) {
    assert.equal(repo.putVectors(kind, "text", [{ ...changed[kind], vector: [0, 1] }]), 0);
    const current = repo.pendingVectors(null, kind, "text")[0];
    assert.equal(repo.putVectors(kind, "text", [{ ...current, vector: [1, 0] }]), 1);
  }
  assert.equal(repo.searchVectors("text", "text", [1, 0]).length, 2);
});

test("keyword limits follow source and rejection exclusions and a shared per-video quota", (t) => {
  const { wiki, repo, video } = fixture(t);
  const target = wiki.importVideo({ tags: [] }, { storageKey: "target.mp4", contentHash: "target", mimeType: "video/mp4", byteSize: 1000, originalName: "target.mp4" }).element;
  for (let i = 0; i < 31; i++) wiki.markers.create(video.id, { startMs: i * 3000, endMs: null, body: "匹配关键词", tags: [], targetIds: [], requestKey: `keyword-marker-${i}` });
  runAnalysis(repo, target.id, { body: "匹配关键词", tags: [] });
  assert.equal(repo.search("匹配关键词", { perVideo: 3 }).filter((hit) => hit.videoId === video.id).length, 3);
  assert.ok(repo.search("匹配关键词").some((hit) => hit.videoId === target.id));
  assert.deepEqual(repo.search("匹配关键词", { excludeId: video.id, limit: 1 }).map((hit) => hit.videoId), [target.id]);
  assert.deepEqual(repo.search("匹配关键词", { excludedIds: [video.id], limit: 1 }).map((hit) => hit.videoId), [target.id]);
  runAnalysis(repo, video.id, { body: "匹配关键词", tags: [] });
  assert.equal(repo.search("匹配关键词", { perVideo: 2 }).filter((hit) => hit.videoId === video.id).length, 2,
    "manual markers and observations share the same video quota");
});

test("schema 32 upgrades text eligibility and tagless suppression without losing history, and rolls back on failure", (t) => {
  const { db, wiki, repo, video } = fixture(t);
  const [observation] = runAnalysis(repo, video.id).observations;
  repo.putVectors("observation", "text", [{ ...observation, vector: [1, 0] }]);
  const legacyView = `CREATE VIEW effective_video_observations AS
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
    )`;
  db.exec("DROP TRIGGER video_analysis_alias_insert; DROP TRIGGER video_analysis_alias_delete; DROP VIEW effective_video_observations; DROP VIEW video_analysis_suppression_matches; DROP VIEW video_analysis_text_documents; ALTER TABLE video_analysis_suppressions DROP COLUMN body; DELETE FROM wiki_schema WHERE version=33");
  db.exec(legacyView);
  db.exec("UPDATE video_analysis_vectors SET content_hash=''");
  db.prepare("INSERT INTO video_analysis_suppressions(video_id,source_hash,start_ms,end_ms,tags,reason,created_at) VALUES(?,?,?,?,?,0,'legacy')")
    .run(video.id, "video-one", 1000, 3000, "[]");
  const history = db.prepare("SELECT * FROM video_analysis_observations").all();
  db.exec("CREATE TRIGGER fail_v33 BEFORE INSERT ON wiki_schema WHEN NEW.version=33 BEGIN SELECT RAISE(ABORT,'fail v33'); END");
  const schema = db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
  assert.throws(() => migrateVideoAnalysisConsistency(db), /fail v33/);
  assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(), schema);
  assert.deepEqual(db.prepare("SELECT * FROM video_analysis_observations").all(), history);
  db.exec("DROP TRIGGER fail_v33");
  migrateVideoAnalysisConsistency(db); migrateVideoAnalysisConsistency(db); migrateWiki(db);
  assert.equal(db.prepare("SELECT count(*) AS n FROM wiki_schema WHERE version=33").get().n, 1);
  assert.deepEqual(db.prepare("SELECT * FROM video_analysis_observations").all(), history);
  assert.equal(repo.searchVectors("text", "text", [1, 0]).length, 0, "legacy vectors without a text fingerprint cannot remain searchable");
  assert.equal(repo.pendingVectors(null, "observation", "text")[0].id, observation.id);
  assert.equal(repo.results(video.id).observations.length, 1, "a legacy unknown concept cannot suppress every future observation");
  assert.equal(wiki.get(video.id).kind, "video");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
});

for (const tags of [["树", "室外"], ["猫", "室外"]]) test(`rejection matches the full observation identity instead of shared tags: ${tags.join("/")}`, (t) => {
  const { repo, wiki, video } = fixture(t);
  const observations = [{ body: "一只猫", tags: ["猫", "室外"] }, { body: "一棵树", tags }];
  const initial = runAnalysis(repo, video.id, { auto: true, observations });
  const cat = initial.observations.find((item) => item.body === "一只猫"), tree = initial.observations.find((item) => item.body === "一棵树");
  repo.reject(cat.id, { revision: cat.revision });
  assert.deepEqual(repo.results(video.id).observations.map((item) => item.body), ["一棵树"]);
  assert.equal(wiki.markers.get(tree.markerId).body, "一棵树");
  const rerun = runAnalysis(repo, video.id, { auto: true, restart: true, observations: [
    { body: "  一只猫  ", tags: ["室外", "猫", "猫"] }, observations[1],
  ] });
  assert.deepEqual(rerun.observations.map((item) => item.body), ["一棵树"]);
  assert.deepEqual(wiki.markers.list(video.id).markers.map((item) => item.body), ["一棵树"]);
});

test("alias changes reconcile suppressed AI markers and allow acceptance after the alias is removed", (t) => {
  const { repo, wiki, video } = fixture(t);
  const [cat] = runAnalysis(repo, video.id, { auto: true, body: "画面中的动物", tags: ["猫"] }).observations;
  repo.reject(cat.id, { revision: cat.revision });
  const observations = [{ body: "画面中的动物", tags: ["狗"] }, { body: "人工说明", tags: ["鸟"] }];
  const next = runAnalysis(repo, video.id, { auto: true, restart: true, observations });
  const dog = next.observations.find((item) => item.body === "画面中的动物"), editable = next.observations.find((item) => item.body === "人工说明");
  const manual = wiki.markers.create(video.id, { startMs: 8000, endMs: null, body: "手工", tags: ["独立标签"], targetIds: [], requestKey: "alias-keeps-manual" });
  const previous = wiki.markers.get(editable.markerId);
  const corrected = wiki.markers.update(previous.id, { startMs: 8000, endMs: null, body: "人工修正", tags: ["独立标签"], targetIds: [], revision: previous.revision });
  const alias = wiki.vocabulary.setAlias({ kind: "tag", alias: { name: "狗" }, canonical: { name: "猫" } });
  assert.equal(repo.results(video.id).observations.length, 0);
  assert.throws(() => wiki.markers.get(dog.markerId), { statusCode: 404 });
  assert.equal(wiki.list({ tag: "猫" }).pagination.total, 0);
  assert.equal(wiki.markers.get(manual.id).origin, "manual");
  assert.equal(wiki.markers.get(corrected.id).origin, "corrected");
  wiki.vocabulary.removeAlias("tag", alias.id);
  const current = repo.results(video.id).observations.find((item) => item.id === dog.id);
  assert.equal(current.status, "suggested");
  assert.equal(current.markerId, null);
  assert.equal(current.revision, dog.revision + 1);
  assert.throws(() => repo.accept(dog.id, { revision: dog.revision }), { statusCode: 409 });
  const accepted = repo.accept(current.id, { revision: current.revision });
  assert.equal(wiki.markers.get(accepted.markerId).origin, "ai");
  assert.deepEqual(wiki.markers.get(accepted.markerId).tags, ["狗"]);
});

for (const auto of [true, false]) test(`corrected markers only block the same observation identity during ${auto ? "automatic" : "manual"} application`, (t) => {
  const { wiki, repo, video } = fixture(t);
  const observations = [{ body: "一只猫", tags: ["猫", "室外"] }, { body: "一棵树", tags: ["树", "室外"] }];
  const initial = runAnalysis(repo, video.id, { auto: true, observations });
  const cat = initial.observations.find((item) => item.body === "一只猫"), tree = initial.observations.find((item) => item.body === "一棵树");
  const marker = wiki.markers.get(cat.markerId);
  const dog = wiki.markers.update(marker.id, { startMs: marker.startMs, endMs: marker.endMs, body: "一只狗", tags: ["狗", "室外"], targetIds: [], revision: marker.revision });
  assert.equal(wiki.markers.get(tree.markerId).body, "一棵树");
  const rerun = runAnalysis(repo, video.id, { auto, restart: true, observations: [...observations, { body: "一只狗", tags: ["室外", "狗"] }] });
  const newTree = rerun.observations.find((item) => item.body === "一棵树"), sameDog = rerun.observations.find((item) => item.body === "一只狗");
  assert.ok(newTree);
  if (auto) assert.ok(newTree.markerId);
  else assert.equal(repo.accept(newTree.id, { revision: newTree.revision }).applied, true);
  assert.equal(repo.accept(sameDog.id, { revision: sameDog.revision }).reason, "manual-overlap");
  assert.deepEqual(wiki.markers.list(video.id).markers.map((item) => item.body).sort(), ["一只狗", "一棵树"]);
  assert.equal(wiki.markers.get(dog.id).origin, "corrected");
});
