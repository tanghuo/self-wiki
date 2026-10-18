import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { initDb } from "../src/server/data/sqlite.js";
import { migrateWiki } from "../src/server/data/wikiMigrations.js";
import { createElementRepository } from "../src/server/data/elementRepository.js";
import { createOrganizationRepository } from "../src/server/data/organizationRepository.js";
import { createSemanticRepository, semanticSpace } from "../src/server/data/semanticRepository.js";
import { createSemanticService } from "../src/server/application/semanticService.js";
import { defaultEmbeddingConfig, embeddingConfig, embeddingChunks, embeddingVector } from "../src/shared/domain/embedding.js";
import { defaultOrganizationConfig, organizationConfig } from "../src/shared/domain/organization.js";
import { embedTexts } from "../src/server/semantic/embeddingClient.js";
import { createServer } from "../src/server/server.js";

function setup(t) {
  const db = initDb(":memory:"), resource = { db, wiki: createElementRepository(db), repo: createSemanticRepository(db) };
  t.after(async () => { await resource.close?.(); db.close(); });
  return resource;
}
const config = () => ({ ...defaultEmbeddingConfig(), enabled: true, dimensions: 3 });
const vector = (values) => new Uint8Array(new Float32Array(values).buffer);

test("library search prioritizes literal evidence over semantic rank and paginates the union", (t) => {
  const { wiki } = setup(t);
  const direct = wiki.createText({ body: "雨伞", tags: ["收藏"] });
  const related = wiki.createText({ body: "雨天街景", tags: [] });
  const query = { q: "雨伞", semanticIds: [related.id, direct.id], pageSize: 1 };
  const first = wiki.list(query);
  assert.equal(first.pagination.total, 2);
  assert.deepEqual(first.elements.map((e) => e.id), [direct.id]);
  assert.deepEqual(wiki.list({ ...query, page: 2 }).elements.map((e) => e.id), [related.id]);
  assert.equal(wiki.list({ ...query, tags: ["收藏"] }).pagination.total, 1);
  wiki.trash(related.id);
  assert.equal(wiki.list(query).pagination.total, 1);
});
async function until(check, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise((r) => setTimeout(r, 50)); }
  assert.fail("Timed out waiting for semantic index");
}
async function temporary(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-semantic-"));
  const resource = { dir };
  t.after(async () => {
    await resource.close?.();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith("wiki-semantic-"));
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return resource;
}
async function provider(t) {
  const requests = [], state = { mode: "ok" };
  const server = createHttpServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    assert.equal(req.url, "/v1/embeddings");
    if (state.mode === "hang") return;
    if (state.mode === "fail") { res.writeHead(503); res.end('secret provider error'); return; }
    if (state.mode === "redirect") { res.writeHead(307, { location: "/unexpected" }); res.end(); return; }
    const data = body.input.map((text, index) => ({ index, embedding: state.mode === "invalid" ? [0, 0] :
      /雨|湿润|街道|降水|rain/i.test(text) ? [1, 0.05, 0] : /苹果|水果|apple/i.test(text) ? [0.05, 1, 0] : [0, 0.05, 1] }));
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: data.reverse() }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)); });
  return { requests, state, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

test("embedding configuration is independent, legacy-compatible, and chunks cover the complete body", () => {
  const old = defaultOrganizationConfig(); delete old.embedding;
  assert.deepEqual(organizationConfig(old).embedding, defaultEmbeddingConfig());
  for (const value of [{ ...config(), dimensions: 0 }, { ...config(), topK: 50 }, { ...config(), apiKeyEnv: "raw-secret-value!" },
    { ...config(), baseUrl: "https://user:secret@example.com/v1" }, { ...config(), baseUrl: "file:///tmp/embeddings" }, { ...config(), provider: "unknown" }]) assert.throws(() => embeddingConfig(value));
  const text = "前文".repeat(5000) + "末尾是雨夜街景";
  const chunks = embeddingChunks(text); assert.ok(chunks.length < 16); assert.ok(chunks.at(-1).endsWith("末尾是雨夜街景"));
  assert.equal(chunks[0] + chunks.slice(1).map((c) => c.slice(150)).join(""), text);
  assert.throws(() => embeddingVector([0, 0, 0], 3)); assert.throws(() => embeddingVector([1e300, 0, 0], 3));
  assert.throws(() => embeddingVector([1, NaN, 0], 3));
  assert.notEqual(semanticSpace(config()), semanticSpace({ ...config(), modelRevision: "2" }));
  assert.equal(semanticSpace(config()), semanticSpace({ ...config(), timeoutMs: 30000, topK: 3 }));
});

test("expired image login preserves pending descriptions while text indexing continues, then resumes", { timeout: 22000 }, async (t) => {
  const resource = await temporary(t), root = resource.dir, remote = await provider(t), settings = defaultOrganizationConfig();
  const sourceHome = path.join(root, "desktop"), previousHome = process.env.CODEX_HOME;
  await mkdir(sourceHome); process.env.CODEX_HOME = sourceHome;
  t.after(() => { if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome; });
  const login = (seconds) => JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "semantic-test",
    access_token: `test.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds })).toString("base64url")}.signature`, refresh_token: "not-for-wiki" } });
  await writeFile(path.join(sourceHome, "auth.json"), login(-1));
  settings.executor.codexCli.executable = path.join(root, "codex.mjs");
  await writeFile(settings.executor.codexCli.executable, await readFile(new URL("./fixtures/codex-external-auth.txt", import.meta.url)));
  settings.embedding = { ...config(), baseUrl: remote.baseUrl };
  await writeFile(path.join(root, "organization.json"), JSON.stringify(settings));
  const app = await createServer({ port: 0, dataDir: root }); resource.close = () => app.close();
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
  const response = await fetch(new URL("api/images", app.url), { method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": "test.png" }, body: bytes });
  assert.ok(response.ok);
  const status = async () => (await (await fetch(new URL("api/organization/status", app.url))).json()).semantic;
  await until(async () => /登录已失效/.test((await status()).diagnostic));
  const text = await fetch(new URL("api/elements", app.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "登录暂停期间的文字" }) });
  assert.ok(text.ok);
  await until(async () => (await status()).counts.ready === 1);
  assert.equal((await status()).counts.failed, 0); assert.equal((await status()).counts.pending, 1);
  await writeFile(path.join(sourceHome, "auth.json"), login(3600));
  await until(async () => (await status()).counts.ready === 2);
  assert.equal((await status()).counts.failed, 0);
});

