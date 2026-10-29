import { migrateChatEffort } from "../../src/server/data/chatEffortMigration.js";
import { migrateChatModelPreference } from "../../src/server/data/chatModelPreferenceMigration.js";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer, fetch } from "../helpers/authenticatedServer.js";
import { initDb } from "../../src/server/data/sqlite.js";
import { createChatRepository } from "../../src/server/data/chatRepository.js";
import { migrateChat } from "../../src/server/data/chatMigration.js";
import { migrateChatModels } from "../../src/server/data/chatModelMigration.js";
import { migrateChatImageEdits } from "../../src/server/data/chatImageEditMigration.js";
import { migrateChatDrafts } from "../../src/server/data/chatDraftMigration.js";
import { createElementRepository } from "../../src/server/data/elementRepository.js";
import { chatCliArgs } from "../../src/shared/domain/chat.js";
import { chatMessageParts } from "../../src/shared/domain/chatMessageParts.js";
import { defaultOrganizationConfig } from "../../src/shared/domain/organization.js";

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-chat-"));
  const config = defaultOrganizationConfig(); config.executor.codexCli.executable = path.join(dir, "app-server.mjs"); config.executor.timeoutMs = 10000;
  await writeFile(config.executor.codexCli.executable, await readFile(new URL("../fixtures/chat-app-server.txt", import.meta.url)));
  await writeFile(path.join(dir, "organization.json"), JSON.stringify(config));
  let app = await createServer({ port: 0, dataDir: dir });
  const api = async (route, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(new URL(`api/${route}`, app.url), { method, headers: { "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    const data = await response.json(); return { status: response.status, data };
  };
  t.after(async () => { await app.close(); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith("wiki-chat-")); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); });
  return { api, dir, get url() { return app.url; }, async restart() { await app.close(); app = await createServer({ port: 0, dataDir: dir }); } };
}
async function waitTurn(api, sessionId, predicate = (t) => t.state !== "running", timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const { data } = await api(`chat/sessions/${sessionId}`);
    if (data.turns.length && predicate(data.turns.at(-1))) return data;
    await sleep(30);
  }
  throw new Error(`Chat did not reach expected state: ${JSON.stringify((await api(`chat/sessions/${sessionId}`)).data)}`);
}
test("direct web images preserve input and full size materials without calling Codex", { timeout: 120000,
  skip: spawnSync(process.env.TEST_PYTHON || "python", ["--version"], { windowsHide: true }).status !== 0 && "Python required" }, async (t) => {
  const app = await fixture(t), { api, dir } = app;
  const note = (await api("elements", { body: "素材原文：字体保持手写感\n这是第二行。" })).data;
  const bytes = await sharp({ create: { width: 1800, height: 1000, channels: 3, background: "#789" } }).png().toBuffer();
  const picture = await (await fetch(new URL("api/images", app.url), { method: "POST", body: bytes })).json();
  const attachment = await (await fetch(new URL("api/chat/attachments", app.url), { method: "POST", body: bytes })).json();
  const config = (await api("organization/status")).data.config;
  const codex = config.executor.codexCli.executable;
  config.executor.codexCli.executable = path.join(dir, "codex-must-not-run.exe");
  config.imageGeneration.chatgptWeb = { python: process.env.TEST_PYTHON || "python", browser: path.join(dir, "browser.mjs"), profile: "relay" };
  await writeFile(config.imageGeneration.chatgptWeb.browser, await readFile(new URL("../fixtures/chrome-use.txt", import.meta.url)));
  assert.equal((await api("organization/config", config, "PUT")).status, 200);
  const text = "  根据图片制作海报\n文案不要改写 ` $()  \n";
  const input = { text, sourceIds: [picture.id, note.id], attachmentIds: [attachment.id], directImage: true, requestKey: "direct-original-input" };
  const started = await api("chat/sessions/start", input);
  assert.equal(started.status, 200);
  const id = started.data.session.id;
  let turn = (await waitTurn(api, id, undefined, 30000)).turns.at(-1);
  assert.equal(turn.state, "completed", turn.error); assert.equal(turn.directImage, true);
  assert.equal(turn.model, "", "A direct web result must not be attributed to the selected Codex model");
  assert.equal(turn.text, text); assert.equal(turn.answer, ""); assert.ok(turn.events.find((event) => event.artifact));
  const commands = () => readFile(path.join(dir, "browser-commands.jsonl"), "utf8").then((text) => text.trim().split("\n").map(JSON.parse));
  assert.equal((await commands()).find((command) => command.args[0] === "keyboard").args[2], text + "\n\n" + note.body);
  const uploaded = JSON.parse(await readFile(path.join(dir, "browser-uploads.json"), "utf8"));
  assert.equal(uploaded.length, 2);
  for (const file of uploaded) {
    const info = await sharp(file).metadata(); assert.equal(info.width, 1800); assert.equal(info.height, 1000);
    assert.deepEqual(await sharp(file).raw().toBuffer(), await sharp(bytes).raw().toBuffer());
  }
  const trace = (await api(`chat/turns/${turn.id}/trace`)).data.record.value;
  assert.equal(trace.contextMode, "direct-image"); assert.equal(trace.thread, undefined);
  assert.equal(trace.input.prompt, text + "\n\n" + note.body); assert.equal(trace.submission.confirmed, true);
  assert.equal((await api("chat/sessions/start", input)).data.turns.at(-1).id, turn.id);
  assert.equal((await commands()).filter((command) => command.args[0] === "keyboard").length, 1, "Replaying the request cannot resubmit to the webpage");
  await app.restart();
  assert.equal((await api(`chat/sessions/${id}`)).data.turns.at(-1).directImage, true);
  await api(`chat/sessions/${id}/turns`, { text: "继续修改上一张图", sourceIds: [], directImage: true, requestKey: "direct-continue-after-restart" });
  const continued = (await waitTurn(api, id, undefined, 30000)).turns.at(-1);
  assert.equal(continued.state, "completed", continued.error);
  assert.equal((await commands()).filter((c) => c.args[0] === "open").at(-1).args[1], "https://chatgpt.com/c/fixture");
  const continuedTrace = (await api(`chat/turns/${continued.id}/trace?event=${continued.events.find(e => e.artifact).id}`)).data.record.value;
  assert.equal(continuedTrace.conversationUrl, "https://chatgpt.com/c/fixture");

  const fork = (await api(`chat/turns/${turn.id}/fork`, { requestKey: "direct-fork-input", branchRevision: 0 })).data;
  assert.equal((await api(`chat/sessions/${fork.id}`)).data.turns.at(-1).directImage, true);
  await api(`chat/sessions/${fork.id}/turns`, { text: "分支生成新图片", sourceIds: [], directImage: true, requestKey: "direct-fork-new-web" });
  assert.equal((await waitTurn(api, fork.id, undefined, 30000)).turns.at(-1).state, "completed");
  assert.equal((await commands()).filter((c) => c.args[0] === "open").at(-1).args[1], "https://chatgpt.com/");

  await api(`chat/turns/${turn.id}/edit`, { text: "  重新生成，保留原文。  ", sourceIds: [], attachmentIds: [], requestKey: "direct-edit-input", branchRevision: 0 });
  turn = (await waitTurn(api, id, undefined, 30000)).turns.at(-1);
  assert.equal(turn.state, "completed", turn.error); assert.equal(turn.directImage, true);
  assert.equal((await commands()).filter((command) => command.args[0] === "keyboard").at(-1).args[2], "  重新生成，保留原文。  ");
  assert.equal((await commands()).filter((c) => c.args[0] === "open").at(-1).args[1], "https://chatgpt.com/");
  config.executor.codexCli.executable = codex;
  await api("organization/config", config, "PUT");
  await api(`chat/sessions/${id}/turns`, { text: "GENERATE_IMAGE", sourceIds: [], requestKey: "normal-after-direct" });
  turn = (await waitTurn(api, id)).turns.at(-1);
  assert.equal(turn.directImage, false); assert.ok(turn.events.some((event) => event.artifact));
  assert.equal((await api(`chat/turns/${turn.id}/trace`)).data.record.value.contextMode, "replayed");
});

