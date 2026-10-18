import { test } from "node:test";
import assert from "node:assert/strict";
import { initDb } from "../src/server/data/sqlite.js";
import { migrateWiki } from "../src/server/data/wikiMigrations.js";
import { createElementRepository } from "../src/server/data/elementRepository.js";
import { createElementService } from "../src/server/application/elementService.js";
import { elementQuery } from "../src/shared/domain/elements.js";

function setup(t) {
  const db = initDb(":memory:"); t.after(() => db.close());
  const repo = createElementRepository(db);
  return { db, repo, service: createElementService(repo) };
}

test("materials span content kinds and combine with search, tags, stacks and pagination", (t) => {
  const { repo, service } = setup(t);
  const text = service.create({ body: "人物设定", tags: ["人物"], material: true });
  const image = repo.importImage({ tags: ["人物"] }, { storageKey: "image.png", mimeType: "image/png", byteSize: 1, originalName: "人物.png", contentHash: "image" }).element;
  const video = repo.importVideo({ tags: ["人物"], material: true }, { storageKey: "video.mp4", mimeType: "video/mp4", byteSize: 1, originalName: "人物.mp4", contentHash: "video" }).element;
  const output = service.create({ body: "人物产物", tags: ["人物"] });
  service.setMaterial({ ids: [image.id], material: true });
  repo.relate(image.id, output.id, "related", "相似", { direction: "symmetric", reverseName: "" });
  const query = elementQuery(new URLSearchParams("material=1&q=人物&tag=人物&pageSize=1"));
  assert.equal(repo.list(query).pagination.total, 3);
  assert.deepEqual(new Set(repo.list({ ...query, throughPage: 3 }).elements.map((e) => e.id)), new Set([text.id, image.id, video.id]));
  for (const [kind, id] of [["text", text.id], ["image", image.id], ["video", video.id]]) {
    assert.deepEqual(repo.list({ ...query, kind }).elements.map((e) => e.id), [id]);
  }
  assert.equal(repo.list({ ...query, stackSimilar: true }).pagination.total, 3);
  assert.equal(repo.list({ material: false }).elements[0].id, output.id);
  assert.equal(repo.list({ material: true, q: "找不到" }).pagination.total, 0);
  assert.equal(repo.get(output.id).material, false);
});

test("material marking is idempotent, reversible, preserves content and survives trash/restore", (t) => {
  const { db, repo, service } = setup(t);
  const a = service.create({ body: "参考", tags: ["标签"] });
  const b = service.create({ body: "产物" });
  repo.relate(a.id, b.id, "related", "参考了", { direction: "forward", reverseName: "被参考" });
  for (let i = 0; i < 2; i++) service.setMaterial({ ids: [a.id, a.id], material: true });
  assert.deepEqual(repo.get(a.id), { ...a, material: true });
  assert.equal(repo.relations(a.id).relations.length, 1);
  repo.trash(a.id);
  assert.equal(repo.list({ material: true }).pagination.total, 0);
  repo.restore(a.id);
  assert.equal(repo.get(a.id).material, true);
  service.setMaterial({ ids: [a.id], material: false });
  assert.deepEqual(repo.get(a.id).tags, a.tags);
  assert.equal(repo.get(a.id).material, false);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("invalid batches change nothing and sessions and private intermediates are ineligible", (t) => {
  const { db, repo, service } = setup(t);
  const a = service.create({ body: "参考" });
  const session = repo.createRecord("session", "对话", { sessionId: "material-test" });
  assert.throws(() => service.setMaterial({ ids: [session.id], material: true }), /部分内容/);
  assert.throws(() => service.setMaterial({ ids: [a.id, 999999], material: true }), /部分内容/);
  assert.equal(repo.get(a.id).material, false);
  for (const payload of [null, {}, { ids: [], material: true }, { ids: [a.id], material: "true" }, { ids: [a.id], material: true, extra: 1 }, { ids: Array(101).fill(a.id), material: true }]) {
    assert.throws(() => service.setMaterial(payload));
  }
  db.prepare("UPDATE elements SET local_only=1 WHERE id=?").run(a.id);
  assert.throws(() => service.setMaterial({ ids: [a.id], material: true }), /部分内容/);
  assert.throws(() => createElementRepository(db, { publicOnly: true }).setMaterial([a.id], true), /仅限本机/);
  assert.throws(() => elementQuery(new URLSearchParams("material=yes")), /素材筛选/);
  assert.throws(() => service.create({ body: "text", material: "true" }), /素材标记/);
});

test("duplicate media import can promote to material and an ordinary import retains that flag", (t) => {
  const { repo } = setup(t);
  for (const kind of ["Image", "Video"]) {
    const file = { storageKey: kind, mimeType: kind === "Image" ? "image/png" : "video/mp4", byteSize: 1, originalName: kind, contentHash: kind };
    const first = repo[`import${kind}`]({ tags: [] }, file).element;
    assert.equal(first.material, false);
    const second = repo[`import${kind}`]({ tags: [], material: true }, file).element;
    assert.equal(second.id, first.id);
    assert.equal(second.material, true);
    assert.equal(repo[`import${kind}`]({ tags: [] }, file).element.material, true);
  }
});

test("existing libraries migrate without marking old elements and migration rolls back on failure", (t) => {
  const { db, repo } = setup(t);
  const a = repo.createText({ body: "旧内容", tags: [] });
  db.exec("DROP INDEX idx_elements_material; ALTER TABLE elements DROP COLUMN is_material; DELETE FROM wiki_schema WHERE version=39");
  db.exec("CREATE TEMP TRIGGER fail_material BEFORE INSERT ON wiki_schema WHEN NEW.version=39 BEGIN SELECT RAISE(ABORT,'fail material'); END");
  assert.throws(() => migrateWiki(db), /fail material/);
  assert.equal(db.prepare("PRAGMA table_info(elements)").all().some((c) => c.name === "is_material"), false);
  db.exec("DROP TRIGGER fail_material");
  migrateWiki(db); migrateWiki(db);
  assert.equal(repo.get(a.id).material, false);
  assert.equal(repo.get(a.id).body, a.body);
});
