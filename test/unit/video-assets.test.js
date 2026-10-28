import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { inspectWikiAssets } from "../../tools/wiki-assets.mjs";

async function fixture(t, videos = true) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-video-assets-"));
  t.after(async () => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("wiki-video-assets-"));
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const db = new DatabaseSync(path.join(dir, "library.sqlite3"));
  db.exec("CREATE TABLE element_images(storage_key TEXT)");
  if (videos) db.exec("CREATE TABLE element_videos(storage_key TEXT)");
  await mkdir(path.join(dir, "assets"));
  return { dir, db };
}

test("Offline audit preserves video references and explicitly removes only recognized orphans", async (t) => {
  const { dir, db } = await fixture(t);
  const image = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png";
  const video = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4";
  const missing = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.webm";
  const orphan = "11111111-2222-3333-4444-555555555555.mov";
  const unfinished = "11111111-2222-3333-4444-555555555555.mp4.tmp";
  db.prepare("INSERT INTO element_images VALUES (?)").run(image);
  db.prepare("INSERT INTO element_videos VALUES (?)").run(video);
  db.prepare("INSERT INTO element_videos VALUES (?)").run(missing);
  db.close();
  const directory = path.join(dir, "assets", "videos");
  await mkdir(directory);
  await writeFile(path.join(dir, "assets", image), "image");
  for (const name of [video, orphan, unfinished, "notes.txt", "personal.mp4"]) await writeFile(path.join(directory, name), name);
  const scan = await inspectWikiAssets(dir);
  assert.equal(scan.referenced, 3);
  assert.deepEqual(scan.missing, [`videos/${missing}`]);
  assert.deepEqual(scan.unused.sort(), [`videos/${orphan}`, `videos/${unfinished}`].sort());
  assert.deepEqual(scan.unknown.sort(), ["videos/notes.txt", "videos/personal.mp4"]);
  await assert.rejects(inspectWikiAssets(dir, { apply: true }), /Close the application/);
  const cleaned = await inspectWikiAssets(dir, { apply: true, offline: true });
  assert.deepEqual(cleaned.removed.sort(), scan.unused);
  assert.equal(await readFile(path.join(directory, video), "utf8"), video);
  assert.equal(await readFile(path.join(directory, "notes.txt"), "utf8"), "notes.txt");
  assert.equal(await readFile(path.join(directory, "personal.mp4"), "utf8"), "personal.mp4");
});

test("Offline audit never removes videos when the database predates their schema", async (t) => {
  const { dir, db } = await fixture(t, false);
  db.close();
  await mkdir(path.join(dir, "assets", "videos"));
  const video = path.join(dir, "assets", "videos", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4");
  await writeFile(video, "keep");
  const scan = await inspectWikiAssets(dir, { apply: true, offline: true });
  assert.deepEqual(scan.unknown, ["videos"]);
  assert.deepEqual(scan.removed, []);
  assert.equal(await readFile(video, "utf8"), "keep");
});

test("Offline audit rejects a linked video directory before deleting any orphan files", async (t) => {
  const { dir, db } = await fixture(t);
  db.close();
  const external = path.join(dir, "separate");
  await mkdir(external);
  await symlink(external, path.join(dir, "assets", "videos"), process.platform === "win32" ? "junction" : "dir");
  const orphan = path.join(dir, "assets", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png.tmp");
  await writeFile(orphan, "keep until safe scan");
  await assert.rejects(inspectWikiAssets(dir, { apply: true, offline: true }), /Videos directory/);
  assert.equal(await readFile(orphan, "utf8"), "keep until safe scan");
});
