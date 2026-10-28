import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { createPreviewQueue } from "../../src/server/assets/previewQueue.js";
import { createImageStore } from "../../src/server/assets/imageStore.js";
import { scheduleVideoCover } from "../../src/renderer/src/videoCoverQueue.js";

test("foreground previews bypass queued background work and queued duplicates can be promoted", async () => {
  const enqueue = createPreviewQueue(), started = [], release = [];
  const job = (name, foreground) => enqueue(() => {
    started.push(name);
    return new Promise((resolve) => { release.push(resolve); });
  }, foreground);
  const a = job("background"), b = job("queued"), c = job("foreground", true);
  await Promise.resolve();
  assert.deepEqual(started, ["background", "foreground"]);
  release[1](); await c.promise;
  b.promote(); await new Promise(setImmediate);
  assert.deepEqual(started, ["background", "foreground", "queued"]);
  release[0](); release[2](); await Promise.all([a.promise, b.promise]);
  await assert.rejects(enqueue(() => { throw new Error("broken image"); }).promise, /broken image/);
  assert.equal(await enqueue(() => "next").promise, "next");
});

test("disk previews survive store recreation, retain oriented dimensions, and are removed with originals", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wiki-previews-"));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("wiki-previews-"));
    await rm(directory, { recursive: true, force: true });
  });
  const store = createImageStore(directory);
  const bytes = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#446688" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const file = await store.save(bytes, "portrait.jpg");
  assert.deepEqual([file.width, file.height], [800, 1200]);
  assert.deepEqual(await store.dimensions(file.storageKey), { width: 800, height: 1200 });
  const preview = await store.thumbnail(file.storageKey, 400);
  assert.deepEqual(await readFile(path.join(directory, "previews-v1", `${file.storageKey}.400.webp`)), preview);
  const cachePath = path.join(directory, "previews-v1", `${file.storageKey}.400.webp`);
  await writeFile(cachePath, "broken cache");
  const repaired = createImageStore(directory);
  assert.deepEqual(await repaired.thumbnail(file.storageKey, 400), preview);
  await writeFile(cachePath, "broken again");
  await repaired.thumbnail(file.storageKey, 400, { regenerate: true });
  assert.deepEqual(await readFile(cachePath), preview);
  // A new store has no memory cache. An unreadable original proves no decoding on a disk hit.
  await writeFile(path.join(directory, file.storageKey), "not an image");
  const restarted = createImageStore(directory);
  assert.deepEqual(await restarted.thumbnail(file.storageKey, 400), preview);
  await restarted.remove(file.storageKey);
  assert.deepEqual(await readdir(path.join(directory, "previews-v1")), []);
  await assert.rejects(restarted.thumbnail(file.storageKey, 400), { statusCode: 404 });
});

test("video cover extraction holds at most two slots and cancellation frees queued and active work", () => {
  const started = [];
  const a = scheduleVideoCover(() => started.push("a"));
  const b = scheduleVideoCover(() => started.push("b"));
  const c = scheduleVideoCover(() => started.push("c"));
  const d = scheduleVideoCover(() => started.push("d"));
  assert.deepEqual(started, ["a", "b"]);
  c(); a(); a();
  assert.deepEqual(started, ["a", "b", "d"]);
  b(); d();
  const e = scheduleVideoCover(() => started.push("e")); e();
  assert.deepEqual(started, ["a", "b", "d", "e"]);
});
