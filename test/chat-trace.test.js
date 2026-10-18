import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { createServer } from "../src/server/server.js";
import { defaultOrganizationConfig } from "../src/shared/domain/organization.js";
import { captureChatTrace, mergeChatToolTrace } from "../src/server/application/chatTrace.js";
import { codexToolTrace } from "../src/agent/executors/codexSession.js";
import { migrateChatTrace } from "../src/server/data/chatTraceMigration.js";
import { initDb } from "../src/server/data/sqlite.js";
import { createChatRepository } from "../src/server/data/chatRepository.js";
import { createElementRepository } from "../src/server/data/elementRepository.js";

test("trace capture bounds output, identifies omitted media and preserves literal text", () => {
  const original = { input: "literal $x\n<script>text</script>", args: { authorization: "Bearer private", apiKey: "private" },
    image: "data:image/png;base64,aGVsbG8=", output: "文".repeat(600000) };
  const result = captureChatTrace(original);
  assert.equal(result.value.input, original.input);
  assert.equal(result.value.image.bytes, 5);
  assert.equal(result.value.image.sha256.length, 64);
  assert.equal(result.value.output.length, 512 * 1024);
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.ok(result.omissions.some((o) => o.originalChars === 600000));
  assert.equal(original.args.apiKey, "private", "Capture does not mutate what is sent");
  const started = codexToolTrace({ type: "imageGeneration", prompt: "实际输入" });
  const completed = mergeChatToolTrace(codexToolTrace({ type: "imageGeneration", prompt: "返回的其他版本", revisedPrompt: "工具改写" }), started);
  assert.equal(completed.input.prompt, "实际输入");
  assert.equal(completed.output.reportedInput.prompt, "返回的其他版本");
  assert.equal(completed.output.revisedPrompt, "工具改写");
  assert.equal(codexToolTrace({ type: "imageGeneration", revisedPrompt: "仅有改写" }).input.prompt, undefined);
});

