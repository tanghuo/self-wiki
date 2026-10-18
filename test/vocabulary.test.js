import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateWiki } from "../src/server/data/wikiMigrations.js";
import { createElementRepository } from "../src/server/data/elementRepository.js";
import { createElementService } from "../src/server/application/elementService.js";
import { createOrganizationRepository } from "../src/server/data/organizationRepository.js";
import { createChatRepository } from "../src/server/data/chatRepository.js";
import { organizationOutput } from "../src/shared/domain/organization.js";

function setup(t) {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON"); migrateWiki(db); t.after(() => db.close());
  const repo = createElementRepository(db), wiki = createElementService(repo), org = createOrganizationRepository(db);
  const tagAlias = (alias, canonical) => wiki.setAlias({ kind: "tag", alias: { name: alias }, canonical: { name: canonical } });
  const relationAlias = (alias, canonical, aliasReverse = "", canonicalReverse = "") => wiki.setAlias({ kind: "relation",
    alias: { name: alias, reverseName: aliasReverse, direction: aliasReverse ? "forward" : "symmetric" },
    canonical: { name: canonical, reverseName: canonicalReverse, direction: canonicalReverse ? "forward" : "symmetric" } });
  const note = (body, tags = []) => wiki.create({ body, tags });
  const canvas = (options = {}) => wiki.canvas({ ids: [], groupIds: [], q: "", tag: "", limit: 100, ...options });
  return { db, repo, wiki, org, tagAlias, relationAlias, note, canvas };
}
function organize(org, source, tags, relations = []) {
  org.enqueue(source.id); const job = org.claim(); org.context(job.id, job.leaseToken);
  const evidence = { kind: "text", elementId: source.id, quote: source.body, reason: "正文依据" };
  return org.submit(job.id, job.leaseToken, `result-${job.id}`, organizationOutput({ summary: "整理", queries: [],
    tagAdds: tags.map((name) => ({ name, evidence })), relationAdds: relations.map((r) => ({ ...r, evidence })) }), { executor: "fixture" }, true);
}

