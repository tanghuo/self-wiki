import { test } from "node:test";
import assert from "node:assert/strict";
import { initDb } from "../src/server/data/sqlite.js";
import { createElementRepository } from "../src/server/data/elementRepository.js";
import { createOrganizationRepository } from "../src/server/data/organizationRepository.js";
import { textSimilarityCandidates } from "../src/server/data/textSimilarityCandidates.js";
import { organizationOutput } from "../src/shared/domain/organization.js";
import { organizationMaterial } from "../src/agent/organizationMaterial.js";

function setup(t) {
  const db = initDb(":memory:"); t.after(() => db.close());
  const wiki = createElementRepository(db), org = createOrganizationRepository(db);
  const note = (body, options = {}) => wiki.createText({ body, tags: [], ...options });
  const begin = (id) => { org.enqueue(id); const job = org.claim(); org.context(job.id, job.leaseToken); return job; };
  const proposal = (target) => organizationOutput({ summary: "核对文字", queries: [], tagAdds: [], relationAdds: [{
    targetId: target.id, name: "相似", direction: "symmetric", reverseName: "",
    evidence: { kind: "text", elementId: target.id, quote: target.body.slice(-100), reason: "内容和关键要求相同，仅少量措辞不同" },
  }] });
  const submit = (job, value, auto = true) => org.submit(job.id, job.leaseToken, `text-${job.id}`, value, { executor: "fixture" }, auto);
  return { db, wiki, org, note, begin, proposal, submit };
}

test("lexical retrieval finds old text without embeddings, excludes private/trash, and supplies complete bounded candidates", (t) => {
  const { wiki, org, note, begin } = setup(t);
  const long = "拍摄雨夜街道，人物撑透明雨伞，背景保留霓虹倒影，暖色侧光。".repeat(110);
  const older = note(`${long}结尾要求：不要出现文字水印。`);
  const hidden = note(`${long}结尾要求：不要出现文字水印。`, { localOnly: true });
  const trashed = note(`${long}结尾要求：不要出现文字水印。`); wiki.trash(trashed.id);
  for (let i = 0; i < 35; i++) note(`无关的近期资料 ${i}`);
  const source = note(`${long}结尾要求：避免文字水印。`), job = begin(source.id);
  const context = org.context(job.id, job.leaseToken);
  assert.ok(context.elements.some((e) => e.id === older.id));
  assert.ok(context.elements.every((e) => ![hidden.id, trashed.id].includes(e.id)));
  assert.equal(context.elements.find((e) => e.id === older.id).body, older.body);
  assert.equal(organizationMaterial(context).elements.find((e) => e.id === older.id).body, older.body);
  assert.ok(context.elements.filter((e) => e.kind === "text").length <= 9);
});

test("retrieval is only a shortlist: negated variants can be candidates but never create relations by score", (t) => {
  const { db, wiki, note } = setup(t);
  const positive = note("画面中是一位撑透明雨伞的女子，雨夜街道和霓虹倒影，必须出现文字水印。");
  const negative = note("画面中是一位撑透明雨伞的女子，雨夜街道和霓虹倒影，不要出现文字水印。");
  const other = note("请计算全年收支，按月份列出每笔开销并汇总余额。");
  const candidates = textSimilarityCandidates(db, positive.id);
  assert.ok(candidates.some((m) => m.elementId === negative.id));
  assert.ok(!candidates.some((m) => m.elementId === other.id));
  assert.equal(wiki.relations(positive.id).relations.length, 0);
});

