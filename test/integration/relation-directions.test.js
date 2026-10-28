import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { migrateWiki } from "../../src/server/data/wikiMigrations.js";
import { migrateRelationDirections } from "../../src/server/data/relationDirectionMigration.js";
import { createElementRepository } from "../../src/server/data/elementRepository.js";
import { createElementService } from "../../src/server/application/elementService.js";
import { createOrganizationRepository } from "../../src/server/data/organizationRepository.js";
import { organizationOutput } from "../../src/shared/domain/organization.js";
import { relationLabel } from "../../src/shared/domain/elements.js";
import { createChatRepository } from "../../src/server/data/chatRepository.js";

function setup(t) {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON"); migrateWiki(db); t.after(() => db.close());
  const repo = createElementRepository(db), wiki = createElementService(repo);
  const a = wiki.create({ body: "来源" }), b = wiki.create({ body: "改编", tags: ["样例"] });
  return { db, repo, wiki, a, b };
}
const semantics = { direction: "forward", reverseName: "被参考" };

test("chat snapshots retain legacy symmetric fingerprints and detect direction-only edits", (t) => {
  const { db, wiki, a, b } = setup(t), chat = createChatRepository(db);
  const r = wiki.relate(a.id, b.id, "related", "参考");
  const version = db.prepare("SELECT content_version FROM elements WHERE id=?").get(a.id).content_version;
  const relations = db.prepare("SELECT id,source_id,target_id,kind,name FROM element_relations WHERE source_id=? OR target_id=? ORDER BY id").all(a.id,a.id);
  const old = createHash("sha256").update(JSON.stringify({ version, body: a.body, tags: a.tags, relations })).digest("hex");
  const previous = chat.snapshot(a.id);
  assert.equal(previous.fingerprint, old);
  wiki.renameRelation(r.id, { name: "参考", ...semantics });
  assert.throws(() => chat.unchanged([previous]), /已有修改/);
  const directed = chat.snapshot(a.id);
  wiki.renameRelation(r.id, { name: "参考", ...semantics, direction: "reverse" });
  assert.throws(() => chat.unchanged([directed]), /已有修改/);
});

test("direction survives canonical endpoint order, restart, inverse creation and edits", (t) => {
  const { db, wiki, a, b } = setup(t);
  const r = wiki.relate(b.id, a.id, "related", "参考了", semantics);
  assert.equal(r.direction, "reverse"); assert.equal(r.sourceId, a.id);
  assert.equal(relationLabel(r, b.id), "参考了"); assert.equal(relationLabel(r, a.id), "被参考");
  assert.equal(wiki.relate(a.id, b.id, "related", "参考了", { ...semantics, direction: "reverse" }).id, r.id);
  assert.throws(() => wiki.relate(a.id, b.id, "related", "参考了", semantics), /已存在同名/);
  migrateWiki(db);
  assert.equal(createElementRepository(db).relations(a.id).relations[0].reverseName, "被参考");
  wiki.renameRelation(r.id, { name: "借鉴了" });
  assert.equal(wiki.relations(b.id, {}).relations[0].direction, "reverse");
  wiki.renameRelation(r.id, { name: "引用了", reverseName: "被引用", direction: "forward" });
  const changed = wiki.relations(a.id, {}).relations[0];
  assert.equal(relationLabel(changed, a.id), "引用了"); assert.equal(relationLabel(changed, b.id), "被引用");
  const canvas = wiki.canvas({ ids: [a.id, b.id], q: "", tag: "", limit: 0 });
  assert.equal(canvas.relations[0].direction, "forward");
});

test("batch creation is atomic and tag relations apply inverse labels to future members", (t) => {
  const { wiki, a, b } = setup(t), c = wiki.create({ body: "第三份" });
  wiki.relateBatch({ sourceId: a.id, targetIds: [b.id], name: "参考了", ...semantics });
  assert.throws(() => wiki.relateBatch({ sourceId: a.id, targetIds: [c.id, b.id], name: "参考了", ...semantics, direction: "reverse" }), /同名/);
  assert.equal(wiki.relations(c.id, {}).relations.length, 0);
  wiki.relateBatch({ sourceId: a.id, targetTags: ["样例"], name: "包含", direction: "forward", reverseName: "属于" });
  const tag = wiki.tagRelations(a.id).tagRelations[0];
  assert.equal(tag.direction, "forward");
  const future = wiki.create({ body: "后来加入", tags: ["样例"] });
  assert.match(relationLabel(wiki.relations(future.id, {}).relations[0], future.id), /^属于/);
  wiki.renameTagRelation(tag.id, { name: "包含", direction: "reverse", reverseName: "属于" });
  assert.match(relationLabel(wiki.relations(future.id, {}).relations[0], future.id), /^包含/);
});