test("native SQLite vector search filters stale, trashed, purged and different-model embeddings", (t) => {
  const { db, wiki, repo } = setup(t), settings = config(), key = repo.configure(settings);
  assert.equal(repo.available(), true);
  const rain = wiki.createText({ body: "雨夜街景", tags: [] }), fruit = wiki.createText({ body: "苹果", tags: [] });
  const first = repo.claim(key); assert.equal(first.element_id, rain.id);
  assert.equal(repo.complete(first, [rain.body], [[1, 0, 0]], 3), true);
  const second = repo.claim(key); repo.complete(second, [fruit.body], [[0, 1, 0]], 3);
  assert.equal(repo.search(vector([1, 0, 0]), key, null, 1)[0].elementId, rain.id);
  wiki.update(rain.id, { body: "雨后路面", tags: [] });
  assert.equal(repo.search(vector([1, 0, 0]), key, null, 1)[0].elementId, fruit.id);
  assert.equal(repo.complete(first, [rain.body], [[1, 0, 0]], 3), false);
  let job = repo.claim(key); repo.complete(job, ["雨后路面"], [[1, 0, 0]], 3);
  wiki.trash(rain.id); assert.equal(repo.search(vector([1, 0, 0]), key, null, 1)[0].elementId, fruit.id);
  wiki.restore(rain.id); job = repo.claim(key); repo.complete(job, ["雨后路面"], [[1, 0, 0]], 3);
  const nextKey = repo.configure({ ...settings, model: "other-model" });
  assert.equal(repo.search(vector([1, 0, 0]), nextKey, null, 10).length, 0);
  job = repo.claim(nextKey); assert.equal(repo.complete(job, ["雨后路面"], [[1, 0, 0]], 3), true);
  wiki.trash(rain.id); wiki.purge(rain.id);
  assert.equal(db.prepare("SELECT count(*) AS n FROM semantic_vectors WHERE element_id=?").get(rain.id).n, 0);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  migrateWiki(db); assert.equal(repo.status().counts.pending, 1);
});