test("text similarity requires complete text, target citations and symmetry; accepts, stacks, deduplicates and remembers undo", (t) => {
  const { db, wiki, org, note, begin, proposal, submit } = setup(t);
  const source = note("画面为雨夜的街道，人物撑着透明雨伞。"), target = note("雨夜街道的画面中，人物撑着一把透明雨伞。");
  const job = begin(source.id), output = proposal(target), action = output.relationAdds[0];
  for (const changes of [
    { direction: "forward", reverseName: "被相似" },
    { evidence: { ...action.evidence, kind: "inference", quote: "" } },
    { evidence: { ...action.evidence, elementId: source.id, quote: source.body } },
    { evidence: { ...action.evidence, quote: "不存在的引用" } },
  ]) assert.throws(() => submit(job, { ...output, relationAdds: [{ ...action, ...changes }] }), /完整正文|依据/);
  const originalContext = db.prepare("SELECT context FROM organization_jobs WHERE id=?").get(job.id).context;
  const truncated = JSON.parse(originalContext); truncated.elements.find((e) => e.id === source.id).body = source.body.slice(0, 5);
  db.prepare("UPDATE organization_jobs SET context=? WHERE id=?").run(JSON.stringify(truncated), job.id);
  assert.throws(() => submit(job, output), /完整正文/);
  db.prepare("UPDATE organization_jobs SET context=? WHERE id=?").run(originalContext, job.id);
  const suggested = submit(job, output, false);
  assert.equal(wiki.relations(source.id).relations.length, 0);
  org.accept(suggested.id, [0]);
  assert.equal(wiki.relations(source.id).relations[0].aiResultId, suggested.id);
  assert.equal(wiki.list({ kind: "text", stackSimilar: true }).pagination.total, 1);
  const duplicate = submit(begin(target.id), proposal(source));
  assert.equal(duplicate.actions[0].state, "existing");
  org.undo(suggested.id);
  assert.equal(wiki.list({ kind: "text", stackSimilar: true }).pagination.total, 2);
  assert.equal(submit(begin(target.id), proposal(source)).actions[0].state, "rejected");
});

test("editing either endpoint invalidates untouched AI similarities, keeps manual links and usage, and allows fresh analysis", (t) => {
  const { db, wiki, org, note, begin, proposal, submit } = setup(t);
  const source = note("一份雨夜街景的完整拍摄要求"), target = note("另一份雨夜街景的完整拍摄要求"), manual = note("人工保留关联");
  submit(begin(source.id), proposal(target));
  wiki.relate(target.id, manual.id, "related", "相似");
  wiki.recordUsage(target.id, "copy"); wiki.recordUsage(target.id, "reference");
  wiki.update(target.id, { body: target.body, tags: ["仅修改标签"] });
  assert.equal(wiki.relations(source.id).relations.length, 1);
  wiki.update(target.id, { body: `${target.body}，调整正文`, tags: [] });
  assert.equal(wiki.relations(source.id).relations.length, 0);
  assert.equal(wiki.relations(target.id).relations.length, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM element_usage_events WHERE element_id=?").get(target.id).n, 2);
  assert.equal(org.status(source.id).results[0].actions[0].editable, false);
  assert.equal(submit(begin(source.id), proposal(wiki.get(target.id))).actions[0].state, "applied");
  const relation = wiki.relations(source.id).relations[0];
  wiki.renameRelation(relation.id, { name: "手工相似" });
  wiki.update(source.id, { body: `${source.body}，保留人工修改的关联`, tags: [] });
  assert.equal(wiki.relations(source.id).relations[0].name, "手工相似");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("text batch scan is bounded and excludes new, private and trashed text from its captured range", (t) => {
  const { wiki, org, note } = setup(t);
  for (let i = 0; i < 103; i++) note(`待扫描的文字 ${i}`);
  note("私有文字", { localOnly: true });
  const trashed = note("回收站文字"); wiki.trash(trashed.id);
  const first = org.textBatch(0, null);
  assert.equal(first.ids.length, 100); assert.ok(first.nextAfter);
  const future = note("开始扫描后新增的文字");
  const second = org.textBatch(first.nextAfter, first.throughId);
  assert.equal(second.ids.length, 3); assert.equal(second.nextAfter, null);
  assert.ok(!second.ids.includes(future.id));
  org.enqueue(first.ids[0]); org.enqueue(first.ids[0]);
  assert.equal(org.status(first.ids[0]).jobs.length, 1);
});
