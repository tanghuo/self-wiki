import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { createServer } from "../../src/server/server.js";

const entry = path.resolve("src/cli/main.js");
function cli(args, input = "", env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args.map(String)], {
      env: { ...process.env, SELF_WIKI_URL: "", APP_DATA_DIR: "", ...env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") reject(error); });
    child.stdin.end(input);
  });
}

function success(result) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).ok, true);
  return JSON.parse(result.stdout).data;
}

function failure(result, code, errorCode) {
  assert.equal(result.code, code, result.stdout || result.stderr);
  assert.equal(result.stdout, "");
  const body = JSON.parse(result.stderr);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, errorCode);
  return body.error;
}

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-cli-test-"));
  const app = await createServer({ port: 0, dataDir: dir });
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("wiki-cli-test-"));
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const run = (args, input) => cli([...args, "--url", app.url], input);
  const ok = async (args, input) => success(await run(args, input));
  return { dir, app, run, ok };
}

test("CLI help/schema work offline and usage failures keep stdout clean", async () => {
  const catalogue = success(await cli(["schema"]));
  assert.equal(catalogue.schemaVersion, 1);
  assert.ok(catalogue.commands.some((entry) => entry.name === "read"));
  assert.ok(catalogue.commands.find((entry) => entry.name === "trash purge").destructive);
  assert.equal(success(await cli(["schema", "elements", "get"])).commands.length, 1);
  for (const args of [[], ["--help"], ["help", "elements", "create"], ["elements", "--help"], ["elements", "get", "--help"]]) {
    const result = await cli(args);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /self-wiki/);
  }
  for (const args of [
    ["unknown"], ["elements", "get", "0"], ["elements", "get", "9007199254740992"], ["elements", "get", "1", "2"],
    ["elements", "list", "--page", "1foo"], ["elements", "list", "--page", "1", "--page", "2"], ["elements", "list", "--scope", "all"],
    ["elements", "list", "--page-size", "101"], ["elements", "list", "--typo"], ["elements", "list", "--timeout", "0"],
    ["elements", "create", "--data", "[]"], ["elements", "create", "--data", "null"], ["elements", "create", "--data", "{"],
    ["elements", "create", "--body", "x", "--body-file", "-"], ["elements", "create", "--data", "{}", "--tag", "x"],
    ["elements", "create", "--data", "{}", "--input", "-"], ["relations", "create", "--source", "1"],
    ["trash", "purge", "--all"], ["trash", "purge", "--yes"], ["trash", "purge", "--all", "--ids", "1", "--yes"], ["trash", "purge", "--ids", "1,no", "--yes"],
    ["status", "--url", "https://127.0.0.1"], ["status", "--url", "http://example.com"], ["status", "--url", "http://127.0.0.1/api"],
  ]) failure(await cli(args), 2, "USAGE");
});

test("CLI preserves Unicode and whitespace, pages results and reports API errors", async (t) => {
  const { ok, run, dir } = await setup(t);
  const body = "第一行\n  保留空格 & ? #\n";
  const sourceFile = path.join(dir, "文字 文件.txt");
  await writeFile(sourceFile, `\uFEFF${body}`);
  const note = await ok(["elements", "create", "--body-file", sourceFile, "--tag", "资料 & 笔记", "--tag", "阅读"]);
  assert.equal(note.body, body);
  assert.deepEqual(note.tags, ["资料 & 笔记", "阅读"]);
  const second = await ok(["elements", "create", "--input", "-"], JSON.stringify({ body: "第二份资料", tags: ["阅读"] }));
  const matches = await ok(["elements", "list", "--q", "& ? #", "--tag", "资料 & 笔记", "--page-size", "1"]);
  assert.equal(matches.pagination.total, 1);
  assert.equal(matches.elements[0].id, note.id);
  const page = await ok(["elements", "list", "--page-size", "1", "--page", "2"]);
  assert.equal(page.pagination.pageCount, 2);
  assert.equal(page.elements.length, 1);
  const updated = await ok(["elements", "update", note.id, "--input", "-"], '{"tags":[]}');
  assert.equal(updated.body, body);
  assert.deepEqual(updated.tags, []);
  const textUpdated = await ok(["elements", "update", second.id, "--body-file", "-"], body);
  assert.equal(textUpdated.body, body);
  assert.deepEqual(textUpdated.tags, ["阅读"]);
  assert.deepEqual((await ok(["tags", "list"])).tags, ["阅读"]);
  assert.equal(failure(await run(["elements", "get", "99999"]), 1, "API_ERROR").status, 404);
  assert.equal(failure(await run(["elements", "create", "--body", " "]), 1, "API_ERROR").status, 400);
});