test("default prompt aliases resolve new input, filter and search; editing preserves the original binding and unalias restores it", (t) => {
  const { db, wiki, note, canvas } = setup(t);
  const a = note("暖色城市街景", [" Prompt ", "prompts", "提示词"]);
  assert.deepEqual(a.tags, ["提示词"]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM element_tags WHERE element_id=?").get(a.id).n, 1);
  for (const tag of ["prompt", "prompts", "提示词"]) {
    assert.equal(wiki.list({ tags: [tag] }).pagination.total, 1);
    assert.equal(wiki.list({ q: tag }).pagination.total, 1);
    assert.equal(canvas({ tag }).elements.length, 1);
    assert.equal(canvas({ q: tag }).elements.length, 1);
  }
  wiki.update(a.id, { body: "补充正文", tags: ["提示词"] });
  wiki.trash(a.id);
  assert.ok(wiki.tagAliases().some((a) => a.alias === "prompt"));
  assert.equal(wiki.list({ scope: "trash", tags: ["prompts"] }).pagination.total, 1);
  wiki.restore(a.id);
  assert.equal(db.prepare("SELECT t.name FROM tags t JOIN element_tags et ON et.tag_id=t.id WHERE et.element_id=?").get(a.id).name, "prompt");
  const rule = wiki.vocabulary().aliases.find((r) => r.alias === "prompt");
  wiki.removeAlias("tag", rule.id);
  assert.deepEqual(wiki.get(a.id).tags, ["prompt"]);
  migrateWiki(db);
  assert.deepEqual(wiki.get(a.id).tags, ["prompt"], "Restart must not reinstall a removed default rule");
});

test("historical tag groups union counts, follow chains and reject cycles without partial writes", (t) => {
  const { db, wiki, note, tagAlias, canvas } = setup(t);
  const a = note("作品 A", ["Cyberpunk", "赛博风"]), b = note("作品 B", ["赛博风"]);
  const first = tagAlias("Cyberpunk", "赛博风"), second = tagAlias("赛博风", "赛博朋克");
  assert.deepEqual(wiki.get(a.id).tags, ["赛博朋克"]);
  assert.deepEqual(wiki.tags(), ["赛博朋克"]);
  const overview = canvas({ view: "tags" });
  assert.equal(overview.groups.length, 1); assert.equal(overview.groups[0].count, 2);
  assert.equal(overview.groups[0].previews.length, 2);
  assert.equal(wiki.list({ tags: ["cyberpunk", "赛博风"] }).pagination.total, 2);
  assert.throws(() => tagAlias("赛博朋克", "Cyberpunk"), /循环/);
  assert.throws(() => tagAlias("Cyberpunk", "新增主名称"), /先解除/);
  assert.equal(db.prepare("SELECT id FROM tags WHERE name='新增主名称'").get(), undefined);
  assert.equal(tagAlias("Cyberpunk", "赛博风").id, first.id);
  wiki.removeAlias("tag", second.id);
  assert.deepEqual(wiki.get(b.id).tags, ["赛博风"]);
  wiki.removeAlias("tag", first.id);
  assert.deepEqual(wiki.get(a.id).tags, ["Cyberpunk", "赛博风"]);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("tag relations collapse across tag aliases, cover future members and preserve raw rules when undone", (t) => {
  const { wiki, db, note, tagAlias, canvas } = setup(t);
  const source = note("汇总"), a = note("A", ["CG"]), b = note("B", ["插画"]);
  wiki.relateBatch({ sourceId: source.id, targetTags: ["CG", "插画"], name: "收录" });
  const alias = tagAlias("CG", "插画");
  const rules = wiki.relations(source.id).tagRelations;
  assert.equal(rules.length, 1); assert.equal(rules[0].targetTag, "插画"); assert.equal(rules[0].memberCount, 2);
  note("C", ["CG"]);
  assert.equal(wiki.tagRelationMembers(rules[0].id, {}).pagination.total, 3);
  wiki.relateBatch({ sourceId: source.id, targetTags: ["CG", "插画"], name: "收录" });
  assert.equal(db.prepare("SELECT count(*) AS n FROM tag_relations").get().n, 2);
  assert.equal(canvas().relations.length, 3);
  wiki.removeAlias("tag", alias.id);
  assert.equal(wiki.tagRelations(source.id).tagRelations.length, 2);
  tagAlias("CG", "插画"); wiki.unrelatedTag(rules[0].id);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tag_relations").get().n, 0);
  assert.equal(wiki.get(a.id).tags[0], "插画"); assert.equal(wiki.get(b.id).tags[0], "插画");
});

test("symmetric relation aliases fold historical edges, deduplicate new writes and restore exact names", (t) => {
  const { db, wiki, note, relationAlias, canvas } = setup(t);
  const a = note("A"), b = note("B");
  const raw = wiki.relate(a.id, b.id, "related", "prompt"), main = wiki.relate(a.id, b.id, "related", "提示词");
  const alias = relationAlias("prompt", "提示词");
  assert.equal(wiki.relations(a.id).pagination.total, 1);
  assert.equal(wiki.relations(b.id).relations[0].name, "提示词");
  assert.equal(canvas().relations.length, 1); assert.equal(wiki.lifecycle(a.id).relations.length, 1);
  assert.equal(wiki.relate(b.id, a.id, "related", "prompt").id, raw.id);
  assert.equal(db.prepare("SELECT count(*) AS n FROM element_relations").get().n, 2);
  wiki.removeAlias("relation", alias.id);
  assert.deepEqual(wiki.relations(a.id).relations.map((r) => r.id).sort(), [raw.id, main.id]);
  relationAlias("prompt", "提示词"); wiki.unrelated(raw.id);
  assert.equal(wiki.relations(a.id).pagination.total, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM element_relations").get().n, 0);
});

test("renaming folded tag relations retains every original tag target after removing the tag alias", (t) => {
  const { wiki, db, note, tagAlias, relationAlias } = setup(t);
  const source = note("汇总"), a = note("A", ["CG"]), b = note("B", ["插画"]);
  wiki.relateBatch({ sourceId: source.id, targetTags: ["CG", "插画"], name: "参考" });
  wiki.relateBatch({ sourceId: source.id, targetTags: ["CG"], name: "reference" });
  const alias = tagAlias("CG", "插画"); relationAlias("reference", "参考");
  const grouped = wiki.tagRelations(source.id).tagRelations[0];
  wiki.renameTagRelation(grouped.id, { name: "收录" });
  assert.equal(wiki.tagRelations(source.id).tagRelations.length, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tag_relations").get().n, 2);
  wiki.removeAlias("tag", alias.id);
  const rules = wiki.tagRelations(source.id).tagRelations;
  assert.deepEqual(rules.map((r) => r.name), ["收录", "收录"]);
  assert.deepEqual(rules.map((r) => r.targetTag).sort(), ["CG", "插画"]);
  assert.ok(wiki.relations(a.id).relations.length && wiki.relations(b.id).relations.length);
});

test("directed aliases preserve both endpoint readings and leave unknown, title and symmetric names alone", (t) => {
  const { db, wiki, note, relationAlias, canvas } = setup(t), a = note("A"), b = note("B"), c = note("C"), d = note("D");
  const directed = wiki.relate(b.id, a.id, "related", "uses", { direction: "forward", reverseName: "used by" });
  wiki.relate(c.id, a.id, "related", "uses");
  wiki.relate(d.id, a.id, "title", "uses");
  const unknown = wiki.relate(c.id, b.id, "related", "uses"); db.prepare("UPDATE element_relations SET direction=2 WHERE id=?").run(unknown.id);
  relationAlias("uses", "参考了", "used by", "被参考");
  const edge = canvas().relations.find((r) => r.id === directed.id);
  assert.equal(edge.name, "参考了"); assert.equal(edge.reverseName, "被参考"); assert.equal(edge.direction, "reverse");
  assert.equal(wiki.relate(b.id, a.id, "related", "参考了", { direction: "forward", reverseName: "被参考" }).id, directed.id);
  assert.equal(canvas().relations.filter((r) => r.name === "uses").length, 3);
  assert.throws(() => wiki.setAlias({ kind: "relation", alias: { name: "X", direction: "symmetric" }, canonical: { name: "Y", direction: "forward", reverseName: "Z" } }), /相同的方向/);
  const scope = wiki.vocabulary();
  assert.ok(scope.relations.some((r) => r.name === "uses" && r.canonicalName === "参考了" && r.direction === "forward"));
});

test("editing a folded relation updates the whole group atomically and preserves unrelated collisions", (t) => {
  const { db, wiki, note, relationAlias } = setup(t), a = note("A"), b = note("B");
  const one = wiki.relate(a.id, b.id, "related", "similar"), two = wiki.relate(a.id, b.id, "related", "相似");
  const other = wiki.relate(a.id, b.id, "related", "相关");
  relationAlias("similar", "相似");
  assert.throws(() => wiki.renameRelation(one.id, { name: "相关" }), /同名关联/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM element_relations").get().n, 3);
  wiki.renameRelation(one.id, { name: "相似" });
  assert.ok(db.prepare("SELECT 1 FROM element_relations WHERE id=?").get(two.id), "No-op edits retain originals");
  wiki.renameRelation(one.id, { name: "改写自", direction: "forward", reverseName: "被改写为" });
  assert.equal(db.prepare("SELECT count(*) AS n FROM element_relations").get().n, 2);
  assert.deepEqual(wiki.relations(a.id).relations.map((r) => r.id).sort(), [one.id, other.id]);
});

test("AI tags and relations reuse aliases, undo owns only its additions and rejection survives alternate spellings", (t) => {
  const { db, wiki, org, note, relationAlias } = setup(t), source = note("原始资料", ["prompt"]), target = note("目标资料");
  const existing = wiki.relate(source.id, target.id, "related", "prompt"); relationAlias("prompt", "提示词");
  const first = organize(org, source, ["prompts", "提示词"], [{ targetId: target.id, name: "提示词", direction: "symmetric", reverseName: "" }]);
  assert.ok(first.actions.every((a) => a.state === "existing")); org.undo(first.id);
  assert.equal(wiki.relations(source.id).relations[0].id, existing.id); assert.deepEqual(wiki.get(source.id).tags, ["提示词"]);
  const fresh = note("另一份资料");
  const second = organize(org, fresh, ["prompt", "提示词"], [{ targetId: target.id, name: "prompt", direction: "symmetric", reverseName: "" }]);
  assert.deepEqual(second.actions.map((a) => a.state), ["applied", "existing", "applied"]);
  assert.equal(wiki.get(fresh.id).aiTags[0].name, "提示词");
  org.undo(second.id);
  const retry = organize(org, fresh, ["prompts"], [{ targetId: target.id, name: "提示词", direction: "symmetric", reverseName: "" }]);
  assert.ok(retry.actions.every((a) => a.state === "rejected"));
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("AI additions retain raw alias bindings and reversed endpoint direction through unalias and undo", (t) => {
  const { db, wiki, org, note, relationAlias } = setup(t), target = note("原始资料"), source = note("引用资料");
  const alias = relationAlias("uses", "参考了", "used by", "被参考");
  const result = organize(org, source, ["prompt"], [{ targetId: target.id, name: "uses", direction: "forward", reverseName: "used by" }]);
  assert.deepEqual(result.actions.map((action) => action.state), ["applied", "applied"]);
  const tag = db.prepare("SELECT t.name FROM organization_bindings b JOIN tags t ON t.id=b.tag_id WHERE b.result_id=?").get(result.id);
  assert.equal(tag.name, "prompt");
  const relation = db.prepare("SELECT r.name,r.direction,r.reverse_name FROM organization_bindings b JOIN element_relations r ON r.id=b.relation_id WHERE b.result_id=?").get(result.id);
  assert.deepEqual({ ...relation }, { name: "uses", direction: -1, reverse_name: "used by" });
  assert.equal(wiki.relations(source.id).relations[0].name, "参考了");
  assert.equal(wiki.relations(source.id).relations[0].direction, "reverse");
  wiki.removeAlias("relation", alias.id);
  wiki.removeAlias("tag", wiki.vocabulary().aliases.find((rule) => rule.kind === "tag" && rule.alias === "prompt").id);
  assert.deepEqual(wiki.get(source.id).tags, ["prompt"]);
  assert.equal(wiki.relations(source.id).relations[0].name, "uses");
  assert.equal(org.undo(result.id).removed, 2);
  assert.deepEqual(wiki.get(source.id).tags, []);
  assert.equal(wiki.relations(source.id).relations.length, 0);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("alias changes invalidate in-flight AI contexts and chat snapshots, while ordinary text edits retain AI tag bindings", (t) => {
  const { db, wiki, org, note, tagAlias, relationAlias } = setup(t), source = note("正文资料"), target = note("目标");
  const result = organize(org, source, ["旧标签"]);
  const alias = tagAlias("旧标签", "主标签");
  wiki.update(source.id, { body: source.body, tags: ["主标签"] });
  assert.equal(db.prepare("SELECT count(*) AS n FROM organization_bindings WHERE result_id=?").get(result.id).n, 1);
  org.undo(result.id); assert.deepEqual(wiki.get(source.id).tags, []);
  org.enqueue(source.id); const job = org.claim(); org.context(job.id, job.leaseToken);
  wiki.removeAlias("tag", alias.id);
  assert.throws(() => org.context(job.id, job.leaseToken), /资料库已变化/);
  wiki.relate(source.id, target.id, "related", "former");
  const chat = createChatRepository(db), snapshot = chat.snapshot(source.id);
  relationAlias("former", "current");
  assert.throws(() => chat.unchanged([snapshot]), /已有修改/);
});

test("chat accepting alias duplicates never acquires ownership of pre-existing tags or relations", (t) => {
  const { db, wiki, note, relationAlias } = setup(t), source = note("资料", ["prompt"]), target = note("目标");
  const old = wiki.relate(source.id, target.id, "related", "prompt"); relationAlias("prompt", "提示词");
  const chat = createChatRepository(db), session = chat.create(), turn = chat.begin(session.id, { text: "整理", requestKey: "vocabulary-request", sourceIds: [] }).turn;
  const tag = chat.propose(turn.id, "vocabulary-tags", { kind: "add_tags", elementId: source.id, tags: ["prompts"], sourceIds: [], reason: "同义" }, [chat.snapshot(source.id)]);
  assert.deepEqual(chat.accept(tag.id).changes.addedTags, []); chat.undo(tag.id);
  assert.deepEqual(wiki.get(source.id).tags, ["提示词"]);
  const relation = chat.propose(turn.id, "vocabulary-relations", { kind: "add_relation", sourceId: source.id, targetId: target.id, name: "提示词", direction: "symmetric", reverseName: "", sourceIds: [], reason: "同义" }, [chat.snapshot(source.id), chat.snapshot(target.id)]);
  assert.deepEqual(chat.accept(relation.id).changes.relationIds, []); chat.undo(relation.id);
  assert.equal(wiki.relations(source.id).relations[0].id, old.id);
});

test("restricted tag suggestions and members apply visibility after resolving aliases", (t) => {
  const { repo, db, note, tagAlias } = setup(t);
  const privateItem = note("私有", ["private-name"]); db.prepare("UPDATE elements SET local_only=1 WHERE id=?").run(privateItem.id);
  tagAlias("private-name", "private-root");
  const shared = createElementRepository(db, { publicOnly: true });
  assert.deepEqual(shared.tags(), []); assert.deepEqual(shared.tagAliases(), []);
  note("共享", ["public-root"]); tagAlias("public-alias", "public-root");
  assert.deepEqual(shared.tags(), ["public-root"]);
  assert.equal(shared.list({ tags: ["public-alias"] }).pagination.total, 1);
  assert.equal(repo.list({ tags: ["private-name"] }).pagination.total, 1);
});
