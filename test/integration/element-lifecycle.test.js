import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createServer, fetch } from "../helpers/authenticatedServer.js";
import { defaultOrganizationConfig } from "../../src/shared/domain/organization.js";
import { initDb } from "../../src/server/data/sqlite.js";
import { createElementRepository } from "../../src/server/data/elementRepository.js";
import { createChatRepository } from "../../src/server/data/chatRepository.js";
import { chatProposal } from "../../src/shared/domain/chat.js";
import { migrateElementLifecycle } from "../../src/server/data/elementLifecycleMigration.js";
import { migrateChatContent } from "../../src/server/data/chatContentMigration.js";
import { checkIndependentPrompt } from "../../src/server/application/chatImagePrompt.js";
import { relationLabel } from "../../src/shared/domain/elements.js";

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-lifecycle-"));
  const config = defaultOrganizationConfig();
  config.executor.codexCli.executable = path.join(dir, "app-server.mjs"); config.executor.timeoutMs = 15000;
  await writeFile(config.executor.codexCli.executable, await readFile(new URL("../fixtures/chat-app-server.txt", import.meta.url)));
  await writeFile(path.join(dir, "organization.json"), JSON.stringify(config));
  let app = await createServer({ port: 0, dataDir: dir });
  const api = async (route, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(new URL(`api/${route}`, app.url), { method, headers: { "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  t.after(async () => { await app.close(); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith("wiki-lifecycle-")); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); });
  return { api, dir, get url() { return app.url; }, async restart() { await app.close(); app = await createServer({ port: 0, dataDir: dir }); } };
}
async function send(app, session, text, extra = {}) {
  const sent = await app.api(`chat/sessions/${session}/turns`, { text, sourceIds: [], requestKey: crypto.randomUUID(), ...extra });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  return settled(app, session);
}
async function settled(app, session) {
  for (let i = 0; i < 250; i++) {
    const state = (await app.api(`chat/sessions/${session}`)).data;
    const turn = state.turns.at(-1);
    if (turn.state !== "running") { assert.equal(turn.state, "completed", turn.error); return turn; }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Fixture turn timed out");
}

function outputData(app, id) {
  const db = initDb(path.join(app.dir, "library.sqlite3"));
  try { return db.prepare("SELECT data FROM chat_element_bindings WHERE element_id=?").all(id).map((r) => JSON.parse(r.data)); }
  finally { db.close(); }
}
async function promptSettled(app, session, turnId, state = "completed") {
  for (let i = 0; i < 300; i++) {
    const detail = (await app.api(`chat/sessions/${session}`)).data;
    const prompt = detail.turns.find((t) => t.id === turnId)?.saved.find((s) => s.key.startsWith("image:"))?.prompt;
    if (prompt && ["completed", "failed", "deleted"].includes(prompt.state) && !detail.running) {
      assert.equal(prompt.state, state, prompt.error); return prompt;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Prompt extraction timed out");
}

test("saved images link directly to conversations and sources, with ordinary editable relations and no operation elements", async (t) => {
  const app = await fixture(t), session = (await app.api("chat/sessions", {})).data.id;
  const source = (await app.api("elements", { body: "完整参考提示词：傍晚城市街景，暖色逆光，稀疏行人，竖幅构图。", tags: [] })).data;
  assert.equal(source.creationSource, "manual");
  const original = await send(app, session, "GENERATE_IMAGE", { sourceIds: [source.id] });
  const artifact = original.events[0].artifact;
  const edited = await send(app, session, "EDIT_IMAGE 再暖一点", { imageEdit: { turnId: original.id, artifact } });
  const finalArtifact = edited.events.find((event) => event.artifact).artifact;
  await writeFile(path.join(app.dir, "chat-artifacts", finalArtifact), await sharp({ create: { width: 10, height: 10, channels: 3, background: "#a07963" } }).png().toBuffer());
  await app.api(`elements/${source.id}`, { body: "后来修改的参考提示词" }, "PATCH");
  const saved = await app.api(`chat/turns/${edited.id}/save`, { artifact: finalArtifact });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const prompt = await promptSettled(app, session, edited.id);
  const result = saved.data;
  assert.equal(result.element.kind, "image"); assert.equal(result.element.localOnly, undefined);
  assert.equal(result.element.creationSource, "chat");
  const graph = (await app.api(`elements/${result.element.id}/lifecycle`)).data;
  assert.equal(graph.elements.filter((e) => e.kind === "image").length, 2);
  assert.equal(graph.elements.filter((e) => e.kind === "session").length, 1);
  assert.equal(graph.elements.filter((e) => e.kind === "activity").length, 0);
  const originalNode = graph.elements.find((e) => e.kind === "image" && e.localOnly);
  assert.ok(outputData(app, originalNode.id).some((data) => data.sources[0].body.includes("暖色逆光")));
  assert.ok(!graph.elements.some((e) => e.kind === "text" && e.body.includes("再暖一点")));
  const conversation = graph.elements.find((e) => e.kind === "session");
  const edge = graph.relations.find((r) => [r.sourceId, r.targetId].includes(conversation.id) && [r.sourceId, r.targetId].includes(result.element.id));
  assert.equal((await app.api(`relations/${edge.id}`, { name: "创作于" }, "PATCH")).status, 200);
  assert.equal((await app.api(`relations/${edge.id}`, undefined, "DELETE")).status, 200);
  assert.equal((await app.api(`elements/${conversation.id}`, { tags: ["创作过程"] }, "PATCH")).status, 200);
  assert.equal((await app.api(`elements/${conversation.id}`, { body: "伪造历史" }, "PATCH")).status, 400);
  assert.ok(!(await app.api("elements")).data.elements.some((e) => e.kind === "session"));
  assert.equal((await app.api("elements?kind=session")).data.elements[0].id, conversation.id);
  await send(app, session, "MODEL_CHECK 后续聊天");
  const preview = (await app.api(`elements/${conversation.id}/conversation?from=${result.element.id}`)).data;
  assert.equal(preview.turnId, edited.id); assert.equal(preview.turns.length, 3);
  assert.equal(preview.turns[0].text, original.text); assert.equal(preview.turns[2].text, "MODEL_CHECK 后续聊天");
  const count = (await app.api("elements?pageSize=100")).data.pagination.total;
  await app.restart();
  const again = await app.api(`chat/turns/${edited.id}/save`, { artifact: finalArtifact });
  assert.equal(again.data.element.id, result.element.id); assert.equal(again.data.reused, true);
  assert.equal((await app.api("elements")).data.pagination.total, count);
  assert.equal((await readdir(path.join(app.dir, "assets"))).filter((name) => name !== "previews-v1").length, 2);
  const db = initDb(path.join(app.dir, "library.sqlite3"));
  try {
    const shared = createElementRepository(db, { publicOnly: true });
    assert.equal(shared.list().elements.filter((e) => e.kind === "image").length, 1);
    assert.throws(() => shared.get(conversation.id), /不存在/);
    assert.throws(() => shared.conversation(conversation.id), /不存在/);
    assert.ok(shared.relations(result.element.id).relations.every((r) => !r.element.localOnly));
    const canvas = shared.canvas.read({ ids: graph.elements.map((e) => e.id), q: "", tag: "", limit: 100 });
    assert.ok(canvas.elements.every((e) => [source.id, result.element.id, prompt.elementId].includes(e.id)));
  } finally { db.close(); }
  const imported = await fetch(new URL("api/images", app.url), { method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": "chosen-original.png" }, body: await readFile(path.join(app.dir, "chat-artifacts", artifact)) });
  const promoted = await imported.json();
  assert.equal(promoted.id, originalNode.id); assert.equal(promoted.localOnly, undefined, "Explicitly importing an intermediate image uses the normal saved-content visibility");
});

test("extraction proposes only complete results, creates nothing until accepted, and preserves actual tool input evidence", async (t) => {
  const app = await fixture(t), session = (await app.api("chat/sessions", {})).data.id;
  const short = await send(app, session, "生成一张傍晚街景，再暖一点，人物少一些");
  await app.api(`chat/turns/${short.id}/extract`, { requestKey: crypto.randomUUID() });
  await settled(app, session);
  assert.equal((await app.api(`chat/sessions/${session}`)).data.proposals.length, 0);
  assert.equal((await app.api("elements")).data.pagination.total, 0);
  const turn = await send(app, session, "GENERATE_IMAGE_PROMPT");
  assert.equal((await app.api(`chat/turns/${turn.id}/extract`, { requestKey: crypto.randomUUID() })).status, 200);
  const extraction = await settled(app, session);
  assert.ok(extraction.text.length < 100, "Internal extraction instructions and history are not messages in the user conversation");
  const proposal = (await app.api(`chat/sessions/${session}`)).data.proposals[0];
  assert.equal(proposal.payload.excerpts[0].role, "tool");
  assert.equal(proposal.payload.excerpts[0].quote, turn.events[0].parameters.prompt);
  assert.equal((await app.api("elements?kind=text")).data.pagination.total, 0);
  const accepted = await app.api(`chat/proposals/${proposal.id}/accept`, {});
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  const id = accepted.data.changes.createdId;
  assert.ok(outputData(app, id).some((data) => data.excerpts[0].field === "prompt"));
  assert.equal(turn.events[0].parameters.model, "fixture-image");
  const count = (await app.api("elements")).data.pagination.total;
  assert.equal((await app.api(`chat/proposals/${proposal.id}/accept`, {})).data.changes.createdId, id);
  assert.equal((await app.api("elements")).data.pagination.total, count);
});

test("image save automatically distills one independent prompt using inherited text and actual reference images", async (t) => {
  const app = await fixture(t), session = (await app.api("chat/sessions", {})).data.id;
  const source = (await app.api("elements", { body: "服装使用参考图1，光线再暖一点。" })).data;
  const response = await fetch(new URL("api/images", app.url), { method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": "reference.png" }, body: await sharp({ create: { width: 8, height: 8, channels: 3, background: "green" } }).png().toBuffer() });
  const reference = await response.json();
  assert.equal(reference.creationSource, "manual");
  await send(app, session, "PROMPT_FINAL", { sourceIds: [source.id, reference.id] });
  const turn = await send(app, session, "GENERATE_IMAGE_PROMPT");
  const image = (await app.api(`chat/turns/${turn.id}/save`, { artifact: turn.events[0].artifact })).data.element;
  const prompt = await promptSettled(app, session, turn.id);
  const element = (await app.api(`elements/${prompt.elementId}`)).data;
  assert.equal(element.kind, "text"); assert.ok(element.body.includes("暖色逆光"));
  assert.equal(element.creationSource, "chat");
  assert.doesNotMatch(element.body, /参考图|原图|图1|wiki:/);
  const related = (await app.api(`elements/${element.id}/relations`)).data.relations.map((r) => r.element.id);
  assert.ok([image.id, reference.id, source.id].every((id) => related.includes(id)));
  const sourceEdges = (await app.api(`elements/${reference.id}/relations`)).data.relations.filter((r) => r.element.id === element.id);
  assert.equal(sourceEdges.length, 1, "Prompt extraction and archival share one reference edge");
  assert.equal(relationLabel(sourceEdges[0], reference.id), "被参考");
  assert.equal(relationLabel(sourceEdges[0], element.id), "参考了");
  assert.equal((await app.api(`elements/${reference.id}`)).data.creationSource, "manual");
  const detail = (await app.api(`chat/sessions/${session}`)).data;
  assert.equal(detail.turns.length, 2, "Automatic extraction does not add conversational noise");
  assert.equal(detail.proposals.length, 0, "Saving already authorizes the single accompanying prompt");
  const count = (await app.api("elements")).data.pagination.total;
  await app.api(`chat/turns/${turn.id}/save`, { artifact: turn.events[0].artifact });
  assert.equal((await promptSettled(app, session, turn.id)).elementId, element.id);
  assert.equal((await app.api("elements")).data.pagination.total, count);
});

test("dependent prompts are corrected automatically; retries keep the image and deleted prompts are not recreated", async (t) => {
  assert.doesNotThrow(() => checkIndependentPrompt("生成写实人像，构图1:1，柔和侧光与简洁灰色背景。"));
  assert.throws(() => checkIndependentPrompt("图1的人物站在卧室中"), /依赖参考图/);
  const app = await fixture(t), session = (await app.api("chat/sessions", {})).data.id;
  const turn = await send(app, session, "GENERATE_IMAGE PROMPT_BAD_FIRST"), artifact = turn.events[0].artifact;
  const image = (await app.api(`chat/turns/${turn.id}/save`, { artifact })).data.element;
  const prompt = await promptSettled(app, session, turn.id);
  assert.equal((await app.api("elements?kind=text")).data.pagination.total, 1);
  const db = initDb(path.join(app.dir, "library.sqlite3"));
  try { assert.equal(db.prepare("SELECT attempts FROM chat_prompt_jobs WHERE turn_id=?").get(turn.id).attempts, 2); }
  finally { db.close(); }
  const retry = (await app.api(`chat/turns/${turn.id}/save`, { artifact })).data;
  assert.equal(retry.element.id, image.id);
  assert.equal((await promptSettled(app, session, turn.id)).elementId, prompt.elementId);
  await app.api(`elements/${prompt.elementId}`, undefined, "DELETE");
  assert.deepEqual((await app.api("trash/purge", { ids: [prompt.elementId] })).data.failed, []);
  await app.api(`chat/turns/${turn.id}/save`, { artifact });
  await promptSettled(app, session, turn.id, "deleted");
  assert.equal((await app.api("elements?kind=text")).data.pagination.total, 0);
  assert.equal((await app.api(`elements/${image.id}`)).status, 200);
});

test("prompt extraction rereads attached images without exhausting the eight-image budget", async (t) => {
  const app = await fixture(t), session = (await app.api("chat/sessions", {})).data.id;
  const sourceIds = [];
  for (let i = 0; i < 7; i++) {
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: i * 25, g: 50, b: 80 } } }).png().toBuffer();
    const response = await fetch(new URL("api/images", app.url), { method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": `reference-${i}.png` }, body: bytes });
    sourceIds.push((await response.json()).id);
  }
  const turn = await send(app, session, "GENERATE_IMAGE PROMPT_REREAD_IMAGES", { sourceIds });
  await app.api(`chat/turns/${turn.id}/save`, { artifact: turn.events[0].artifact });
  await promptSettled(app, session, turn.id);
});

test("queued image prompts skip a busy session and resume when that session finishes", async (t) => {
  const app = await fixture(t);
  const first = (await app.api("chat/sessions", {})).data.id, second = (await app.api("chat/sessions", {})).data.id;
  const a = await send(app, first, "GENERATE_IMAGE_PROMPT"), b = await send(app, second, "GENERATE_IMAGE_PROMPT");
  assert.equal((await app.api(`chat/sessions/${first}/turns`, { text: "SLOW", sourceIds: [], requestKey: "prompt-busy-session" })).status, 200);
  assert.equal((await app.api(`chat/turns/${a.id}/save`, { artifact: a.events[0].artifact })).status, 200);
  assert.equal((await app.api(`chat/turns/${b.id}/save`, { artifact: b.events[0].artifact })).status, 200);
  await promptSettled(app, second, b.id);
  const pending = (await app.api(`chat/sessions/${first}`)).data;
  assert.equal(pending.running, true);
  assert.equal(pending.turns[0].saved[0].prompt.state, "queued");
  await app.api(`chat/sessions/${first}/stop`, {});
  await promptSettled(app, first, a.id);
});

for (const mode of ["REREAD", "RETRY", "ALWAYS", "CANCEL"]) test(`prompt source changes recover safely: ${mode}`, async (t) => {
  const app = await fixture(t), session = (await app.api("chat/sessions", {})).data.id;
  const source = (await app.api("elements", { body: "完整街景画面依据", tags: [] })).data;
  const turn = await send(app, session, `GENERATE_IMAGE PROMPT_SOURCE_CHANGE ${mode}`, { sourceIds: [source.id] });
  const artifact = turn.events[0].artifact;
  const saved = (await app.api(`chat/turns/${turn.id}/save`, { artifact })).data.element;
  for (let attempt = 1; attempt <= (mode === "ALWAYS" ? 3 : 1); attempt++) {
    const ready = path.join(app.dir, "chat-workspace", String(session), `prompt-ready-${attempt}`);
    for (let i = 0; ; i++) {
      if (await readFile(ready).catch(() => null)) break;
      assert.ok(i < 400, `Extraction attempt ${attempt} did not start`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal((await app.api(`elements/${source.id}`, { tags: [`后台标签-${attempt}`] }, "PATCH")).status, 200);
    if (mode === "CANCEL") { await app.api(`chat/sessions/${session}/stop`, {}); break; }
    await writeFile(path.join(app.dir, "chat-workspace", String(session), `prompt-continue-${attempt}`), "continue");
  }
  const failed = ["ALWAYS", "CANCEL"].includes(mode);
  const prompt = await promptSettled(app, session, turn.id, failed ? "failed" : "completed");
  if (mode === "ALWAYS") assert.match(prompt.error, /wiki:\d+ 已有修改/);
  if (mode === "CANCEL") assert.match(prompt.error, /已停止生成/);
  const db = initDb(path.join(app.dir, "library.sqlite3"));
  try {
    const job = db.prepare("SELECT attempts FROM chat_prompt_jobs WHERE turn_id=?").get(turn.id);
    assert.equal(job.attempts, mode === "ALWAYS" ? 3 : mode === "RETRY" ? 2 : 1);
    assert.equal(db.prepare("SELECT count(*) n FROM chat_element_bindings WHERE turn_id=? AND output_key LIKE 'image:%'").get(turn.id).n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM chat_proposals WHERE state=1").get().n, failed ? 0 : 1);
    assert.equal(db.prepare("SELECT id FROM elements WHERE id=? AND deleted_at IS NULL").get(saved.id).id, saved.id);
  } finally { db.close(); }
  if (mode === "ALWAYS") {
    await app.api(`chat/turns/${turn.id}/save`, { artifact });
    // A manual retry gets a new recovery budget; do not let this fixture keep changing the source.
    for (let attempt = 4; attempt <= 6; attempt++) await writeFile(path.join(app.dir, "chat-workspace", String(session), `prompt-continue-${attempt}`), "stable");
    await promptSettled(app, session, turn.id);
  }
});

test("tool excerpts without a turn ID return an actionable field error", () => {
  assert.throws(() => chatProposal({ kind: "create_text", body: "完整画面描述", reason: "整理工具提示词", sourceIds: [],
    excerpts: [{ role: "tool", eventId: "actual-tool", field: "prompt", quote: "逐字原文" }] }), /excerpts\[0\]\.turnId.*补全后重新提交/);
});

test("prompt failures retain the submission error even when the model completes normally", async (t) => {
  const app = await fixture(t), session = (await app.api("chat/sessions", {})).data.id;
  const turn = await send(app, session, "GENERATE_IMAGE PROMPT_MISSING_TURN");
  await app.api(`chat/turns/${turn.id}/save`, { artifact: turn.events[0].artifact });
  const prompt = await promptSettled(app, session, turn.id, "failed");
  assert.match(prompt.error, /excerpts\[0\]\.turnId/);
  const db = initDb(path.join(app.dir, "library.sqlite3"));
  try { assert.equal(db.prepare("SELECT attempts FROM chat_prompt_jobs WHERE turn_id=?").get(turn.id).attempts, 3); }
  finally { db.close(); }
});

test("a missing excerpt turn ID is automatically retried with the specific correction", async (t) => {
  const app = await fixture(t), session = (await app.api("chat/sessions", {})).data.id;
  const turn = await send(app, session, "GENERATE_IMAGE PROMPT_MISSING_TURN FIRST");
  await app.api(`chat/turns/${turn.id}/save`, { artifact: turn.events[0].artifact });
  await promptSettled(app, session, turn.id);
  const db = initDb(path.join(app.dir, "library.sqlite3"));
  try { assert.equal(db.prepare("SELECT attempts FROM chat_prompt_jobs WHERE turn_id=?").get(turn.id).attempts, 2); }
  finally { db.close(); }
});

test("permanent image deletion removes registered artifacts and edit copies without resurrecting a saved output", async (t) => {
  const app = await fixture(t), session = (await app.api("chat/sessions", {})).data.id;
  const original = await send(app, session, "GENERATE_IMAGE");
  const artifact = original.events[0].artifact;
  const saved = (await app.api(`chat/turns/${original.id}/save`, { artifact })).data.element;
  await promptSettled(app, session, original.id);
  const edited = await send(app, session, "EDIT_IMAGE 再暖一点", { imageEdit: { turnId: original.id, artifact } });
  const finalArtifact = edited.events.find((event) => event.artifact).artifact;
  await writeFile(path.join(app.dir, "chat-artifacts", finalArtifact), await sharp({ create: { width: 9, height: 9, channels: 3, background: "blue" } }).png().toBuffer());
  const final = (await app.api(`chat/turns/${edited.id}/save`, { artifact: finalArtifact })).data.element;
  await promptSettled(app, session, edited.id);
  const text = (await app.api(`chat/turns/${edited.id}/save`, { body: "保存编辑后的说明" })).data.element;
  const db = initDb(path.join(app.dir, "library.sqlite3"));
  const copies = db.prepare("SELECT path FROM chat_file_copies WHERE artifact=?").all(artifact); db.close();
  assert.ok(copies.length > 0);
  await app.api(`elements/${saved.id}`, undefined, "DELETE");
  const purged = await app.api("trash/purge", { ids: [saved.id] });
  assert.deepEqual(purged.data.failed, []); assert.equal(purged.data.historyCleanupFailed, undefined);
  await assert.rejects(readFile(path.join(app.dir, "chat-artifacts", artifact)), { code: "ENOENT" });
  for (const file of copies) await assert.rejects(readFile(path.join(app.dir, "chat-workspace", file.path)), { code: "ENOENT" });
  assert.equal((await app.api(`chat/turns/${original.id}/save`, { artifact })).status, 410);
  assert.equal((await app.api(`chat/turns/${edited.id}/save`, { artifact: finalArtifact })).data.element.id, final.id);
  assert.equal((await app.api(`chat/turns/${edited.id}/save`, { body: "保存编辑后的说明" })).data.element.id, text.id);
  assert.ok(outputData(app, final.id).some((data) => data.imageEdit?.deleted));
  assert.equal((await app.api(`chat/sessions/${session}`)).data.turns.find((t) => t.id === edited.id).imageEdit.deleted, true);
});

test("source images retain the pixels actually shown, and purge redacts snapshots while unrelated saved text survives", async (t) => {
  const app = await fixture(t), session = (await app.api("chat/sessions", {})).data.id;
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "green" } }).png().toBuffer();
  const response = await fetch(new URL("api/images", app.url), { method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": "reference.png" }, body: bytes });
  const source = await response.json(); assert.equal(response.status, 201);
  const turn = await send(app, session, `IMAGE:${source.id}`, { sourceIds: [source.id] });
  const saved = (await app.api(`chat/turns/${turn.id}/save`, { body: "独立保存的图像说明" })).data.element;
  const snapshot = outputData(app, saved.id).flatMap((data) => data.sources || []).find((s) => s.id === source.id);
  const captured = await fetch(new URL(`api/chat/turns/${turn.id}/artifacts/${snapshot.imageArtifact}`, app.url));
  assert.equal(captured.status, 200);
  const modelPreview = await fetch(new URL(`api/elements/${source.id}/thumbnail?width=800`, app.url));
  assert.deepEqual(await sharp(Buffer.from(await captured.arrayBuffer())).raw().toBuffer(), await sharp(Buffer.from(await modelPreview.arrayBuffer())).raw().toBuffer());
  assert.equal((await readdir(path.join(app.dir, "chat-artifacts"))).length, 1, "Repeated reads reuse the same actual image snapshot");
  await app.api(`elements/${source.id}`, undefined, "DELETE");
  const purge = await app.api("trash/purge", { ids: [source.id] }); assert.deepEqual(purge.data.failed, []);
  assert.equal((await fetch(new URL(`api/chat/turns/${turn.id}/artifacts/${snapshot.imageArtifact}`, app.url))).status, 404);
  assert.ok(outputData(app, saved.id).some((data) => data.sources?.some((s) => s.deleted && s.id === source.id && !s.imageArtifact)));
  await app.api(`elements/${saved.id}`, undefined, "DELETE");
  assert.deepEqual((await app.api("trash/purge", { ids: [saved.id] })).data.failed, []);
  assert.equal((await app.api(`chat/sessions/${session}`)).data.turns[0].answer, turn.answer, "Deleting a partial or edited save does not delete its entire original answer");
});

test("deleting source conversation content redacts extraction copies and cancels pending evidence while preserving adopted elements", async (t) => {
  const app = await fixture(t), session = (await app.api("chat/sessions", {})).data.id;
  const original = await send(app, session, "PROMPT_FINAL");
  await app.api(`chat/turns/${original.id}/extract`, { requestKey: crypto.randomUUID() }); await settled(app, session);
  let p = (await app.api(`chat/sessions/${session}`)).data.proposals[0];
  const accepted = (await app.api(`chat/proposals/${p.id}/accept`, {})).data;
  const graph = (await app.api(`elements/${accepted.changes.createdId}/lifecycle`)).data;
  const sourceRecord = graph.elements.find((e) => e.kind === "session");
  await app.api(`chat/turns/${original.id}/extract`, { requestKey: crypto.randomUUID() }); await settled(app, session);
  p = (await app.api(`chat/sessions/${session}`)).data.proposals[0];
  await app.api(`elements/${sourceRecord.id}`, undefined, "DELETE");
  assert.deepEqual((await app.api("trash/purge", { ids: [sourceRecord.id] })).data.failed, []);
  assert.equal((await app.api(`chat/proposals/${p.id}/accept`, {})).status, 409);
  assert.ok(outputData(app, accepted.changes.createdId).some((data) => data.excerpts?.some((x) => x.deleted && !x.quote)));
  assert.equal((await app.api(`elements/${accepted.changes.createdId}`)).data.body, original.answer);
  assert.equal((await app.api(`chat/sessions/${session}`)).data.turns[0].answer, "");
});

test("edited text saves keep the original response and retries preserve identity through trash", async (t) => {
  const app = await fixture(t), session = (await app.api("chat/sessions", {})).data.id;
  const turn = await send(app, session, "讨论一个完整方案");
  const saved = await app.api(`chat/turns/${turn.id}/save`, { body: "我选择保存的完整方案。" });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const id = saved.data.element.id;
  assert.ok(outputData(app, id).some((data) => data.originalAnswer === turn.answer && data.savedBody === "我选择保存的完整方案。"));
  assert.equal((await app.api(`chat/turns/${turn.id}/save`, { body: "我选择保存的完整方案。" })).data.element.id, id);
  await app.api(`elements/${id}`, undefined, "DELETE");
  assert.equal((await app.api(`chat/turns/${turn.id}/save`, { body: "我选择保存的完整方案。" })).status, 409);
  await app.api(`elements/${id}/restore`, {});
  assert.equal((await app.api(`chat/turns/${turn.id}/save`, { body: "我选择保存的完整方案。" })).data.element.id, id);
});

test("extraction binds exact previous message spans and rejects invented, ambiguous or cross-session evidence", () => {
  const db = initDb(":memory:");
  try {
    const chat = createChatRepository(db), session = chat.create();
    const first = chat.begin(session.id, { text: "完整提示词：暖色傍晚街景，单人背影。", sourceIds: [], requestKey: "evidence-first-1" }).turn;
    chat.updateTurn({ ...first, state: "completed", answer: "方案一。方案二。", sources: [], events: [] });
    const current = chat.begin(session.id, { text: "提取完整提示词", sourceIds: [], requestKey: "evidence-next-1" }).turn;
    const payload = chatProposal({ kind: "create_text", body: first.text, reason: "完整提示词，可复用", sourceIds: [], excerpts: [{ turnId: first.id, role: "user", quote: first.text }] });
    const p = chat.propose(current.id, "extract-1", payload, []);
    assert.equal(p.payload.excerpts[0].start, 0); assert.equal(p.payload.excerpts[0].end, first.text.length); assert.ok(p.payload.excerpts[0].version);
    assert.throws(() => chat.propose(current.id, "bad-1", { ...payload, excerpts: [{ turnId: first.id, role: "user", quote: "不存在的原文" }] }, []), /定位/);
    assert.throws(() => chat.propose(current.id, "bad-2", { ...payload, excerpts: [{ turnId: first.id, role: "assistant", quote: "方案" }] }, []), /定位/);
    chat.propose(current.id, "extract-2", payload, [], 3); chat.propose(current.id, "extract-3", payload, [], 3);
    assert.throws(() => chat.propose(current.id, "extract-4", payload, [], 3), /上限/);
    chat.updateTurn({ ...current, state: "completed", sources: [], events: [] });
    const other = chat.begin(chat.create().id, { text: "其他会话", sourceIds: [], requestKey: "evidence-other-1" }).turn;
    assert.throws(() => chat.propose(other.id, "bad-3", payload, []), /当前会话/);
  } finally { db.close(); }
});

test("failed lifecycle saves roll back all nodes and files; racing retries resolve to one saved identity", async (t) => {
  const app = await fixture(t), session = (await app.api("chat/sessions", {})).data.id;
  const turn = await send(app, session, "GENERATE_IMAGE"), artifact = turn.events[0].artifact;
  const db = initDb(path.join(app.dir, "library.sqlite3"));
  db.exec("CREATE TRIGGER reject_provenance BEFORE INSERT ON chat_element_bindings BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  const failed = await app.api(`chat/turns/${turn.id}/save`, { artifact }); assert.equal(failed.status, 500);
  assert.equal(db.prepare("SELECT count(*) AS n FROM elements WHERE kind!=3").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM chat_element_bindings").get().n, 0);
  assert.deepEqual((await readdir(path.join(app.dir, "assets"))).filter((name) => name !== "previews-v1"), []);
  db.exec("DROP TRIGGER reject_provenance"); db.close();
  const results = await Promise.all([app.api(`chat/turns/${turn.id}/save`, { artifact }), app.api(`chat/turns/${turn.id}/save`, { artifact })]);
  assert.ok(results.some((r) => r.status === 200)); assert.ok(results.every((r) => [200, 409].includes(r.status)));
  const retry = await app.api(`chat/turns/${turn.id}/save`, { artifact });
  assert.equal(retry.data.element.id, results.find((r) => r.status === 200).data.element.id);
  assert.equal((await readdir(path.join(app.dir, "assets"))).filter((name) => name !== "previews-v1").length, 1);
});

test("lifecycle migration rolls back dropped schema objects and restores foreign keys if DDL fails", () => {
  const db = initDb(":memory:");
  try {
    db.exec("DELETE FROM wiki_schema WHERE version=14; CREATE TABLE elements_v14(sentinel INTEGER)");
    const schema = () => db.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
    const before = schema();
    assert.throws(() => migrateElementLifecycle(db), /already exists/);
    assert.deepEqual(schema(), before);
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(db.isTransaction, false);
  } finally { db.close(); }
});

test("legacy operation elements migrate into output metadata while preserving conversation tags, content and manual relations", () => {
  const db = initDb(":memory:");
  try {
    const wiki = createElementRepository(db), chat = createChatRepository(db), session = chat.create("旧会话");
    const input = wiki.createText({ body: "原始完整提示词", tags: [] }), output = wiki.createText({ body: "保存的成果", tags: [] });
    const turn = chat.begin(session.id, { text: "生成结果", sourceIds: [], requestKey: "migration-test" }).turn;
    chat.updateTurn({ ...turn, state: "completed", answer: "原回答", sources: [chat.snapshot(input.id)], events: [] });
    db.exec("DROP TRIGGER elements_content_kind_insert; DROP TRIGGER elements_content_kind_update");
    const operationId = Number(db.prepare("INSERT INTO elements(kind,body,created_at,updated_at,local_only) VALUES(4,'执行记录','2026-09-08','2026-09-08',1)").run().lastInsertRowid);
    db.prepare("INSERT INTO element_records VALUES(?,?,?,?)").run(operationId, session.id, turn.id, JSON.stringify({ kind: "turn", originalAnswer: "原回答", savedBody: output.body }));
    db.prepare("INSERT INTO chat_element_bindings(turn_id,output_key,element_id) VALUES(?,?,?)").run(turn.id, "activity:turn", operationId);
    db.prepare("INSERT INTO chat_element_bindings(turn_id,output_key,element_id) VALUES(?,?,?)").run(turn.id, "text:old-result", output.id);
    const generated = wiki.relate(operationId, output.id, "related", "产出", { direction: "forward", reverseName: "生成自" });
    db.prepare("INSERT INTO element_provenance VALUES(?)").run(generated.id);
    wiki.relate(operationId, input.id, "related", "人工关联");
    const tagId = Number(db.prepare("INSERT INTO tags(name,normalized_name) VALUES('收藏','收藏')").run().lastInsertRowid);
    db.prepare("INSERT INTO element_tags VALUES(?,?)").run(operationId, tagId);
    db.exec("DROP TABLE chat_prompt_jobs; ALTER TABLE chat_element_bindings DROP COLUMN data; DROP INDEX IF EXISTS idx_chat_turns_parent; ALTER TABLE chat_turns DROP COLUMN internal; DELETE FROM wiki_schema WHERE version=16");
    db.exec("CREATE TRIGGER reject_content BEFORE INSERT ON element_relations BEGIN SELECT RAISE(ABORT,'migration rollback'); END");
    assert.throws(() => migrateChatContent(db), /migration rollback/);
    assert.equal(db.prepare("SELECT count(*) n FROM elements WHERE kind=4").get().n, 1);
    assert.ok(!db.prepare("PRAGMA table_info(chat_element_bindings)").all().some((r) => r.name === "data"));
    db.exec("DROP TRIGGER reject_content");
    migrateChatContent(db); migrateChatContent(db);
    assert.equal(db.prepare("SELECT count(*) n FROM elements WHERE kind=4").get().n, 0);
    assert.equal(wiki.get(output.id).body, "保存的成果");
    assert.ok(wiki.get(session.elementId).tags.includes("收藏"));
    assert.ok(wiki.relations(session.elementId).relations.some((r) => r.name === "人工关联" && r.element.id === input.id));
    assert.equal(JSON.parse(db.prepare("SELECT data FROM chat_element_bindings WHERE element_id=?").get(output.id).data).savedBody, output.body);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(() => db.prepare("INSERT INTO elements(kind,body,created_at,updated_at) VALUES(4,'噪音','','')").run(), /not elements/);
  } finally { db.close(); }
});
