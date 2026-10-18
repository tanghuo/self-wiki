import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateWiki } from "../src/server/data/wikiMigrations.js";
import { createElementRepository } from "../src/server/data/elementRepository.js";
import { createElementService } from "../src/server/application/elementService.js";
import { elementQuery } from "../src/shared/domain/elements.js";

function setup(t) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON"); migrateWiki(db); t.after(() => db.close());
  const repo = createElementRepository(db), wiki = createElementService(repo);
  let counter = 0;
  function media(kind = "image", tags = [], localOnly = false) {
    const index = ++counter;
    const file = { storageKey: `media-${index}`, mimeType: kind === "image" ? "image/png" : "video/mp4", byteSize: 10,
      originalName: `media-${index}`, contentHash: `hash-${index}` };
    const { element } = kind === "image" ? repo.importImage({ tags, localOnly }, file) : repo.importVideo({ tags, localOnly }, file);
    const time = new Date(Date.UTC(2026, 0, index)).toISOString();
    db.prepare("UPDATE elements SET created_at=?,updated_at=? WHERE id=?").run(time, time, element.id);
    return wiki.get(element.id);
  }
  const link = (a, b, name = "相似", semantics = {}) => wiki.relate(a.id, b.id, "related", name, semantics);
  const list = (query = {}) => wiki.list({ stackSimilar: true, ...query });
  return { db, repo, wiki, media, link, list };
}

test("similar chains and cycles stack across pages with newest-created covers, while ordinary lists stay flat", (t) => {
  const { db, wiki, media, link, list } = setup(t);
  const a = media(), b = media(), c = media(), other = media("video");
  link(a, b); link(b, c); link(c, a);
  db.prepare("UPDATE elements SET updated_at='2099-01-01T00:00:00.000Z' WHERE id=?").run(a.id);
  const first = list({ pageSize: 1 });
  assert.equal(first.pagination.total, 2);
  assert.equal(first.pagination.pageCount, 2);
  assert.equal(first.totalElements, 4);
  assert.equal(first.elements[0].id, c.id, "Editing the oldest member must not make it the cover");
  assert.deepEqual(first.elements[0].similarStack, { count: 3 });
  assert.deepEqual(list({ pageSize: 1, page: 2 }).elements.map((e) => e.id), [other.id]);
  assert.equal(wiki.list().pagination.total, 4);
  assert.ok(wiki.list().elements.every((e) => !e.similarStack));
  assert.deepEqual(list({ stackOf: b.id, pageSize: 2 }).elements.map((e) => e.id), [c.id, b.id]);
  assert.deepEqual(list({ stackOf: b.id, pageSize: 2, page: 2 }).elements.map((e) => e.id), [a.id]);
  db.prepare("UPDATE elements SET created_at=? WHERE id=?").run(c.createdAt, b.id);
  assert.equal(list().elements.find((e) => e.similarStack).id, c.id, "Equal timestamps use the greater ID");
});

test("filtering selects the newest matching member without breaking chains through nonmatching media", (t) => {
  const { media, link, list } = setup(t);
  const a = media("image", ["keeper"]), b = media("video"), c = media("image", ["keeper"]), d = media("video");
  link(a, b); link(b, c); link(c, d);
  const filtered = list({ kind: "image", tags: ["keeper"] });
  assert.deepEqual(filtered.elements.map((e) => e.id), [c.id]);
  assert.equal(filtered.totalElements, 2);
  assert.equal(filtered.elements[0].similarStack.count, 4);
  assert.equal(list({ q: a.image.originalName }).elements[0].id, a.id);
  assert.equal(list({ q: "semantic only", semanticIds: [a.id, c.id] }).elements[0].id, c.id);
  assert.equal(list({ q: "absent" }).pagination.total, 0);
  assert.deepEqual(list({ stackOf: a.id }).elements.map((e) => e.id), [d.id, c.id, b.id, a.id]);
});

test("only explicit symmetric similarity between media counts; canonical aliases are respected", (t) => {
  const { wiki, media, link, list } = setup(t);
  const a = media("image", ["same"]), b = media("image", ["same"]), c = media(), d = media(), e = media(), f = media();
  const note = wiki.create({ body: "bridge" });
  link(a, note); link(note, b); link(b, c, "相关");
  link(c, d, "相似", { direction: "forward", reverseName: "被比较" });
  link(d, e, "视觉接近");
  wiki.relateBatch({ sourceId: f.id, targetTags: ["same"], name: "相似" });
  assert.equal(list().pagination.total, 7);
  wiki.setAlias({ kind: "relation", alias: { name: "视觉接近", direction: "symmetric" }, canonical: { name: "相似", direction: "symmetric" } });
  assert.equal(list().pagination.total, 6);
  assert.equal(list().elements.find((item) => item.similarStack).id, e.id);
  assert.deepEqual(list({ stackOf: note.id }).elements.map((e) => e.id), [note.id], "Text cannot bridge media stacks");
});

