import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateWiki } from "../src/server/data/wikiMigrations.js";
import { migrateVideos } from "../src/server/data/videoMigration.js";
import { createElementRepository } from "../src/server/data/elementRepository.js";
import { createOrganizationRepository } from "../src/server/data/organizationRepository.js";

function legacyDb(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE wiki_schema(version INTEGER PRIMARY KEY); INSERT INTO wiki_schema VALUES(29);
    CREATE TABLE elements (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind INTEGER NOT NULL CHECK(kind IN(1,2,3,4)),
      body TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
      content_version INTEGER NOT NULL DEFAULT 1, local_only INTEGER NOT NULL DEFAULT 0 CHECK(local_only IN(0,1)),
      creation_source INTEGER NOT NULL DEFAULT 0 CHECK(creation_source IN(0,1,2)),
      CHECK((kind=2 AND body='') OR (kind IN(1,3,4) AND length(trim(body))>0))
    );
    CREATE TABLE retained_children(element_id INTEGER REFERENCES elements(id) ON DELETE CASCADE, value TEXT);
    CREATE TABLE audit(element_id INTEGER, body TEXT);
    CREATE INDEX idx_elements_updated ON elements(deleted_at,updated_at DESC,id DESC);
    CREATE VIEW visible_elements AS SELECT * FROM elements WHERE deleted_at IS NULL;
    CREATE TRIGGER record_updates AFTER UPDATE ON elements BEGIN INSERT INTO audit VALUES(NEW.id,NEW.body); END;
    CREATE TRIGGER elements_content_kind_insert BEFORE INSERT ON elements WHEN NEW.kind=4
      BEGIN SELECT RAISE(ABORT,'Operations are chat metadata, not elements'); END;
    CREATE TRIGGER elements_content_kind_update BEFORE UPDATE OF kind ON elements WHEN NEW.kind=4
      BEGIN SELECT RAISE(ABORT,'Operations are chat metadata, not elements'); END;
    INSERT INTO elements VALUES
      (2,1,'正文','created','updated',NULL,7,0,1),
      (3,2,'','image-created','image-updated',NULL,2,1,2),
      (4,3,'会话','session-created','session-updated',NULL,1,1,0),
      (8,1,'已删除','trash-created','trash-updated','deleted',9,0,1);
    INSERT INTO retained_children VALUES(2,'tag'),(3,'image'),(8,'trash');
    UPDATE sqlite_sequence SET seq=900 WHERE name='elements';`);
  return db;
}

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  migrateWiki(db);
  return { db, wiki: createElementRepository(db) };
}

function videoFile(overrides = {}) {
  return { storageKey: "video-one.mp4", mimeType: "video/mp4", byteSize: 4096, originalName: "旅行 50%_.mp4", contentHash: "video-hash", ...overrides };
}

test("video migration preserves rows, foreign references, schema objects and retired kind 4 while extending the kind constraint", (t) => {
  const db = legacyDb(t);
  const before = db.prepare("SELECT * FROM elements ORDER BY id").all();
  const children = db.prepare("SELECT * FROM retained_children ORDER BY element_id").all();
  const schema = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN('index','trigger','view') ORDER BY name").all();
  assert.throws(() => db.exec("INSERT INTO elements(kind,created_at,updated_at) VALUES(5,'now','now')"), /CHECK/);
  migrateVideos(db);
  migrateVideos(db);
  assert.deepEqual(db.prepare("SELECT * FROM elements ORDER BY id").all(), before);
  assert.deepEqual(db.prepare("SELECT * FROM retained_children ORDER BY element_id").all(), children);
  for (const item of schema) assert.deepEqual(db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name=?").get(item.name), item);
  assert.equal(db.prepare("SELECT count(*) AS n FROM visible_elements").get().n, 3);
  assert.equal(db.prepare("SELECT count(*) AS n FROM wiki_schema WHERE version=30").get().n, 1);
  const id = db.prepare("INSERT INTO elements(kind,created_at,updated_at) VALUES(5,'now','now')").run().lastInsertRowid;
  assert.equal(id, 901);
  db.prepare("INSERT INTO element_videos VALUES(?,?,?,?,?,?)").run(id, "managed.mp4", "video/mp4", 100, "original.mp4", "hash");
  assert.throws(() => db.exec("INSERT INTO elements(kind,body,created_at,updated_at) VALUES(5,'invalid','now','now')"), /CHECK/);
  assert.throws(() => db.exec("INSERT INTO elements(kind,body,created_at,updated_at) VALUES(4,'old operation','now','now')"), /Operations/);
  assert.throws(() => db.exec("UPDATE elements SET kind=4 WHERE id=2"), /Operations/);
  assert.throws(() => db.exec("INSERT INTO element_videos VALUES(9999,'bad.mp4','video/mp4',10,'bad.mp4','bad')"), /FOREIGN KEY/);
  db.exec("UPDATE elements SET updated_at='later' WHERE id=2");
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit WHERE element_id=2").get().n, 1);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
});

test("video migration rolls back the entire rebuild and restores foreign-key enforcement on late failure", (t) => {
  const db = legacyDb(t);
  db.exec("CREATE TRIGGER fail_video BEFORE INSERT ON wiki_schema WHEN NEW.version=30 BEGIN SELECT RAISE(ABORT,'migration failed'); END");
  const schema = db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
  const before = db.prepare("SELECT * FROM elements ORDER BY id").all();
  assert.throws(() => migrateVideos(db), /migration failed/);
  assert.deepEqual(db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all(), schema);
  assert.deepEqual(db.prepare("SELECT * FROM elements ORDER BY id").all(), before);
  assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='elements'").get().seq, 900);
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  db.exec("DROP TRIGGER fail_video");
  migrateVideos(db);
  assert.equal(db.prepare("SELECT count(*) AS n FROM wiki_schema WHERE version=30").get().n, 1);
});

test("video migration rejects dangling references and preserves an empty table's high-water ID", (t) => {
  const db = legacyDb(t);
  db.exec("PRAGMA foreign_keys=OFF; INSERT INTO retained_children VALUES(999,'orphan'); PRAGMA foreign_keys=ON");
  assert.throws(() => migrateVideos(db), /foreign key check failed/);
  assert.equal(db.prepare("SELECT 1 FROM wiki_schema WHERE version=30").get(), undefined);
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  db.exec("DELETE FROM retained_children; DELETE FROM elements");
  migrateVideos(db);
  assert.equal(db.prepare("INSERT INTO elements(kind,created_at,updated_at) VALUES(5,'now','now')").run().lastInsertRowid, 901);
});

test("video imports preserve provenance and queue public videos once without text indexing", (t) => {
  const { db, wiki } = fixture(t);
  db.exec("UPDATE organization_state SET enabled=1");
  const file = videoFile();
  const imported = wiki.importVideo({ tags: ["旅行"], creationSource: "manual", localOnly: true }, file);
  const id = imported.element.id;
  assert.equal(imported.element.kind, "video");
  assert.equal(imported.element.body, "");
  assert.equal(imported.element.creationSource, "manual");
  assert.equal(imported.element.importStatus, "created");
  assert.equal(imported.keepFile, true);
  assert.deepEqual(imported.element.video, { url: `/api/elements/${id}/video`, mimeType: file.mimeType, byteSize: file.byteSize, originalName: file.originalName });
  const shared = createElementRepository(db, { publicOnly: true });
  assert.throws(() => shared.video(id), /不存在/);
  assert.equal(shared.list().pagination.total, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM organization_jobs").get().n, 0, "Private imports do not enqueue");
  const reused = wiki.importVideo({ tags: ["风景"], creationSource: "chat" }, videoFile({ storageKey: "duplicate.mp4", originalName: "renamed.mp4" }));
  assert.equal(reused.keepFile, false);
  assert.equal(reused.element.id, id);
  assert.equal(reused.element.localOnly, undefined);
  assert.equal(reused.element.importStatus, "reused");
  assert.equal(reused.element.creationSource, "manual");
  assert.equal(reused.element.video.originalName, file.originalName);
  assert.deepEqual(reused.element.tags, ["旅行", "风景"]);
  const repaired = wiki.importVideo({ tags: [] }, videoFile({ storageKey: "replacement.mp4" }), file.storageKey);
  assert.equal(repaired.keepFile, true);
  assert.deepEqual(shared.video(id), { storageKey: "replacement.mp4", mimeType: file.mimeType, byteSize: file.byteSize });
  assert.equal(wiki.findVideoByHash(file.contentHash).storage_key, "replacement.mp4");
  assert.equal(wiki.importVideo({ tags: [] }, videoFile({ storageKey: "different.mp4", contentHash: "different" })).element.importStatus, "same-name");
  assert.equal(db.prepare("SELECT count(*) AS n FROM semantic_documents").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM organization_jobs").get().n, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM organization_jobs WHERE element_id=?").get(id).n, 1, "Publishing, dedup and repair do not duplicate work");
  const text = wiki.createText({ body: "AI still handles text", tags: [] });
  assert.ok(db.prepare("SELECT 1 FROM semantic_documents WHERE element_id=?").get(text.id));
  assert.ok(db.prepare("SELECT 1 FROM organization_jobs WHERE element_id=?").get(text.id));
});

test("video filename search, tags, relations and grouped canvas preserve video identity", (t) => {
  const { db, wiki } = fixture(t);
  const video = wiki.importVideo({ tags: ["旅行"] }, videoFile()).element;
  const text = wiki.createText({ body: "旅行说明", tags: ["旅行"] });
  const session = wiki.createRecord("session", "会话", { sessionId: 1 });
  const relation = wiki.relate(text.id, video.id, "title", "标题");
  assert.equal(db.prepare("SELECT kind FROM elements WHERE id=?").get(video.id).kind, 5);
  assert.equal(wiki.get(session.id).kind, "session");
  assert.deepEqual(wiki.list().elements.map((e) => e.id).sort(), [video.id, text.id].sort());
  assert.deepEqual(wiki.list({ q: "50%_" }).elements.map((e) => e.id), [video.id]);
  assert.deepEqual(wiki.list({ kind: "video", tags: ["旅行"] }).elements.map((e) => e.id), [video.id]);
  const related = wiki.relations(text.id).relations.find((r) => r.id === relation.id);
  assert.equal(related.element.kind, "video");
  assert.equal(related.element.video.originalName, video.video.originalName);
  const graph = wiki.canvas.read({ ids: [], q: "50%_", tag: "", limit: 100 });
  assert.deepEqual(graph.elements.map((e) => e.id), [video.id]);
  assert.equal(graph.elements[0].kind, "video");
  assert.equal(graph.elements[0].video.originalName, video.video.originalName);
  const grouped = wiki.canvas.read({ ids: [], q: "", tag: "", limit: 100, view: "tags" });
  const preview = grouped.groups[0].previews.find((e) => e.id === video.id);
  assert.equal(preview.kind, "video");
  assert.equal(preview.video.originalName, video.video.originalName);
});

test("video trash, restore and purge enforce lifecycle and leave image purge results compatible", (t) => {
  const { db, wiki } = fixture(t);
  const file = videoFile(), video = wiki.importVideo({ tags: ["保留"] }, file).element;
  const text = wiki.createText({ body: "视频关联", tags: [] });
  wiki.relate(text.id, video.id);
  wiki.canvas.save([{ id: video.id, x: 20, y: -30 }]);
  assert.throws(() => wiki.purge(video.id), /回收站/);
  wiki.trash(video.id);
  assert.throws(() => wiki.video(video.id), /不存在/);
  assert.throws(() => wiki.importVideo({ tags: ["不能添加"] }, file), /相同视频已在回收站/);
  const trashed = wiki.list({ scope: "trash", kind: "video" }).elements[0];
  assert.equal(trashed.kind, "video");
  assert.deepEqual(trashed.tags, ["保留"]);
  assert.equal(wiki.restore(video.id).id, video.id);
  assert.equal(wiki.relations(text.id).relations[0].element.id, video.id);
  wiki.trash(video.id);
  assert.deepEqual(wiki.purge(video.id), { kind: "video", storageKey: file.storageKey });
  assert.equal(wiki.purge(video.id), null);
  assert.equal(wiki.findVideoByHash(file.contentHash), undefined);
  for (const table of ["element_videos", "element_tags", "canvas_positions"]) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE element_id=?`).get(video.id).n, 0);
  }
  assert.deepEqual(wiki.relations(text.id).relations, []);
  const image = wiki.importImage({ tags: [] }, { ...file, storageKey: "image.png", mimeType: "image/png" }).element;
  wiki.trash(image.id);
  assert.equal(wiki.purge(image.id), "image.png");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("repositories used by historical chat migration can read records before the video table exists", (t) => {
  const { db } = fixture(t);
  db.exec("DROP INDEX idx_elements_material; ALTER TABLE elements DROP COLUMN is_material; DELETE FROM wiki_schema WHERE version=39; DROP TABLE element_videos; DELETE FROM wiki_schema WHERE version=30");
  const wiki = createElementRepository(db);
  const session = wiki.createRecord("session", "历史会话", { sessionId: 1 });
  assert.equal(wiki.get(session.id).kind, "session");
  assert.equal(wiki.list({ kind: "session", q: "历史" }).elements[0].id, session.id);
  migrateVideos(db);
  assert.equal(createElementRepository(db).get(session.id).body, "历史会话");
});

