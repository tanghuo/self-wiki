import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer, fetch } from "../helpers/authenticatedServer.js";
import { defaultOrganizationConfig, organizationConfig } from "../../src/shared/domain/organization.js";
import { createGrokTools } from "../../src/agent/executors/grokTools.js";
import { acquireExternalResource } from '../../src/agent/executors/resourceGate.js';
import { externalResourceLimits } from '../../src/shared/domain/externalResources.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-grok-chat-"));
  const previous = process.env.GROK_HOME; process.env.GROK_HOME = root;
  const config = defaultOrganizationConfig(); config.chat.engine = "grok-build";
  config.chat.grokBuild.executable = path.join(root, "grok.mjs");
  config.executor.codexCli.executable = path.join(root, "missing-codex.exe");
  await writeFile(config.chat.grokBuild.executable, await readFile(new URL("../fixtures/grok-acp.txt", import.meta.url)));
  await writeFile(path.join(root, "organization.json"), JSON.stringify(config));
  let app = await createServer({ port: 0, dataDir: root });
  t.after(async () => {
    await app.close(); if (previous === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = previous;
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("wiki-grok-chat-"));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  async function api(route, body, method = body ? "POST" : "GET") {
    const response = await fetch(new URL(`api/${route}`, app.url), { method, headers: { "content-type": "application/json" }, ...(body && { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  }
  async function wait(id) {
    for (let i = 0; i < 200; i++) { const value = await api(`chat/sessions/${id}`); if (value.turns.at(-1)?.state !== "running") return value; await sleep(15); }
    throw new Error("Grok turn did not complete");
  }
  return { root, config, api, wait,
    start: (text) => api("chat/sessions/start", { text, sourceIds: [], requestKey: `start-${Date.now()}`, imageOptions: { executor: "grok-build", direct: false } }),
    send: async (id, text) => { await api(`chat/sessions/${id}/turns`, { text, sourceIds: [], requestKey: `next-${Date.now()}`, imageOptions: { executor: "grok-build", direct: false } }); return wait(id); },
    async restart() { await app.close(); app = await createServer({ port: 0, dataDir: root }); },
    requests: async () => (await readFile(path.join(root, "acp-requests.ndjson"), "utf8")).trim().split("\n").map(JSON.parse),
  };
}

test("chat engine defaults preserve old configurations and validate local Grok settings", () => {
  const config = defaultOrganizationConfig(); delete config.chat;
  assert.equal(organizationConfig(config).chat.engine, "codex");
  for (const executable of ["\\\\host\\share\\grok.exe", "grok.cmd", "grok.bat"]) {
    assert.throws(() => organizationConfig({ ...config, chat: { engine: "grok-build", grokBuild: { executable, model: "grok-4.6" } } }));
  }
  assert.throws(() => organizationConfig({ ...config, chat: { engine: 'grok-build', grokBuild: { executable: 'grok', model: '--yolo' } } }));
});

test('Grok queued turns show a notice, can be stopped and release their waiting slot', { timeout: 10000 }, async (t) => {
  const releases = [];
  t.after(() => releases.forEach(release => release()));
  for (let i = 0; i < externalResourceLimits.keys.grok - 1; i++) releases.push(await acquireExternalResource('grok'));
  const f = await fixture(t), first = await f.start('HANG');
  for (let i = 0; i < 100; i++) {
    const data = await f.api(`chat/sessions/${first.session.id}`);
    if (data.turns.at(-1).turnId) break;
    await sleep(10);
  }
  const second = await f.start('hello');
  let queued;
  for (let i = 0; i < 100; i++) {
    queued = await f.api(`chat/sessions/${second.session.id}`);
    if (queued.progressNotice.includes('等待 Grok')) break;
    await sleep(10);
  }
  assert.match(queued.progressNotice, /等待 Grok/);
  const stopped = await f.api(`chat/sessions/${second.session.id}/stop`, {});
  assert.equal(stopped.turns.at(-1).state, 'interrupted');
  await f.api(`chat/sessions/${first.session.id}/stop`, {});
  const third = await f.start('hello again');
  assert.equal((await f.wait(third.session.id)).turns.at(-1).state, 'completed');
});

test("Grok MCP bearer is scoped to active tools and never grants arbitrary tool calls", async (t) => {
  let calls = 0;
  const bridge = await createGrokTools(async () => { calls++; return { success: true, contentItems: [{ type: "inputText", text: "ok" }] }; });
  t.after(() => bridge.close());
  const headers = { "content-type": "application/json", Authorization: bridge.definition.headers[0].value };
  assert.equal((await fetch(bridge.definition.url, { method: "POST", body: "{}" })).status, 401);
  const invoke = async (name) => (await fetch(bridge.definition.url, { method: "POST", headers, body: JSON.stringify({ id: 1, method: "tools/call", params: { name, arguments: {} } }) })).json();
  bridge.configure([{ name: "wiki_cli" }]);
  assert.ok((await invoke("wiki_cli")).error); bridge.begin("thread", "turn");
  assert.ok((await invoke("delete_database")).error); assert.equal(calls, 0);
  assert.equal((await invoke("wiki_cli")).result.content[0].text, "ok"); bridge.end();
  assert.ok((await invoke("wiki_cli")).error); assert.equal(calls, 1);
});

test("Grok chat generates, resumes, edits automatically after restart and preserves tool boundaries", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const models = await f.api("chat/models"); assert.ok(models.models.some((entry) => entry.id === "grok-4.6"));
  assert.equal((await f.api("chat/status")).engine, "grok-build");
  const first = await f.start("GENERATE_CAT"), id = first.session.id;
  let data = await f.wait(id), turn = data.turns.at(-1);
  assert.equal(turn.state, "completed", turn.error); assert.ok(turn.events.some((entry) => entry.artifact));
  const thread = data.session.threadId;
  data = await f.send(id, "REMEMBER CAT42"); assert.equal(data.session.threadId, thread);
  await f.restart();
  data = await f.send(id, "EDIT_CAT"); turn = data.turns.at(-1);
  assert.equal(turn.state, "completed", turn.error); assert.ok(turn.events.some((entry) => entry.artifact));
  assert.equal(data.session.threadId, thread); assert.ok(!turn.answer.includes("REPLAY_SHOULD_BE_IGNORED"));
  let trace = await f.api(`chat/turns/${turn.id}/trace`);
  assert.equal(trace.record.value.contextMode, "resumed");
  assert.ok(!JSON.stringify(trace).includes("Bearer"));
  const requests = await f.requests(); assert.equal(requests.filter((entry) => entry.method === "session/new").length, 1);
  assert.equal(requests.at(-1).method, "session/load");
  assert.notEqual(requests[0].mcpUrl, requests.at(-1).mcpUrl);
  data = await f.send(id, "RECALL"); assert.equal(data.turns.at(-1).answer, "CAT42");
  data = await f.send(id, "WIKI"); assert.equal(data.turns.at(-1).state, "completed", data.turns.at(-1).error);
  assert.ok(data.turns.at(-1).events.some((entry) => entry.toolType === "wiki_cli" && entry.state === "completed"));
  data = await f.send(id, "DENY_SHELL"); assert.equal(data.turns.at(-1).answer, "SHELL_BLOCKED");
  const fork = await f.api(`chat/turns/${data.turns[0].id}/fork`, { title: "fork", requestKey: `fork-${Date.now()}`, branchRevision: data.session.branchRevision });
  data = await f.send(fork.id, "GENERATE_CAT"); assert.notEqual(data.session.threadId, thread);
  trace = await f.api(`chat/turns/${data.turns.at(-1).id}/trace`); assert.equal(trace.record.value.contextMode, "replayed");
});

test("Grok cancellation and foreign image results do not leave a successful artifact", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const first = await f.start("HANG");
  // Wait until the ACP prompt has actually started before cancelling.
  for (let i = 0; i < 100; i++) {
    const data = await f.api(`chat/sessions/${first.session.id}`);
    if (data.turns.at(-1).turnId) break; await sleep(10);
  }
  const stopped = await f.api(`chat/sessions/${first.session.id}/stop`, {});
  assert.equal(stopped.turns.at(-1).state, "interrupted");
  const data = await f.send(first.session.id, "BAD_IMAGE"), turn = data.turns.at(-1);
  assert.ok(turn.events.some((entry) => entry.state === "failed")); assert.ok(!turn.events.some((entry) => entry.artifact));
});

test("switching between Codex and Grok rebuilds the engine context while retaining local history", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const first = await f.start("REMEMBER CAT42"), id = first.session.id;
  let data = await f.wait(id); const originalThread = data.session.threadId;
  f.config.executor.codexCli.executable = path.join(f.root, "codex.mjs");
  await writeFile(f.config.executor.codexCli.executable, await readFile(new URL("../fixtures/chat-app-server.txt", import.meta.url)));
  f.config.chat.engine = "codex";
  await f.api("organization/config", f.config, "PUT");
  data = await f.send(id, "MODEL_CHECK"); assert.equal(data.turns.at(-1).state, "completed", data.turns.at(-1).error);
  assert.notEqual(data.session.threadId, originalThread);
  f.config.chat.engine = "grok-build";
  await f.api("organization/config", f.config, "PUT");
  data = await f.send(id, "HELLO_GROK");
  assert.equal(data.turns.length, 3); assert.equal(data.turns.at(-1).state, "completed", data.turns.at(-1).error);
  assert.notEqual(data.session.threadId, originalThread);
  const trace = await f.api(`chat/turns/${data.turns.at(-1).id}/trace`);
  assert.equal(trace.record.value.contextMode, "replayed"); assert.equal(trace.record.value.chatEngine, "grok-build");
});