test("trash, restore and unlink recompute components; private media cannot bridge shared stacks", (t) => {
  const { db, wiki, media, link, list } = setup(t);
  const a = media(), b = media("video", [], true), c = media();
  link(a, b); const edge = link(b, c);
  const publicRepo = createElementRepository(db, { publicOnly: true });
  assert.equal(list().pagination.total, 1);
  const publicList = publicRepo.list({ stackSimilar: true });
  assert.equal(publicList.pagination.total, 2);
  assert.ok(publicList.elements.every((item) => !item.similarStack));
  assert.deepEqual(publicRepo.list({ stackOf: a.id }).elements.map((e) => e.id), [a.id]);
  assert.throws(() => publicRepo.list({ stackOf: b.id }), /不存在/);
  wiki.trash(b.id);
  assert.equal(list().pagination.total, 2);
  assert.equal(list({ scope: "trash" }).elements[0].id, b.id);
  wiki.restore(b.id);
  assert.equal(list().pagination.total, 1);
  wiki.unrelated(edge.id);
  assert.equal(list().pagination.total, 2);
  wiki.trash(b.id);
  assert.ok(list().elements.every((item) => !item.similarStack));
});

test("stack query parameters validate IDs and preserve legacy query defaults", () => {
  const plain = elementQuery(new URLSearchParams());
  assert.equal(plain.stackSimilar, undefined);
  assert.equal(elementQuery(new URLSearchParams("stackSimilar=1")).stackSimilar, true);
  assert.equal(elementQuery(new URLSearchParams("stackOf=9")).stackOf, 9);
  for (const value of ["stackSimilar=maybe", "stackOf=0", "stackOf=-1", "stackOf=abc"]) {
    assert.throws(() => elementQuery(new URLSearchParams(value)));
  }
});


test("stack pagination reuses groups until data changes and range refresh preserves page boundaries", (t) => {
  const { db, wiki, media, link, list } = setup(t);
  const a = media(), b = media(), c = media(), d = media();
  link(a, b);
  const original = db.prepare.bind(db);
  let scans = 0;
  db.prepare = (sql) => { if (sql.includes("SELECT e.id,e.created_at")) scans++; return original(sql); };
  assert.equal(list({ pageSize: 1 }).elements.length, 1);
  assert.equal(list({ pageSize: 1, page: 2 }).elements.length, 1);
  assert.equal(scans, 1);
  const range = list({ pageSize: 1, throughPage: 3 });
  assert.equal(range.elements.length, 3); assert.equal(range.pagination.page, 3);
  assert.equal(scans, 1);
  link(c, d);
  assert.equal(list({ pageSize: 1, throughPage: 3 }).elements.length, 2);
  assert.equal(scans, 2);
  wiki.trash(d.id);
  assert.equal(list().elements.some((element) => element.id === d.id), false);
  assert.equal(scans, 3);
  const plain = wiki.list({ pageSize: 1, throughPage: 3 });
  assert.equal(plain.elements.length, 3); assert.equal(plain.pagination.page, 3);
});


test("rolled-back stack reads cannot publish uncommitted groups into later pages", (t) => {
  const { db, media, link, list } = setup(t);
  const a = media(), b = media();
  db.exec("BEGIN IMMEDIATE"); link(a, b);
  assert.equal(list().pagination.total, 1);
  db.exec("ROLLBACK");
  assert.equal(list().pagination.total, 2);
});

test("text stacks use the most-used matching cover and sort groups before pagination without sharing usage", (t) => {
  const { db, repo, wiki, media, link, list } = setup(t);
  const a = wiki.create({ body: "常用的旧版本", tags: ["keeper"] });
  const b = wiki.create({ body: "最新的版本" });
  const c = wiki.create({ body: "另一个版本", tags: ["keeper"] });
  const other = wiki.create({ body: "另一组文字" });
  const image = media();
  db.prepare("UPDATE elements SET created_at=?,updated_at=? WHERE id=?").run("2020-01-01", "2020-01-01", a.id);
  link(a, b); link(b, c); link(c, image);
  for (let i = 0; i < 3; i++) repo.recordUsage(a.id, i ? "reference" : "copy");
  repo.recordUsage(other.id, "copy");
  const first = list({ kind: "text", sort: "usage", pageSize: 1 });
  assert.equal(first.pagination.total, 2); assert.equal(first.totalElements, 4);
  assert.equal(first.elements[0].id, a.id); assert.equal(first.elements[0].similarStack.count, 3);
  assert.equal(list({ kind: "text", sort: "usage", pageSize: 1, page: 2 }).elements[0].id, other.id);
  assert.deepEqual(list({ stackOf: b.id }).elements.map((e) => e.id), [a.id, c.id, b.id]);
  assert.deepEqual(list({ kind: "text", q: "最新" }).elements.map((e) => e.id), [b.id]);
  assert.deepEqual(list({ kind: "text", tags: ["keeper"] }).elements.map((e) => e.id), [a.id]);
  for (let i = 0; i < 4; i++) repo.recordUsage(c.id, "copy");
  assert.equal(list({ kind: "text", sort: "usage" }).elements[0].id, c.id, "Recording usage invalidates the grouped cache");
  const publicRepo = createElementRepository(db, { publicOnly: true });
  assert.deepEqual(publicRepo.list({ stackOf: a.id }).elements.map((e) => e.id), [c.id, b.id, a.id]);
  const newest = wiki.create({ body: "最新但未使用的版本" }); link(b, newest);
  assert.equal(publicRepo.list({ kind: "text", stackSimilar: true }).elements.find((e) => e.similarStack).id, newest.id);
  assert.equal(list({ kind: "text" }).elements.find((e) => e.similarStack).id, c.id);
  wiki.trash(b.id);
  assert.ok(list({ kind: "text" }).elements.every((e) => !e.similarStack));
  assert.equal(list({ kind: "image" }).elements[0].id, image.id);
});
