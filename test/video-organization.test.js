import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateWiki } from "../src/server/data/wikiMigrations.js";
import { migrateVideoOrganization } from "../src/server/data/videoOrganizationMigration.js";
import { createElementRepository } from "../src/server/data/elementRepository.js";
import { createOrganizationRepository } from "../src/server/data/organizationRepository.js";
import { organizationMaterial } from "../src/agent/organizationMaterial.js";

function setup(t) {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON"); migrateWiki(db);
  t.after(() => db.close());
  return { db, wiki: createElementRepository(db), org: createOrganizationRepository(db) };
}
function media(wiki, kind, name, localOnly = false) {
  return wiki[kind === "video" ? "importVideo" : "importImage"]({ tags: [], localOnly }, {
    storageKey: `${name}.${kind === "video" ? "mp4" : "png"}`, contentHash: name, originalName: name,
    mimeType: kind === "video" ? "video/mp4" : "image/png", byteSize: 100,
  }).element;
}
const proposal = (target) => ({ summary: "首帧主体与构图相似", queries: [], imageRequests: [], tagAdds: [], relationAdds: [{
  targetId: target.id, name: "相似", direction: "symmetric", reverseName: "",
  evidence: { kind: "visual", elementId: target.id, quote: "", reason: "首帧的主体姿势、构图与背景细节一致，颜色略不同" },
}] });
function begin(org, id) {
  org.enqueue(id); const job = org.claim(); assert.equal(job.elementId, id);
  return { job, context: org.context(job.id, job.leaseToken) };
}

