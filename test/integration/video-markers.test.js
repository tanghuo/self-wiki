import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrateWiki } from "../../src/server/data/wikiMigrations.js";
import { migrateVideoMarkers } from "../../src/server/data/videoMarkerMigration.js";
import { createElementRepository } from "../../src/server/data/elementRepository.js";
import { createServer } from "../../src/server/server.js";
import { createElementService } from "../../src/server/application/elementService.js";
import { videoMarkerInput, parseMarkerTime, formatMarkerTime } from "../../src/shared/domain/videoMarkers.js";

const input = (overrides = {}) => videoMarkerInput({ startMs: 300, endMs: 1200, body: "运镜 50%_", tags: ["片段"], targetIds: [], requestKey: "marker-request-001", ...overrides });
const update = (marker, overrides = {}) => videoMarkerInput({ startMs: marker.startMs, endMs: marker.endMs, body: marker.body,
  tags: marker.tags, targetIds: marker.links.map((link) => link.id), revision: marker.revision, ...overrides }, { update: true });
function fixture(t) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON"); migrateWiki(db);
  const wiki = createElementRepository(db);
  const video = wiki.importVideo({ tags: ["整段"] }, { storageKey: "test.mp4", mimeType: "video/mp4", byteSize: 9000, originalName: "示例.mp4", contentHash: "one" }).element;
  const note = wiki.createText({ body: "参考资料", tags: [] });
  return { db, wiki, video, note };
}