test("trace migration is additive, repeatable and atomic", () => {
  for (const fail of [false, true]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE wiki_schema(version INTEGER PRIMARY KEY); CREATE TABLE chat_turns(id INTEGER PRIMARY KEY); INSERT INTO chat_turns VALUES(1)");
      if (fail) db.exec("CREATE TABLE chat_trace_records(existing INTEGER)");
      if (fail) { assert.throws(() => migrateChatTrace(db)); assert.equal(db.prepare("SELECT 1 FROM wiki_schema WHERE version=21").get(), undefined); }
      else { migrateChatTrace(db); migrateChatTrace(db); assert.equal(db.prepare("SELECT count(*) n FROM wiki_schema WHERE version=21").get().n, 1); }
      assert.equal(db.prepare("SELECT id FROM chat_turns").get().id, 1);
    } finally { db.close(); }
  }
});

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-chat-trace-"));
  const config = defaultOrganizationConfig(); config.executor.codexCli.executable = path.join(dir, "app-server.mjs");
  await writeFile(config.executor.codexCli.executable, await readFile(new URL("./fixtures/chat-app-server.txt", import.meta.url)));
  await writeFile(path.join(dir, "organization.json"), JSON.stringify(config));
  let app = await createServer({ port: 0, dataDir: dir });
  t.after(async () => { await app.close(); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith("wiki-chat-trace-")); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); });
  const api = async (route, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(new URL(`api/${route}`, app.url), { method, headers: { "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
  };
  async function send(session, text, sourceIds = []) {
    await api(`chat/sessions/${session.id}/turns`, { text, sourceIds, requestKey: randomUUID() });
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const detail = await api(`chat/sessions/${session.id}`);
      if (detail.turns.at(-1)?.state !== "running") return detail.turns.at(-1);
      await sleep(30);
    }
    throw new Error("Trace fixture did not finish");
  }
  return { dir, api, send, get url() { return app.url; }, async restart() { await app.close(); app = await createServer({ port: 0, dataDir: dir }); } };
}

test("file tools are registered, dispatch without shell commands and persist one trace per call across concurrent sessions", async (t) => {
  const app = await fixture(t);
  const sessions = await Promise.all([app.api("chat/sessions", {}), app.api("chat/sessions", {})]);
  const turns = await Promise.all(sessions.map((session) => app.send(session, "FILE_TOOLS")));
  for (const [index, turn] of turns.entries()) {
    assert.equal(turn.state, "completed", turn.error);
    const answer = JSON.parse(turn.answer);
    assert.equal(answer.listed.entries.length, 1);
    assert.equal(answer.read.content, "文件工具第一行\nNeedle literal [1]");
    assert.equal(answer.search.matches[0].line, 2);
    assert.match(answer.error, /当前会话工作目录/);
    assert.deepEqual(turn.events.filter((e) => e.command).map((e) => e.command), ["查找文件", "读取文件", "搜索文件内容", "读取文件"]);
    assert.ok(!turn.events.some((e) => e.toolType === "commandExecution" || e.toolType === "wiki_cli"));
    const request = (await app.api(`chat/turns/${turn.id}/trace`)).record.value;
    assert.deepEqual(request.thread.params.dynamicTools.map((tool) => tool.name), ["wiki_cli", "list_files", "read_file", "search_files"]);
    for (const event of turn.events.filter((e) => e.command)) {
      const trace = (await app.api(`chat/turns/${turn.id}/trace?event=${event.id}`)).record.value;
      assert.equal(trace.observedVia, "应用实际调用");
      assert.equal(trace.input.cwd, path.join(app.dir, "chat-workspace", String(sessions[index].id)));
      assert.equal(trace.output.success, event.state === "completed");
      assert.equal(trace.type, event.toolType);
    }
  }
  const next = await app.send(sessions[0], "FILE_TOOLS again");
  assert.equal(next.state, "completed", next.error);
  assert.equal((await app.api(`chat/turns/${next.id}/trace`)).record.value.contextMode, "resumed");
  await app.restart();
  assert.deepEqual((await app.api(`chat/sessions/${sessions[1].id}`)).turns[0].events, turns[1].events);
});

test("old conversations rebuild once to receive file tools and then resume normally", async (t) => {
  const app = await fixture(t), session = await app.api("chat/sessions", {});
  const first = await app.send(session, "CONTENT_INPUT 保留原有上下文");
  const db = initDb(path.join(app.dir, "library.sqlite3"));
  try {
    const trace = JSON.parse(db.prepare("SELECT data FROM chat_trace_records WHERE turn_id=? AND record_key='request'").get(first.id).data);
    delete trace.value.toolsetVersion;
    trace.value.thread.params.dynamicTools = trace.value.thread.params.dynamicTools.filter((tool) => tool.name === "wiki_cli");
    db.prepare("UPDATE chat_trace_records SET data=? WHERE turn_id=? AND record_key='request'").run(JSON.stringify(trace), first.id);
  } finally { db.close(); }
  const upgraded = await app.send(session, "FILE_TOOLS upgrade");
  assert.equal(upgraded.state, "completed", upgraded.error);
  const trace = (await app.api(`chat/turns/${upgraded.id}/trace`)).record.value;
  assert.equal(trace.contextMode, "replayed");
  assert.match(trace.turn.params.input[0].text, /保留原有上下文/);
  assert.equal(trace.thread.params.dynamicTools.length, 4);
  const resumed = await app.send(session, "FILE_TOOLS resume");
  assert.equal(resumed.state, "completed", resumed.error);
  assert.equal((await app.api(`chat/turns/${resumed.id}/trace`)).record.value.contextMode, "resumed");
});

test("a different image executor rebuilds the thread even with the same toolset version", async (t) => {
  const app = await fixture(t), session = await app.api("chat/sessions", {});
  const first = await app.send(session, "CONTENT_INPUT 保留生图切换前的上下文");
  const db = initDb(path.join(app.dir, "library.sqlite3"));
  try {
    const trace = JSON.parse(db.prepare("SELECT data FROM chat_trace_records WHERE turn_id=? AND record_key='request'").get(first.id).data);
    trace.value.imageExecutor = "another-image-executor";
    db.prepare("UPDATE chat_trace_records SET data=? WHERE turn_id=? AND record_key='request'").run(JSON.stringify(trace), first.id);
  } finally { db.close(); }
  const next = await app.send(session, "CONTENT_INPUT 新执行器");
  assert.equal(next.state, "completed", next.error);
  const request = (await app.api(`chat/turns/${next.id}/trace`)).record.value;
  assert.equal(request.contextMode, "replayed");
  assert.match(request.turn.params.input[0].text, /保留生图切换前的上下文/);
  const resumed = await app.send(session, "CONTENT_INPUT 继续");
  assert.equal((await app.api(`chat/turns/${resumed.id}/trace`)).record.value.contextMode, "resumed");
});

test("failed shell commands show their actual output when no error field was returned", async (t) => {
  const app = await fixture(t), session = await app.api("chat/sessions", {});
  const turn = await app.send(session, "COMMAND_OUTPUT_ERROR");
  const event = turn.events.find((e) => e.toolType === "commandExecution");
  assert.equal(event.state, "failed");
  assert.match(event.error, /CommandNotFoundException/);
  assert.ok(!event.error.includes("未返回具体原因"));
});

test("CLI receives chosen text and images without Wiki metadata or proposal state", async (t) => {
  const app = await fixture(t), session = await app.api("chat/sessions", {});
  const source = await app.api("elements", { body: "  用户引用的原文\n保持换行与空格。  ", tags: ["TEXT_TAG_NOISE"] });
  const unrelated = await app.api("elements", { body: "RELATED_CONTENT_NOISE" });
  await app.api("relations", { sourceId: source.id, targetId: unrelated.id, name: "RELATION_NAME_NOISE" });
  const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: "#234567" } }).png().toBuffer();
  const imported = await fetch(new URL("api/images", app.url), { method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": "reference.png" }, body: bytes });
  assert.equal(imported.status, 201);
  const image = await imported.json();
  await app.api(`elements/${image.id}`, { tags: ["IMAGE_TAG_NOISE"] }, "PATCH");
  const first = await app.send(session, "CONTENT_INPUT 使用图片和文字", [image.id, source.id]);
  assert.equal(first.state, "completed", first.error);
  const actual = JSON.parse(await readFile(path.join(app.dir, "chat-workspace", String(session.id), "content-request.json"), "utf8"));
  const suppliedText = actual.turn.input[0].text;
  const references = JSON.parse(suppliedText.slice(suppliedText.indexOf("\n[") + 1));
  assert.deepEqual(references, [{ kind: "image", filename: "reference.png", attachment: 1 }, { kind: "text", body: source.body }]);
  assert.equal(actual.turn.input.length, 2);
  const pixels = await sharp(Buffer.from(actual.turn.input[1].url.split(",")[1], "base64")).metadata();
  assert.equal(pixels.width, 12); assert.equal(pixels.height, 8);
  assert.doesNotMatch(JSON.stringify(actual), /TEXT_TAG_NOISE|IMAGE_TAG_NOISE|RELATED_CONTENT_NOISE|RELATION_NAME_NOISE|imageArtifact|appearedAt|fingerprint|最近建议状态|add_relation|add_tags|create_text/);
  const db = initDb(path.join(app.dir, "library.sqlite3"));
  try {
    const stored = createChatRepository(db).turn(first.id);
    assert.deepEqual(stored.sources.find((s) => s.id === image.id).tags, ["IMAGE_TAG_NOISE"]);
    assert.ok(stored.sources.find((s) => s.id === image.id).imageArtifact, "The Wiki still retains its provenance snapshot");
  } finally { db.close(); }
  const proposal = await app.api(`chat/turns/${first.id}/draft`, { requestKey: randomUUID(), body: "PROPOSAL_CONTENT_NOISE", sourceIds: [] });
  await app.api(`chat/proposals/${proposal.id}/accept`, {});
  const plain = await app.send(session, "CONTENT_INPUT 只处理这句话");
  const plainTrace = await app.api(`chat/turns/${plain.id}/trace`);
  assert.deepEqual(plainTrace.record.value.turn.params.input, [{ type: "text", text: "CONTENT_INPUT 只处理这句话" }]);
  assert.equal(plainTrace.record.value.thread.method, "thread/resume");

  const fork = await app.api(`chat/turns/${first.id}/fork`, { requestKey: randomUUID(), branchRevision: 0 });
  const continued = await app.send(fork, "CONTENT_INPUT 在新分支继续");
  const forkTrace = (await app.api(`chat/turns/${continued.id}/trace`)).record.value;
  const history = JSON.parse(forkTrace.turn.params.input[0].text.match(/<chat_history>(.*?)<\/chat_history>/s)[1]);
  assert.deepEqual(history[0].sources, [{ kind: "image", filename: "reference.png", historyAttachment: 1 }, { kind: "text", body: source.body }]);
  assert.equal(forkTrace.turn.params.input.length, 2);
  assert.doesNotMatch(JSON.stringify(forkTrace), /TEXT_TAG_NOISE|IMAGE_TAG_NOISE|RELATED_CONTENT_NOISE|RELATION_NAME_NOISE|imageArtifact|appearedAt|fingerprint|最近建议状态/);

  const management = await app.send(session, "CONTENT_INPUT SCHEMA 用户需要管理 Wiki");
  const event = management.events.find((e) => e.toolType === "wiki_cli");
  const tool = (await app.api(`chat/turns/${management.id}/trace?event=${event.id}`)).record.value;
  const guidance = tool.output.contentItems.find((item) => item.text?.includes("以下规则用于检索和管理 Wiki"));
  assert.match(guidance.text, /add_relation/);
  const statuses = JSON.parse(guidance.text.split("最近建议状态：")[1]);
  assert.ok(statuses.some((p) => p.id === proposal.id && p.state === "accepted"));
});