test("index leases survive restart, discard stale rebuild completion and retain atomic failure", (t) => {
  const { db, wiki, repo } = setup(t), settings = config(), key = repo.configure(settings);
  wiki.createText({ body: "完整文档", tags: [] });
  const old = repo.claim(key); repo.configure(settings); const resumed = repo.claim(key);
  assert.notEqual(old.token, resumed.token); assert.equal(repo.complete(old, ["旧内容"], [[1, 0, 0]], 3), false);
  assert.equal(resumed.attempts, 2);
  repo.failed(resumed, "暂时失败"); assert.equal(repo.status().counts.pending, 1);
  db.exec("UPDATE semantic_documents SET available_at=0"); let job = repo.claim(key);
  repo.failed(job, "第三次失败"); assert.equal(repo.status().counts.failed, 1); assert.equal(repo.claim(key), null);
  repo.reset("retry"); job = repo.claim(key);
  db.exec("CREATE TRIGGER reject_vector BEFORE INSERT ON semantic_vectors BEGIN SELECT RAISE(ABORT,'write failed'); END");
  assert.throws(() => repo.complete(job, ["完整文档"], [[1, 0, 0]], 3), /write failed/);
  assert.equal(repo.status().counts.running, 1); assert.equal(db.prepare("SELECT count(*) AS n FROM semantic_vectors").get().n, 0);
  db.exec("DROP TRIGGER reject_vector"); repo.reset("all"); assert.equal(repo.complete(job, ["过时任务"], [[1, 0, 0]], 3), false);
});

test("model upgrades and rollbacks rebuild without mixing vectors or accepting old jobs", async (t) => {
  const changes = [
    ["different model with the same dimensions", { model: "replacement-model" }],
    ["same model name with upgraded weights", { modelRevision: "2" }],
    ["different output dimensions", { dimensions: 2 }],
  ];
  for (const [name, change] of changes) await t.test(name, (t) => {
    const { wiki, repo } = setup(t), original = config(), originalKey = repo.configure(original);
    const indexed = wiki.createText({ body: "保留原始笔记", tags: ["保留标签"] });
    const pending = wiki.createText({ body: "尚在处理的笔记", tags: [] });
    repo.complete(repo.claim(originalKey), [indexed.body], [[1, 0, 0]], 3);
    const oldJob = repo.claim(originalKey);
    assert.equal(oldJob.element_id, pending.id);

    const replacement = { ...original, ...change }, replacementKey = repo.configure(replacement);
    const replacementVector = Array.from({ length: replacement.dimensions }, (_, i) => i === 1 ? 1 : 0);
    assert.notEqual(replacementKey, originalKey);
    assert.equal(repo.status().counts.ready, 0);
    assert.deepEqual(repo.search(vector(replacementVector), replacementKey, null, 10), []);
    assert.deepEqual(repo.vectors(indexed.id, replacementKey), []);
    assert.equal(repo.complete(oldJob, [pending.body], [[1, 0, 0]], 3), false);
    assert.equal(repo.failed(oldJob, "旧模型请求失败"), false);

    const newJob = repo.claim(replacementKey);
    assert.equal(repo.complete(newJob, [indexed.body], [replacementVector], replacement.dimensions), true);
    assert.equal(repo.search(vector(replacementVector), replacementKey, null, 10)[0].elementId, indexed.id);
    assert.deepEqual(repo.vectors(indexed.id, originalKey), []);

    // Returning to an earlier space must not revive an earlier lease or reuse the replacement vectors.
    assert.equal(repo.configure(original), originalKey);
    assert.equal(repo.status().counts.ready, 0);
    assert.equal(repo.complete(oldJob, [pending.body], [[1, 0, 0]], 3), false);
    assert.equal(repo.complete(newJob, [indexed.body], [replacementVector], replacement.dimensions), false);
    assert.deepEqual(repo.search(vector([1, 0, 0]), originalKey, null, 10), []);
    assert.equal(repo.complete(repo.claim(originalKey), [indexed.body], [[1, 0, 0]], 3), true);
    assert.equal(repo.search(vector([1, 0, 0]), originalKey, null, 10)[0].elementId, indexed.id);
    assert.equal(wiki.get(indexed.id).body, indexed.body);
    assert.deepEqual(wiki.get(indexed.id).tags, ["保留标签"]);
  });
});

