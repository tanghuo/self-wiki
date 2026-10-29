import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { migrateWiki } from "../../src/server/data/wikiMigrations.js";
import { createElementRepository } from "../../src/server/data/elementRepository.js";
import { createOrganizationRepository } from "../../src/server/data/organizationRepository.js";
import { defaultOrganizationConfig, organizationConfig, organizationOutput } from "../../src/shared/domain/organization.js";
import { codexCli } from "../../src/agent/executors/codexCli.js";
import { organizationMaterial, organizationEvidence } from "../../src/agent/organizationMaterial.js";
import { createServer, fetch } from "../helpers/authenticatedServer.js";
import { createServer as createHttpServer } from "node:http";
import { defaultVideoAnalysisConfig } from "../../src/shared/domain/videoAnalysis.js";

function setup(t) {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON"); migrateWiki(db);
  t.after(() => db.close());
  return { db, wiki: createElementRepository(db), org: createOrganizationRepository(db) };
}
const note = (wiki, body = "仪玄 雨夜", tags = []) => wiki.createText({ body, tags });
const output = (id) => ({ summary: "仪玄资料", queries: [], tagAdds: [{ name: "仪玄", evidence: { kind: "text", elementId: id, quote: "仪玄", reason: "正文明确提及" } }], relationAdds: [] });
function begin(org, id) { org.enqueue(id); const j = org.claim(); org.context(j.id, j.leaseToken); return j; }
const submit = (org, j, value, auto = true) => org.submit(j.id, j.leaseToken, `key-${j.id}`, organizationOutput(value), { executor: "fixture" }, auto);

test("organization config defaults match example and invalid contracts fail", async () => {
  const defaults = defaultOrganizationConfig();
  assert.deepEqual(defaults, JSON.parse(await readFile("config/organization.example.json", "utf8")));
  assert.deepEqual(organizationConfig(defaults), defaults);
  for (const c of [{ ...defaults, unknown: true }, { ...defaults, schemaVersion: 2 }, { ...defaults, executor: { ...defaults.executor, type: "invented" } },
    { ...defaults, executor: { ...defaults.executor, codexCli: { ...defaults.executor.codexCli, codexHome: "relative" } } },
    ...["\\\\server\\share\\codex", "//server/share/codex"].map((codexHome) => ({ ...defaults, executor: { ...defaults.executor, codexCli: { ...defaults.executor.codexCli, codexHome } } }))]) assert.throws(() => organizationConfig(c));
  for (const codexHome of ["C:\\Users\\me\\.codex", "/home/me/.codex"]) assert.equal(organizationConfig({ ...defaults, executor: { ...defaults.executor, codexCli: { ...defaults.executor.codexCli, codexHome } } }).executor.codexCli.codexHome, codexHome);
  assert.throws(() => organizationOutput({ ...output(1), tagAdds: [{ name: "x", evidence: { kind: "text" } }] }));
});

test("model material preserves citation text and vocabulary without presentation metadata", (t) => {
  const { wiki, org } = setup(t);
  const source = note(wiki), job = begin(org, source.id), context = org.context(job.id, job.leaseToken);
  context.elements[0].aiTags = [{ resultId: 999, name: "unneeded-provenance" }];
  context.elements[0].bodyExcerpts = ["引用的原始片段"];
  const material = organizationMaterial(context);
  assert.equal(material.elements[0].body, context.elements[0].body);
  assert.deepEqual(material.elements[0].bodyExcerpts, ["引用的原始片段"]);
  assert.deepEqual(material.tags, context.tags.map((tag) => tag.name));
  assert.ok(!JSON.stringify(material).includes("unneeded-provenance"));
  assert.equal(material.elements[0].createdAt, undefined);
  assert.equal(material.epoch, undefined);
  const reversed = { ...material, elements: [...material.elements].reverse() };
  assert.equal(organizationEvidence(material), organizationEvidence(reversed));
  assert.notEqual(organizationEvidence(material), organizationEvidence({ ...material, elements: [...material.elements, { id: 99, body: "新资料" }] }));
});

test("visual evidence requires an attached original; description-based inference remains usable", (t) => {
  const { wiki, org } = setup(t);
  const { element: image } = wiki.importImage({ body: "", tags: [] }, { mimeType: "image/png", byteSize: 10, originalName: "sample.png", storageKey: "sample.png", contentHash: "sample" });
  const job = begin(org, image.id);
  const proposed = { summary: "画面描述", queries: [], tagAdds: [{ name: "雨夜", evidence: { kind: "visual", elementId: image.id, quote: "", reason: "画面观察" } }], relationAdds: [] };
  assert.throws(() => org.submit(job.id, job.leaseToken, "unseen", proposed, { imageIds: [] }, false), /需要实际查看原图/);
  proposed.tagAdds[0].evidence = { kind: "inference", elementId: image.id, quote: "", reason: "依据已有图片描述推断" };
  assert.equal(org.submit(job.id, job.leaseToken, "described", proposed, { imageIds: [] }, false).actions[0].state, "suggested");
});

