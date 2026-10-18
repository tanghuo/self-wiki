import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateWiki } from "../src/server/data/wikiMigrations.js";
import { createElementRepository } from "../src/server/data/elementRepository.js";
import { createElementService } from "../src/server/application/elementService.js";

function setup(t) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrateWiki(db);
  t.after(() => db.close());
  const repo = createElementRepository(db);
  const wiki = createElementService(repo, {});
  const create = (body, tags = []) => wiki.create({ body, tags });
  const graph = (ids, expand = null) => wiki.canvas({ ids, expand, q: "", tag: "", limit: expand ? 100 : 0 });
  return { db, wiki, repo, create, graph };
}

test("tag relations dynamically cover members, exclude self, and agree with canvas and pagination", (t) => {
  const { db, wiki, create, graph } = setup(t);
  const source = create("参考图", ["仪玄"]), a = create("成员 A", ["仪玄"]), b = create("成员 B", ["仪玄"]);
  const payload = { sourceId: source.id, targetTags: ["仪玄"], name: "参考图" };
  wiki.relateBatch(payload); wiki.relateBatch(payload);
  migrateWiki(db);
  const grouped = wiki.relations(source.id);
  assert.equal(grouped.tagRelations.length, 1);
  assert.equal(grouped.relations.length, 0);
  assert.equal(grouped.pagination.total, 1);
  assert.equal(grouped.tagRelations[0].memberCount, 2);
  assert.deepEqual(new Set(grouped.tagRelations[0].previews.map((e) => e.id)), new Set([a.id, b.id]));
  const first = wiki.tagRelationMembers(grouped.tagRelations[0].id, { pageSize: 1, page: 1 });
  const second = wiki.tagRelationMembers(grouped.tagRelations[0].id, { pageSize: 1, page: 2 });
  assert.equal(first.pagination.total, 2);
  assert.notEqual(first.elements[0].id, second.elements[0].id);
  assert.equal(wiki.relations(a.id).relations[0].sourceId, source.id);
  assert.equal(wiki.relations(a.id).relations[0].targetTag, "仪玄");
  assert.deepEqual(graph([a.id], a.id).elements.map((e) => e.id).sort(), [source.id, a.id].sort());
  assert.equal(graph([source.id, a.id, b.id]).relations.length, 2);
  const c = create("后来加入", ["仪玄"]);
  assert.equal(wiki.relations(c.id).relations[0].element.id, source.id);
  assert.equal(wiki.relations(source.id).tagRelations[0].memberCount, 3);
  wiki.update(a.id, { tags: [] });
  assert.equal(wiki.relations(a.id).relations.length, 0);
  wiki.trash(source.id);
  assert.throws(() => wiki.tagRelationMembers(grouped.tagRelations[0].id), { statusCode: 404 });
  assert.equal(wiki.relations(b.id).relations.length, 0);
  assert.equal(graph([source.id, b.id]).relations.length, 0);
  wiki.restore(source.id);
  assert.equal(wiki.relations(b.id).relations.length, 1);
  wiki.trash(b.id);
  assert.equal(wiki.relations(source.id).pagination.total, 1);
  assert.equal(wiki.relations(source.id).tagRelations[0].memberCount, 1);
  assert.deepEqual(wiki.tagRelationMembers(grouped.tagRelations[0].id).elements.map((e) => e.id), [c.id]);
  wiki.restore(b.id);
  const rule = wiki.relations(source.id).tagRelations[0];
  wiki.unrelatedTag(rule.id);
  assert.throws(() => wiki.tagRelationMembers(rule.id), { statusCode: 404 });
  assert.equal(wiki.relations(b.id).relations.length, 0);
  assert.equal(graph([source.id, b.id]).relations.length, 0);
});