test("text organization still excludes video candidates without hiding older text and images", (t) => {
  const { db, wiki } = fixture(t);
  const source = wiki.createText({ body: "旅行笔记", tags: ["旅行"] });
  const olderText = wiki.createText({ body: "旅行旧笔记", tags: ["旅行"] });
  const olderImage = wiki.importImage({ tags: ["旅行"] }, { ...videoFile(), storageKey: "older.png", mimeType: "image/png", originalName: "旅行.png" }).element;
  const videos = [];
  for (let i = 0; i < 45; i++) videos.push(wiki.importVideo({ tags: ["旅行"] }, videoFile({ storageKey: `video-${i}.mp4`, contentHash: `hash-${i}` })).element);
  const organization = createOrganizationRepository(db);
  organization.configure(false);
  organization.enqueue(source.id);
  const job = organization.claim();
  const context = organization.context(job.id, job.leaseToken, ["旅行"], {
    matches: videos.map((video) => ({ elementId: video.id, score: 1 })),
  });
  assert.deepEqual(context.elements.map((e) => e.id).sort(), [source.id, olderText.id, olderImage.id].sort());
  assert.equal(context.total, 3);
  assert.equal(context.truncated, false);
  assert.ok(context.elements.every((e) => ["text", "image"].includes(e.kind)));
  assert.equal(organization.enqueue(videos[0].id).elementId, videos[0].id);
  // An already-captured context cannot reintroduce unsupported candidates.
  db.prepare("UPDATE organization_jobs SET context=? WHERE id=?").run(JSON.stringify({ ...context, elements: [videos[0], ...context.elements] }), job.id);
  assert.ok(organization.context(job.id, job.leaseToken).elements.every((e) => e.kind !== "video"));
});