test("automatic enqueue is atomic, content-only, durable and disabled by default", (t) => {
  const { db, wiki, org } = setup(t); note(wiki); assert.equal(org.claim(), null); org.configure(true);
  const source = note(wiki); assert.equal(org.status(source.id).jobs.length, 1);
  wiki.update(source.id, { body: source.body, tags: ["手动"] }); assert.equal(org.status(source.id).jobs.length, 1);
  wiki.update(source.id, { body: "仪玄 更新", tags: [] });
  assert.equal(org.status(source.id).jobs.length, 2); assert.equal(org.status(source.id).jobs[1].state, "cancelled");
  migrateWiki(db); assert.equal(org.status(source.id).jobs.length, 2);
  db.exec("CREATE TRIGGER fail_organization_insert BEFORE INSERT ON organization_jobs BEGIN SELECT RAISE(ABORT,'queue failed'); END");
  assert.throws(() => note(wiki, "不得部分保存"), /queue failed/); assert.equal(wiki.list({ q: "不得部分保存" }).pagination.total, 0);
});

test("idempotent submission adds incrementally; undo owns new bindings and remembers rejection", (t) => {
  const { wiki, org } = setup(t), source = note(wiki, "仪玄 雨夜", ["已有"]), j = begin(org, source.id), proposal = output(source.id);
  const r = submit(org, j, proposal); assert.deepEqual(wiki.get(source.id).tags, ["已有", "仪玄"]);
  assert.equal(submit(org, j, proposal).id, r.id);
  assert.throws(() => submit(org, j, { ...proposal, summary: "改变请求" }), /其他结果/);
  assert.equal(org.status(source.id).jobs.length, 1);
  org.undo(r.id); org.undo(r.id); assert.deepEqual(wiki.get(source.id).tags, ["已有"]);
  assert.equal(submit(org, begin(org, source.id), proposal).actions[0].state, "rejected");
});

test("image similarity requires both images and preserves symmetric provenance, undo and rejection", (t) => {
  const { wiki, org } = setup(t);
  const images = ["source", "target"].map((name) => wiki.importImage({ tags: [] }, {
    storageKey: `${name}.png`, contentHash: name, originalName: `${name}.png`, mimeType: "image/png", byteSize: 10,
  }).element);
  const [source, target] = images, job = begin(org, source.id);
  const proposal = organizationOutput({ summary: "相似画面", queries: [], tagAdds: [], relationAdds: [{
    targetId: target.id, name: "相似", direction: "symmetric", reverseName: "",
    evidence: { kind: "inference", elementId: target.id, quote: "", reason: "构图、姿势及服装细节一致，颜色略有变化" },
  }] });
  for (const imageIds of [undefined, `${source.id},${target.id}`, [], [source.id], [target.id]]) {
    assert.throws(() => org.submit(job.id, job.leaseToken, "similar", proposal, { imageIds }, true), /实际查看两张图片/);
  }
  const execution = { imageIds: images.map((image) => image.id) };
  const directed = { ...proposal, relationAdds: [{ ...proposal.relationAdds[0], direction: "forward", reverseName: "被相似" }] };
  assert.throws(() => org.submit(job.id, job.leaseToken, "directed", directed, execution, true), /双向同名/);
  const result = org.submit(job.id, job.leaseToken, "similar", proposal, execution, true);
  for (const image of images) {
    const relation = wiki.relations(image.id).relations[0];
    assert.equal(relation.name, "相似"); assert.equal(relation.direction, "symmetric"); assert.equal(relation.aiResultId, result.id);
    assert.deepEqual(wiki.get(image.id).tags, []);
  }
  org.undo(result.id);
  assert.equal(wiki.relations(source.id).relations.length, 0);
  const reverseJob = begin(org, target.id), reversed = { ...proposal, relationAdds: [{ ...proposal.relationAdds[0], targetId: source.id }] };
  assert.equal(org.submit(reverseJob.id, reverseJob.leaseToken, "reverse", reversed, execution, true).actions[0].state, "rejected");
});

test("image comparison candidates exclude private and trashed images and prioritize older visual neighbors", (t) => {
  const { db, wiki, org } = setup(t);
  const images = ["old", "private", "trash", "source"].map((name) => wiki.importImage({ tags: [] }, {
    storageKey: `${name}.png`, contentHash: name, originalName: `${name}.png`, mimeType: "image/png", byteSize: 10,
  }).element);
  const [older, privateImage, trashed, source] = images;
  db.prepare("UPDATE elements SET local_only=1 WHERE id=?").run(privateImage.id);
  wiki.trash(trashed.id);
  for (let i = 0; i < 25; i++) note(wiki, `最近文字 ${i}`);
  const job = begin(org, source.id);
  const context = org.context(job.id, job.leaseToken, [], null, [], {
    matches: [privateImage, trashed, older].map((image) => ({ kind: "image", elementId: image.id })),
  });
  assert.deepEqual(context.elements.filter((e) => e.kind === "image").map((e) => e.id), [source.id, older.id]);
  assert.deepEqual(org.context(job.id, job.leaseToken).visual, context.visual);
});