test("direct web validation and cancellation never fall back to a model", { timeout: 30000,
  skip: spawnSync(process.env.TEST_PYTHON || "python", ["--version"], { windowsHide: true }).status !== 0 && "Python required" }, async (t) => {
  const app = await fixture(t), { api, dir } = app;
  const config = (await api("organization/status")).data.config;
  config.executor.codexCli.executable = path.join(dir, "codex-must-not-run.exe");
  config.imageGeneration.chatgptWeb = { python: process.env.TEST_PYTHON || "python", browser: path.join(dir, "browser.mjs"), profile: "relay" };
  await writeFile(config.imageGeneration.chatgptWeb.browser, await readFile(new URL("../fixtures/chrome-use.txt", import.meta.url)));
  await api("organization/config", config, "PUT");
  const note = (await api("elements", { body: "长".repeat(12000) })).data;
  const session = (await api("chat/sessions", {})).data, route = `chat/sessions/${session.id}/turns`;
  const base = { text: "生成图片", sourceIds: [], directImage: true, requestKey: "direct-validation" };
  assert.equal((await api(route, { ...base, directImage: "true" })).status, 400);
  await api(route, { ...base, sourceIds: [note.id] });
  const failed = (await waitTurn(api, session.id)).turns.at(-1);
  assert.equal(failed.state, "failed"); assert.match(failed.error, /合计超过 12000/);
  await assert.rejects(readFile(path.join(dir, "browser-commands.jsonl")), { code: "ENOENT" });
  await writeFile(path.join(dir, "browser-mode"), "wait");
  await api(route, { ...base, requestKey: "direct-cancel-input" });
  await waitTurn(api, session.id, (turn) => turn.events.some((event) => event.progress === "ChatGPT 正在生成图片"), 20000);
  const stopped = await api(`chat/sessions/${session.id}/stop`, {});
  assert.equal(stopped.data.turns.at(-1).state, "interrupted");
  const commands = (await readFile(path.join(dir, "browser-commands.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(commands.filter((command) => command.args[0] === "keyboard").length, 1);
  assert.ok(commands.some((command) => command.args[0] === "close"));
});

test("image backend switches preserve history, web artifacts and edit references", { timeout: 60000,
  skip: spawnSync(process.env.TEST_PYTHON || "python", ["--version"], { windowsHide: true }).status !== 0 && "Python required" }, async (t) => {
  const app = await fixture(t), { api, dir } = app;
  const session = (await api("chat/sessions", {})).data, route = `chat/sessions/${session.id}/turns`;
  await api(route, { text: "GENERATE_IMAGE", sourceIds: [], requestKey: "native-before-web" });
  const native = (await waitTurn(api, session.id)).turns[0];
  const original = native.events.find((event) => event.artifact).artifact;
  const config = (await api("organization/status")).data.config;
  config.imageGeneration = { executor: "chatgpt-web", chatgptWeb: { python: process.env.TEST_PYTHON || "python", browser: path.join(dir, "browser.mjs"), profile: "relay" } };
  await writeFile(config.imageGeneration.chatgptWeb.browser, await readFile(new URL("../fixtures/chrome-use.txt", import.meta.url)));
  assert.equal((await api("organization/config", config, "PUT")).status, 200);
  assert.equal((await api("chat/image-generation/probe", {})).data.available, true);
  const imageEdit = { turnId: native.id, artifact: original, region: { x: .1, y: .1, width: .5, height: .5 } };
  await api(route, { text: "WEB_IMAGE", imageEdit, sourceIds: [], requestKey: "web-edit-selected" });
  let turn = (await waitTurn(api, session.id, undefined, 30000)).turns.at(-1);
  assert.equal(turn.state, "completed", turn.error); assert.equal(turn.answer, "网页版图片已返回");
  const events = turn.events.filter((e) => e.command);
  assert.equal(events.length, 1); assert.equal(events[0].parameters.executor, "chatgpt-web");
  assert.ok(events[0].artifact);
  const image = await fetch(new URL(`api/chat/turns/${turn.id}/artifacts/${events[0].artifact}`, app.url));
  assert.equal(image.status, 200); assert.equal((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).format, "png");
  const uploads = JSON.parse(await readFile(path.join(dir, "browser-uploads.json"), "utf8"));
  assert.deepEqual(await readFile(uploads[0]), await readFile(path.join(dir, "chat-artifacts", original)));
  assert.equal(path.basename(uploads[1]), "selection.png");
  const trace = (await api(`chat/turns/${turn.id}/trace?event=${events[0].id}`)).data.record.value;
  assert.ok(trace.preparedPrompt.includes(trace.input.prompt)); assert.equal(trace.output.success, true);
  assert.equal(trace.submission.confirmed, true);
  assert.equal((await api(`chat/turns/${turn.id}/trace`)).data.record.value.contextMode, "replayed");
  await api(route, { text: "WEB_IMAGE OMIT_REFERENCE", imageEdit, sourceIds: [], requestKey: "web-must-use-original" });
  turn = (await waitTurn(api, session.id)).turns.at(-1);
  assert.match(turn.answer, /必须引用用户选择的原图/); assert.equal(turn.events.some((e) => e.artifact), false);
  config.imageGeneration.executor = "codex-cli";
  await api("organization/config", config, "PUT");
  await api(route, { text: "GENERATE_IMAGE", sourceIds: [], requestKey: "native-after-web" });
  turn = (await waitTurn(api, session.id)).turns.at(-1);
  assert.ok(turn.events.some((e) => e.artifact));
  const request = (await api(`chat/turns/${turn.id}/trace`)).data.record.value;
  assert.equal(request.contextMode, "replayed");
  assert.equal(request.thread.params.dynamicTools.some((tool) => tool.name === "generate_image"), false);
  assert.ok(request.turn.params.input[0].text.includes("WEB_IMAGE"));
});
test("web image failures stay visible and stopping a turn awaits the browser executor", { timeout: 25000,
  skip: spawnSync(process.env.TEST_PYTHON || "python", ["--version"], { windowsHide: true }).status !== 0 && "Python required" }, async (t) => {
  const app = await fixture(t), { api, dir } = app;
  const config = (await api("organization/status")).data.config;
  config.imageGeneration = { executor: "chatgpt-web", chatgptWeb: { python: process.env.TEST_PYTHON || "python", browser: "missing-web-browser", profile: "relay" } };
  await api("organization/config", config, "PUT");
  const session = (await api("chat/sessions", {})).data, route = `chat/sessions/${session.id}`;
  await api(`${route}/turns`, { text: "WEB_IMAGE", sourceIds: [], requestKey: "web-missing-browser" });
  let turn = (await waitTurn(api, session.id)).turns.at(-1);
  const error = turn.events.find((e) => e.command);
  assert.equal(error.state, "failed"); assert.match(error.error, /未找到 chrome-use/);
  assert.equal(turn.events.some((e) => e.artifact), false);
  const trace = (await api(`chat/turns/${turn.id}/trace?event=${error.id}`)).data.record.value;
  assert.equal(trace.output.success, false); assert.equal(trace.output.error, error.error);
  config.imageGeneration.chatgptWeb.browser = path.join(dir, "browser.mjs");
  await writeFile(config.imageGeneration.chatgptWeb.browser, await readFile(new URL("../fixtures/chrome-use.txt", import.meta.url)));
  await writeFile(path.join(dir, "browser-mode"), "wait");
  await api("organization/config", config, "PUT");
  await api(`${route}/turns`, { text: "WEB_IMAGE", sourceIds: [], requestKey: "web-stop-browser" });
  await waitTurn(api, session.id, (t) => t.events.some((e) => e.parameters?.revisedPrompt));
  const stopped = (await api(`${route}/stop`, {})).data;
  assert.equal(stopped.running, false); assert.equal(stopped.turns.at(-1).state, "interrupted");
  const log = await readFile(path.join(dir, "browser-commands.jsonl"), "utf8");
  await sleep(1800);
  assert.equal(await readFile(path.join(dir, "browser-commands.jsonl"), "utf8"), log, "no browser subprocess remains after stop");
  turn = (await api(route)).data.turns.at(-1);
  assert.equal(turn.events.some((e) => e.artifact), false);
});
test("image-only requests preserve empty user text, reject empty content and keep retry identity", async (t) => {
  const app = await fixture(t), { api } = app;
  const note = (await api("elements", { body: "仅文字资料" })).data;
  const empty = { text: " \n", sourceIds: [], requestKey: "empty-message-request" };
  assert.equal((await api("chat/sessions/start", empty)).status, 400);
  assert.equal((await api("chat/sessions/start", { ...empty, sourceIds: [note.id] })).status, 400);
  assert.equal((await api("chat/sessions")).data.sessions.length, 0);
  const bytes = await sharp({ create: { width: 12, height: 10, channels: 4, background: "#a68" } }).png().toBuffer();
  for (const kind of ["pasted", "wiki"]) {
    const image = await (await fetch(new URL(kind === "pasted" ? "api/chat/attachments" : "api/images", app.url), { method: "POST", body: bytes })).json();
    const input = { text: "", sourceIds: kind === "wiki" ? [image.id] : [], ...(kind === "pasted" && { attachmentIds: [image.id] }), requestKey: `image-only-${kind}-request` };
    const start = await api("chat/sessions/start", input);
    assert.equal(start.status, 200, JSON.stringify(start.data));
    const session = start.data.session;
    assert.equal(session.title, "图片会话");
    const first = (await waitTurn(api, session.id)).turns[0];
    assert.equal(first.state, "completed", first.error);
    assert.equal(first.text, "");
    assert.equal(first.answer, "仅图片消息通过");
    const trace = (await api(`chat/turns/${first.id}/trace`)).data.record.value;
    assert.equal(trace.userText, "", "No placeholder request is invented for the user");
    assert.equal((await api("chat/sessions/start", input)).data.turns.length, 1);
    const edit = await api(`chat/turns/${first.id}/edit`, { text: " \n", requestKey: `image-only-${kind}-edit`, branchRevision: 0 });
    assert.equal(edit.status, 200, JSON.stringify(edit.data));
    const edited = (await waitTurn(api, session.id)).turns[0];
    assert.equal(edited.text, "");
    assert.equal(edited.answer, "仅图片消息通过");
    assert.equal((await api(`chat/turns/${edited.id}/edit`, { text: "", sourceIds: [], attachmentIds: [], requestKey: `image-only-${kind}-empty`, branchRevision: 1 })).status, 400);
    await app.restart();
    assert.equal((await api(`chat/sessions/${session.id}`)).data.turns[0].text, "");
  }
});

test("pasted image attachments stay outside Wiki and survive send retries, edits, forks and restart", async (t) => {
  const app = await fixture(t), { api } = app;
  const bytes = await sharp({ create: { width: 37, height: 29, channels: 4, background: "#a63" } }).png().toBuffer();
  const upload = await fetch(new URL("api/chat/attachments", app.url), { method: "POST", headers: { "x-file-name": encodeURIComponent("截图.png") }, body: bytes });
  assert.equal(upload.status, 201);
  const image = await upload.json();
  assert.equal(image.label, "截图.png");
  assert.equal((await api("elements?kind=image")).data.pagination.total, 0);
  assert.equal((await api("chat/sessions")).data.sessions.length, 0);
  const imageUrl = () => new URL(`api/chat/attachments/${image.id}/image`, app.url);
  const metadata = await sharp(Buffer.from(await (await fetch(imageUrl())).arrayBuffer())).metadata();
  assert.equal(metadata.width, 37); assert.equal(metadata.height, 29);
  const payload = { text: "PASTED_IMAGE", sourceIds: [], attachmentIds: [image.id], requestKey: "chat-only-image-send" };
  const started = await api("chat/sessions/start", payload);
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const session = started.data.session;
  const first = (await waitTurn(api, session.id)).turns[0];
  assert.equal(first.answer, "聊天图片附件通过");
  assert.deepEqual(first.inputSources, []); assert.deepEqual(first.sources, []);
  assert.deepEqual(first.inputAttachments, [image]);
  assert.equal((await api(`chat/attachments/${image.id}`, undefined, "DELETE")).data.removed, false, "A sent attachment cannot be deleted as an unused draft");
  assert.equal((await api("chat/sessions/start", payload)).data.turns.length, 1);
  assert.equal((await api("chat/sessions/start", { ...payload, attachmentIds: [] })).status, 409);
  await app.restart();
  assert.equal((await fetch(imageUrl())).status, 200);
  assert.deepEqual((await api(`chat/sessions/${session.id}`)).data.turns[0].inputAttachments, [image]);
  const edited = await api(`chat/turns/${first.id}/edit`, { text: "PASTED_IMAGE edited", requestKey: "chat-only-image-edit", branchRevision: 0 });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  const current = (await waitTurn(api, session.id)).turns[0];
  assert.equal(current.answer, "聊天图片附件通过");
  assert.deepEqual(current.inputAttachments, [image]);
  const fork = await api(`chat/turns/${current.id}/fork`, { requestKey: "chat-only-image-fork", branchRevision: 1 });
  assert.equal(fork.status, 200);
  await api(`chat/sessions/${fork.data.id}/turns`, { text: "BRANCH_CONTEXT pasted history", sourceIds: [], requestKey: "chat-only-image-followup" });
  const replay = JSON.parse((await waitTurn(api, fork.data.id)).turns.at(-1).answer);
  assert.equal(replay.images, 1);
  assert.deepEqual(replay.history[0].sources, [{ kind: "image", filename: "截图.png", historyAttachment: 1 }]);
  assert.equal((await api("elements?kind=image")).data.pagination.total, 0);
  const db = initDb(path.join(app.dir, "library.sqlite3"));
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM element_images").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM semantic_documents").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM organization_jobs").get().n, 0);
    const wiki = createElementRepository(db), repo = createChatRepository(db);
    wiki.trash(session.elementId); wiki.purge(session.elementId);
    assert.deepEqual(repo.turn(first.id).inputAttachments, []);
    assert.equal(repo.attachment(image.id).artifact, image.artifact, "The independent fork retains its attachment");
    wiki.trash(fork.data.elementId); wiki.purge(fork.data.elementId);
    assert.throws(() => repo.attachment(image.id), /附件不存在/);
    assert.ok(db.prepare("SELECT 1 FROM chat_file_cleanup WHERE name=?").get(image.artifact));
    assert.ok(db.prepare("SELECT 1 FROM chat_file_cleanup WHERE name LIKE 'workspace:%'").get());
  } finally { db.close(); }
});

test("invalid and removed draft images never create Wiki entries or partial conversations", async (t) => {
  const app = await fixture(t), { api } = app;
  assert.equal((await fetch(new URL("api/chat/attachments", app.url), { method: "POST", body: "not an image" })).status, 400);
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
  const image = await (await fetch(new URL("api/chat/attachments", app.url), { method: "POST", body: bytes })).json();
  assert.equal((await api(`chat/attachments/${image.id}`, undefined, "DELETE")).data.removed, true);
  await assert.rejects(readFile(path.join(app.dir, "chat-artifacts", image.artifact)), { code: "ENOENT" });
  const input = { text: "PASTED_IMAGE", sourceIds: [], attachmentIds: [image.id], requestKey: "missing-image-start" };
  assert.equal((await api("chat/sessions/start", input)).status, 404);
  assert.equal((await api("chat/sessions/start", { ...input, attachmentIds: "bad" })).status, 400);
  assert.equal((await api("chat/sessions/start", { ...input, attachmentIds: Array(9).fill(image.id) })).status, 400);
  assert.equal((await api("chat/sessions")).data.sessions.length, 0);
  assert.equal((await api("elements?kind=image")).data.pagination.total, 0);
});

test("starting a session saves the first message atomically and retries survive restart", async (t) => {
  const app = await fixture(t), { api } = app;
  assert.deepEqual((await api("chat/model-preference")).data, { model: "", effort: "" });
  assert.equal((await api("chat/model-preference", { model: "bad model", effort: "high" }, "PATCH")).status, 400);
  const preference = { model: "fixture-fast", effort: "high" };
  assert.deepEqual((await api("chat/model-preference", preference, "PATCH")).data, preference);
  assert.equal((await api("chat/sessions")).data.sessions.length, 0, "Picking a model does not create a session");
  const input = { text: "EFFORT_CHECK", sourceIds: [], requestKey: "first-message-request", branchRevision: 0, ...preference };
  assert.equal((await api("chat/sessions/start", { ...input, text: " " })).status, 400);
  assert.equal((await api("chat/sessions/start", { ...input, branchRevision: 1 })).status, 409);
  assert.equal((await api("chat/sessions")).data.sessions.length, 0, "A failure inside the transaction rolls back the session");
  assert.equal((await api("elements?kind=session")).data.pagination.total, 0, "Rollback also removes the associated Wiki record");
  const attempts = await Promise.all([api("chat/sessions/start", input), api("chat/sessions/start", input)]);
  for (const attempt of attempts) assert.equal(attempt.status, 200, JSON.stringify(attempt.data));
  const session = attempts[0].data.session;
  assert.equal(attempts[1].data.session.id, session.id);
  assert.equal(attempts[1].data.turns[0].id, attempts[0].data.turns[0].id);
  assert.equal(session.title, "EFFORT_CHECK");
  assert.deepEqual(JSON.parse((await waitTurn(api, session.id)).turns[0].answer), preference);
  await app.restart();
  const retried = await api("chat/sessions/start", input);
  assert.equal(retried.status, 200);
  assert.equal(retried.data.session.id, session.id);
  assert.equal(retried.data.turns.length, 1);
  assert.deepEqual((await api("chat/model-preference")).data, preference);
  assert.equal((await api("chat/sessions/start", { ...input, text: "changed" })).status, 409);
  assert.equal((await api("chat/sessions")).data.sessions.length, 1);
});

test("reference and text timestamps persist across restart and branching", async (t) => {
  const app = await fixture(t);
  const background = (await app.api("elements", { body: "预先提供" })).data;
  const discovered = (await app.api("elements", { body: "之后读取" })).data;
  const session = (await app.api("chat/sessions", {})).data;
  await app.api(`chat/sessions/${session.id}/turns`, { text: `TIMELINE_SOURCES ${discovered.id}`, sourceIds: [background.id], requestKey: "timeline-sources-123" });
  const { turns: [turn] } = await waitTurn(app.api, session.id);
  assert.ok(turn.sources.every((s) => Number.isFinite(s.appearedAt) && Number.isInteger(s.sequence)));
  assert.ok(turn.events.every((e) => Number.isFinite(e.appearedAt) && Number.isInteger(e.sequence)));
  const parts = (value) => chatMessageParts(value.answer, value.events);
  assert.deepEqual(parts(turn).map((p) => p.type === "text" ? p.text : "工具"), [
    "先说明，再读取新资料。", "工具", "新资料已读完。", "工具", "重复读取不移动已有资料。",
  ]);
  await app.restart();
  assert.deepEqual(parts((await app.api(`chat/sessions/${session.id}`)).data.turns[0]), parts(turn));
  const fork = await app.api(`chat/turns/${turn.id}/fork`, { requestKey: "timeline-fork-123", branchRevision: 0 });
  assert.equal(fork.status, 200, JSON.stringify(fork.data));
  assert.deepEqual(parts((await app.api(`chat/sessions/${fork.data.id}`)).data.turns[0]), parts(turn));
});

test("composer drafts survive restart, isolate sessions and reject stale writes after submission", async (t) => {
  const app = await fixture(t);
  const first = (await app.api("chat/sessions", {})).data;
  const second = (await app.api("chat/sessions", {})).data;
  const route = `chat/sessions/${first.id}/draft`;
  const draft = { text: "  未发送的中文草稿\n第二行保留空白  ", revision: 100 };
  assert.deepEqual((await app.api(route, draft, "PUT")).data, draft);
  await app.restart();
  assert.deepEqual((await app.api(`chat/sessions/${first.id}`)).data.session.draft, draft);
  assert.deepEqual((await app.api(`chat/sessions/${second.id}`)).data.session.draft, { text: "", revision: 0 });
  assert.deepEqual((await app.api(route, { text: "晚到的旧草稿", revision: 99 }, "PUT")).data, draft);
  assert.equal((await app.api(route, { text: "冲突的同版草稿", revision: 100 }, "PUT")).status, 409);
  assert.equal((await app.api(route, { text: "x".repeat(12001), revision: 101 }, "PUT")).status, 400);
  assert.equal((await app.api(route, { text: "有效文字", revision: -1 }, "PUT")).status, 400);
  assert.equal((await app.api("chat/sessions/999999/draft", draft, "PUT")).status, 404);
  const input = { text: draft.text, sourceIds: [], requestKey: "composer-draft-send" };
  assert.equal((await app.api(`chat/sessions/${first.id}/turns`, { ...input, requestKey: "bad" })).status, 400);
  assert.deepEqual((await app.api(`chat/sessions/${first.id}`)).data.session.draft, draft, "A rejected message preserves its draft");
  const sent = await app.api(`chat/sessions/${first.id}/turns`, input);
  assert.equal(sent.status, 200);
  const cleared = { text: "", revision: 101 };
  assert.deepEqual(sent.data.session.draft, cleared);
  assert.deepEqual((await app.api(route, draft, "PUT")).data, cleared, "A delayed save cannot resurrect sent text");
  await waitTurn(app.api, first.id);
  const next = { text: "下一条消息", revision: 102 };
  await app.api(route, next, "PUT");
  await app.api(`chat/sessions/${first.id}/turns`, input);
  assert.deepEqual((await app.api(`chat/sessions/${first.id}`)).data.session.draft, next, "Retrying a submitted message preserves a later draft");
  await app.restart();
  assert.deepEqual((await app.api(`chat/sessions/${first.id}`)).data.session.draft, next);
});

test("composer draft migration preserves old sessions, is idempotent and rolls back on failure", () => {
  for (const fail of [false, true]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE wiki_schema(version INTEGER PRIMARY KEY)"); migrateChat(db);
      db.exec("INSERT INTO chat_sessions(title,created_at,updated_at) VALUES('旧会话',1,1)");
      if (fail) db.exec("ALTER TABLE chat_sessions ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 0");
      if (fail) {
        assert.throws(() => migrateChatDrafts(db));
        assert.equal(db.prepare("PRAGMA table_info(chat_sessions)").all().some((r) => r.name === "draft_text"), false);
        assert.equal(db.prepare("SELECT 1 FROM wiki_schema WHERE version=18").get(), undefined);
      } else {
        migrateChatDrafts(db); migrateChatDrafts(db);
        const row = db.prepare("SELECT title,draft_text,draft_revision FROM chat_sessions").get();
        assert.deepEqual({ ...row }, { title: "旧会话", draft_text: "", draft_revision: 0 });
        assert.equal(db.prepare("SELECT count(*) n FROM wiki_schema WHERE version=18").get().n, 1);
      }
    } finally { db.close(); }
  }
});
test("image positions retain interleaved replies after restart and branching", async (t) => {
  const app = await fixture(t);
  const session = (await app.api("chat/sessions", {})).data;
  await app.api(`chat/sessions/${session.id}/turns`, { text: "GENERATE_IMAGE_ORDER", sourceIds: [], requestKey: "ordered-images-123" });
  const { turns: [turn] } = await waitTurn(app.api, session.id);
  assert.equal(turn.answer, "开始生成第一张图片。\n\n第一张已完成，继续生成第二张。\n\n两张图片都已生成。");
  assert.deepEqual(turn.events.filter((e) => e.command).map((e) => e.startedAnswerOffset), ["开始生成第一张图片。".length, "开始生成第一张图片。\n\n第一张已完成，继续生成第二张。".length]);
  assert.deepEqual(turn.events.filter((e) => e.command).map((e) => e.answerOffset), ["开始生成第一张图片。".length, "开始生成第一张图片。\n\n第一张已完成，继续生成第二张。".length]);
  assert.ok(turn.events.filter((e) => e.command).every((e) => e.artifact));
  await app.restart();
  const saved = (await app.api(`chat/sessions/${session.id}`)).data.turns[0];
  assert.deepEqual(saved.events, turn.events);
  const fork = await app.api(`chat/turns/${turn.id}/fork`, { requestKey: "ordered-images-fork", branchRevision: 0 });
  assert.equal(fork.status, 200, JSON.stringify(fork.data));
  assert.deepEqual((await app.api(`chat/sessions/${fork.data.id}`)).data.turns[0].events, turn.events);
});

