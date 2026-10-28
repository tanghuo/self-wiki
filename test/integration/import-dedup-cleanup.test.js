import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { initDb } from "../../src/server/data/sqlite.js";
import { createElementRepository } from "../../src/server/data/elementRepository.js";
import { createElementService } from "../../src/server/application/elementService.js";
import { createImageStore } from "../../src/server/assets/imageStore.js";

test("a committed duplicate import still succeeds when removing the redundant copy fails", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-dedup-cleanup-"));
  const db = initDb(":memory:");
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  const store = createImageStore(path.join(dir, "assets"));
  const failing = { ...store, remove: async () => { throw Object.assign(new Error("EBUSY: file in use"), { code: "EBUSY" }); } };
  const wiki = createElementService(createElementRepository(db), failing, async () => {});
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).png().toBuffer();
  const first = await wiki.importImage(bytes, "a.png", ["一"]);
  const errors = t.mock.method(console, "error", () => {});
  const second = await wiki.importImage(bytes, "b.png", ["二"]);
  assert.equal(second.id, first.id);
  assert.equal(second.importStatus, "reused");
  assert.deepEqual(wiki.get(first.id).tags.sort(), ["一", "二"]);
  assert.equal(errors.mock.callCount(), 1);
});