test("legacy Codex context is rebuilt from chosen content once and then resumes normally", async (t) => {
  const app = await fixture(t), session = await app.api("chat/sessions", {});
  const source = await app.api("elements", { body: "用户选择的材料", tags: ["LEGACY_TAG_NOISE"] });
  const unrelated = await app.api("elements", { body: "UNSELECTED_DISCOVERY_NOISE", tags: ["DISCOVERY_TAG_NOISE"] });
  const read = await app.api("elements", { body: "工具实际读取的正文", tags: ["TOOL_TAG_NOISE"] });
  const first = await app.send(session, "CONTENT_INPUT 旧消息", [source.id]);
  const db = initDb(path.join(app.dir, "library.sqlite3"));
  let oldRequest;
  try {
    const repo = createChatRepository(db), stored = repo.turn(first.id);
    db.prepare("UPDATE chat_turns SET sources=?,events=? WHERE id=?").run(
      JSON.stringify([...stored.sources, repo.snapshot(unrelated.id), repo.snapshot(read.id)]),
      JSON.stringify([...stored.events, { id: "old-read", toolType: "wiki_cli", command: `read ${read.id}`, state: "completed" }]), first.id);
    const trace = repo.trace(first.id, "request").record;
    delete trace.value.contextFormat;
    trace.value.thread.params.developerInstructions = "LEGACY_WIKI_RULES_NOISE";
    trace.value.turn.params.input[0].text += "\nOLD_MANAGEMENT_CONTEXT_NOISE";
    repo.writeTrace(first.id, "request", trace, [source.id]);
    oldRequest = repo.trace(first.id, "request");
  } finally { db.close(); }
  await app.restart();
  const second = await app.send(session, "CONTENT_INPUT 新消息");
  const trace = (await app.api(`chat/turns/${second.id}/trace`)).record.value;
  assert.equal(trace.thread.method, "thread/start");
  assert.equal(trace.contextMode, "replayed");
  const history = JSON.parse(trace.turn.params.input[0].text.match(/<chat_history>(.*?)<\/chat_history>/s)[1]);
  assert.equal(history[0].user, "CONTENT_INPUT 旧消息");
  assert.deepEqual(history[0].sources, [{ kind: "text", body: source.body }]);
  assert.deepEqual(history[0].outputs.find((e) => e.eventId === "old-read").content, { kind: "text", body: read.body });
  assert.doesNotMatch(JSON.stringify(trace), /LEGACY_TAG_NOISE|UNSELECTED_DISCOVERY_NOISE|DISCOVERY_TAG_NOISE|TOOL_TAG_NOISE|LEGACY_WIKI_RULES_NOISE|OLD_MANAGEMENT_CONTEXT_NOISE/);
  assert.deepEqual(await app.api(`chat/turns/${first.id}/trace`), oldRequest, "Original call records remain auditable");
  const third = await app.send(session, "CONTENT_INPUT 再继续");
  const thirdTrace = (await app.api(`chat/turns/${third.id}/trace`)).record.value;
  assert.equal(thirdTrace.thread.method, "thread/resume");
  assert.equal(thirdTrace.turn.params.threadId, trace.turn.params.threadId);
  assert.equal(thirdTrace.turn.params.input[0].text, "CONTENT_INPUT 再继续");
});