test("generated images expose progress, persist across restart and only serve registered artifacts", async (t) => {
  const app = await fixture(t);
  const session = (await app.api("chat/sessions", {})).data;
  await app.api(`chat/sessions/${session.id}/turns`, { text: "GENERATE_IMAGE", sourceIds: [], requestKey: "generated-image-123" });
  const running = await waitTurn(app.api, session.id, (turn) => turn.events.some((e) => e.state === "running"));
  assert.equal(running.turns[0].events[0].command, "生成图片");
  const done = await waitTurn(app.api, session.id);
  const turn = done.turns[0], event = turn.events[0];
  assert.equal(event.state, "completed", event.error);
  assert.ok(event.artifact);
  await app.restart();
  const response = await fetch(new URL(`api/chat/turns/${turn.id}/artifacts/${event.artifact}`, app.url));
  assert.equal(response.status, 200);
  assert.equal((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).format, "png");
  assert.equal((await fetch(new URL(`api/chat/turns/${turn.id}/artifacts/00000000-0000-0000-0000-000000000000.png`, app.url))).status, 404);
});

test("image moderation reasons reach the running session and survive successful retries and restart", async (t) => {
  const app = await fixture(t);
  const session = (await app.api("chat/sessions", {})).data;
  await app.api(`chat/sessions/${session.id}/turns`, { text: "GENERATE_IMAGE_ERRORS_RETRY", sourceIds: [], requestKey: "moderation-retry-123" });
  const running = await waitTurn(app.api, session.id, (turn) => turn.events.filter((e) => e.error === "生成结果被内容审核拦截：性相关内容。").length === 3);
  assert.equal(running.turns[0].state, "running", "Report tool failures before the whole turn finishes");
  const done = await waitTurn(app.api, session.id);
  assert.equal(done.turns[0].state, "completed");
  assert.ok(done.turns[0].events.at(-1).artifact, "A later successful retry still returns its image");
  await app.restart();
  const restored = (await app.api(`chat/sessions/${session.id}`)).data.turns[0];
  assert.equal(restored.events.filter((e) => e.error === "生成结果被内容审核拦截：性相关内容。").length, 3);
});

