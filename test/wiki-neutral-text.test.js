import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateWiki } from "../src/server/data/wikiMigrations.js";
import { migrateNeutralText } from "../src/server/data/neutralTextMigration.js";

function legacyDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE wiki_schema(version INTEGER PRIMARY KEY); INSERT INTO wiki_schema VALUES(1),(2),(3);
    CREATE TABLE elements(id INTEGER PRIMARY KEY AUTOINCREMENT, kind INTEGER, title TEXT, body TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE element_images(element_id INTEGER PRIMARY KEY REFERENCES elements(id), original_name TEXT, storage_key TEXT, content_hash TEXT);
    CREATE TABLE element_relations(id INTEGER PRIMARY KEY AUTOINCREMENT, left_id INTEGER REFERENCES elements(id), right_id INTEGER REFERENCES elements(id), created_at TEXT);
    CREATE TABLE tags(id INTEGER PRIMARY KEY, name TEXT, normalized_name TEXT);
    CREATE TABLE element_tags(element_id INTEGER REFERENCES elements(id), tag_id INTEGER REFERENCES tags(id), PRIMARY KEY(element_id, tag_id));
    CREATE TABLE canvas_positions(element_id INTEGER PRIMARY KEY REFERENCES elements(id), x REAL, y REAL);
    INSERT INTO elements VALUES
      (1,1,'旧标题','  原有文字\n  空格','created','updated',NULL),
      (2,1,'只有标题','','created','updated',NULL),
      (3,2,'自定义图名','','created','updated',NULL),
      (4,2,'original.png','','created','updated',NULL),
      (5,1,'回收站标题','回收站文字','created','updated','deleted');
    INSERT INTO element_images VALUES(3,'photo.png','original-a.png','hash-a'),(4,'original.png','original-b.png','hash-b');
    INSERT INTO tags VALUES(1,'人物','人物'); INSERT INTO element_tags VALUES(1,1),(3,1),(5,1);
    INSERT INTO canvas_positions VALUES(1,23,-40),(4,-23,40);
    INSERT INTO element_relations VALUES(7,1,3,'old-edge');
    UPDATE sqlite_sequence SET seq=100 WHERE name='elements';
    UPDATE sqlite_sequence SET seq=200 WHERE name='element_relations';`);
  return db;
}

test("v5 preserves old relation identities and sequence, and named relations survive reopening migration", () => {
  const db = legacyDb();
  try {
    migrateNeutralText(db);
    const old = db.prepare("SELECT * FROM element_relations ORDER BY id").all();
    migrateWiki(db);
    const migrated = db.prepare("SELECT * FROM element_relations ORDER BY id").all();
    assert.deepEqual(migrated.map(({ name, direction, reverse_name, ...row }) => row), old.map((row) => ({ ...row })));
    assert.ok(migrated.every((row) => row.name === "" && row.direction === 0 && row.reverse_name === ""));
    db.prepare("INSERT INTO element_relations(source_id,target_id,kind,name,created_at) VALUES(1,3,1,?, 'now')").run("参考来源");
    migrateWiki(db);
    assert.equal(db.prepare("SELECT name FROM element_relations ORDER BY id DESC LIMIT 1").get().name, "参考来源");
  } finally { db.close(); }
  const empty = legacyDb();
  try {
    migrateNeutralText(empty);
    empty.exec("DELETE FROM element_relations; UPDATE sqlite_sequence SET seq=900 WHERE name='element_relations'");
    migrateWiki(empty);
    const result = empty.prepare("INSERT INTO element_relations(source_id,target_id,kind,name,created_at) VALUES(1,3,1,'自定义','now')").run();
    assert.equal(result.lastInsertRowid, 901);
  } finally { empty.close(); }
});

test("v4 splits old titles into text and directed edges while preserving identities, tags, layout and image metadata", () => {
  const db = legacyDb();
  try {
    const beforeImages = db.prepare("SELECT * FROM element_images").all();
    const beforeTags = db.prepare("SELECT * FROM element_tags").all();
    const beforeLayout = db.prepare("SELECT * FROM canvas_positions").all();
    migrateWiki(db);
    assert.equal(db.prepare("PRAGMA table_info(elements)").all().some((row) => row.name === "title"), false);
    const rows = db.prepare("SELECT * FROM elements ORDER BY id").all();
    assert.deepEqual(rows.map((row) => [row.id, row.body]), [[1,"  原有文字\n  空格"],[2,"只有标题"],[3,""],[4,""],[5,"回收站文字"],[101,"旧标题"],[102,"自定义图名"],[103,"回收站标题"]]);
    for (const row of rows) {
      assert.equal(row.created_at, "created");
      assert.equal(row.updated_at, "updated");
      assert.equal(row.deleted_at, [5,103].includes(row.id) ? "deleted" : null);
    }
    const edges = db.prepare("SELECT * FROM element_relations ORDER BY id").all();
    assert.deepEqual(edges.map((row) => [row.id,row.source_id,row.target_id,row.kind]), [[7,1,3,1],[201,101,1,2],[202,102,3,2],[203,103,5,2]]);
    assert.equal(edges[0].created_at, "old-edge");
    assert.deepEqual(db.prepare("SELECT * FROM element_images").all(), beforeImages);
    assert.deepEqual(db.prepare("SELECT * FROM element_tags").all(), beforeTags);
    assert.deepEqual(db.prepare("SELECT * FROM canvas_positions").all(), beforeLayout);
    migrateWiki(db);
    assert.deepEqual(db.prepare("SELECT * FROM elements ORDER BY id").all(), rows);
    assert.deepEqual(db.prepare("SELECT * FROM element_relations ORDER BY id").all(), edges);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.throws(() => db.exec("INSERT INTO elements(kind,body,created_at,updated_at) VALUES(1,'','a','b')"), /CHECK/);
    assert.throws(() => db.exec("INSERT INTO element_tags VALUES(999,1)"), /FOREIGN KEY/);
  } finally { db.close(); }
});

test("v4 migration failure rolls back the entire rebuild and restores foreign key enforcement", () => {
  const db = legacyDb();
  try {
    db.exec("UPDATE elements SET title='',body='' WHERE id=1");
    const original = db.prepare("SELECT * FROM elements ORDER BY id").all();
    assert.throws(() => migrateNeutralText(db), /CHECK/);
    assert.deepEqual(db.prepare("SELECT * FROM elements ORDER BY id").all(), original);
    assert.equal(db.prepare("SELECT count(*) AS n FROM wiki_schema WHERE version=4").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('elements_v4','relations_v4')").get().n, 0);
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    db.exec("UPDATE elements SET body='修复后原有文字' WHERE id=1");
    migrateNeutralText(db);
    assert.equal(db.prepare("SELECT body FROM elements WHERE id=1").get().body, "修复后原有文字");
  } finally { db.close(); }
});

test("v4 preserves high-water identifiers when all old records have already been removed", () => {
  const db = legacyDb();
  try {
    db.exec("DELETE FROM element_relations; DELETE FROM canvas_positions; DELETE FROM element_tags; DELETE FROM element_images; DELETE FROM elements");
    migrateNeutralText(db);
    db.exec("INSERT INTO elements(kind,body,created_at,updated_at) VALUES(1,'新文字','now','now'),(1,'第二段','now','now')");
    assert.equal(db.prepare("SELECT min(id) AS id FROM elements").get().id, 101);
    db.exec("INSERT INTO element_relations(source_id,target_id,kind,created_at) VALUES(101,102,2,'now')");
    assert.equal(db.prepare("SELECT id FROM element_relations").get().id, 201);
  } finally { db.close(); }
});