test("multiple tags remain independent and empty rules survive until source is purged", (t) => {
  const { wiki, repo, create, db } = setup(t);
  const source = create("来源"), a = create("A", ["Hero", "第二标签"]);
  wiki.relateBatch({ sourceId: source.id, targetTags: ["hero", "第二标签", "HERO"], name: "参考图" });
  assert.equal(wiki.relations(source.id).tagRelations.length, 2);
  assert.equal(wiki.relations(source.id).pagination.total, 2);
  const rules = wiki.relations(source.id).tagRelations;
  wiki.update(a.id, { tags: [] });
  assert.ok(wiki.relations(source.id).tagRelations.every((r) => r.memberCount === 0 && r.previews.length === 0));
  assert.equal(wiki.relations(source.id).relations.length, 0);
  assert.equal(wiki.relations(source.id).tagRelations.length, 2);
  wiki.update(a.id, { tags: ["Hero", "第二标签"] });
  wiki.unrelatedTag(rules.find((r) => r.targetTag === "Hero").id);
  assert.equal(wiki.relations(a.id).relations.length, 1);
  wiki.trash(a.id); repo.purge(a.id);
  assert.equal(wiki.relations(source.id).tagRelations.length, 1);
  wiki.trash(source.id); repo.purge(source.id);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tag_relations").get().n, 0);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("tag cards share pagination with direct and incoming relations without expanding outgoing members", (t) => {
  const { wiki, create } = setup(t);
  const source = create("来源", ["仪玄"]), image = create("双向来源", ["仪玄"]), direct = create("直接关联");
  const members = Array.from({ length: 40 }, (_, i) => create(`成员 ${i}`, ["仪玄", "合集"]));
  wiki.relateBatch({ sourceId: source.id, targetTags: ["仪玄", "合集"], name: "原型图" });
  wiki.relateBatch({ sourceId: image.id, targetTags: ["仪玄"], name: "原型图" });
  wiki.relate(source.id, direct.id);
  const all = wiki.relations(source.id);
  assert.equal(all.pagination.total, 4);
  assert.equal(all.tagRelations.length, 2);
  assert.equal(all.relations.length, 2);
  assert.deepEqual(new Set(all.relations.map((r) => r.element.id)), new Set([image.id, direct.id]));
  assert.ok(all.tagRelations.every((r) => r.previews.length === 4));
  assert.equal(all.tagRelations.find((r) => r.targetTag === "仪玄").memberCount, 41);
  assert.equal(all.tagRelations.find((r) => r.targetTag === "合集").memberCount, members.length);
  const first = wiki.relations(source.id, { pageSize: 3, page: 1 });
  const second = wiki.relations(source.id, { pageSize: 3, page: 2 });
  assert.equal(first.tagRelations.length, 2);
  assert.equal(first.relations.length, 1);
  assert.equal(second.tagRelations.length, 0);
  assert.equal(second.relations.length, 1);
  assert.notEqual(first.relations[0].id, second.relations[0].id);
  assert.equal(first.pagination.pageCount, 2);
  const pages = [1, 2, 3, 4].map((page) => wiki.relations(source.id, { pageSize: 1, page }));
  assert.deepEqual(pages.map((p) => p.tagRelations.length + p.relations.length), [1, 1, 1, 1]);
  assert.equal(new Set(pages.flatMap((p) => p.tagRelations.map((r) => r.id))).size, 2);
});

test("tag covers prefer at most four active images and retain text-only and empty tags", (t) => {
  const { wiki, repo, create } = setup(t);
  const source = create("来源", ["封面"]);
  const images = Array.from({ length: 6 }, (_, i) => repo.importImage({ tags: ["封面"] }, {
    storageKey: `image-${i}`, contentHash: `hash-${i}`, mimeType: "image/png", byteSize: 1, originalName: `图 ${i}`,
  }).element);
  const text = create("比图片更新的文字", ["封面"]);
  wiki.relateBatch({ sourceId: source.id, targetTags: ["封面"], name: "参考图" });
  const rule = wiki.relations(source.id).tagRelations[0];
  assert.equal(rule.memberCount, 7);
  assert.equal(rule.previews.length, 4);
  assert.ok(rule.previews.every((e) => e.kind === "image"));
  for (const image of images) wiki.trash(image.id);
  const textOnly = wiki.relations(source.id).tagRelations[0];
  assert.equal(textOnly.memberCount, 1);
  assert.deepEqual(textOnly.previews.map((e) => e.id), [text.id]);
  wiki.trash(text.id);
  const empty = wiki.relations(source.id);
  assert.equal(empty.pagination.total, 1);
  assert.equal(empty.tagRelations[0].memberCount, 0);
  assert.deepEqual(wiki.tagRelationMembers(rule.id).elements, []);
});

test("batch connections validate every target and retry without partial or duplicate writes", (t) => {
  const { wiki, create } = setup(t);
  const source = create("来源"), a = create("A", ["仪玄"]), b = create("B");
  assert.throws(() => wiki.relateBatch({ sourceId: source.id, targetIds: [a.id, 9999] }));
  assert.equal(wiki.relations(a.id).relations.length, 0);
  assert.throws(() => wiki.relateBatch({ sourceId: source.id, targetTags: ["仪玄", "不存在"] }));
  assert.equal(wiki.relations(source.id).tagRelations.length, 0);
  const payload = { sourceId: source.id, targetIds: [a.id, b.id, a.id], name: "参考图" };
  wiki.relateBatch(payload); wiki.relateBatch(payload);
  assert.equal(wiki.relations(source.id).pagination.total, 2);
  for (const invalid of [null, {}, { targetIds: [] }, { targetTags: [] }, { targetIds: [source.id] },
    { targetIds: [a.id], targetTags: ["仪玄"] }, { targetIds: [a.id], name: "a\nb" }]) {
    assert.throws(() => wiki.relateBatch(invalid === null ? null : { sourceId: source.id, ...invalid }));
  }
});