test("CLI connects content, reads context and manages dynamic tag relations", async (t) => {
  const { ok } = await setup(t);
  const a = await ok(["elements", "create", "--body", "来源"]);
  const b = await ok(["elements", "create", "--body", "成员一", "--tag", "集合"]);
  await ok(["elements", "create", "--body", "成员二", "--tag", "集合"]);
  const edge = await ok(["relations", "create", "--source", a.id, "--target", b.id, "--name", "参考", "--type", "title"]);
  await ok(["relations", "rename", edge.id, "--name", "标题"]);
  const context = await ok(["read", a.id, "--page-size", "1"]);
  assert.equal(context.element.body, "来源");
  assert.equal(context.relations.relations[0].name, "标题");
  assert.equal(context.relations.relations[0].element.body, "成员一");
  await ok(["relations", "batch", "--input", "-"], JSON.stringify({ sourceId: a.id, targetTags: ["集合"], name: "合集" }));
  const cards = await ok(["tag-relations", "list", a.id]);
  const card = cards.tagRelations[0];
  const members = await ok(["tag-relations", "members", card.id, "--page-size", "1"]);
  assert.equal(members.pagination.total, 2);
  assert.equal(members.elements.length, 1);
  await ok(["tag-relations", "rename", card.id, "--name", "参考合集"]);
  assert.equal((await ok(["tag-relations", "list", a.id])).tagRelations[0].name, "参考合集");
  await ok(["tag-relations", "delete", card.id]);
  await ok(["relations", "delete", edge.id]);
  assert.equal((await ok(["relations", "list", a.id])).relations.length, 0);
});

test("CLI imports original image bytes, reuses duplicates, and never overwrites downloads", async (t) => {
  const { dir, ok, run } = await setup(t);
  const original = await sharp({ create: { width: 2, height: 3, channels: 3, background: "blue" } }).png().toBuffer();
  const source = path.join(dir, "原图 空格.png");
  await writeFile(source, original);
  const imported = await ok(["images", "import", source, "--tag", "图片"]);
  const reused = await ok(["images", "import", source, "--tag", "其他"]);
  assert.equal(reused.id, imported.id);
  assert.equal(reused.importStatus, "reused");
  assert.deepEqual(reused.tags, ["图片", "其他"]);
  const output = path.join(dir, "输出.png");
  assert.equal((await ok(["elements", "download", imported.id, "--output", output])).bytes, original.length);
  assert.deepEqual(await readFile(output), original);
  failure(await run(["elements", "download", imported.id, "--output", output]), 1, "IO_ERROR");
  assert.deepEqual(await readFile(output), original);
  const note = await ok(["elements", "create", "--body", "原始文字\n  空格"]);
  const textFile = path.join(dir, "output.txt");
  await ok(["elements", "download", note.id, "--output", textFile]);
  assert.equal(await readFile(textFile, "utf8"), note.body);
});

test("CLI trash lifecycle and partial purge results preserve recoverability", async (t) => {
  const { ok, run } = await setup(t);
  const a = await ok(["elements", "create", "--body", "A"]);
  const b = await ok(["elements", "create", "--body", "B"]);
  await ok(["elements", "trash", a.id]);
  assert.equal((await ok(["elements", "list", "--scope", "trash"])).elements[0].id, a.id);
  assert.equal((await ok(["elements", "restore", a.id])).body, "A");
  await ok(["elements", "trash", a.id]);
  const partial = failure(await run(["trash", "purge", "--ids", `${a.id},${b.id}`, "--yes"]), 1, "PARTIAL_FAILURE");
  assert.deepEqual(partial.details.deleted, [a.id]);
  assert.equal(partial.details.failed[0].id, b.id);
  assert.equal((await ok(["elements", "get", b.id])).body, "B");
  assert.deepEqual((await ok(["trash", "purge", "--ids", a.id, "--yes"])).deleted, [a.id]);
  await ok(["elements", "trash", b.id]);
  assert.deepEqual((await ok(["trash", "purge", "--all", "--yes"])).deleted, [b.id]);
});