test("video queue backfills once on enable, excludes private/trash, and does not retry failures on restart", (t) => {
  const { db, wiki, org } = setup(t);
  const source = media(wiki, "video", "old"), privateVideo = media(wiki, "video", "private", true), trash = media(wiki, "video", "trash");
  wiki.trash(trash.id);
  org.configure(false); assert.equal(org.claim(), null);
  org.configure(true); org.configure(true); migrateWiki(db);
  assert.equal(org.status(source.id).jobs.length, 1);
  assert.equal(org.status(privateVideo.id).jobs.length, 0); assert.equal(org.status(trash.id).jobs.length, 0);
  assert.throws(() => org.enqueue(privateVideo.id), /私有/);
  const job = org.claim(); assert.equal(job.elementId, source.id);
  org.failed(job.id, job.leaseToken, "decode failed", false);
  org.configure(false); org.configure(true); assert.equal(org.claim(), null);
  const next = media(wiki, "video", "new"); assert.equal(org.status(next.id).jobs.length, 1);
  wiki.importVideo({ tags: [] }, { storageKey: "repair.mp4", contentHash: "new", originalName: "new", mimeType: "video/mp4", byteSize: 100 });
  assert.equal(org.status(next.id).jobs.length, 1);
  db.prepare("UPDATE elements SET local_only=0 WHERE id=?").run(privateVideo.id);
  assert.equal(org.status(privateVideo.id).jobs.length, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM semantic_documents").get().n, 0);
});

test("video organization migration is atomic and safe to rerun", (t) => {
  const { db } = setup(t);
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name IN('organization_new_video','organization_publish_video') OR name LIKE 'organization_clock_element_videos_%')").all()) {
    db.exec(`DROP TRIGGER ${name}`);
  }
  db.exec("DELETE FROM wiki_schema WHERE version=37; CREATE TRIGGER fail_video_organization BEFORE INSERT ON wiki_schema WHEN NEW.version=37 BEGIN SELECT RAISE(ABORT,'migration failed'); END");
  assert.throws(() => migrateVideoOrganization(db), /migration failed/);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='organization_new_video'").get(), undefined);
  db.exec("DROP TRIGGER fail_video_organization"); migrateVideoOrganization(db); migrateVideoOrganization(db);
  assert.equal(db.prepare("SELECT count(*) AS n FROM wiki_schema WHERE version=37").get().n, 1);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

for (const [sourceKind, targetKind] of [["video", "image"], ["image", "video"], ["video", "video"]]) {
  test(`${sourceKind} to ${targetKind} similarity requires both visible frames and supports suggest, stack, undo and rejection`, (t) => {
    const { wiki, org } = setup(t);
    const target = media(wiki, targetKind, "target"), source = media(wiki, sourceKind, "source");
    const { job, context } = begin(org, source.id), output = proposal(target);
    const frameIds = [source, target].filter((e) => e.kind === "video").map((e) => e.id);
    const execution = { imageIds: [source.id, target.id], firstFrameIds: frameIds };
    for (const id of frameIds) assert.equal(organizationMaterial(context).elements.find((e) => e.id === id).visualScope, "first-frame-only");
    const send = (value, seen, auto = false) => org.submit(job.id, job.leaseToken, "result", value, seen, auto);
    assert.throws(() => send(output, { imageIds: execution.imageIds }), /实际首帧/);
    assert.throws(() => send(output, { ...execution, imageIds: [source.id] }), /实际查看/);
    assert.throws(() => send({ ...output, relationAdds: [{ ...output.relationAdds[0], direction: "forward", reverseName: "被相似" }] }, execution), /双向同名/);
    assert.throws(() => send({ ...output, relationAdds: [{ ...output.relationAdds[0], evidence: { ...output.relationAdds[0].evidence, kind: "inference" } }] }, execution), /实际首帧/);
    const result = send(output, execution);
    assert.equal(result.actions[0].state, "suggested"); assert.equal(wiki.list({ stackSimilar: true }).elements.length, 2);
    org.accept(result.id, [0]);
    const stacked = wiki.list({ stackSimilar: true });
    assert.equal(stacked.elements.length, 1); assert.equal(stacked.elements[0].id, source.id); assert.equal(stacked.elements[0].similarStack.count, 2);
    assert.equal(wiki.relations(source.id).relations[0].aiResultId, result.id);
    org.undo(result.id); assert.equal(wiki.list({ stackSimilar: true }).elements.length, 2);
    const reverse = begin(org, target.id).job;
    const retried = org.submit(reverse.id, reverse.leaseToken, "reverse", proposal(source), execution, true);
    assert.equal(retried.actions[0].state, "rejected"); assert.equal(wiki.relations(source.id).relations.length, 0);
  });
}

test("video contexts prioritize visual neighbors, hide private/trash and invalidate on file repair", (t) => {
  const { db, wiki, org } = setup(t);
  const old = media(wiki, "video", "older"), hidden = media(wiki, "video", "hidden", true), trash = media(wiki, "image", "trash");
  wiki.trash(trash.id);
  for (let i = 0; i < 30; i++) media(wiki, "image", `noise-${i}`);
  const source = media(wiki, "video", "source"), { job } = begin(org, source.id);
  const context = org.context(job.id, job.leaseToken, [], null, [], { matches: [hidden, trash, old].map((e) => ({ kind: e.kind, elementId: e.id })) });
  assert.equal(context.elements[1].id, old.id);
  assert.ok(!context.elements.some((e) => [hidden.id, trash.id].includes(e.id)));
  assert.throws(() => org.context(job.id, job.leaseToken, [], null, [hidden.id]), /不属于/);
  assert.throws(() => org.submit(job.id, job.leaseToken, "tags", { ...proposal(old), tagAdds: [{ name: "整段标签", evidence: proposal(old).relationAdds[0].evidence }] }, {}, true), /不添加整段视频标签/);
  db.prepare("UPDATE element_videos SET storage_key='repair.mp4' WHERE element_id=?").run(old.id);
  assert.throws(() => org.submit(job.id, job.leaseToken, "old", proposal(old), { imageIds: [source.id, old.id], firstFrameIds: [source.id, old.id] }, true), /资料库已变化/);
});