test("mixed image failures retain labeled causes without guessing which image item failed for each reason", async (t) => {
  const app = await fixture(t);
  const session = (await app.api("chat/sessions", {})).data;
  await app.api(`chat/sessions/${session.id}/turns`, { text: "GENERATE_IMAGE_ERRORS_MIXED", sourceIds: [], requestKey: "moderation-mixed-123" });
  const turn = (await waitTurn(app.api, session.id)).turns[0];
  assert.equal(turn.events.filter((e) => e.error === "图片生成失败，图片工具未提供具体原因。").length, 3);
  const detail = turn.events.find((e) => e.command === "图片工具错误详情");
  assert.match(detail.error, /正面平视：生成结果被内容审核拦截：性相关内容/);
  assert.match(detail.error, /侧面半身：image generation failed: connection timed out/);
  assert.equal(turn.events.filter((e) => e.command).length, 4, "Diagnostic polling does not duplicate details");
});

test("silent image generation survives the old deadline, resumes after idle notices, and remains stoppable", { timeout: 30000 }, async (t) => {
  const { api } = await fixture(t);
  await api("chat/probe", {});
  const session = (await api("chat/sessions", {})).data;
  const other = (await api("chat/sessions", {})).data;
  const route = `chat/sessions/${session.id}`;
  async function waitSnapshot(predicate) {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      t.mock.timers.tick(120); // Deliver the service's batched snapshot updates.
      const snapshot = (await api(route)).data;
      if (predicate(snapshot)) return snapshot;
      await sleep(20);
    }
    throw new Error("Expected chat progress was not observed");
  }
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await api(`${route}/turns`, { text: "GENERATE_IMAGE_PROGRESS", sourceIds: [], requestKey: "idle-image-progress" });
    await waitSnapshot((data) => data.turns[0]?.events.some((event) => event.command === "生成图片"));
    t.mock.timers.tick(60000);
    let snapshot = (await api(route)).data;
    assert.equal(snapshot.turns[0].state, "running", "The organizer's 10-second limit must not stop a chat turn");
    assert.equal(snapshot.progressNotice, "");
    t.mock.timers.tick(120000);
    snapshot = (await api(route)).data;
    assert.match(snapshot.progressNotice, /未收到新进展.*仍在运行/);
    assert.equal(snapshot.turns[0].events[0].state, "running");
    assert.equal((await api(`chat/sessions/${other.id}`)).data.progressNotice, "", "Notices belong to the active session");
    t.mock.timers.tick(3600000);
    assert.equal((await api(route)).data.turns[0].state, "running", "Even prolonged tool silence must not cancel generation");

    snapshot = await waitSnapshot((data) => !data.progressNotice);
    assert.equal(snapshot.progressNotice, "", "Reasoning activity clears the notice even without an answer delta");
    assert.equal(snapshot.turns[0].state, "running");
    assert.equal(snapshot.turns[0].answer, "");
    t.mock.timers.tick(60000);
    assert.equal((await api(route)).data.progressNotice, "", "The inactivity window restarts at new progress");
    t.mock.timers.tick(120000);
    assert.ok((await api(route)).data.progressNotice);
    const done = await waitSnapshot((data) => data.turns[0].state !== "running");
    assert.equal(done.turns[0].state, "completed", done.turns[0].error);
    assert.ok(done.turns[0].events[0].artifact, "The late image result is saved normally");
    assert.equal(done.progressNotice, "");
    t.mock.timers.tick(3600000);
    assert.equal((await api(route)).data.progressNotice, "", "Finished turns must not publish late notices");

    await api(`${route}/turns`, { text: "SLOW", sourceIds: [], requestKey: "idle-manual-stop" });
    await waitSnapshot((data) => Boolean(data.turns.at(-1).answer));
    t.mock.timers.tick(180000);
    assert.ok((await api(route)).data.progressNotice);
    const stopped = (await api(`${route}/stop`, {})).data;
    assert.equal(stopped.turns.at(-1).state, "interrupted");
    assert.equal(stopped.progressNotice, "");
    assert.equal(stopped.running, false);
  } finally { t.mock.timers.reset(); }
});