test("actual requests and tool parameters persist independently of chat snapshots and source edits", async (t) => {
  const app = await fixture(t), session = await app.api("chat/sessions", {});
  const source = await app.api("elements", { body: "发送当时的背景资料" });
  const turn = await app.send(session, "TRACE_TOOLS", [source.id]);
  assert.equal(turn.state, "completed", turn.error);
  const trace = await app.api(`chat/turns/${turn.id}/trace`);
  const actual = JSON.parse(await readFile(path.join(app.dir, "chat-workspace", String(session.id), "trace-request.json"), "utf8"));
  assert.deepEqual(trace.record.value.turn.params, actual.turn);
  assert.deepEqual(trace.record.value.thread.params, actual.thread);
  assert.equal(trace.record.value.turn.delivery, "acknowledged");
  assert.ok(trace.record.value.turn.params.input[0].text.includes(source.body));
  assert.equal(trace.record.value.contextMode, "replayed");
  assert.ok(!JSON.stringify(turn).includes("literal $value"), "Heavy details are absent from ordinary conversation snapshots");
  const command = await app.api(`chat/turns/${turn.id}/trace?event=codex:trace-command`);
  assert.equal(command.record.value.output.exitCode, 0);
  assert.equal(command.record.value.output.aggregatedOutput, "literal $value\n<script>text</script>");
  const wikiEvent = turn.events.find((e) => e.toolType === "wiki_cli");
  const wiki = await app.api(`chat/turns/${turn.id}/trace?event=${wikiEvent.id}`);
  assert.deepEqual(wiki.record.value.input.args, ["schema"]);
  assert.equal(wiki.record.value.input.stdin, "实际标准输入\n第二行");
  assert.equal(wiki.record.value.execution.exitCode, 0);
  assert.ok(wiki.record.value.execution.stdout.length > 0);
  const image = await app.api(`chat/turns/${turn.id}/trace?event=codex:trace-image`);
  assert.equal(image.record.value.input.prompt, "保持原有构图和姿势。");
  assert.equal(image.record.value.output.revisedPrompt, "保持原有构图和姿势，添加暖色灯光。");
  const missing = await app.api(`chat/turns/${turn.id}/trace?event=codex:trace-missing`);
  assert.equal(missing.record.value.input.prompt, undefined);
  const plugin = await app.api(`chat/turns/${turn.id}/trace?event=codex:trace-plugin`);
  assert.deepEqual(plugin.record.value.input.arguments, { query: "完整查询", page: 2 });
  await app.api(`elements/${source.id}`, { body: "后来修改的资料" }, "PATCH");
  assert.deepEqual(await app.api(`chat/turns/${turn.id}/trace`), trace);
  const resumed = await app.send(session, "TRACE_TOOLS 第二轮");
  const resumedTrace = await app.api(`chat/turns/${resumed.id}/trace`);
  assert.equal(resumedTrace.record.value.contextMode, "resumed");
  await app.restart();
  assert.deepEqual(await app.api(`chat/turns/${turn.id}/trace`), trace);
  assert.deepEqual(await app.api(`chat/turns/${turn.id}/trace?event=codex:trace-image`), image);
  const failed = await app.send(session, "START_FAILURE");
  const failedTrace = await app.api(`chat/turns/${failed.id}/trace`);
  assert.equal(failedTrace.record.value.turn.delivery, "unknown");
  assert.match(failedTrace.record.value.error, /请求确认失败/);
  await assert.rejects(app.api(`chat/turns/${turn.id}/trace?event=not-a-tool`), /工具记录不存在/);
  const db = initDb(path.join(app.dir, "library.sqlite3"));
  let legacy;
  try {
    const repo = createChatRepository(db), oldSession = repo.create();
    legacy = repo.begin(oldSession.id, { text: "旧消息", sourceIds: [], requestKey: "legacy-trace" }).turn;
    repo.updateTurn({ ...legacy, state: "completed", events: [{ id: "old-tool", command: "生成图片", parameters: { prompt: "旧版实际保存的提示词" } }] });
  } finally { db.close(); }
  assert.equal((await app.api(`chat/turns/${legacy.id}/trace`)).status, "unavailable");
  const oldTool = await app.api(`chat/turns/${legacy.id}/trace?event=old-tool`);
  assert.equal(oldTool.status, "legacy");
  assert.equal(oldTool.record.value.input.prompt, "旧版实际保存的提示词");
});