test("a full tag budget preserves alias reuse and remaining relations without partial manual edits", (t) => {
  const { wiki, org, db } = setup(t), target = note(wiki, "引用目标");
  const originalTags = ["prompt", ...Array.from({ length: 28 }, (_, index) => `已有${index}`)];
  const source = note(wiki, "仪玄 雨夜", originalTags), proposal = output(source.id);
  proposal.tagAdds = ["prompts", "仪玄", "超额标签"].map((name) => ({ ...proposal.tagAdds[0], name }));
  proposal.relationAdds = [{ targetId: target.id, name: "参考了", direction: "forward", reverseName: "被参考", evidence: proposal.tagAdds[0].evidence }];
  const result = submit(org, begin(org, source.id), proposal);
  assert.deepEqual(result.actions.map((action) => action.state), ["existing", "applied", "suggested", "applied"]);
  assert.match(result.actions[2].note, /上限/);
  assert.equal(wiki.get(source.id).tags.length, 30);
  assert.equal(db.prepare("SELECT id FROM tags WHERE name='超额标签'").get(), undefined);
  const relation = wiki.relations(source.id).relations[0];
  assert.equal(relation.direction, "reverse");
  assert.equal(relation.aiResultId, result.id);
  assert.throws(() => wiki.update(source.id, { body: "不得部分修改", tags: [...wiki.get(source.id).tags, "手工超额"] }), /超过 30/);
  assert.equal(wiki.get(source.id).body, source.body);
  assert.equal(db.prepare("SELECT id FROM tags WHERE name='手工超额'").get(), undefined);
  assert.equal(org.undo(result.id).removed, 2);
  assert.deepEqual(wiki.get(source.id).tags, ["提示词", ...originalTags.slice(1)]);
  assert.equal(wiki.relations(source.id).relations.length, 0);
});

test("a later relation conflict rolls back earlier additions and the organization receipt", (t) => {
  const { wiki, org, db } = setup(t), source = note(wiki), target = note(wiki, "已有目标"), fresh = note(wiki, "新目标");
  const existing = wiki.relate(source.id, target.id, "related", "参考了", { direction: "forward", reverseName: "被参考" });
  const proposal = output(source.id), evidence = proposal.tagAdds[0].evidence;
  proposal.relationAdds = [
    { targetId: fresh.id, name: "相关资料", direction: "symmetric", reverseName: "", evidence },
    { targetId: target.id, name: "参考了", direction: "reverse", reverseName: "被参考", evidence },
  ];
  const job = begin(org, source.id), revision = org.revision();
  assert.throws(() => submit(org, job, proposal), /已存在同名关联/);
  assert.deepEqual(wiki.get(source.id).tags, []);
  assert.deepEqual(wiki.relations(source.id).relations.map((relation) => relation.id), [existing.id]);
  assert.equal(db.prepare("SELECT id FROM tags WHERE name='仪玄'").get(), undefined);
  assert.equal(db.prepare("SELECT count(*) AS n FROM organization_bindings").get().n, 0);
  assert.equal(org.status(source.id).results.length, 0);
  assert.equal(org.status(source.id).jobs[0].state, "running");
  assert.deepEqual(org.revision(), revision);
});

test("context changes, deleted targets and stale leases never apply", (t) => {
  const { wiki, org, db } = setup(t), source = note(wiki), target = note(wiki, "另一份内容");
  let j = begin(org, source.id); wiki.update(target.id, { body: target.body, tags: ["刚修改"] });
  assert.throws(() => submit(org, j, output(source.id)), /已变化/); org.failed(j.id, j.leaseToken, "冲突", true);
  db.prepare("UPDATE organization_jobs SET available_at=0 WHERE id=?").run(j.id);
  j = org.claim(); org.context(j.id, j.leaseToken); db.prepare("UPDATE organization_jobs SET lease_until=0 WHERE id=?").run(j.id);
  const next = org.claim(); assert.notEqual(next.leaseToken, j.leaseToken);
  assert.throws(() => submit(org, j, output(source.id)), /租约/);
  org.context(next.id, next.leaseToken); wiki.trash(target.id); assert.throws(() => submit(org, next, output(source.id)), /已变化/);
  assert.deepEqual(wiki.get(source.id).tags, []);
});

test("own partial apply permits remaining suggestions; later human edit protects undo", (t) => {
  const { wiki, org } = setup(t), source = note(wiki), target = note(wiki, "配套资料"), proposal = output(source.id);
  proposal.relationAdds.push({ targetId: target.id, name: "配套资料", evidence: { kind: "inference", elementId: target.id, quote: "", reason: "需要人工判断" } });
  let r = submit(org, begin(org, source.id), proposal, false); r = org.accept(r.id, [0]); assert.deepEqual(r.actions.map((a) => a.state), ["applied", "suggested"]);
  r = org.accept(r.id, [1]); assert.equal(r.actions[1].state, "applied"); assert.equal(wiki.relations(source.id).relations.length, 1);
  wiki.update(source.id, { body: source.body, tags: ["仪玄", "人工"] }); org.undo(r.id);
  assert.deepEqual(wiki.get(source.id).tags, ["人工"]);
});

test("existing relations survive undo and reverse proposals respect rejected links", (t) => {
  const { wiki, org } = setup(t), source = note(wiki), target = note(wiki);
  wiki.relate(source.id, target.id, "related", "已有关系");
  const proposal = { ...output(source.id), relationAdds: [{ targetId: target.id, name: "已有关系", evidence: { kind: "inference", elementId: source.id, quote: "", reason: "已有" } }] };
  const r = submit(org, begin(org, source.id), proposal, false); org.accept(r.id, [0, 1]); org.undo(r.id);
  assert.equal(wiki.relations(source.id).relations.length, 1);
  const other = { ...output(source.id), tagAdds: [], relationAdds: [{ ...proposal.relationAdds[0], name: "候选关系" }] };
  const suggested = submit(org, begin(org, source.id), other, false); org.reject(suggested.id, [0]);
  const reversed = { ...other, relationAdds: [{ ...other.relationAdds[0], targetId: source.id }] };
  assert.equal(submit(org, begin(org, target.id), reversed, false).actions[0].state, "rejected");
});