test("image edits attach the exact original, persist provenance and selection, and reject invalid references", async (t) => {
  const app = await fixture(t);
  const session = (await app.api("chat/sessions", {})).data;
  const route = `chat/sessions/${session.id}/turns`;
  await app.api(route, { text: "GENERATE_IMAGE", sourceIds: [], requestKey: "original-image-123" });
  const original = (await waitTurn(app.api, session.id)).turns[0];
  const imageEdit = { turnId: original.id, artifact: original.events.find((e) => e.artifact).artifact };
  const originalPath = path.join(app.dir, "chat-artifacts", imageEdit.artifact);
  const bytes = await sharp({ create: { width: 1800, height: 1200, channels: 3, background: "#326578" } }).png().toBuffer();
  await writeFile(originalPath, bytes);
  const input = { text: "EDIT_IMAGE", sourceIds: [], imageEdit, requestKey: "edit-image-123" };
  assert.equal((await app.api(route, input)).status, 200);
  assert.equal((await app.api(route, input)).data.turns.length, 2);
  let turn = (await waitTurn(app.api, session.id)).turns.at(-1);
  assert.equal(turn.state, "completed", turn.error);
  assert.equal(JSON.parse(turn.answer).originalHash, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(turn.events.find((e) => e.command).command, "编辑图片");
  assert.notEqual(turn.events.find((e) => e.artifact).artifact, imageEdit.artifact);
  assert.deepEqual(turn.imageEdit, imageEdit);
  assert.deepEqual(await readFile(originalPath), bytes);
  const region = { x: .1, y: .2, width: .4, height: .3 };
  const regionInput = { ...input, text: "EDIT_IMAGE EXPECT_REGION", imageEdit: { turnId: turn.id, artifact: turn.events.find((e) => e.artifact).artifact, region }, requestKey: "edit-region-123" };
  assert.equal((await app.api(route, regionInput)).status, 200);
  turn = (await waitTurn(app.api, session.id)).turns.at(-1);
  assert.equal(turn.state, "completed", turn.error);
  assert.equal(JSON.parse(turn.answer).images, 2);
  await app.restart();
  assert.deepEqual((await app.api(`chat/sessions/${session.id}`)).data.turns.at(-1).imageEdit, regionInput.imageEdit);
  assert.equal((await app.api(route, regionInput)).data.turns.length, 3, "Retries survive restart");
  assert.equal((await app.api(route, { ...regionInput, imageEdit })).status, 409, "Different image with same request key conflicts");
  assert.equal((await app.api(route, { ...regionInput, imageEdit: { ...regionInput.imageEdit, region: { ...region, x: .9 } } })).status, 400);
  assert.equal((await app.api(route, { ...input, requestKey: "invalid-path-123", imageEdit: { ...imageEdit, artifact: "../../secret.png" } })).status, 400);
  assert.equal((await app.api(route, { ...input, requestKey: "unregistered-123", imageEdit: { ...imageEdit, artifact: "00000000-0000-0000-0000-000000000000.png" } })).status, 400);
  const other = (await app.api("chat/sessions", {})).data;
  assert.equal((await app.api(`chat/sessions/${other.id}/turns`, input)).status, 400);
  assert.equal((await app.api(`chat/sessions/${other.id}`)).data.turns.length, 0);
  assert.equal(path.dirname(originalPath), path.join(app.dir, "chat-artifacts"));
  await rm(originalPath);
  await app.api(route, { ...input, requestKey: "missing-original-123" });
  turn = (await waitTurn(app.api, session.id)).turns.at(-1);
  assert.equal(turn.state, "failed"); assert.match(turn.error, /待编辑原图无法读取/);
});

test("image edit migration is additive, repeatable and preserves legacy request hashes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE wiki_schema(version INTEGER PRIMARY KEY)"); migrateChat(db);
    db.exec("INSERT INTO chat_sessions(id,title,created_at,updated_at) VALUES(1,'旧会话',1,1)");
    db.exec("INSERT INTO chat_turns(session_id,request_key,payload_hash,text,answer,created_at,updated_at) VALUES(1,'legacy-123','unchanged','问题','历史回答',1,1)");
    migrateChatImageEdits(db); migrateChatImageEdits(db);
    const row = db.prepare("SELECT * FROM chat_turns").get();
    assert.equal(row.image_edit, null); assert.equal(row.payload_hash, "unchanged"); assert.equal(row.answer, "历史回答");
    assert.equal(db.prepare("SELECT count(*) n FROM wiki_schema WHERE version=13").get().n, 1);
  } finally { db.close(); }
});

test("chat uses real CLI subprocesses, persists sources and supports acceptance, conflict, undo and restart", { timeout: 40000 }, async (t) => {
  const { api, restart } = await fixture(t);
  const source = (await api("elements", { body: "资料甲：雨夜街头的视觉参考", tags: [] })).data;
  const session = (await api("chat/sessions", {})).data;
  assert.equal((await api("chat/probe", {})).data.available, true);
  const input = { text: "根据资料生成笔记", sourceIds: [source.id], requestKey: "request-first-123" };
  assert.equal((await api(`chat/sessions/${session.id}/turns`, input)).status, 200);
  assert.equal((await api(`chat/sessions/${session.id}/turns`, input)).data.turns.length, 1);
  const done = await waitTurn(api, session.id);
  assert.equal(done.turns[0].state, "completed", done.turns[0].error);
  const usage = (await api("token-usage?days=0")).data;
  assert.equal(usage.summary.calls, 1);
  assert.equal(usage.summary.total, 150, "Duplicate usage events and historical thread usage must not be added");
  assert.equal(usage.recent[0].context.sessionId, session.id);
  assert.equal(usage.recent[0].state, "completed");
  assert.match(done.turns[0].answer, /资料甲/); assert.doesNotMatch(done.turns[0].answer, /�/);
  assert.equal(done.turns[0].sources[0].id, source.id);
  assert.equal(done.proposals.length, 2);
  assert.equal((await api("elements")).data.pagination.total, 1, "Proposals must not mutate the library");
  const create = done.proposals.find((p) => p.payload.kind === "create_text"), tags = done.proposals.find((p) => p.payload.kind === "add_tags");
  const accepted = (await api(`chat/proposals/${create.id}/accept`, { body: "用户修改后的笔记", tags: ["审核"] })).data;
  assert.equal(accepted.state, "accepted"); assert.ok(accepted.changes.createdId);
  assert.equal((await api(`chat/proposals/${create.id}/accept`, {})).data.changes.createdId, accepted.changes.createdId);
  assert.equal((await api("elements")).data.elements.filter((e) => !e.localOnly).length, 2);
  assert.equal((await api(`chat/proposals/${tags.id}/accept`, {})).data.state, "accepted", "Same-turn pending baselines advance only for accepted changes");
  assert.equal((await api(`chat/proposals/${tags.id}/undo`, {})).data.state, "undone");
  assert.equal((await api(`chat/proposals/${create.id}/undo`, {})).data.state, "undone");
  await restart();
  assert.equal((await api("token-usage?days=0")).data.summary.total, 150, "Usage survives restart");
  const restored = (await api(`chat/sessions/${session.id}`)).data;
  assert.equal(restored.session.threadId, done.session.threadId);
  await api(`chat/sessions/${session.id}/turns`, { text: "CONTINUE", sourceIds: [], requestKey: "request-resume-123" });
  const continued = await waitTurn(api, session.id); assert.match(continued.turns.at(-1).answer, /继续会话/);
  assert.equal(continued.session.threadId, done.session.threadId);
  const draft = (await api(`chat/turns/${continued.turns.at(-1).id}/draft`, { requestKey: "manual-draft-123", body: "另一份笔记", sourceIds: [source.id] })).data;
  await api(`elements/${source.id}`, { body: "资料甲已人工修改" }, "PATCH");
  assert.equal((await api(`chat/proposals/${draft.id}/accept`, {})).status, 409);
  assert.equal((await api("elements")).data.elements.filter((e) => !e.localOnly).length, 1);
});

test("chat cancellation, late interrupt, process failure and forbidden writes do not leave a busy session", { timeout: 40000 }, async (t) => {
  const { api, restart } = await fixture(t);
  await api("elements", { body: "资料甲", tags: [] });
  const session = (await api("chat/sessions", {})).data;
  for (const text of ["SLOW", "NO_INTERRUPT_EVENT"]) {
    await api(`chat/sessions/${session.id}/turns`, { text, sourceIds: [], requestKey: `request-${text}` });
    await waitTurn(api, session.id, (turn) => Boolean(turn.answer));
    const other = (await api("chat/sessions", {})).data;
    assert.equal((await api(`chat/sessions/${other.id}/turns`, { text: "SLOW", sourceIds: [], requestKey: "request-other-123" })).status, 200);
    await waitTurn(api, other.id, (turn) => Boolean(turn.answer));
    assert.equal((await api(`chat/sessions/${session.id}/turns`, { text: "重复发送", sourceIds: [], requestKey: "request-same-session" })).status, 409);
    await api(`chat/sessions/${session.id}/stop`, {});
    assert.equal((await waitTurn(api, session.id)).turns.at(-1).state, "interrupted");
    assert.equal((await api(`chat/sessions/${other.id}`)).data.running, true);
    assert.equal((await api(`chat/sessions/${other.id}`)).data.turns.at(-1).state, "running");
    await api(`chat/sessions/${other.id}/stop`, {});
  }
  for (const text of ["START_FAILURE", "CONTINUE", "CRASH", "FAIL", "FORBIDDEN"]) {
    await api(`chat/sessions/${session.id}/turns`, { text, sourceIds: [], requestKey: `request-${text}` });
    const value = await waitTurn(api, session.id);
    assert.equal(value.turns.at(-1).state, ["FORBIDDEN", "CONTINUE"].includes(text) ? "completed" : "failed");
  }
  assert.equal((await api("elements")).data.pagination.total, 1);
  assert.equal((await api("chat/proposals", { kind: "create_text", body: "bad", reason: "bad" })).status, 403);
  await api(`chat/sessions/${session.id}/turns`, { text: "SLOW", sourceIds: [], requestKey: "request-restart-slow" });
  await waitTurn(api, session.id, (turn) => Boolean(turn.answer)); await restart();
  assert.equal((await api(`chat/sessions/${session.id}`)).data.turns.at(-1).state, "interrupted");
});

