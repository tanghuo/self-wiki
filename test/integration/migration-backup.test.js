import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initDb } from "../../src/server/data/sqlite.js";
import { latestWikiVersion, pendingWikiVersions, wikiMigrations } from "../../src/server/data/wikiMigrations.js";

async function temporary(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-migration-backup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("migration registry covers every schema version exactly once and in order", () => {
  const versions = wikiMigrations.flatMap((step) => step.versions);
  assert.deepEqual(versions, Array.from({ length: latestWikiVersion }, (_, i) => i + 1));
});

test("an outdated library is snapshotted before migrating, opened in WAL mode, and up-to-date opens make no backup", async (t) => {
  const dir = await temporary(t), file = path.join(dir, "library.sqlite3");
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE wiki_schema(version INTEGER PRIMARY KEY); INSERT INTO wiki_schema VALUES(1),(2),(3);
    CREATE TABLE elements(id INTEGER PRIMARY KEY AUTOINCREMENT, kind INTEGER, title TEXT, body TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE element_images(element_id INTEGER PRIMARY KEY REFERENCES elements(id), original_name TEXT, storage_key TEXT, content_hash TEXT);
    CREATE TABLE element_relations(id INTEGER PRIMARY KEY AUTOINCREMENT, left_id INTEGER REFERENCES elements(id), right_id INTEGER REFERENCES elements(id), created_at TEXT);
    CREATE TABLE tags(id INTEGER PRIMARY KEY, name TEXT, normalized_name TEXT);
    CREATE TABLE element_tags(element_id INTEGER REFERENCES elements(id), tag_id INTEGER REFERENCES tags(id), PRIMARY KEY(element_id, tag_id));
    CREATE TABLE canvas_positions(element_id INTEGER PRIMARY KEY REFERENCES elements(id), x REAL, y REAL);
    INSERT INTO elements VALUES(1,1,'旧标题','正文','c','u',NULL);`);
  assert.equal(pendingWikiVersions(legacy).length, latestWikiVersion - 3);
  legacy.close();

  const db = initDb(file);
  try {
    assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.deepEqual(pendingWikiVersions(db), []);
    assert.equal(db.prepare("SELECT count(*) AS n FROM elements").get().n, 2); // the old title became its own text element
  } finally { db.close(); }
  const backups = await readdir(path.join(dir, "backups"));
  assert.equal(backups.length, 1);
  assert.match(backups[0], new RegExp(`^library-v3-to-v${latestWikiVersion}-\\d{8}T\\d{6}Z\\.sqlite3$`));
  const snapshot = new DatabaseSync(path.join(dir, "backups", backups[0]), { readOnly: true });
  try {
    assert.equal(snapshot.prepare("SELECT max(version) AS v FROM wiki_schema").get().v, 3);
    assert.equal(snapshot.prepare("SELECT title FROM elements WHERE id=1").get().title, "旧标题");
  } finally { snapshot.close(); }

  initDb(file).close();
  assert.equal((await readdir(path.join(dir, "backups"))).length, 1);
});

test("a database from a newer app version is refused before anything is written", async (t) => {
  const dir = await temporary(t), file = path.join(dir, "library.sqlite3");
  initDb(file).close();
  const db = new DatabaseSync(file); db.exec(`INSERT INTO wiki_schema VALUES(${latestWikiVersion + 1})`); db.close();
  assert.throws(() => initDb(file), /Unsupported Wiki schema version/);
});