test("disable invalidates leases; resume and purge preserve database consistency", (t) => {
  const { wiki, org, db } = setup(t); org.configure(true);
  const source = note(wiki), j = org.claim(); org.context(j.id, j.leaseToken);
  org.configure(false); assert.throws(() => submit(org, j, output(source.id)), /租约/); assert.equal(org.claim(), null);
  org.configure(true); assert.equal(org.claim().id, j.id); wiki.trash(source.id); wiki.purge(source.id);
  assert.equal(db.prepare("SELECT count(*) AS n FROM organization_jobs").get().n, 0); assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("suggest-only mode never applies; failed writes leave neither tags nor completion", (t) => {
  const { wiki, org, db } = setup(t), source = note(wiki, "不要仪玄");
  const r = submit(org, begin(org, source.id), output(source.id), false);
  assert.equal(r.actions[0].state, "suggested"); assert.deepEqual(wiki.get(source.id).tags, []);
  assert.throws(() => org.accept(r.id, [20]), /有效建议/);
  wiki.update(source.id, { body: "仪玄", tags: [] });
  const job = begin(org, source.id);
  db.exec("CREATE TRIGGER reject_auto_tag BEFORE INSERT ON element_tags BEGIN SELECT RAISE(ABORT,'write failed'); END");
  assert.throws(() => submit(org, job, output(source.id)), /write failed/);
  assert.equal(org.status(source.id).jobs[0].state, "running");
  assert.equal(org.status(source.id).results.length, 1); assert.deepEqual(wiki.get(source.id).tags, []);
});

test("auto applies inferred relations and provenance protects renamed and recreated bindings", (t) => {
  const { wiki, org, db } = setup(t), source = note(wiki), target = note(wiki);
  const proposal = { ...output(source.id), relationAdds: [{ targetId: target.id, name: "相关资料", evidence: { kind: "inference", elementId: target.id, quote: "", reason: "内容推断" } }] };
  const r = submit(org, begin(org, source.id), proposal);
  assert.deepEqual(r.actions.map((a) => a.state), ["applied", "applied"]);
  assert.deepEqual(wiki.get(source.id).aiTags, [{ name: "仪玄", resultId: r.id }]);
  const relation = wiki.relations(target.id).relations[0];
  assert.equal(relation.aiResultId, r.id);
  wiki.renameRelation(relation.id, { name: "参考" });
  wiki.update(source.id, { body: source.body, tags: [] });
  wiki.update(source.id, { body: source.body, tags: ["仪玄"] });
  assert.deepEqual(wiki.get(source.id).aiTags, []);
  const undone = org.undo(r.id);
  assert.equal(undone.skipped, 2);
  assert.deepEqual(wiki.get(source.id).tags, ["仪玄"]);
  assert.equal(wiki.relations(source.id).relations[0].name, "参考");
  assert.equal(submit(org, begin(org, source.id), proposal).actions[1].state, "rejected");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("cross-record replacement changes only selected bindings and persists rejection", (t) => {
  const { wiki, org } = setup(t), a = note(wiki), b = note(wiki), untouched = note(wiki, "人工", ["仪玄"]);
  const first = submit(org, begin(org, a.id), output(a.id)), second = submit(org, begin(org, b.id), output(b.id));
  const selections = [first, second].map((r) => ({ resultId: r.id, index: 0 }));
  assert.equal(org.correct(selections, "replace", "角色 B").changed, 2);
  assert.deepEqual(wiki.get(a.id).tags, ["角色 B"]);
  assert.deepEqual(wiki.get(b.id).tags, ["角色 B"]);
  assert.deepEqual(wiki.get(untouched.id).tags, ["仪玄"]);
  assert.equal(org.result(first.id).actions[0].correction, "角色 B");
  org.undo(first.id);
  assert.deepEqual(wiki.get(a.id).tags, ["角色 B"]);
  assert.equal(submit(org, begin(org, a.id), output(a.id)).actions[0].state, "rejected");
});

test("stale bulk correction is atomic; unrelated changes do not block undo", (t) => {
  const { wiki, org } = setup(t), a = note(wiki), b = note(wiki);
  const first = submit(org, begin(org, a.id), output(a.id)), second = submit(org, begin(org, b.id), output(b.id));
  wiki.update(b.id, { body: b.body, tags: ["人工"] });
  assert.throws(() => org.correct([{ resultId: first.id, index: 0 }, { resultId: second.id, index: 0 }], "remove"), /修改或移除/);
  assert.deepEqual(wiki.get(a.id).tags, ["仪玄"]);
  assert.equal(org.undo(first.id).removed, 1);
  assert.deepEqual(wiki.get(b.id).tags, ["人工"]);
});

test("relation correction merges an existing relation without owning or deleting it", (t) => {
  const { wiki, org } = setup(t), source = note(wiki), target = note(wiki);
  wiki.relate(source.id, target.id, "related", "参考");
  const proposal = { ...output(source.id), tagAdds: [], relationAdds: [{ targetId: target.id, name: "相关资料", evidence: { kind: "inference", elementId: target.id, quote: "", reason: "推断" } }] };
  const r = submit(org, begin(org, source.id), proposal);
  org.correct([{ resultId: r.id, index: 0 }], "replace", "参考");
  org.undo(r.id);
  assert.equal(wiki.relations(source.id).relations.length, 1);
  assert.equal(wiki.relations(source.id).relations[0].name, "参考");
});

test("history pagination retains old records; legacy undo remains conservative", (t) => {
  const { wiki, org, db } = setup(t), source = note(wiki);
  const r = submit(org, begin(org, source.id), output(source.id));
  db.prepare("DELETE FROM organization_bindings WHERE result_id=?").run(r.id);
  db.prepare("UPDATE organization_results SET tracked=0 WHERE id=?").run(r.id);
  note(wiki, "其他修改");
  assert.throws(() => org.undo(r.id), /已有修改/);
  for (let i = 0; i < 11; i++) submit(org, begin(org, source.id), { ...output(source.id), tagAdds: [] });
  const page = org.status(source.id), older = org.status(source.id, page.nextBefore);
  assert.equal(page.results.length, 10);
  assert.equal(older.results.length, 2);
  assert.equal(older.results.at(-1).id, r.id);
  assert.equal(older.nextBefore, null);
});

test("a manual replacement adopting another AI tag survives that other batch's undo", (t) => {
  const { wiki, org } = setup(t), source = note(wiki, "仪玄 雨夜");
  const first = submit(org, begin(org, source.id), output(source.id));
  const second = submit(org, begin(org, source.id), { ...output(source.id), tagAdds: [{ name: "雨夜", evidence: { kind: "text", elementId: source.id, quote: "雨夜", reason: "正文" } }] });
  org.correct([{ resultId: first.id, index: 0 }], "replace", "雨夜");
  assert.equal(org.undo(second.id).skipped, 1);
  assert.deepEqual(wiki.get(source.id).tags, ["雨夜"]);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-organization-test-"));
  const resource = { root };
  t.after(async () => {
    await resource.close?.();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("wiki-organization-test-"));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const executable = path.join(root, "codex-fixture.mjs");
  await writeFile(executable, `import { readFile, writeFile } from 'node:fs/promises';
const args=process.argv.slice(2);
if(args[0]==='app-server') {
  const {createInterface}=await import('node:readline');
  for await(const line of createInterface({input:process.stdin})) {
    const q=JSON.parse(line); if(q.id===undefined)continue;
    const result=q.method==='config/read'?{config:{model:'fixture-default'}}:
      q.method==='model/list'?{data:[{model:'fixture-built-in',isDefault:true}]}:{};
    console.log(JSON.stringify({id:q.id,result}));
  }
  process.exit(0);
}

if(args.includes('--version')){console.log('codex-cli fixture');process.exit(0)}
if(args.includes('--help')){console.log('--image --output-schema --ignore-user-config --ephemeral');process.exit(0)}
if(args[0]==='login'){console.log('Logged in');process.exit(0)}
if(args.includes('fixture-slow')) await new Promise(r=>setTimeout(r,30000));
if(!args.includes('--model'))process.exit(10);
if(!args.includes('read-only')||args.includes('--ignore-user-config')||!args.includes('project_doc_max_bytes=0'))process.exit(8);
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const context=JSON.parse(prompt.split('资料 JSON：\\n').at(-1));
const source=context.elements.find(e=>e.id===context.sourceId);
const output={summary:'测试整理结果',queries:[],tagAdds:[{name:'仪玄',evidence:{kind:source.kind==='image'?'visual':'text',elementId:source.id,quote:source.kind==='image'?'':'仪玄',reason:'固定进程样例'}}],relationAdds:[]};
for(let i=0;i<args.length;i++)if(args[i]==='--image' && !(await readFile(args[i+1])).length)process.exit(9);
await writeFile(args[args.indexOf('-o')+1],JSON.stringify(output));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100}}));`);
  const config = defaultOrganizationConfig(); config.executor.codexCli.executable = executable;
  config.executor.codexCli.codexHome = path.join(root, "isolated-test-auth");
  return Object.assign(resource, { config });
}

test("Codex adapter exercises subprocess output and cancellation", { timeout: 15000 }, async (t) => {
  const { config } = await fixture(t); assert.equal((await codexCli.probe(config.executor)).available, true);
  const prompt = `资料 JSON：\n${JSON.stringify({ sourceId: 1, elements: [{ id: 1, kind: "text", body: "仪玄" }] })}`;
  const records = [];
  const result = await codexCli.execute({ prompt, images: [] }, { config: config.executor, signal: AbortSignal.timeout(4000), onUsage: (event) => records.push(event) });
  assert.equal(result.output.tagAdds[0].name, "仪玄");
  assert.equal(result.execution.model, "fixture-default");
  assert.equal(records.at(-1).model, "fixture-default");
  assert.equal(records.at(-1).state, "completed");
  config.executor.codexCli.model = "fixture-slow";
  await assert.rejects(codexCli.execute({ prompt, images: [] }, { config: config.executor, signal: AbortSignal.timeout(200) }), /取消或超时/);
});

test("expired Codex login retains work without consuming retries and resumes automatically", { timeout: 25000 }, async (t) => {
  const resource = await fixture(t), { root, config } = resource;
  const executable = config.executor.codexCli.executable, script = await readFile(executable, "utf8");
  await writeFile(executable, script.replace("let prompt='';", `
console.error('private diagnostic sk-fixture-secret');
console.log(JSON.stringify({type:'turn.failed',error:{message:'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.'}}));
process.exit(1);
let prompt='';`));
  config.executor.codexCli.model = "fixture-expired";
  await assert.rejects(codexCli.execute({ prompt: "test", images: [] }, { config: config.executor, signal: AbortSignal.timeout(4000) }), (error) => {
    assert.equal(error.code, "AUTH_REQUIRED"); assert.equal(error.retryable, false);
    assert.match(error.message, /登录已失效/); assert.ok(!error.message.includes("sk-fixture-secret")); return true;
  });
  config.enabled = true;
  await writeFile(path.join(root, "organization.json"), JSON.stringify(config));
  const app = await createServer({ port: 0, dataDir: root }); resource.close = () => app.close();
  const response = await fetch(new URL("api/elements", app.url), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "仪玄", tags: [] }) });
  const source = await response.json(); assert.ok(response.ok);
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const state = await (await fetch(new URL(`api/organization/status?elementId=${source.id}`, app.url))).json();
    if (state.jobs[0]?.state === "queued" && state.executor.code === "AUTH_REQUIRED") {
      assert.equal(state.jobs[0].attempts, 0); assert.equal(state.executor.available, false);
      assert.match(state.jobs[0].error, /登录已失效/);
      await writeFile(executable, script);
      const recoveredBy = Date.now() + 15000;
      while (Date.now() < recoveredBy) {
        const recovered = await (await fetch(new URL(`api/organization/status?elementId=${source.id}`, app.url))).json();
        if (recovered.jobs[0]?.state === "succeeded") { assert.equal(recovered.jobs[0].attempts, 1); assert.equal(recovered.results.length, 1); return; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail("Worker did not resume after authentication recovered");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("Worker did not report the expired login");
});

test("Codex model attribution handles built-in defaults, explicit choices and rerouting", async (t) => {
  const { config } = await fixture(t);
  const executable = config.executor.codexCli.executable;
  const script = await readFile(executable, "utf8");
  const prompt = `资料 JSON：\n${JSON.stringify({ sourceId: 1, elements: [{ id: 1, kind: "text", body: "仪玄" }] })}`;
  const invoke = () => codexCli.execute({ prompt, images: [] }, { config: config.executor, signal: AbortSignal.timeout(4000) });
  await writeFile(executable, script.replace("config:{model:'fixture-default'}", "config:{}"));
  assert.equal((await invoke()).execution.model, "fixture-built-in");
  config.executor.codexCli.model = "fixture-explicit";
  await writeFile(executable, script.replace("if(args[0]==='app-server') {", "if(args[0]==='app-server')process.exit(11); if(false) {"));
  assert.equal((await invoke()).execution.model, "fixture-explicit");
  await writeFile(executable, script + `\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'error',message:'model rerouted: fixture-explicit -> fixture-actual (capacity)'}}));`);
  assert.equal((await invoke()).execution.model, "fixture-actual");
  config.executor.codexCli.model = null;
  await writeFile(executable, script.replace("config:{model:'fixture-default'}", "config:{}").replace("isDefault:true", "isDefault:false"));
  await assert.rejects(invoke(), /无法确定 Codex 默认模型/);
});

test("real worker HTTP integration handles new text, images, configuration and restart", { timeout: 30000 }, async (t) => {
  const resource = await fixture(t), { root, config } = resource; config.enabled = true; config.applyMode = "auto";
  await writeFile(path.join(root, "organization.json"), JSON.stringify(config));
  let app = await createServer({ port: 0, dataDir: root }); resource.close = () => app.close();
  const api = async (route, body, method = "POST") => {
    const response = await fetch(new URL(`api/${route}`, app.url), { method, headers: { "content-type": "application/json" }, ...(method !== "GET" && { body: JSON.stringify(body) }) });
    const json = await response.json(); assert.equal(response.ok, true, JSON.stringify(json)); return json;
  };
  async function completed(id) {
    const deadline = Date.now() + 18000;
    while (Date.now() < deadline) {
      const state = await api(`organization/status?elementId=${id}`, null, "GET");
      if (state.results.length) return state;
      if (state.jobs[0]?.state === "failed") assert.fail(JSON.stringify(state));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail("Worker did not complete");
  }
  const source = await api("elements", { body: "仪玄 雨夜", tags: ["手动"] });
  const finished = await completed(source.id); assert.equal(finished.results[0].actions[0].state, "applied");
  const usage = await api("token-usage?days=0", null, "GET");
  assert.equal(usage.summary.calls, 1); assert.equal(usage.summary.input, 100);
  assert.equal(usage.recent[0].context.elementId, source.id);
  assert.equal(usage.recent[0].context.round, 1);
  assert.equal(usage.recent[0].state, "completed");
  assert.equal(usage.recent[0].model, "fixture-default");
  assert.deepEqual((await api(`elements/${source.id}`, null, "GET")).tags, ["手动", "仪玄"]);
  const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: "red" } }).png().toBuffer();
  const imageResponse = await fetch(new URL("api/images", app.url), { method: "POST", body: bytes, headers: { "content-type": "application/octet-stream", "x-file-name": "sample.png" } });
  const image = await imageResponse.json(); assert.equal(imageResponse.ok, true);
  const imageDone = await completed(image.id); assert.equal(imageDone.results[0].actions[0].state, "applied");
  await api(`organization/results/${imageDone.results[0].id}/accept`, { indices: [0] });
  assert.deepEqual((await api(`elements/${image.id}`, null, "GET")).tags, ["仪玄"]);
  config.executor.codexCli.model = "fixture-slow";
  await api("organization/config", config, "PUT");
  const interrupted = await api("elements", { body: "仪玄 待恢复" });
  const deadline = Date.now() + 8000;
  while ((await api(`organization/status?elementId=${interrupted.id}`, null, "GET")).jobs[0]?.state !== "running") {
    assert.ok(Date.now() < deadline, "Worker should claim the task before shutdown");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await app.close();
  config.executor.codexCli.model = null;
  await writeFile(path.join(root, "organization.json"), JSON.stringify(config));
  app = await createServer({ port: 0, dataDir: root });
  assert.equal((await completed(interrupted.id)).results[0].actions[0].state, "applied");
  config.enabled = false; await api("organization/config", config, "PUT");
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "organization.json"), "utf8")), config);
  await app.close(); await writeFile(path.join(root, "organization.json"), '{"schemaVersion":99}');
  app = await createServer({ port: 0, dataDir: root });
  assert.match((await api("organization/status", null, "GET")).configError, /配置无效/);
  assert.equal((await api(`elements/${source.id}`, null, "GET")).id, source.id);
});


test("imported images automatically compare visual candidates and cached descriptions still require both images", { timeout: 60000 }, async (t) => {
  const resource = await fixture(t), { root, config } = resource;
  let unavailable = false;
  const encoder = createHttpServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    if (unavailable) { res.writeHead(503); res.end(); return; }
    const body = JSON.parse(raw);
    const embeddings = body.images ? await Promise.all(body.images.map(async (value) => {
      const stats = await sharp(Buffer.from(value, "base64")).stats();
      return stats.channels[0].mean > stats.channels[2].mean ? [1, 0] : [0, 1];
    })) : body.texts.map(() => [1, 0]);
    res.end(JSON.stringify({ model: body.model, revision: body.revision, fingerprint: "a".repeat(64), dimensions: 2, embeddings }));
  });
  await new Promise((resolve) => encoder.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { encoder.close(resolve); encoder.closeAllConnections(); }));
  const videoConfig = defaultVideoAnalysisConfig();
  videoConfig.visual = { ...videoConfig.visual, enabled: true, baseUrl: `http://127.0.0.1:${encoder.address().port}` };
  await writeFile(path.join(root, "video-analysis.json"), JSON.stringify(videoConfig));
  const executable = config.executor.codexCli.executable, script = await readFile(executable, "utf8");
  await writeFile(executable, script.replace("await writeFile(args[args.indexOf('-o')+1]", `
output.tagAdds=[];
if(source.filename==='variant.png' || source.filename==='cached.png') {
  const target=context.elements.find(e=>e.filename==='older.png');
  const attached=prompt.split('附件顺序对应元素：')[1].split('\\n')[0].split(',').map(Number);
  if(!target || ![source.id,target.id].every(id=>attached.includes(id)))process.exit(12);
  if(source.filename==='cached.png' && !source.semanticDescription)process.exit(13);
  output.relationAdds=[{targetId:target.id,name:'相似',direction:'symmetric',reverseName:'',evidence:{kind:'visual',elementId:target.id,quote:'',reason:'固定样例验证两图已提供，构图和主体一致，尺寸不同'}}];
}
await writeFile(args[args.indexOf('-o')+1]`));
  await writeFile(path.join(root, "organization.json"), JSON.stringify(config));
  const app = await createServer({ port: 0, dataDir: root }); resource.close = () => app.close();
  const api = async (route, body, method = body ? "POST" : "GET") => {
    const response = await fetch(new URL(`api/${route}`, app.url), { method, headers: { "content-type": "application/json" },
      ...(body && { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  async function upload(name, color, width) {
    const bytes = await sharp({ create: { width, height: 12, channels: 3, background: color } }).png().toBuffer();
    const response = await fetch(new URL("api/images", app.url), { method: "POST", body: bytes,
      headers: { "content-type": "application/octet-stream", "x-file-name": name } });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  }
  async function until(fn) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { const result = await fn(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 100)); }
    assert.fail("Image comparison did not finish");
  }
  const finished = (id) => until(async () => {
    const state = await api(`organization/status?elementId=${id}`);
    assert.notEqual(state.jobs[0]?.state, "failed", state.jobs[0]?.error);
    return state.results[0] ? api(`organization/results/${state.results[0].id}`) : null;
  });
  const target = await upload("older.png", "red", 10);
  for (let i = 0; i < 15; i++) await upload(`unrelated-${i}.png`, "blue", 20 + i);
  const cached = await upload("cached.png", "red", 12);
  const cacheDb = new DatabaseSync(path.join(root, "library.sqlite3"));
  try { cacheDb.prepare("UPDATE semantic_documents SET description='已有图片说明' WHERE element_id=?").run(cached.id); }
  finally { cacheDb.close(); }
  await until(async () => { const status = await api("visual-index/status"); return status.ready && status.pending === 0 && status.indexed >= 17; });
  await api("organization/enqueue", { elementId: cached.id });
  const suggested = await finished(cached.id);
  assert.equal(suggested.actions[0].state, "suggested");
  assert.equal(suggested.context.visual.matches[0].elementId, target.id);
  assert.ok(suggested.execution.imageIds.includes(target.id)); assert.ok(suggested.execution.imageIds.includes(cached.id));
  assert.equal((await api(`elements/${cached.id}/relations`)).relations.length, 0);

  config.enabled = true; config.applyMode = "auto";
  await api("organization/config", config, "PUT");
  const imported = await upload("variant.png", "red", 13), result = await finished(imported.id);
  assert.equal(result.actions[0].state, "applied"); assert.equal(result.actions[0].name, "相似");
  assert.equal(result.context.visual.matches[0].elementId, target.id);
  for (const id of [target.id, imported.id]) {
    const relations = (await api(`elements/${id}/relations`)).relations;
    assert.ok(relations.some((relation) => relation.name === "相似" && relation.aiResultId === result.id));
  }
  assert.deepEqual((await api(`elements/${imported.id}`)).tags, []);
  await api(`organization/results/${result.id}/undo`, {});
  await api("organization/enqueue", { elementId: imported.id });
  const retried = await until(async () => {
    const state = await api(`organization/status?elementId=${imported.id}`);
    return state.results.find((r) => r.id !== result.id);
  });
  assert.equal(retried.actions[0].state, "rejected");

  unavailable = true;
  const unrelated = await upload("unrelated-new.png", "blue", 50), fallback = await finished(unrelated.id);
  assert.equal(fallback.actions.length, 0);
  assert.match(fallback.context.visual.diagnostic, /503/);
  assert.ok(fallback.execution.imageIds.includes(unrelated.id));
});

test("concurrent executions share a stable cwd and clean only their own request files", async (t) => {
  const { config } = await fixture(t), executable = config.executor.codexCli.executable;
  const script = await readFile(executable, "utf8");
  await writeFile(executable, script.replace("await writeFile(args[args.indexOf('-o')+1]", `output.summary=JSON.stringify({cwd:process.cwd(),file:args[args.indexOf('-o')+1],model:args[args.indexOf('--model')+1]});
await writeFile(args[args.indexOf('-o')+1]`));
  const prompt = `资料 JSON：\n${JSON.stringify({ sourceId: 1, elements: [{ id: 1, kind: "text", body: "仪玄" }] })}`;
  const results = await Promise.all(["first", "second"].map((model) => codexCli.execute({ prompt, images: [] }, {
    config: { ...config.executor, codexCli: { ...config.executor.codexCli, model } }, signal: AbortSignal.timeout(4000),
  })));
  const [first, second] = results.map((result) => JSON.parse(result.output.summary));
  assert.equal(first.cwd, second.cwd);
  assert.notEqual(first.file, second.file);
  assert.deepEqual([first.model, second.model], ["first", "second"]);
  await assert.rejects(readFile(first.file), { code: "ENOENT" });
  await assert.rejects(readFile(second.file), { code: "ENOENT" });
});

test("worker requests only needed images and stops searches that add no evidence", { timeout: 20000 }, async (t) => {
  const resource = await fixture(t), { root, config } = resource;
  const executable = config.executor.codexCli.executable;
  const script = await readFile(executable, "utf8");
  await writeFile(executable, script.replace("await writeFile(args[args.indexOf('-o')+1]", `
if(source.body.includes('补看候选')) {
  const target=context.elements.find(e=>e.kind==='image');
  output.tagAdds=[];
  if(!args.includes('--image')) output.imageRequests=[target.id];
  else output.relationAdds=[{targetId:target.id,name:'提示词匹配',direction:'symmetric',reverseName:'',evidence:{kind:'inference',elementId:target.id,quote:'',reason:'已查看所请求图片，具体维度匹配推断'}}];
}
if(source.body.includes('空检索')) output.queries=['no-such-candidate-974893'];
await writeFile(args[args.indexOf('-o')+1]`));
  await writeFile(path.join(root, "organization.json"), JSON.stringify(config));
  const app = await createServer({ port: 0, dataDir: root }); resource.close = () => app.close();
  const api = async (route, body) => {
    const response = await fetch(new URL(`api/${route}`, app.url), { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, ...(body && { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  for (const color of ["red", "blue", "green"]) {
    const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: color } }).png().toBuffer();
    const response = await fetch(new URL("api/images", app.url), { method: "POST", body: bytes, headers: { "content-type": "application/octet-stream", "x-file-name": `${color}.png` } });
    assert.ok(response.ok); await response.json();
  }
  const finish = async (body) => {
    const source = await api("elements", { body });
    await api("organization/enqueue", { elementId: source.id });
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      const status = await api(`organization/status?elementId=${source.id}`);
      if (status.results.length) return { source, result: status.results[0] };
      assert.notEqual(status.jobs[0]?.state, "failed", status.jobs[0]?.error);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail("worker should finish");
  };
  const requested = await finish("仪玄 补看候选");
  assert.equal(requested.result.execution.rounds, 2);
  assert.equal(requested.result.execution.imageIds.length, 1);
  const usage = await api("token-usage?days=0");
  const calls = usage.recent.filter((r) => r.context.elementId === requested.source.id).sort((a, b) => a.context.round - b.context.round);
  assert.deepEqual(calls.map((r) => r.context.imageCount), [0, 1]);
  const noResults = await finish("仪玄 空检索");
  assert.equal(noResults.result.execution.rounds, 1);
  assert.deepEqual(noResults.result.execution.imageIds, []);
  assert.equal((await api("token-usage?days=0")).recent.filter((r) => r.context.elementId === noResults.source.id).length, 1);
});