test("semantic matches from a long document tail remain readable and valid evidence for the agent", (t) => {
  const { wiki, repo, db } = setup(t), key = repo.configure(config());
  const body = "无关前文。".repeat(900) + "雨夜街景的拍摄笔记", target = wiki.createText({ body, tags: [] });
  const source = wiki.createText({ body: "湿润的街道", tags: [] }), chunks = embeddingChunks(body), job = repo.claim(key);
  repo.complete(job, chunks, chunks.map((c) => c.includes("雨夜街景") ? [1, 0, 0] : [0, 1, 0]), 3);
  const matches = repo.search(vector([1, 0, 0]), key, source.id, 5);
  assert.ok(matches[0].excerpt.includes("雨夜街景"));
  const org = createOrganizationRepository(db); org.enqueue(source.id); const task = org.claim();
  const context = org.context(task.id, task.leaseToken, [], { matches });
  assert.ok(context.elements.find((e) => e.id === target.id).bodyExcerpts[0].includes("雨夜街景"));
  const result = org.submit(task.id, task.leaseToken, "tail-evidence", { summary: "场景候选", queries: [], tagAdds: [], relationAdds: [{
    targetId: target.id, name: "场景参考", evidence: { kind: "text", elementId: target.id, quote: "雨夜街景", reason: "引用提供的原文片段" },
  }] }, { executor: "fixture" }, false);
  assert.equal(result.actions[0].state, "suggested");
});

test("embedding HTTP protocol validates ordering, dimensions, secrets, redirects and cancellation", async (t) => {
  const remote = await provider(t), settings = { ...config(), baseUrl: remote.baseUrl };
  const vectors = await embedTexts(settings, ["rain", "apple"], new AbortController().signal);
  assert.ok(vectors[0][0] > vectors[0][1]); assert.ok(vectors[1][1] > vectors[1][0]);
  remote.state.mode = "invalid"; await assert.rejects(embedTexts(settings, ["rain"], new AbortController().signal), /响应无效/);
  remote.state.mode = "fail"; await assert.rejects(embedTexts(settings, ["rain"], new AbortController().signal), (e) => e.retryable && !e.message.includes("secret"));
  remote.state.mode = "redirect"; await assert.rejects(embedTexts(settings, ["rain"], new AbortController().signal), /无法连接/);
  remote.state.mode = "hang"; await assert.rejects(embedTexts(settings, ["rain"], AbortSignal.timeout(100)), /取消/);
  await assert.rejects(embedTexts({ ...settings, apiKeyEnv: "WIKI_SEMANTIC_UNSET_TEST_KEY" }, ["rain"], new AbortController().signal), /未设置/);
});

test("background text indexing does not require Codex; retrieval crosses recent-item window and preserves new candidates", { timeout: 25000 }, async (t) => {
  const resource = setup(t), { wiki, repo, db } = resource, remote = await provider(t), settings = defaultOrganizationConfig();
  settings.embedding = { ...config(), baseUrl: remote.baseUrl }; settings.executor.codexCli.executable = "nonexistent-codex";
  const rain = wiki.createText({ body: "雨夜街景", tags: [] });
  const needle = wiki.createText({ body: "unique-key", tags: [] });
  const service = createSemanticService({ repo, wiki }); resource.close = () => service.close(); await service.configure(settings);
  await until(() => repo.status().counts.ready === 2);
  assert.deepEqual((await service.search({ query: "rain", minScore: 0.48 })).matches.map((m) => m.elementId), [rain.id]);
  assert.deepEqual((await service.search({ query: "apple", minScore: 0.48 })).matches, []);
  for (let i = 0; i < 55; i++) wiki.createText({ body: `无关笔记 ${i}`, tags: i < 30 ? [`tag${i % 3}`] : [] });
  const source = wiki.createText({ body: "湿润的街道", tags: ["tag0", "tag1", "tag2"] });
  const found = await service.search({ elementId: source.id }); assert.equal(found.matches[0].elementId, rain.id);
  const org = createOrganizationRepository(db); org.enqueue(source.id); const job = org.claim();
  const initial = org.context(job.id, job.leaseToken);
  assert.equal(initial.elements.length, 40); assert.ok(!initial.elements.some((e) => [rain.id, needle.id].includes(e.id)));
  assert.ok(org.context(job.id, job.leaseToken, [], found).elements.some((e) => e.id === rain.id));
  assert.ok(org.context(job.id, job.leaseToken, ["unique-key"]).elements.some((e) => e.id === needle.id));
  settings.embedding.enabled = false; await service.configure(settings);
  assert.match((await service.search({ query: "雨夜" })).reason, /未启用/);
});

