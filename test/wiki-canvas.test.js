import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { createServer } from "../src/server/server.js";
import { migrateWiki } from "../src/server/data/wikiMigrations.js";

async function setup(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wiki-canvas-test-"));
  const app = await createServer({ port: 0, dataDir });
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("wiki-canvas-test-"));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
  });
  const request = (route, method = "GET", body) => fetch(new URL(route, app.url), {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const create = async (content, tags = []) => (await request("api/elements", "POST", { body: `${content}\n${"x".repeat(1000)}`, tags })).json();
  const graph = async (params = {}) => {
    const response = await request(`api/canvas?${new URLSearchParams(params)}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  return { app, dataDir, request, create, graph };
}

test("Canvas loads bounded summaries, expands direct neighbours and excludes trash from nodes and edges", async (t) => {
  const { request, create, graph } = await setup(t);
  const a = await create("Focus 50%_", ["Focus"]), b = await create("Neighbour"), c = await create("Other");
  const edge = await (await request("api/relations", "POST", { leftId: a.id, rightId: b.id })).json();
  await request("api/relations", "POST", { leftId: b.id, rightId: c.id });
  let data = await graph({ q: "50%_", tag: "focus" });
  assert.deepEqual(data.elements.map((element) => element.id), [a.id]);
  assert.equal(data.elements[0].summary.length, 240);
  assert.equal(data.elements[0].body, undefined);
  data = await graph({ ids: a.id, q: "50%_", tag: "focus", expand: a.id });
  assert.deepEqual(data.elements.map((element) => element.id).sort(), [a.id, b.id]);
  assert.equal(data.relations[0].id, edge.id);
  assert.equal(data.expansionHasMore, false);
  assert.equal(data.hasMore, false);
  await request(`api/elements/${b.id}`, "DELETE");
  data = await graph({ ids: `${a.id},${b.id}`, limit: 0 });
  assert.deepEqual(data.elements.map((element) => element.id), [a.id]);
  assert.deepEqual(data.relations, []);
  assert.equal((await request(`api/canvas?ids=${a.id}&expand=${b.id}`)).status, 400);
  await request(`api/elements/${b.id}/restore`, "POST");
  assert.equal((await graph({ ids: a.id, expand: a.id })).relations[0].id, edge.id);
});

test("Canvas batches stop at 300 nodes and truncate dense edges explicitly", async (t) => {
  const { dataDir, graph, request } = await setup(t);
  const db = new DatabaseSync(path.join(dataDir, "library.sqlite3"));
  try {
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO elements(kind,body,created_at,updated_at) VALUES (1,?, 'now', 'now')");
    for (let i = 0; i < 350; i++) insert.run(`Node ${i}`);
    const connect = db.prepare("INSERT INTO element_relations(source_id,target_id,kind,created_at) VALUES (?,?,1,'now')");
    for (let a = 296; a <= 350; a++) for (let b = a + 1; b <= 350; b++) connect.run(a, b);
    db.exec("COMMIT");
  } finally { db.close(); }
  let data = await graph();
  assert.equal(data.elements.length, 100);
  assert.equal(data.relations.length, 1200);
  assert.equal(data.edgesTruncated, true);
  assert.equal(data.hasMore, true);
  data = await graph({ ids: data.elements.map((element) => element.id).join(",") });
  assert.equal(data.elements.length, 200);
  data = await graph({ ids: data.elements.map((element) => element.id).join(",") });
  assert.equal(data.elements.length, 300);
  data = await graph({ ids: data.elements.map((element) => element.id).join(",") });
  assert.equal(data.elements.length, 300);
  assert.equal(data.hasMore, true);
  const ids = new Set(data.elements.map((element) => element.id));
  assert.ok(data.relations.every((edge) => edge.elementIds.every((id) => ids.has(id))));
  for (const query of ["limit=101", "limit=-1", "limit=NaN", "ids=1,1", `ids=${Array.from({ length: 301 }, (_, i) => i + 1)}`]) {
    assert.equal((await request(`api/canvas?${query}`)).status, 400, query);
  }
});

test("Canvas positions persist independently, validate before writing and retain through trash/restore", async (t) => {
  const { dataDir, request, create, graph } = await setup(t);
  const a = await create("A"), b = await create("B");
  const positions = [{ id: a.id, x: -120.5, y: 300 }, { id: b.id, x: 100, y: 700 }];
  assert.equal((await request("api/canvas/layout", "PUT", { positions })).status, 200);
  assert.deepEqual((await graph()).elements.find((element) => element.id === a.id).position, { x: -120.5, y: 300 });
  assert.deepEqual(await (await request(`api/elements/${a.id}`)).json(), a);
  for (const positions of [[null], [], [{ id: a.id, x: "4", y: 4 }], [{ id: a.id, x: 1e9, y: 0 }], [{ id: a.id, x: 2, y: 2 }, { id: a.id, x: 3, y: 3 }]]) {
    assert.equal((await request("api/canvas/layout", "PUT", { positions })).status, 400);
  }
  await request(`api/elements/${b.id}`, "DELETE");
  assert.equal((await request("api/canvas/layout", "PUT", { positions: [{ id: a.id, x: 999, y: 999 }, { id: b.id, x: 1, y: 1 }] })).status, 409);
  await request(`api/elements/${b.id}/restore`, "POST");
  const db = new DatabaseSync(path.join(dataDir, "library.sqlite3"), { readOnly: true });
  try { assert.deepEqual(db.prepare("SELECT element_id AS id,x,y FROM canvas_positions ORDER BY element_id").all().map((row) => ({ ...row })), positions); }
  finally { db.close(); }
});

test("Tag canvas groups the full library, shares multi-tag elements, and regroups after edits and trash", async (t) => {
  const { request, create, graph } = await setup(t);
  const shared = await create("Shared 50%_", ["Travel", "Ideas"]);
  const travel = await create("Travel note", ["travel"]);
  const loose = await create("Loose 50%_");
  const removed = await create("Deleted", ["Only trash"]);
  await request(`api/elements/${removed.id}`, "DELETE");
  await request("api/canvas/layout", "PUT", { positions: [{ id: shared.id, x: 999, y: 999 }, { id: loose.id, x: 123, y: 456 }] });
  let data = await graph({ view: "tags" });
  assert.deepEqual(data.totals, { groups: 2, untagged: 1 });
  assert.deepEqual(data.elements.map((element) => element.id), [loose.id]);
  assert.equal(data.elements[0].position, null);
  assert.equal(data.groups.find((group) => group.name === "Travel").count, 2);
  assert.equal(data.groups.find((group) => group.name === "Ideas").previews[0].id, shared.id);
  assert.equal(data.hasMore, false);
  for (const tag of ["Travel", "Ideas"]) {
    const folder = await graph({ view: "tags", tag });
    assert.ok(folder.elements.some((element) => element.id === shared.id));
    assert.equal(folder.elements.find((element) => element.id === shared.id).position, null);
  }
  const filtered = await graph({ view: "tags", q: "50%_" });
  assert.equal(filtered.groups.length, 2);
  assert.ok(filtered.groups.every((group) => group.count === 1 && group.previews[0].id === shared.id));
  assert.deepEqual(filtered.elements.map((element) => element.id), [loose.id]);
  const retained = { view: "tags", ids: loose.id, groupIds: data.groups.map((group) => group.id).join(",") };
  await request(`api/elements/${loose.id}`, "PATCH", { tags: ["New group"] });
  await request(`api/elements/${shared.id}`, "PATCH", { tags: [] });
  data = await graph(retained);
  assert.deepEqual(data.elements.map((element) => element.id), [shared.id]);
  assert.deepEqual(data.groups.map((group) => [group.name, group.count]).sort(), [["New group", 1], ["Travel", 1]]);
  await request(`api/elements/${travel.id}`, "DELETE");
  data = await graph({ ...retained, groupIds: data.groups.map((group) => group.id).join(",") });
  assert.deepEqual(data.groups.map((group) => group.name), ["New group"]);
  await request(`api/elements/${travel.id}/restore`, "POST");
  assert.equal((await graph({ view: "tags" })).totals.groups, 2);
  const flat = await graph();
  assert.deepEqual(flat.elements.find((element) => element.id === shared.id).position, { x: 999, y: 999 });
  for (const query of ["view=unknown", "view=flat&groupIds=1", "view=tags&tag=x&groupIds=1", "view=tags&groupIds=1,1", "view=tags&expand=1", `view=tags&ids=1&groupIds=${Array.from({ length: 300 }, (_, i) => i + 1)}`]) {
    assert.equal((await request(`api/canvas?${query}`)).status, 400, query);
  }
});

test("Tag canvas bounds mixed cards and previews while folder counts exceed the flat node cap", async (t) => {
  const { dataDir, graph } = await setup(t);
  const db = new DatabaseSync(path.join(dataDir, "library.sqlite3"));
  try {
    db.exec("BEGIN");
    const element = db.prepare("INSERT INTO elements(kind,body,created_at,updated_at) VALUES (1,?,'now','now')");
    const tag = db.prepare("INSERT INTO tags(name,normalized_name) VALUES (?,?)");
    const link = db.prepare("INSERT INTO element_tags(element_id,tag_id) VALUES (?,?)");
    const main = Number(tag.run("Main", "main").lastInsertRowid);
    for (let i = 0; i < 400; i++) link.run(Number(element.run(`Shared ${i}`).lastInsertRowid), main);
    for (let i = 0; i < 180; i++) {
      const group = Number(tag.run(`Tag ${i}`, `tag ${i}`).lastInsertRowid);
      link.run(Number(element.run(`Grouped ${i}`).lastInsertRowid), group);
    }
    for (let i = 0; i < 180; i++) element.run(`Untagged ${i}`);
    db.exec("COMMIT");
  } finally { db.close(); }
  let data = await graph({ view: "tags" });
  assert.deepEqual(data.totals, { groups: 181, untagged: 180 });
  assert.equal(data.elements.length + data.groups.length, 100);
  assert.ok(data.groups.length > 0 && data.elements.length > 0);
  for (const count of [200, 300, 300]) {
    data = await graph({ view: "tags", ids: data.elements.map((element) => element.id).join(","), groupIds: data.groups.map((group) => group.id).join(",") });
    assert.equal(data.elements.length + data.groups.length, count);
    assert.equal(data.hasMore, true);
    assert.ok(data.groups.every((group) => group.previews.length <= 3 && group.previews.every((item) => item.summary.length <= 100)));
  }
  data = await graph({ view: "tags", q: "Shared" });
  assert.equal(data.groups[0].count, 400);
  assert.equal(data.groups[0].previews.length, 3);
  assert.equal(data.elements.length, 0);
  assert.equal(data.hasMore, false);
  const folder = await graph({ view: "tags", tag: "main" });
  assert.equal(folder.elements.length, 100);
  assert.equal(folder.hasMore, true);
});

test("Canvas migration upgrades v2 without changing contents or connections and can run again", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE wiki_schema(version INTEGER PRIMARY KEY); INSERT INTO wiki_schema VALUES(1),(2);
      CREATE TABLE elements(id INTEGER PRIMARY KEY AUTOINCREMENT, kind INTEGER, title TEXT, body TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
      CREATE TABLE element_images(element_id INTEGER PRIMARY KEY REFERENCES elements(id), original_name TEXT);
      CREATE TABLE tags(id INTEGER PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE);
      CREATE TABLE element_tags(element_id INTEGER REFERENCES elements(id), tag_id INTEGER REFERENCES tags(id), PRIMARY KEY(element_id,tag_id));
      CREATE TABLE element_relations(id INTEGER PRIMARY KEY AUTOINCREMENT, left_id INTEGER REFERENCES elements(id), right_id INTEGER REFERENCES elements(id), created_at TEXT);
      INSERT INTO elements(kind,title,body,created_at,updated_at) VALUES (1,'','A','now','now'),(1,'','B','now','now');
      INSERT INTO element_relations(left_id,right_id,created_at) VALUES(1,2,'now');`);
    migrateWiki(db); migrateWiki(db);
    assert.equal(db.prepare("SELECT count(*) AS total FROM elements").get().total, 2);
    assert.equal(db.prepare("SELECT count(*) AS total FROM element_relations").get().total, 1);
    assert.equal(db.prepare("SELECT count(*) AS total FROM canvas_positions").get().total, 0);
  } finally { db.close(); }
});