test("concurrent sessions isolate streamed answers, tools, proposals, images and completion", { timeout: 30000 }, async (t) => {
  const app = await fixture(t), { api } = app;
  const sessions = await Promise.all(["A", "B"].map(async (label) => {
    const session = (await api("chat/sessions", {})).data;
    const source = (await api("elements", { body: `资料 ${label}` })).data;
    return { ...session, label, source };
  }));
  const payload = (s) => ({ text: `CONCURRENT ${s.label} ${s.source.id}`, sourceIds: [], requestKey: `concurrent-${s.label}-request`,
    model: s.label === "A" ? "fixture-fast" : "fixture-deep", effort: s.label === "A" ? "low" : "high" });
  const sent = await Promise.all(sessions.map((s) => api(`chat/sessions/${s.id}/turns`, payload(s))));
  for (const result of sent) assert.equal(result.status, 200, JSON.stringify(result.data));
  const running = await Promise.all(sessions.map((s) => waitTurn(api, s.id, (turn) => turn.answer === `${s.label} ready` && turn.events.some((e) => e.artifact))));
  assert.deepEqual(new Set((await api("chat/status")).data.activeSessionIds), new Set(sessions.map((s) => s.id)));
  for (const [index, s] of sessions.entries()) {
    const detail = running[index], turn = detail.turns[0];
    assert.equal(detail.running, true);
    assert.equal(turn.state, "running");
    assert.equal(turn.model, payload(s).model);
    assert.equal(turn.effort, payload(s).effort);
    assert.deepEqual(turn.sources.map((source) => source.id), [s.source.id]);
    assert.equal(detail.proposals.length, 1);
    assert.equal(detail.proposals[0].payload.body, `并发笔记 ${s.label}`);
    assert.equal(detail.proposals[0].turnId, turn.id);
    const retry = await api(`chat/sessions/${s.id}/turns`, payload(s));
    assert.equal(retry.status, 200);
    assert.equal(retry.data.turns.length, 1);
    assert.equal(retry.data.turns[0].id, turn.id);
    assert.equal((await api(`chat/sessions/${s.id}/turns`, { ...payload(s), requestKey: `second-${s.label}-request` })).status, 409);
    const trace = (await api(`chat/turns/${turn.id}/trace`)).data.record.value;
    assert.equal(trace.thread.params.cwd, path.join(app.dir, "chat-workspace", String(s.id)));
  }
  const images = await Promise.all(running.map(async (detail) => {
    const turn = detail.turns[0], name = turn.events.find((e) => e.artifact).artifact;
    const response = await fetch(new URL(`api/chat/turns/${turn.id}/artifacts/${name}`, app.url));
    assert.equal(response.status, 200); return Buffer.from(await response.arrayBuffer());
  }));
  assert.notDeepEqual(images[0], images[1]);
  // Reprobing connection settings must also leave both active sessions intact.
  assert.equal((await api("chat/probe", {})).status, 200);
  await writeFile(path.join(app.dir, "chat-workspace", String(sessions[0].id), "continue"), "done");
  const first = await waitTurn(api, sessions[0].id);
  assert.equal(first.turns[0].answer, "A ready A done");
  assert.equal(first.running, false);
  assert.equal((await api(`chat/sessions/${sessions[1].id}`)).data.running, true);
  await writeFile(path.join(app.dir, "chat-workspace", String(sessions[1].id), "continue"), "done");
  const second = await waitTurn(api, sessions[1].id);
  assert.equal(second.turns[0].answer, "B ready B done");
  assert.deepEqual((await api("chat/status")).data.activeSessionIds, []);
  await app.restart();
  for (const s of sessions) assert.equal((await api(`chat/sessions/${s.id}`)).data.turns[0].answer, `${s.label} ready ${s.label} done`);
});

test("a failed or cancelled startup cannot interrupt another session, and shutdown stops all sessions", { timeout: 30000 }, async (t) => {
  const app = await fixture(t), { api } = app;
  const stable = (await api("chat/sessions", {})).data;
  await api(`chat/sessions/${stable.id}/turns`, { text: "SLOW", sourceIds: [], requestKey: "concurrent-stable" });
  await waitTurn(api, stable.id, (turn) => Boolean(turn.answer));
  const other = (await api("chat/sessions", {})).data;
  for (const text of ["START_FAILURE", "CRASH", "FAIL"]) {
    assert.equal((await api(`chat/sessions/${other.id}/turns`, { text, sourceIds: [], requestKey: `concurrent-${text}` })).status, 200);
    assert.equal((await waitTurn(api, other.id)).turns.at(-1).state, "failed");
    assert.equal((await api(`chat/sessions/${stable.id}`)).data.running, true);
  }
  const early = (await api("chat/sessions", {})).data;
  await api(`chat/sessions/${early.id}/turns`, { text: "SLOW", sourceIds: [], requestKey: "concurrent-early-stop" });
  assert.equal((await api(`chat/sessions/${early.id}/stop`, {})).data.turns[0].state, "interrupted");
  assert.equal((await api(`chat/sessions/${stable.id}`)).data.running, true);
  await api(`chat/sessions/${other.id}/turns`, { text: "SLOW", sourceIds: [], requestKey: "concurrent-shutdown" });
  await waitTurn(api, other.id, (turn) => Boolean(turn.answer));
  await app.restart();
  for (const s of [stable, other]) {
    const detail = (await api(`chat/sessions/${s.id}`)).data;
    assert.equal(detail.running, false);
    assert.equal(detail.turns.at(-1).state, "interrupted");
  }
});

test("idle session processes are reused then reclaimed without stopping a busy session", async (t) => {
  const { api } = await fixture(t);
  const idle = (await api("chat/sessions", {})).data, busy = (await api("chat/sessions", {})).data;
  let sequence = 0;
  async function processId() {
    await api(`chat/sessions/${idle.id}/turns`, { text: "PROCESS_CHECK", sourceIds: [], requestKey: `process-check-${++sequence}` });
    const turn = (await waitTurn(api, idle.id)).turns.at(-1);
    assert.equal(turn.state, "completed", turn.error);
    return JSON.parse(turn.answer).pid;
  }
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const first = await processId();
    assert.equal(await processId(), first);
    await api(`chat/sessions/${busy.id}/turns`, { text: "SLOW", sourceIds: [], requestKey: "process-busy-session" });
    await waitTurn(api, busy.id, (turn) => Boolean(turn.turnId));
    t.mock.timers.tick(60000);
    assert.notEqual(await processId(), first);
    assert.equal((await api(`chat/sessions/${busy.id}`)).data.running, true);
    await api(`chat/sessions/${busy.id}/stop`, {});
  } finally { t.mock.timers.reset(); }
});

test("chat attaches selected images and reuses them on CLI rereads", { timeout: 20000 }, async (t) => {
  const { api, url } = await fixture(t);
  const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: "#123456" } }).png().toBuffer();
  const response = await fetch(new URL("api/images", url), { method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": "fixture.png" }, body: bytes });
  assert.equal(response.status, 201); const image = await response.json();
  const session = (await api("chat/sessions", {})).data;
  await api(`chat/sessions/${session.id}/turns`, { text: `IMAGE:${image.id}`, sourceIds: [image.id], requestKey: "request-image-123" });
  const value = await waitTurn(api, session.id);
  assert.equal(value.turns[0].state, "completed", value.turns[0].error);
  assert.match(value.turns[0].answer, /图片读取通过/);
  assert.deepEqual(value.turns[0].sources.map(({ id, kind, label }) => ({ id, kind, label })), [{ id: image.id, kind: "image", label: "fixture.png" }]);
});