test("server API indexes images via executor, caches descriptions, rebuilds and integrates semantic context", { timeout: 30000 }, async (t) => {
  const resource = await temporary(t), root = resource.dir, remote = await provider(t), settings = defaultOrganizationConfig();
  const executable = path.join(root, "caption-fixture.mjs"), calls = path.join(root, "caption-calls.txt");
  await writeFile(executable, `import {writeFile,appendFile,readFile} from 'node:fs/promises';
const args=process.argv.slice(2);
if(args[0]==='app-server') {
  const {createInterface}=await import('node:readline');
  for await(const line of createInterface({input:process.stdin})) {
    const q=JSON.parse(line); if(q.id===undefined)continue;
    const result=q.method==='config/read'?{config:{model:'caption-default'}}:
      q.method==='model/list'?{data:[{model:'fixture-built-in',isDefault:true}]}:{};
    console.log(JSON.stringify({id:q.id,result}));
  }
  process.exit(0);
}

if(args[0]==='--version'){console.log('fixture');process.exit(0);}
if(args.includes('--help')){console.log('--image --output-schema --ignore-user-config --ephemeral');process.exit(0);}
if(args[0]==='login')process.exit(0);
let input=''; for await(const chunk of process.stdin) input+=chunk;
if(args.includes('--image') && !(await readFile(args[args.indexOf('--image')+1])).length)process.exit(2);
const output={summary:'雨夜街头，湿润路面反射灯光。',queries:[],tagAdds:[],relationAdds:[]};
if(input.includes('资料 JSON：\\n')) {
  const context=JSON.parse(input.split('资料 JSON：\\n').at(-1));
  const target=context.elements.find(e=>e.kind==='text');
  output.relationAdds=[{targetId:target.id,name:'场景参考',evidence:{kind:'text',elementId:target.id,quote:'雨后的路面',reason:'场景相关候选，供人工确认'}}];
} else await appendFile(${JSON.stringify(calls)},'caption\\n');
const schema=JSON.parse(await readFile(args[args.indexOf('--output-schema')+1],'utf8'));
const result=schema.required.length===1?{summary:output.summary}:output;
await writeFile(args[args.indexOf('-o')+1],JSON.stringify(result));`);
  settings.executor.codexCli.executable = executable;
  settings.executor.codexCli.codexHome = path.join(root, "isolated-test-auth");
  settings.embedding = { ...config(), baseUrl: remote.baseUrl };
  await writeFile(path.join(root, "organization.json"), JSON.stringify(settings));
  let app = await createServer({ port: 0, dataDir: root }); resource.close = () => app.close();
  const api = async (route, body = null, method = body ? "POST" : "GET") => {
    const response = await fetch(new URL(`api/${route}`, app.url), { method, headers: { "content-type": "application/json" }, ...(body && { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  const rain = await api("elements", { body: "雨后的路面" });
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
  const response = await fetch(new URL("api/images", app.url), { method: "POST", body: bytes, headers: { "content-type": "application/octet-stream", "x-file-name": "sample.png" } });
  assert.ok(response.ok); const image = await response.json();
  await until(async () => (await api("organization/semantic/status")).counts.ready === 2);
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 1);
  const hits = await api("organization/semantic/search", { query: "降水后的街道" });
  assert.ok(hits.matches.some((m) => m.elementId === image.id)); assert.ok(hits.matches.some((m) => m.elementId === rain.id));
  assert.deepEqual((await api(`elements/${image.id}`)).tags, []);
  const searchQuery = `elements?scope=library&semantic=1&q=${encodeURIComponent("降水后的街道")}`;
  assert.equal((await api(`elements?q=${encodeURIComponent("降水后的街道")}`)).pagination.total, 0);
  const combined = await api(searchQuery);
  assert.equal(combined.pagination.total, 2);
  assert.deepEqual(combined.possible, []);
  const weakQuery = 'elements?scope=library&semantic=1&q=apple';
  const weak = await api(weakQuery);
  assert.equal(weak.pagination.total, 0);
  assert.deepEqual(weak.elements, []);
  assert.equal(weak.possible.length, 2);
  assert.deepEqual((await api(`${weakQuery}&kind=image`)).possible.map((e) => e.id), [image.id]);
  assert.deepEqual((await api(`${weakQuery}&tag=absent`)).possible, []);
  assert.deepEqual((await api('elements?semantic=1&scope=trash&q=apple')).possible, []);
  assert.deepEqual((await api('elements?q=apple')).possible, []);
  assert.deepEqual((await api(`${searchQuery}&page=50`)).possible, []);
  assert.ok(combined.elements.some((e) => e.id === image.id));
  assert.equal((await api(`${searchQuery}&kind=image`)).elements[0].id, image.id);
  assert.equal((await api(`${searchQuery}&tag=absent`)).pagination.total, 0);
  // A description-only literal match survives even when the provider cannot retrieve it.
  remote.state.mode = "fail";
  const descriptionHit = await api(`elements?semantic=1&q=${encodeURIComponent("湿润")}`);
  assert.deepEqual((await api(weakQuery)).possible, []);
  assert.deepEqual(descriptionHit.elements.map((e) => e.id), [image.id]);
  assert.equal((await api(`elements?q=${encodeURIComponent("湿润")}`)).pagination.total, 0);
  assert.equal((await api(`elements?semantic=1&q=${encodeURIComponent("%")}`)).pagination.total, 0);
  remote.state.mode = "ok";
  const firstPage = await api(`${searchQuery}&pageSize=1`), secondPage = await api(`${searchQuery}&pageSize=1&page=2`);
  assert.equal(firstPage.pagination.total, 2);
  assert.notEqual(firstPage.elements[0].id, secondPage.elements[0].id);
  assert.equal((await api(`elements?semantic=1&q=${encodeURIComponent("雨后")}`)).pagination.total, 2);
  remote.state.mode = "fail";
  const fallback = await api(`elements?semantic=1&q=${encodeURIComponent("雨后")}`);
  assert.deepEqual(fallback.elements.map((e) => e.id), [rain.id]);
  assert.match(fallback.searchNotice, /仅匹配文字、文件名和已有图片描述/);
  remote.state.mode = "ok";
  await api("organization/enqueue", { elementId: image.id });
  const organized = await until(async () => (await api(`organization/status?elementId=${image.id}`)).results[0]);
  assert.equal(organized.execution.rounds, 1); assert.equal(organized.actions[0].targetId, rain.id);
  const usage = await api("token-usage?days=0");
  for (const purpose of ["organization", "image-description", "embedding-index", "embedding-search", "embedding-probe"]) {
    assert.ok(usage.groups.some((g) => g.purpose === purpose), `Missing usage category: ${purpose}`);
  }
  assert.equal(usage.groups.find((g) => g.purpose === "organization").calls, 1);
  assert.equal(usage.groups.find((g) => g.purpose === "image-description").model, "caption-default");
  assert.equal(organized.actions[0].state, "suggested");
  assert.deepEqual(organized.execution.imageIds, []);
  assert.equal(usage.recent.find((r) => r.purpose === "organization").context.descriptionCount, 1);
  await api("organization/semantic/rebuild", { mode: "all" });
  await until(async () => (await api("organization/semantic/status")).counts.ready === 2);
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 1);
  settings.executor.codexCli.executable = path.join(root, "missing.exe");
  await api("organization/config", settings, "PUT");
  await api("organization/enqueue", { elementId: rain.id }); const { job } = await api("organization/claim", {});
  const context = await api(`organization/jobs/${job.id}/context`, { leaseToken: job.leaseToken });
  assert.ok(context.semantic.matches.some((m) => m.elementId === image.id));
  assert.match(context.elements.find((e) => e.id === image.id).semanticDescription, /湿润/);
  const countBeforeRestart = remote.requests.length;
  await app.close(); app = await createServer({ port: 0, dataDir: root });
  assert.equal((await api("organization/semantic/status")).counts.ready, 2);
  assert.equal(remote.requests.length, countBeforeRestart);
  remote.state.mode = "hang";
  await api("elements", { body: "取消中的向量请求" });
  await until(async () => (await api("organization/semantic/status")).counts.running === 1);
  settings.embedding.enabled = false; const start = Date.now(); await api("organization/config", settings, "PUT");
  assert.ok(Date.now() - start < 5000); assert.equal((await api("organization/semantic/status")).counts.running, 0);
});