test("trace copies follow forked history and are cleared when dependent content is purged", () => {
  const db = initDb(":memory:");
  try {
    const repo = createChatRepository(db), wiki = createElementRepository(db), session = repo.create();
    const first = repo.begin(session.id, { text: "一", sourceIds: [], requestKey: "trace-first" }).turn;
    repo.updateTurn({ ...first, state: "completed", answer: "答" });
    repo.writeTrace(first.id, "request", { value: { userText: "一" } });
    const second = repo.begin(session.id, { text: "二", sourceIds: [], requestKey: "trace-second" }).turn;
    repo.updateTurn({ ...second, state: "completed", answer: "答二" });
    repo.writeTrace(second.id, "request", { value: { userText: "二", history: "一：答" } }, [], [first.id]);
    const fork = repo.fork(second.id, "trace-fork", 0), copies = repo.detail(fork.id).turns;
    wiki.trash(session.elementId); wiki.purge(session.elementId);
    assert.equal(repo.trace(first.id, "request").status, "deleted");
    assert.equal(repo.trace(copies[1].id, "request").status, "recorded", "Deleting the original does not erase the fork's independent history");
    assert.throws(() => repo.writeTrace(first.id, "request", { value: "late reply" }), /不能重新写入/);
    wiki.trash(fork.elementId); wiki.purge(fork.elementId);
    assert.equal(repo.trace(copies[1].id, "request").status, "deleted");
    const source = wiki.createText({ body: "将被清理的来源正文", tags: [] }), another = repo.create();
    const linked = repo.begin(another.id, { text: "引用", sourceIds: [], requestKey: "trace-source-purge" }).turn;
    repo.updateTurn({ ...linked, state: "completed", answer: "完成" });
    repo.writeTrace(linked.id, "request", { value: { sourceText: source.body } }, [source.id]);
    repo.writeTrace(linked.id, "tool:read", { value: { output: source.body } }, [source.id]);
    wiki.trash(source.id); wiki.purge(source.id);
    assert.equal(repo.trace(linked.id, "request").status, "deleted");
    assert.equal(repo.trace(linked.id, "tool:read").status, "deleted");
    assert.equal(repo.turn(linked.id).requestTraceVersion, 2);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});