test("chat counts eight distinct CLI images once each and rejects a ninth", async (t) => {
  const { api, url } = await fixture(t);
  for (let i = 0; i < 9; i++) {
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: i * 20, g: 30, b: 60 } } }).png().toBuffer();
    assert.equal((await fetch(new URL("api/images", url), { method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": `budget-${i}.png` }, body: bytes })).status, 201);
  }
  const session = (await api("chat/sessions", {})).data;
  await api(`chat/sessions/${session.id}/turns`, { text: "IMAGE_READ_BUDGET", sourceIds: [], requestKey: "image-budget-test" });
  const turn = (await waitTurn(api, session.id)).turns.at(-1);
  assert.equal(turn.state, "completed", turn.error);
  assert.match(turn.answer, /第九张已限制/);
});

test("chat repository makes acceptance atomic and preserves manual edits on undo", () => {
  const db = initDb(":memory:");
  try {
    const wiki = createElementRepository(db), chat = createChatRepository(db);
    const source = wiki.createText({ body: "资料", tags: [] });
    const s = chat.create(), turn = chat.begin(s.id, { text: "hello", requestKey: "request-123", sourceIds: [] }).turn;
    const p = chat.propose(turn.id, "proposal-1", { kind: "create_text", body: "新文字", tags: [], sourceIds: [source.id], reason: "总结" }, [chat.snapshot(source.id)]);
    db.exec("CREATE TRIGGER fail_chat_receipt BEFORE UPDATE OF state ON chat_proposals BEGIN SELECT RAISE(ABORT,'receipt failed'); END");
    assert.throws(() => chat.accept(p.id), /receipt failed/);
    assert.equal(wiki.list({}).pagination.total, 1); assert.equal(chat.proposal(p.id).state, "pending");
    db.exec("DROP TRIGGER fail_chat_receipt");
    const accepted = chat.accept(p.id), createdId = accepted.changes.createdId;
    wiki.update(createdId, { body: "人工补充", tags: [] });
    assert.throws(() => chat.undo(p.id), /已有修改/); assert.equal(wiki.get(createdId).body, "人工补充");
    chat.recover(); assert.equal(chat.turn(turn.id).state, "interrupted");
  } finally { db.close(); }
});

test("chat history pages retain every proposal for their included turns", () => {
  const db = initDb(":memory:");
  try {
    const chat = createChatRepository(db), session = chat.create();
    for (let n = 0; n < 24; n++) {
      const turn = chat.begin(session.id, { text: `message ${n}`, sourceIds: [], requestKey: `request-history-${n}` }).turn;
      for (let p = 0; p < 6; p++) chat.propose(turn.id, `proposal-${p}`, { kind: "create_text", body: `draft ${p}`, tags: [], sourceIds: [], reason: "整理" }, []);
      chat.updateTurn({ ...turn, state: "completed" });
    }
    const recent = chat.detail(session.id), older = chat.detail(session.id, recent.turns[0].id);
    assert.equal(recent.turns.length, 20); assert.equal(recent.proposals.length, 120);
    assert.equal(older.turns.length, 4); assert.equal(older.proposals.length, 24);
    assert.equal(older.hasOlder, false);
    assert.ok(older.proposals.every((p) => older.turns.some((t) => t.id === p.turnId)));
  } finally { db.close(); }
});

test("conversation CLI rejects filesystem, endpoint and mutation escapes", () => {
  for (const args of [["elements", "create", "--body", "bad"], ["read", "1", "--url", "http://127.0.0.1:2"], ["chat", "propose", "--input", "C:/secret.json"], ["elements", "download", "1", "--output", "x"], ["organize", "accept", "1"]]) assert.throws(() => chatCliArgs({ args, stdin: "" }));
  assert.deepEqual(chatCliArgs({ args: ["read", "1"], stdin: "" }), ["read", "1"]);
});

test("chat model selection persists independently, reaches each Codex turn, restores defaults and preserves retry identity", { timeout: 20000 }, async (t) => {
  const { api, restart, dir } = await fixture(t);
  const catalog = await api("chat/models");
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.data, { defaultEffort: "", defaultModel: "fixture-default", models: [
    { id: "fixture-fast", label: "快速模型", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })) }, { id: "fixture-deep", label: "深度模型", isDefault: false, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "high" }] },
  ] });
  const session = (await api("chat/sessions", {})).data;
  const other = (await api("chat/sessions", {})).data;
  for (const model of [null, 1, "bad model", "x\nfoo", "x".repeat(161)]) {
    assert.equal((await api(`chat/sessions/${session.id}`, { model }, "PATCH")).status, 400);
    assert.equal((await api(`chat/sessions/${session.id}/turns`, { text: "MODEL_CHECK", sourceIds: [], requestKey: "bad-model-123", model })).status, 400);
  }
  assert.equal((await api(`chat/sessions/${session.id}`)).data.turns.length, 0);
  assert.equal((await api(`chat/sessions/${session.id}`, { model: "fixture-fast" }, "PATCH")).data.session.model, "fixture-fast");
  assert.equal((await api(`chat/sessions/${other.id}`)).data.session.model, "");
  await restart();
  assert.equal((await api(`chat/sessions/${session.id}`)).data.session.model, "fixture-fast", "An unsent selection survives restart");
  const first = { text: "MODEL_CHECK", sourceIds: [], model: "fixture-fast", requestKey: "model-first-123" };
  await api(`chat/sessions/${session.id}/turns`, first);
  let value = await waitTurn(api, session.id);
  const threadId = value.session.threadId;
  assert.deepEqual(JSON.parse(value.turns[0].answer), { model: "fixture-fast", threadModel: "fixture-fast" });
  assert.equal(value.turns[0].model, "fixture-fast");
  assert.equal((await api(`chat/sessions/${session.id}/turns`, first)).data.turns.length, 1);
  assert.equal((await api(`chat/sessions/${session.id}/turns`, { ...first, model: "fixture-deep" })).status, 409);
  await api(`chat/sessions/${session.id}`, { model: "fixture-deep" }, "PATCH");
  // Legacy callers without a model use the session preference and retain their original payload hash.
  const legacy = { text: "MODEL_CHECK", sourceIds: [], requestKey: "model-legacy-123" };
  await api(`chat/sessions/${session.id}/turns`, legacy);
  value = await waitTurn(api, session.id);
  assert.equal(value.session.threadId, threadId);
  assert.deepEqual(JSON.parse(value.turns.at(-1).answer), { model: "fixture-deep", threadModel: "fixture-deep" });
  await api(`chat/sessions/${session.id}`, { model: "" }, "PATCH");
  assert.equal((await api(`chat/sessions/${session.id}/turns`, legacy)).data.turns.length, 2);
  assert.equal((await api(`chat/sessions/${session.id}`)).data.session.model, "", "Retrying a completed turn must not restore an old preference");
  await api(`chat/sessions/${session.id}/turns`, { text: "MODEL_CHECK", sourceIds: [], model: "", requestKey: "model-default-123" });
  value = await waitTurn(api, session.id);
  assert.equal(value.session.threadId, threadId);
  assert.deepEqual(JSON.parse(value.turns.at(-1).answer), { model: "fixture-default", threadModel: "fixture-default" });
  assert.equal(value.turns[0].model, "fixture-fast", "Historical model labels remain unchanged");
  assert.equal((await api("organization/status")).data.config.executor.codexCli.model, null);

  const file = path.join(dir, "organization.json"), config = JSON.parse(await readFile(file, "utf8"));
  config.executor.codexCli.model = "fixture-configured";
  await writeFile(file, JSON.stringify(config)); await restart();
  assert.equal((await api("chat/models")).data.defaultModel, "fixture-default", "Organization model must not override the chat default");
  await api(`chat/sessions/${session.id}/turns`, { text: "MODEL_CHECK", sourceIds: [], requestKey: "configured-default-123" });
  value = await waitTurn(api, session.id);
  assert.deepEqual(JSON.parse(value.turns.at(-1).answer), { model: "fixture-default", threadModel: "fixture-default" });
  assert.equal(value.turns.at(-1).model, "fixture-default");
  assert.equal((await api("organization/status")).data.config.executor.codexCli.model, "fixture-configured");

  await api(`chat/sessions/${session.id}/turns`, { text: "SLOW", sourceIds: [], model: "fixture-fast", requestKey: "model-slow-123" });
  await waitTurn(api, session.id, (turn) => Boolean(turn.answer));
  assert.equal((await api(`chat/sessions/${session.id}`, { model: "fixture-deep" }, "PATCH")).status, 409);
  assert.equal((await api("chat/models")).status, 200, "Reading model choices does not interrupt an active turn");
  assert.equal((await api(`chat/sessions/${session.id}`)).data.turns.at(-1).state, "running");
  assert.equal((await api(`chat/sessions/${other.id}`, { model: "fixture-deep" }, "PATCH")).status, 200);
  await api(`chat/sessions/${session.id}/stop`, {});

  config.executor.codexCli.model = "fixture-configured";
  await writeFile(file, JSON.stringify(config));
  await writeFile(config.executor.codexCli.executable, (await readFile(config.executor.codexCli.executable, "utf8")).replace('model: "fixture-default", mcp_servers:', 'model: null, mcp_servers:'));
  await restart();
  assert.equal((await api("chat/models")).data.defaultModel, "fixture-fast", "An unset Codex config resolves the catalog default");
  await api(`chat/sessions/${session.id}/turns`, { text: "MODEL_CHECK", sourceIds: [], model: "", requestKey: "catalog-default-123" });
  value = await waitTurn(api, session.id);
  assert.deepEqual(JSON.parse(value.turns.at(-1).answer), { model: "fixture-fast", threadModel: "fixture-fast" });
});

test("model migration preserves existing chat data and retry hashes, is repeatable and rolls back partial DDL", () => {
  for (const fail of [false, true]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE wiki_schema(version INTEGER PRIMARY KEY)"); migrateChat(db);
      db.exec("INSERT INTO chat_sessions(id,title,created_at,updated_at) VALUES(1,'旧会话',1,1)");
      db.exec("INSERT INTO chat_turns(session_id,request_key,payload_hash,text,answer,created_at,updated_at) VALUES(1,'legacy-123','unchanged','问题','历史回答',1,1)");
      if (fail) {
        db.exec("ALTER TABLE chat_turns ADD COLUMN model TEXT NOT NULL DEFAULT ''");
        assert.throws(() => migrateChatModels(db), /duplicate column/);
        assert.equal(db.prepare("PRAGMA table_info(chat_sessions)").all().some((c) => c.name === "model"), false);
        assert.equal(db.prepare("SELECT 1 FROM wiki_schema WHERE version=11").get(), undefined);
      } else {
        migrateChatModels(db); migrateChatModels(db);
        assert.equal(db.prepare("SELECT model FROM chat_sessions").get().model, "");
        assert.equal(db.prepare("SELECT model FROM chat_turns").get().model, "");
      }
      assert.deepEqual({ ...db.prepare("SELECT payload_hash,text,answer FROM chat_turns").get() }, { payload_hash: "unchanged", text: "问题", answer: "历史回答" });
    } finally { db.close(); }
  }
});


