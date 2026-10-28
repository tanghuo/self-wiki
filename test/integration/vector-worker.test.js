import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initDb } from "../../src/server/data/sqlite.js";
import { createElementRepository } from "../../src/server/data/elementRepository.js";
import { createSemanticRepository } from "../../src/server/data/semanticRepository.js";
import { createVectorQueries } from "../../src/server/data/vectorQueries.js";
import { defaultEmbeddingConfig, embeddingChunks } from "../../src/shared/domain/embedding.js";

test("semantic vector search on the worker thread matches the main connection and sees new commits", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-vector-worker-")), file = path.join(dir, "library.sqlite3");
  const db = initDb(file), queries = createVectorQueries(db, file);
  t.after(async () => { await queries.close(); db.close(); await rm(dir, { recursive: true, force: true }); });
  const wiki = createElementRepository(db), main = createSemanticRepository(db), threaded = createSemanticRepository(db, { vectorQueries: queries });
  if (!main.available()) { t.skip("sqlite-vec unavailable"); return; }
  const key = main.configure({ ...defaultEmbeddingConfig(), enabled: true, dimensions: 3 });
  const index = (body, vector) => {
    wiki.createText({ body, tags: [] });
    const job = main.claim(key), chunks = embeddingChunks(body);
    main.complete(job, chunks, chunks.map(() => vector), 3);
  };
  index("雨夜", [1, 0, 0]); index("晴天", [0, 1, 0]); index("黄昏", [0.7, 0.7, 0]);
  const query = new Uint8Array(new Float32Array([1, 0.1, 0]).buffer);
  const expected = main.search(query, key, 0, 5);
  assert.equal(expected.length, 3);
  const plain = (rows) => rows.map((row) => ({ ...row }));
  assert.deepEqual(plain(await threaded.searchAsync(query, key, 0, 5)), plain(expected));
  assert.equal(queries.usesWorker, true);
  index("新的雨景", [1, 0, 0]);
  assert.equal((await threaded.searchAsync(query, key, 0, 5)).length, 4);
  await assert.rejects(queries.all("SELECT * FROM no_such_table"), /no such table/);
  await assert.rejects(queries.all("DELETE FROM elements"), /readonly|read-only/i);
});

test("in-memory databases answer vector queries on the main connection", async () => {
  const db = initDb(":memory:"), queries = createVectorQueries(db, ":memory:");
  try {
    assert.deepEqual(await queries.all("SELECT 1 AS one"), [{ one: 1 }].map((row) => Object.assign(Object.create(null), row)));
    assert.equal(queries.usesWorker, false);
  } finally { await queries.close(); db.close(); }
});
