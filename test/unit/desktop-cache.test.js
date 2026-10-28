import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pruneCache } from "../../src/main/cacheCleanup.js";

test("desktop caches keep recent and protected entries and prune by count and size", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-cache-prune-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (let i = 0; i < 8; i++) {
    const dir = path.join(root, `entry-${i}`); await mkdir(dir);
    await writeFile(path.join(dir, "video.mp4"), Buffer.alloc(100));
    const time = new Date(Date.UTC(2026, 0, 1 + i));
    await utimes(path.join(dir, "video.mp4"), time, time); await utimes(dir, time, time);
  }
  const removed = await pruneCache(root, { keep: 1, maxEntries: 5, protect: [path.join(root, "entry-0", "video.mp4")] });
  assert.equal(removed.length, 2);
  assert.deepEqual((await readdir(root)).sort(), ["entry-0", "entry-3", "entry-4", "entry-5", "entry-6", "entry-7"]);
  await pruneCache(root, { keep: 2, maxBytes: 250 });
  assert.deepEqual((await readdir(root)).sort(), ["entry-6", "entry-7"]);
  assert.deepEqual(await pruneCache(path.join(root, "missing")), []);
});