test("effort persists, reaches RPC, resets explicitly and remains independent across sessions", { timeout: 20000 }, async (t) => {
  const { api, restart } = await fixture(t);
  const session = (await api("chat/sessions", {})).data;
  const other = (await api("chat/sessions", {})).data;
  assert.equal((await api(`chat/sessions/${session.id}`, { model: "fixture-fast", effort: "high" }, "PATCH")).status, 200);
  await restart();
  assert.equal((await api(`chat/sessions/${session.id}`)).data.session.effort, "high");
  assert.equal((await api(`chat/sessions/${other.id}`)).data.session.effort, "");
  const input = { text: "EFFORT_CHECK", sourceIds: [], requestKey: "effort-first-123", model: "fixture-fast", effort: "high" };
  await api(`chat/sessions/${session.id}/turns`, input);
  let value = await waitTurn(api, session.id);
  assert.deepEqual(JSON.parse(value.turns.at(-1).answer), { model: "fixture-fast", effort: "high" });
  assert.equal(value.turns.at(-1).effort, "high");
  assert.equal((await api(`chat/sessions/${session.id}/turns`, { ...input, effort: "low" })).status, 409);
  await api(`chat/sessions/${session.id}`, { model: "fixture-fast", effort: "" }, "PATCH");
  await api(`chat/sessions/${session.id}/turns`, { text: "EFFORT_CHECK", sourceIds: [], requestKey: "effort-default-123" });
  value = await waitTurn(api, session.id);
  assert.deepEqual(JSON.parse(value.turns.at(-1).answer), { model: "fixture-fast", effort: "medium" });
  assert.equal(value.session.effort, "");
  assert.equal(value.turns[0].effort, "high");
  const forked = (await api(`chat/turns/${value.turns.at(-1).id}/fork`, { requestKey: "effort-fork-123", branchRevision: value.session.branchRevision })).data;
  assert.equal(forked.effort, "");
  assert.deepEqual((await api(`chat/sessions/${forked.id}`)).data.turns.map((turn) => turn.effort), ["high", "medium"]);
  for (const effort of [null, 1, "bad effort", "x".repeat(41)]) assert.equal((await api(`chat/sessions/${session.id}`, { model: "fixture-fast", effort }, "PATCH")).status, 400);
  await api(`chat/sessions/${session.id}/turns`, { text: "EFFORT_CHECK", sourceIds: [], requestKey: "effort-invalid-123", model: "fixture-deep", effort: "low" });
  value = await waitTurn(api, session.id);
  assert.equal(value.turns.at(-1).state, "failed");
  assert.match(value.turns.at(-1).error, /不支持/);
});


test("new conversations remember model and effort across restart without old activity or forks replacing the preference", { timeout: 20000 }, async (t) => {
  const { api, restart } = await fixture(t);
  const first = (await api("chat/sessions", {})).data;
  const old = (await api("chat/sessions", {})).data;
  const expectNew = async (model, effort) => {
    const created = await api("chat/sessions", {});
    assert.equal(created.status, 200);
    assert.deepEqual([created.data.model, created.data.effort], [model, effort]);
    return created.data;
  };
  assert.equal((await api(`chat/sessions/${first.id}`, { model: "fixture-fast", effort: "ultra" }, "PATCH")).status, 200);
  await restart();
  await expectNew("fixture-fast", "ultra");
  assert.equal((await api(`chat/sessions/${old.id}`)).data.session.effort, "", "Existing sessions keep their setting");
  assert.equal((await api(`chat/sessions/${old.id}`, { model: "fixture-fast", effort: "low" }, "PATCH")).status, 200);
  const input = { text: "EFFORT_CHECK", sourceIds: [], requestKey: "remember-effort-123" };
  await api(`chat/sessions/${first.id}/turns`, input);
  const completed = await waitTurn(api, first.id);
  assert.deepEqual(JSON.parse(completed.turns[0].answer), { model: "fixture-fast", effort: "ultra" });
  await api(`chat/sessions/${first.id}/turns`, input);
  const fork = await api(`chat/turns/${completed.turns[0].id}/fork`, { requestKey: "remember-fork-123", branchRevision: completed.session.branchRevision });
  assert.equal(fork.status, 200);
  assert.deepEqual([fork.data.model, fork.data.effort], ["fixture-fast", "ultra"]);
  await expectNew("fixture-fast", "low");
  assert.equal((await api(`chat/sessions/${old.id}`, { model: "fixture-fast", effort: null }, "PATCH")).status, 400);
  await expectNew("fixture-fast", "low");
  await api(`chat/sessions/${first.id}/turns`, { text: "SLOW", sourceIds: [], requestKey: "remember-running-123" });
  await waitTurn(api, first.id, (turn) => Boolean(turn.answer));
  assert.equal((await api(`chat/sessions/${first.id}`, { model: "fixture-fast", effort: "high" }, "PATCH")).status, 409);
  await expectNew("fixture-fast", "low");
  await api(`chat/sessions/${first.id}/stop`, {});
  await api(`chat/sessions/${old.id}`, { model: "fixture-fast", effort: "" }, "PATCH");
  await expectNew("fixture-fast", "");
  await api(`chat/sessions/${old.id}`, { model: "" }, "PATCH");
  await restart();
  await expectNew("", "");
  assert.equal((await api(`chat/sessions/${first.id}`)).data.session.effort, "ultra");
});

test("model preference write failure rolls back the conversation change", () => {
  const db = initDb(":memory:");
  try {
    const repo = createChatRepository(db), session = repo.create();
    repo.setModel(session.id, "fixture-fast", "high");
    const before = repo.session(session.id);
    db.exec("CREATE TRIGGER fail_preference BEFORE UPDATE ON chat_model_preferences BEGIN SELECT RAISE(ABORT, 'preference write failed'); END");
    assert.throws(() => repo.setModel(session.id, "fixture-deep", ""), /preference write failed/);
    assert.deepEqual(repo.session(session.id), before);
    const next = repo.create();
    assert.deepEqual([next.model, next.effort], ["fixture-fast", "high"]);
  } finally { db.close(); }
});

test("model preference migration preserves old conversations, repeats safely and rolls back failed registration", () => {
  const db = initDb(":memory:");
  try {
    const repo = createChatRepository(db), old = repo.create();
    repo.setModel(old.id, "fixture-fast", "high");
    const before = repo.session(old.id);
    db.exec("DROP TABLE chat_model_preferences; DELETE FROM wiki_schema WHERE version=22");
    db.exec("CREATE TRIGGER fail_preference_migration BEFORE INSERT ON wiki_schema WHEN NEW.version=22 BEGIN SELECT RAISE(ABORT, 'migration failed'); END");
    assert.throws(() => migrateChatModelPreference(db), /migration failed/);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='chat_model_preferences'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM wiki_schema WHERE version=22").get(), undefined);
    db.exec("DROP TRIGGER fail_preference_migration");
    migrateChatModelPreference(db);
    assert.deepEqual(repo.session(old.id), before);
    assert.equal(db.prepare("SELECT count(*) n FROM chat_model_preferences").get().n, 0, "Migration does not guess which historical choice was manual");
    repo.setModel(old.id, "fixture-fast", "ultra");
    migrateChatModelPreference(db);
    assert.equal(db.prepare("SELECT count(*) n FROM wiki_schema WHERE version=22").get().n, 1);
    assert.equal(repo.create().effort, "ultra");
  } finally { db.close(); }
});

test("effort migration preserves legacy rows, repeats safely and rolls back partial changes", () => {
  for (const fail of [false, true]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE wiki_schema(version INTEGER PRIMARY KEY); CREATE TABLE chat_sessions(id INTEGER PRIMARY KEY); CREATE TABLE chat_turns(id INTEGER PRIMARY KEY); INSERT INTO chat_sessions VALUES(1); INSERT INTO chat_turns VALUES(1)");
      if (fail) {
        db.exec("ALTER TABLE chat_turns ADD COLUMN effort TEXT NOT NULL DEFAULT ''");
        assert.throws(() => migrateChatEffort(db), /duplicate column/);
        assert.equal(db.prepare("PRAGMA table_info(chat_sessions)").all().some((c) => c.name === "effort"), false);
        assert.equal(db.prepare("SELECT count(*) n FROM wiki_schema").get().n, 0);
      } else {
        migrateChatEffort(db); migrateChatEffort(db);
        assert.equal(db.prepare("SELECT effort FROM chat_sessions WHERE id=1").get().effort, "");
        assert.equal(db.prepare("SELECT effort FROM chat_turns WHERE id=1").get().effort, "");
        assert.equal(db.prepare("SELECT count(*) n FROM wiki_schema WHERE version=20").get().n, 1);
      }
    } finally { db.close(); }
  }
});

test("chat event streams send turn deltas while streaming and full snapshots for structural changes", { timeout: 30000 }, async (t) => {
  const app = await fixture(t), { api } = app;
  const session = (await api("chat/sessions", {})).data;
  const source = (await api("elements", { body: "增量资料" })).data;
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(new URL(`api/chat/sessions/${session.id}/events`, app.url), { signal: controller.signal });
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const events = []; let buffer = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) return;
        buffer += value;
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const kind = /^event: (\w+)/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
          if (kind && data) events.push({ kind, data: JSON.parse(data) });
        }
      }
    } catch { /* aborted */ }
  })();
  const waitFor = async (predicate) => {
    const end = Date.now() + 15000;
    while (Date.now() < end) { const found = events.find(predicate); if (found) return found; await sleep(20); }
    throw new Error(`event not seen: ${JSON.stringify(events.map((e) => e.kind))}`);
  };
  assert.equal((await api(`chat/sessions/${session.id}/turns`, { text: `CONCURRENT A ${source.id}`, sourceIds: [], requestKey: "delta-stream" })).status, 200);
  const delta = await waitFor((e) => e.kind === "turn" && e.data.turn.answer === "A ready");
  assert.equal(delta.data.sessionId, session.id);
  assert.equal(delta.data.running, true);
  assert.equal(delta.data.turns, undefined, "a delta never carries the whole page");
  assert.equal(delta.data.proposals, undefined);
  assert.ok(events.some((e) => e.kind === "snapshot" && e.data.proposals.length === 1), "a new proposal is delivered as a snapshot");
  await writeFile(path.join(app.dir, "chat-workspace", String(session.id), "continue"), "done");
  const final = await waitFor((e) => e.kind === "snapshot" && e.data.turns[0]?.state === "completed");
  assert.equal(final.data.turns[0].answer, "A ready A done");
  assert.ok(final.data.revision > delta.data.revision);
  const revisions = events.map((e) => e.data.revision);
  assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b), "revisions only grow");
  controller.abort(); await pump;
});