test("invalid metadata, title direction changes and blank directed names are rejected atomically", (t) => {
  const { wiki, a, b } = setup(t);
  for (const bad of [{ direction: "unknown" }, { direction: "forward" }, { direction: "symmetric", reverseName: "bad" }]) {
    assert.throws(() => wiki.relate(a.id, b.id, "related", "参考了", bad));
  }
  const r = wiki.relate(a.id, b.id, "related", "参考了", semantics);
  assert.throws(() => wiki.renameRelation(r.id, { name: "" }), /正反名称/);
  assert.throws(() => wiki.renameRelations({ ids: [r.id], name: "" }), /正反名称/);
  assert.equal(wiki.relations(a.id, {}).relations[0].name, "参考了");
  const title = wiki.relate(a.id, b.id, "title", "标题");
  assert.throws(() => wiki.renameRelation(title.id, { name: "参考了", ...semantics }), /标题关联/);
});

test("migration preserves relation identity and marks legacy directional names unknown without guessing", (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec(`CREATE TABLE wiki_schema(version INTEGER PRIMARY KEY); INSERT INTO wiki_schema VALUES(11);
    CREATE TABLE element_relations(id INTEGER PRIMARY KEY,source_id INTEGER,target_id INTEGER,kind INTEGER,name TEXT);
    CREATE TABLE tag_relations(id INTEGER PRIMARY KEY,source_id INTEGER,tag_id INTEGER,name TEXT);
    CREATE TABLE tags(id INTEGER PRIMARY KEY,name TEXT); CREATE TABLE element_tags(element_id INTEGER,tag_id INTEGER);
    CREATE TABLE organization_bindings(element_id INTEGER,relation_id INTEGER,modified INTEGER);
    CREATE TABLE organization_rejections(element_id INTEGER,action_key TEXT,UNIQUE(element_id,action_key));
    CREATE VIEW resolved_element_relations AS SELECT * FROM element_relations;
    INSERT INTO element_relations VALUES(8,1,2,1,'参考'),(9,1,2,1,'提示词匹配'),(10,1,2,2,'参考');
    INSERT INTO tag_relations VALUES(4,1,3,'包含'); INSERT INTO organization_bindings VALUES(1,8,0);`);
  migrateRelationDirections(db); migrateRelationDirections(db);
  assert.deepEqual(db.prepare("SELECT id,direction FROM element_relations ORDER BY id").all().map((r) => [r.id,r.direction]), [[8,2],[9,0],[10,0]]);
  assert.equal(db.prepare("SELECT direction FROM tag_relations").get().direction, 2);
  assert.equal(db.prepare("SELECT modified FROM organization_bindings").get().modified, 0);
  db.prepare("UPDATE element_relations SET direction=1,reverse_name='被参考' WHERE id=8").run();
  assert.equal(db.prepare("SELECT modified FROM organization_bindings").get().modified, 1);
});

test("AI directed additions preserve provenance and human direction edits survive undo", (t) => {
  const { db, wiki, a, b } = setup(t), org = createOrganizationRepository(db);
  org.enqueue(b.id); const job = org.claim(); org.context(job.id, job.leaseToken);
  const result = org.submit(job.id, job.leaseToken, "direction-test", organizationOutput({ summary: "参考关系", tagAdds: [], queries: [],
    relationAdds: [{ targetId: a.id, name: "参考了", ...semantics, evidence: { kind: "inference", elementId: b.id, quote: "", reason: "测试依据" } }] }), {}, true);
  const r = wiki.relations(b.id, {}).relations[0];
  assert.equal(r.aiResultId, result.id); assert.equal(relationLabel(r,b.id), "参考了");
  wiki.renameRelation(r.id, { name: r.name, direction: "forward", reverseName: "被参考" });
  assert.equal(org.undo(result.id).skipped, 1);
  assert.equal(wiki.relations(b.id, {}).relations[0].direction, "forward");
});