test("Canvas thumbnails are bounded WebP previews, preserve original bytes and reject deleted content", async (t) => {
  const { app, request } = await setup(t);
  const bytes = await sharp({ create: { width: 1800, height: 1200, channels: 3, background: "#568861" } }).png().toBuffer();
  const element = await (await fetch(new URL("api/images", app.url), { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes })).json();
  const previews = await Promise.all(Array.from({ length: 8 }, () => request(`api/elements/${element.id}/thumbnail`).then((response) => response.arrayBuffer())));
  const preview = Buffer.from(previews[0]);
  assert.ok(previews.every((value) => Buffer.from(value).equals(preview)));
  const metadata = await sharp(preview).metadata();
  assert.equal(metadata.format, "webp");
  assert.ok(metadata.width <= 400 && metadata.height <= 280);
  assert.deepEqual(Buffer.from(await (await request(`api/elements/${element.id}/image`)).arrayBuffer()), bytes);
  await request(`api/elements/${element.id}`, "DELETE");
  assert.equal((await request(`api/elements/${element.id}/thumbnail`)).status, 404);
});

test("Responsive previews preserve portrait detail, bound dimensions and validate requested widths", async (t) => {
  const { app, request } = await setup(t);
  const bytes = await sharp({ create: { width: 1800, height: 2700, channels: 3, background: "#568861" } }).png().toBuffer();
  const element = await (await fetch(new URL("api/images", app.url), { method: "POST", body: bytes })).json();
  const previewUrl = `api/elements/${element.id}/thumbnail`;
  for (const width of [400, 800, 1200, 1600]) {
    const responses = await Promise.all(Array.from({ length: 3 }, () => request(`${previewUrl}?width=${width}`)));
    assert.ok(responses.every((response) => response.status === 200 && response.headers.get("content-type") === "image/webp"));
    const buffers = await Promise.all(responses.map(async (response) => Buffer.from(await response.arrayBuffer())));
    assert.ok(buffers.every((buffer) => buffer.equals(buffers[0])));
    const metadata = await sharp(buffers[0]).metadata();
    assert.equal(metadata.width, width);
    assert.equal(metadata.height, width * 1.5);
  }
  const small = await sharp(Buffer.from(await (await request(previewUrl)).arrayBuffer())).metadata();
  assert.ok(small.width <= 400 && small.height <= 280);
  for (const width of ["", "0", "-1", "401", "999999", "nope"]) assert.equal((await request(`${previewUrl}?width=${width}`)).status, 400);
  assert.deepEqual(Buffer.from(await (await request(`api/elements/${element.id}/image`)).arrayBuffer()), bytes);
  await request(`api/elements/${element.id}`, "DELETE");
  assert.equal((await request(`${previewUrl}?width=1600`)).status, 404);
});