test("video markers preserve whole-video tags and support canonical tag search, aliases and backlinks", (t) => {
  const { db, wiki, video, note } = fixture(t);
  const marker = wiki.markers.create(video.id, input({ targetIds: [note.id] }));
  assert.deepEqual(marker.links.map((link) => link.id), [note.id]);
  assert.equal(wiki.get(note.id).videoReferenceCount, 1);
  assert.equal(wiki.markers.references(note.id).references[0].id, marker.id);
  assert.deepEqual(wiki.get(video.id).tags, ["整段"]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM elements").get().n, 2);
  assert.ok(wiki.tags().includes("片段"));
  assert.equal(wiki.vocabulary.read().tags.find((tag) => tag.name === "片段").count, 1);
  for (const options of [{ q: "运镜" }, { q: "50%_" }, { tag: "片段" }, { q: "片段" }]) {
    assert.deepEqual(wiki.list(options).elements.map((item) => item.id), [video.id]);
  }
  assert.equal(wiki.list({ q: "50%X" }).pagination.total, 0);
  const alias = wiki.vocabulary.setAlias({ kind: "tag", alias: { name: "片段" }, canonical: { name: "镜头" } });
  assert.deepEqual(wiki.markers.get(marker.id).tags, ["镜头"]);
  assert.deepEqual(wiki.vocabulary.tagAliases(), [{ alias: "片段", name: "镜头" }].map((row) => Object.assign(Object.create(null), row)));
  for (const options of [{ tags: ["片段"] }, { tags: ["镜头"] }, { q: "片段" }, { q: "镜头" }]) {
    assert.equal(wiki.markers.list(video.id, options).pagination.total, 1);
    assert.equal(wiki.list(options).pagination.total, 1);
  }
  const renamed = wiki.markers.update(marker.id, update(wiki.markers.get(marker.id), { body: "已补充" }));
  wiki.vocabulary.removeAlias("tag", alias.id);
  assert.deepEqual(wiki.markers.get(marker.id).tags, ["片段"], "editing canonical tags must preserve historical alias bindings");
  assert.equal(renamed.revision, 2);
  assert.equal(wiki.relations(video.id).pagination.total, 0, "marker links remain scoped to the marker");
});

test("marker retries, conflicting edits, pagination and failed bindings are atomic", (t) => {
  const { db, wiki, video, note } = fixture(t);
  const payload = input({ targetIds: [note.id] }), marker = wiki.markers.create(video.id, payload);
  assert.equal(wiki.markers.create(video.id, payload).id, marker.id);
  assert.equal(wiki.markers.create(video.id, payload).reused, true);
  assert.throws(() => wiki.markers.create(video.id, { ...payload, body: "different" }), { statusCode: 409 });
  assert.throws(() => wiki.markers.create(video.id, input({ requestKey: "invalid-links", targetIds: [99999], tags: ["失败标签"] })), { statusCode: 404 });
  assert.equal(wiki.markers.list(video.id).pagination.total, 1);
  assert.ok(!wiki.tags().includes("失败标签"));
  assert.throws(() => wiki.markers.create(note.id, input()), /只有视频/);
  assert.throws(() => wiki.markers.create(video.id, input({ requestKey: "self-reference", targetIds: [video.id] })), /自身/);
  assert.throws(() => wiki.markers.update(marker.id, update(marker, { targetIds: [99999], body: "应回滚" })), { statusCode: 404 });
  assert.deepEqual(wiki.markers.get(marker.id), marker);
  const edited = wiki.markers.update(marker.id, update(marker, { endMs: null, body: "时间点" }));
  assert.equal(edited.revision, 2);
  assert.throws(() => wiki.markers.update(marker.id, update(marker, { body: "覆盖" })), { statusCode: 409 });
  assert.throws(() => wiki.markers.remove(marker.id, 1), { statusCode: 409 });
  assert.deepEqual(wiki.markers.get(marker.id), edited);
  const early = wiki.markers.create(video.id, input({ startMs: 0, requestKey: "earlier-marker" }));
  const result = wiki.markers.list(video.id, { page: 2, pageSize: 1 });
  assert.equal(result.pagination.pageCount, 2); assert.equal(result.markers[0].id, marker.id);
  assert.equal(wiki.markers.list(video.id, { pageSize: 1 }).markers[0].id, early.id);
  assert.equal(wiki.markers.list(video.id, { q: "50%_" }).pagination.total, 1);
  wiki.markers.remove(marker.id, edited.revision);
  assert.throws(() => wiki.markers.get(marker.id), { statusCode: 404 });
  assert.equal(wiki.markers.references(note.id).pagination.total, 0);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("marker edits preserve historical tags exposed beyond the limit when an alias is removed", (t) => {
  const { wiki, video } = fixture(t), service = createElementService(wiki);
  const tags = Array.from({ length: 30 }, (_, i) => `tag-${i}`);
  const marker = service.createMarker(video.id, input({ tags }));
  const alias = wiki.vocabulary.setAlias({ kind: "tag", alias: { name: tags[0] }, canonical: { name: tags[1] } });
  const combined = service.marker(marker.id);
  service.updateMarker(marker.id, { ...update(combined), tags: [...combined.tags, "another"] });
  wiki.vocabulary.removeAlias("tag", alias.id);
  const expanded = service.marker(marker.id);
  assert.equal(expanded.tags.length, 31);
  const payload = { startMs: 300, endMs: null, body: "保留历史标签", tags: expanded.tags, targetIds: [], revision: expanded.revision };
  const saved = service.updateMarker(marker.id, payload);
  assert.deepEqual(saved.tags, expanded.tags);
  assert.throws(() => service.updateMarker(marker.id, { ...payload, revision: saved.revision, tags: [...saved.tags, "extra"] }), /最多设置/);
});

test("video markers survive trash/restore, retain unavailable targets and cascade only on permanent deletion", (t) => {
  const { db, wiki, video, note } = fixture(t);
  const marker = wiki.markers.create(video.id, input({ targetIds: [note.id] }));
  wiki.trash(note.id);
  const unavailable = wiki.markers.get(marker.id);
  assert.equal(unavailable.links[0].unavailable, true);
  wiki.markers.update(marker.id, update(unavailable, { body: "只改说明" }));
  assert.throws(() => wiki.markers.create(video.id, input({ requestKey: "trash-new-link", targetIds: [note.id] })), { statusCode: 404 });
  wiki.restore(note.id); wiki.trash(video.id);
  assert.equal(wiki.markers.references(note.id).pagination.total, 0);
  assert.equal(wiki.get(note.id).videoReferenceCount, undefined);
  assert.throws(() => wiki.markers.get(marker.id), { statusCode: 404 });
  assert.equal(db.prepare("SELECT count(*) AS n FROM video_markers").get().n, 1);
  wiki.restore(video.id);
  assert.equal(wiki.get(note.id).videoReferenceCount, 1);
  assert.equal(wiki.markers.get(marker.id).links[0].unavailable, false);
  wiki.trash(note.id); wiki.purge(note.id);
  assert.deepEqual(wiki.markers.get(marker.id).links, []);
  wiki.trash(video.id); wiki.purge(video.id);
  for (const table of ["video_markers", "video_marker_tags", "video_marker_links"]) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  assert.ok(!wiki.tags().includes("片段"));
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("public marker reads hide private owners, targets, tags and backlink counts", (t) => {
  const { db, wiki, video, note } = fixture(t);
  const secret = wiki.createText({ body: "私有", tags: [], localOnly: true });
  const marker = wiki.markers.create(video.id, input({ targetIds: [note.id, secret.id] }));
  const shared = createElementRepository(db, { publicOnly: true });
  assert.deepEqual(shared.markers.get(marker.id).links.map((link) => link.id), [note.id]);
  assert.throws(() => shared.markers.references(secret.id), { statusCode: 404 });
  db.prepare("UPDATE elements SET local_only=1 WHERE id=?").run(video.id);
  assert.throws(() => shared.markers.get(marker.id), { statusCode: 404 });
  assert.equal(shared.markers.references(note.id).pagination.total, 0);
  assert.equal(shared.get(note.id).videoReferenceCount, undefined);
  assert.ok(!shared.tags().includes("片段"));
  assert.equal(shared.list({ tag: "片段" }).pagination.total, 0);
});

test("marker migration is repeatable and rolls back its schema on a late failure", (t) => {
  const { db, wiki, video } = fixture(t);
  const marker = wiki.markers.create(video.id, input());
  migrateWiki(db); migrateVideoMarkers(db);
  assert.equal(wiki.markers.get(marker.id).body, marker.body);
  db.exec(`DROP VIEW canonical_content_tag_usage; DROP VIEW content_tag_usage; DROP VIEW canonical_video_marker_tags;
    DROP TABLE video_marker_links; DROP TABLE video_marker_tags; DROP TABLE video_markers; DELETE FROM wiki_schema WHERE version=31;
    CREATE TRIGGER fail_markers BEFORE INSERT ON wiki_schema WHEN NEW.version=31 BEGIN SELECT RAISE(ABORT,'marker migration failed'); END;`);
  const before = db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
  assert.throws(() => migrateVideoMarkers(db), /marker migration failed/);
  assert.deepEqual(db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all(), before);
  assert.equal(createElementRepository(db).get(video.id).video.originalName, video.video.originalName);
  db.exec("DROP TRIGGER fail_markers"); migrateVideoMarkers(db);
  assert.equal(db.prepare("SELECT count(*) AS n FROM wiki_schema WHERE version=31").get().n, 1);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("marker time input validates bounds and round-trips millisecond positions", () => {
  for (const [text, ms] of [["0", 0], ["1.003", 1003], ["02:15.5", 135500], ["1:02:03.004", 3723004], ["168:00:00", 604800000]]) {
    assert.equal(parseMarkerTime(text), ms); assert.equal(parseMarkerTime(formatMarkerTime(ms)), ms);
  }
  for (const text of ["", "-1", "1:60", "1::2", "1:2:3:4", "1.0001", "Infinity", "169:00:00"]) assert.throws(() => parseMarkerTime(text));
  for (const patch of [{ startMs: -1 }, { startMs: 1.5 }, { endMs: 300 }, { endMs: 604800001 }, { body: "x".repeat(2001) },
    { tags: Array.from({ length: 31 }, (_, i) => String(i)) }, { targetIds: Array(13).fill(1) }, { videoId: 2 }, { requestKey: "short" }]) assert.throws(() => input(patch));
});

test("marker HTTP CRUD uses revision checks and leaves original video bytes intact", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-markers-"));
  const app = await createServer({ port: 0, dataDir: dir });
  t.after(async () => {
    await app.close(); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith("wiki-markers-"));
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const api = (route, body, method = body === undefined ? "GET" : "POST") => fetch(new URL(`api/${route}`, app.url), {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const bytes = await readFile(new URL("../fixtures/sample.mp4", import.meta.url));
  const video = await (await fetch(new URL("api/videos", app.url), { method: "POST", headers: { "x-file-name": "sample.mp4" }, body: bytes })).json();
  const created = await api(`elements/${video.id}/markers`, input());
  assert.equal(created.status, 201); const marker = await created.json();
  assert.equal((await api(`elements/${video.id}/markers`, input())).status, 200);
  assert.equal((await api(`elements/${video.id}/markers?tag=${encodeURIComponent("片段")}&pageSize=1`)).status, 200);
  assert.equal((await (await api(`elements?q=${encodeURIComponent("运镜")}`)).json()).elements[0].id, video.id);
  assert.equal((await api(`video-markers/${marker.id}`, update(marker, { body: "改动" }), "PUT")).status, 200);
  assert.equal((await api(`video-markers/${marker.id}`, { revision: 1 }, "DELETE")).status, 409);
  assert.equal((await api(`video-markers/${marker.id}`, {}, "DELETE")).status, 400);
  assert.equal((await api(`elements/${video.id}/markers`, { ...input(), endMs: -1 })).status, 400);
  const blocked = await fetch(new URL(`api/video-markers/${marker.id}`, app.url), { method: "DELETE", headers: { origin: "https://other.invalid", "content-type": "application/json" }, body: '{"revision":2}' });
  assert.equal(blocked.status, 403);
  assert.equal((await api(`video-markers/${marker.id}`, { revision: 2 }, "DELETE")).status, 200);
  assert.equal((await api(`video-markers/${marker.id}`)).status, 404);
  assert.deepEqual(Buffer.from(await (await fetch(new URL(video.video.url, app.url))).arrayBuffer()), bytes);
});