test("CLI reads and writes canvas and controls sharing configuration", async (t) => {
  const { ok, run, dir } = await setup(t);
  const note = await ok(["elements", "create", "--body", "画布"]);
  const inputFile = path.join(dir, "positions.json");
  await writeFile(inputFile, `\uFEFF${JSON.stringify({ positions: [{ id: note.id, x: 100, y: 200 }] })}`);
  await ok(["canvas", "save", "--input", inputFile]);
  const graph = await ok(["canvas", "get", "--ids", note.id, "--limit", "0"]);
  assert.ok(JSON.stringify(graph).includes('"x":100'));
  assert.equal((await ok(["sharing", "status"])).enabled, false);
  assert.equal((await ok(["sharing", "configure", "--data", '{"autoStart":false,"port":12345}'])).port, 12345);
  assert.equal((await ok(["sharing", "disable"])).enabled, false);
});

test("CLI discovery verifies identity, rejects ambiguity and cleans each instance's marker", async (t) => {
  const { dir, app } = await setup(t);
  // Empty environment values should be equivalent to unset; discovery still works.
  const args = ["status", "--data-dir", dir];
  const discovered = success(await cli(args));
  assert.equal(discovered.instance.url, app.url);
  assert.equal(discovered.instance.dataDir, dir);
  if (process.platform === "win32") success(await cli(["status", "--data-dir", dir.toUpperCase()]));
  const runtimeDir = path.join(dir, ".runtime");
  const marker = (await readdir(runtimeDir))[0];
  const record = JSON.parse(await readFile(path.join(runtimeDir, marker), "utf8"));
  await writeFile(path.join(runtimeDir, "server-dead.json"), JSON.stringify({ ...record, instanceId: "stale" }));
  success(await cli(args));
  const mismatch = await fetch(new URL("/api/elements", app.url), {
    method: "POST", headers: { "content-type": "application/json", "x-self-wiki-instance": "stale" }, body: '{"body":"must not exist"}',
  });
  assert.equal(mismatch.status, 409);
  const second = await createServer({ port: 0, dataDir: dir });
  try {
    failure(await cli(args), 3, "AMBIGUOUS_INSTANCE");
    assert.equal(success(await cli(["status", "--url", second.url])).instance.url, second.url);
  } finally { await second.close(); }
  success(await cli(args));
  await app.close();
  assert.deepEqual(await readdir(runtimeDir), ["server-dead.json"]);
  failure(await cli(args), 3, "NOT_RUNNING");
});

test("CLI does not follow redirects or retry uncertain writes, and bounds request time", async (t) => {
  let writes = 0;
  const server = createHttpServer((req, res) => {
    if (req.url === "/api/instance") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ application: "self-wiki", protocolVersion: 1, instanceId: "fake-test-instance", dataDir: os.tmpdir() }));
    } else if (req.method === "POST") { writes++; req.resume(); req.socket.destroy(); }
    else if (req.url === "/api/elements/1") { res.writeHead(302, { location: "/api/instance" }); res.end(); }
    // /api/elements intentionally never responds.
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  failure(await cli(["elements", "get", "1", "--url", url]), 3, "PROTOCOL");
  const uncertain = failure(await cli(["elements", "create", "--body", "uncertain", "--url", url]), 3, "CONNECTION");
  assert.match(uncertain.message, /may have succeeded/);
  assert.equal(writes, 1);
  failure(await cli(["elements", "list", "--url", url, "--timeout", "100"]), 3, "CONNECTION");
});


test("CLI no longer advertises or accepts collection commands", async () => {
  const catalogue = success(await cli(["schema"]));
  assert.equal(catalogue.commands.some(command => /^(items|jobs) /.test(command.name)), false);
  for (const args of [["items", "list"], ["jobs", "start"]]) failure(await cli(args), 2, "USAGE");
});
