import { test } from "node:test";
import assert from "node:assert/strict";
import { initDb } from "../../src/server/data/sqlite.js";
import { createElementRepository } from "../../src/server/data/elementRepository.js";
import { createElementService } from "../../src/server/application/elementService.js";

function setup(t) {
  const db = initDb(":memory:"); t.after(() => db.close());
  const repo = createElementRepository(db), wiki = createElementService(repo);
  const first = wiki.create({ body: "原始资料" }), second = wiki.create({ body: "后续作品" });
  const alias = (name, reverseName, canonical, canonicalReverse) => wiki.setAlias({ kind: "relation",
    alias: { name, reverseName, direction: reverseName ? "forward" : "symmetric" },
    canonical: { name: canonical, reverseName: canonicalReverse, direction: canonicalReverse ? "forward" : "symmetric" } });
  return { db, wiki, first, second, alias };
}

test("reference roles survive canonical renaming and alias chains at both normalized endpoints", (t) => {
  const { wiki, first, second, alias } = setup(t);
  wiki.relate(second.id, first.id, "related", "参考了", { direction: "forward", reverseName: "被参考" });
  const rule = alias("参考了", "被参考", "借鉴了", "被借鉴");
  alias("借鉴了", "被借鉴", "inspired by", "inspired");
  const result = wiki.relations(second.id).relations[0], source = wiki.relations(first.id).relations[0];
  assert.equal(result.name, "inspired by"); assert.equal(result.direction, "reverse");
  assert.equal(result.role, "reference"); assert.equal(source.role, "referencedBy");
  wiki.removeAlias("relation", rule.id);
  assert.equal(wiki.relations(second.id).relations[0].name, "参考了");
  assert.equal(wiki.relations(second.id).relations[0].role, "reference");
});

test("canonical new writes and symmetric matches use confirmed meanings, not literal display labels", (t) => {
  const { wiki, first, second, alias } = setup(t);
  alias("参考了", "被参考", "uses", "used by");
  wiki.relate(second.id, first.id, "related", "uses", { direction: "forward", reverseName: "used by" });
  alias("相似", "", "resembles", "");
  wiki.relate(first.id, second.id, "related", "resembles");
  for (const id of [first.id, second.id]) assert.equal(wiki.relations(id).relations.find((r) => r.name === "resembles").role, "match");
  assert.equal(wiki.relations(second.id).relations.find((r) => r.name === "uses").role, "reference");
});

test("unknown directions, title relations and ambiguous alias meanings do not infer a role", (t) => {
  const { db, wiki, first, second, alias } = setup(t);
  const unknown = wiki.relate(second.id, first.id, "related", "参考了", { direction: "forward", reverseName: "被参考" });
  db.prepare("UPDATE element_relations SET direction=2,reverse_name='' WHERE id=?").run(unknown.id);
  wiki.relate(first.id, second.id, "title", "生成自");
  assert.ok(wiki.relations(first.id).relations.every((r) => r.role === ""));
  alias("参考了", "被参考", "参考资料", "参考自");
  wiki.relate(first.id, second.id, "related", "参考资料", { direction: "forward", reverseName: "参考自" });
  for (const id of [first.id, second.id]) assert.equal(wiki.relations(id).relations.find((r) => r.name === "参考资料" && r.direction !== "unknown").role, "");
});

test("generated prompt and session roles stay on the receiving endpoint after aliases", (t) => {
  const { wiki, first, second, alias } = setup(t);
  wiki.relate(first.id, second.id, "related", "提示词", { direction: "forward", reverseName: "使用提示词" });
  wiki.relate(first.id, second.id, "related", "产出", { direction: "forward", reverseName: "来自会话" });
  alias("提示词", "使用提示词", "prompt for", "prompted by");
  alias("产出", "来自会话", "produced", "conversation");
  assert.deepEqual(wiki.relations(second.id).relations.map((r) => r.role).sort(), ["prompt", "session"]);
  assert.ok(wiki.relations(first.id).relations.every((r) => r.role === ""));
});
