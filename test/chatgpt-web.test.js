import { runInNewContext } from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { generateChatgptWeb, probeChatgptWeb } from "../src/agent/executors/chatgptWeb.js";
import { defaultOrganizationConfig, organizationConfig } from "../src/shared/domain/organization.js";
import { createChatImageExecutor } from "../src/server/application/chatImageExecutor.js";
import { initDb } from "../src/server/data/sqlite.js";
import { createChatRepository } from "../src/server/data/chatRepository.js";

const python = process.env.TEST_PYTHON || "python";
const pythonReady = spawnSync(python, ["--version"], { windowsHide: true }).status === 0;
const webTest = (name, fn) => test(name, { skip: !pythonReady && "Python 3.10+ required", timeout: 45000 }, fn);
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-web-image-"));
  const config = { python, browser: path.join(root, "browser 中文.mjs"), profile: "relay" };
  await writeFile(config.browser, await readFile(new URL("./fixtures/chrome-use.txt", import.meta.url)));
  t.after(async () => {
    const pid = await readFile(path.join(root, "daemon-pid"), "utf8").catch(() => null);
    if (pid) { try { process.kill(Number(pid)); } catch (error) { if (error.code !== "ESRCH") throw error; } }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("wiki-web-image-")); await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { root, config, commands: async () => (await readFile(path.join(root, "browser-commands.jsonl"), "utf8")).trim().split("\n").map(JSON.parse),
    generate: (value = {}, extra = {}) => generateChatgptWeb({ prompt: "蓝色纸鹤 ` $() 中文", referencePaths: [], size: "auto", ...value }, { config, workspace: root, ...extra }) };
}
test("existing configs default to Codex images and validate new backend options", () => {
  const old = defaultOrganizationConfig(); delete old.imageGeneration;
  assert.equal(organizationConfig(old).imageGeneration.executor, "codex-cli");
  assert.throws(() => organizationConfig({ ...old, imageGeneration: { executor: "unknown" } }));
  const native = createChatImageExecutor(organizationConfig(old).imageGeneration);
  assert.equal(native.mode, "native");
  assert.equal(native.generate, undefined, "Native generation belongs to the model session");
  assert.equal(native.tool, undefined);
  assert.throws(() => createChatImageExecutor({ executor: "unknown" }), /不支持/);
});
webTest("executor selection snapshots settings and binds direct images to their own conversation", async (t) => {
  const f = await fixture(t), db = initDb(":memory:");
  t.after(() => db.close());
  const repo = createChatRepository(db), session = repo.create("images"), other = repo.create("other");
  const config = { executor: "codex-cli", chatgptWeb: f.config };
  const executor = createChatImageExecutor(config, { repo, sessionId: session.id, direct: true });
  config.chatgptWeb.browser = "changed-after-turn-start";
  assert.equal(executor.id, "chatgpt-web");
  assert.equal(executor.directInput, true);
  assert.equal((await executor.probe(f.root)).available, true);
  const events = [];
  const result = await executor.generate({ prompt: "  literal prompt\n", referencePaths: [], size: "auto" }, {
    workspace: f.root, verbatim: true, onProgress: (event) => events.push(event),
  });
  assert.ok(result.bytes.length);
  assert.equal((await f.commands()).find((command) => command.args[0] === "keyboard").args[2], "  literal prompt\n");
  assert.equal(repo.webConversation(session.id, 0), "https://chatgpt.com/c/fixture");
  assert.equal(repo.webConversation(other.id, 0), "");
  assert.ok(events.some((event) => event.type === "progress" && event.message === "正在打开 ChatGPT 页面"));
  assert.equal(events.find((event) => event.type === "metadata").metadata.conversationUrl, "https://chatgpt.com/c/fixture");
});
webTest("web executor probes, generates through upstream and preserves literal prompts and conversations", async (t) => {
  const f = await fixture(t), events = [];
  assert.equal((await probeChatgptWeb(f.config, f.root)).available, true);
  const result = await f.generate({}, { onProgress: (event) => events.push(event) });
  assert.ok(result.bytes.subarray(1, 4).equals(Buffer.from("PNG")));
  assert.deepEqual(await readFile(result.savedPath), result.bytes);
  const commands = await f.commands(), typed = commands.find((c) => c.args[0] === "keyboard").args[2];
  assert.equal(typed, events.find((e) => e.type === "prepared_prompt").prompt);
  assert.equal(events.filter((e) => e.type === "submitted").length, 1);
  assert.ok(commands.filter((c) => c.args[0] === "eval").every((c) => c.args.includes("--json")));
  assert.ok(typed.includes("蓝色纸鹤 ` $() 中文"));
  assert.ok(commands.some((c) => c.args[0] === "close"));
  assert.equal(commands.some((c) => c.args.some((s) => s.includes("PATCH"))), false);
});
webTest("browser daemons inheriting output handles cannot stall the Python caller", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "browser-mode"), "inherited");
  assert.ok((await f.generate()).bytes.length);
  const pid = Number(await readFile(path.join(f.root, "daemon-pid"), "utf8"));
  process.kill(pid, 0); // generation finished while the long-lived handle owner is still alive
});
webTest("verbatim web requests type the exact text without instructions or size suffixes", async (t) => {
  const f = await fixture(t), events = [];
  const prompt = "  请按参考图生成海报。\n文案：原样保留 ` $() 与空格  \n";
  await f.generate({ prompt, size: "1536x1024" }, { verbatim: true, onProgress: (event) => events.push(event) });
  assert.equal(events.find((event) => event.type === "prepared_prompt").prompt, prompt);
  assert.equal((await f.commands()).find((command) => command.args[0] === "keyboard").args[2], prompt);
});
webTest("unconfirmed submission stops before polling, and JSON command errors are propagated", async (t) => {
  const f = await fixture(t), events = [];
  await writeFile(path.join(f.root, "browser-mode"), "unsent");
  await assert.rejects(f.generate({}, { onProgress: (event) => events.push(event) }), /未能确认网页收到提示词/);
  assert.equal(events.some((e) => e.type === "submitted"), false);
  assert.equal((await f.commands()).some((c) => c.args[0] === "eval" && c.args[1].includes("new Set(")), false);
  await writeFile(path.join(f.root, "browser-mode"), "command-error");
  await assert.rejects(f.generate(), /fixture browser failed/);
});
webTest("page load failures stop waiting with the original URL and legacy eval values remain supported", async (t) => {
  const f = await fixture(t), events = [];
  await writeFile(path.join(f.root, "browser-mode"), "page-error");
  await assert.rejects(f.generate({}, { onProgress: (event) => events.push(event) }), /页面内容加载失败.*https:\/\/chatgpt.com\/c\/fixture/);
  assert.equal(events.filter((event) => event.type === "submitted").length, 1);
  await writeFile(path.join(f.root, "browser-mode"), "legacy");
  assert.ok((await f.generate()).bytes.length);
});
webTest("every reference must upload before submitting an edit", async (t) => {
  const f = await fixture(t);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  for (const name of ["原图.png", "参考.png"]) await writeFile(path.join(f.root, name), png);
  await writeFile(path.join(f.root, "browser-mode"), "partial");
  await assert.rejects(f.generate({ referencePaths: ["原图.png", "参考.png"] }), /未全部上传成功/);
  assert.equal((await f.commands()).some((c) => c.args[0] === "keyboard"), false);
});
webTest("missing browser, missing relay, quota and outside references fail without fallback", async (t) => {
  const f = await fixture(t);
  assert.equal((await probeChatgptWeb({ ...f.config, browser: "definitely-missing-chrome-use" }, f.root)).available, false);
  await writeFile(path.join(f.root, "browser-mode"), "disconnected");
  await assert.rejects(f.generate(), /扩展尚未连接/);
  assert.equal((await f.commands()).some((c) => c.args[0] === "open"), false);
  await writeFile(path.join(f.root, "browser-mode"), "limited");
  await assert.rejects(f.generate(), /rate-limited/);
  await assert.rejects(f.generate({ referencePaths: [f.config.browser + "/../.."] }), /当前会话工作目录/);
  assert.equal((await f.commands()).some((c) => c.args[0] === "keyboard"), false);
});
webTest("active and queued calls cancel without submitting the queued prompt", async (t) => {
  const f = await fixture(t), active = new AbortController(), queued = new AbortController();
  await writeFile(path.join(f.root, "browser-mode"), "wait");
  let started; const ready = new Promise((r) => { started = r; });
  const first = f.generate({}, { signal: active.signal, onProgress: (e) => { if (e.message === "ChatGPT 正在生成图片") started(); } });
  const firstCheck = assert.rejects(first, /已停止/);
  await Promise.race([ready, sleep(12000).then(() => { throw new Error("Browser did not start"); })]);
  const second = f.generate({ prompt: "must not submit" }, { signal: queued.signal });
  const secondCheck = assert.rejects(second, /取消排队/);
  queued.abort(); active.abort(); await Promise.all([firstCheck, secondCheck]);
  assert.equal((await f.commands()).filter((c) => c.args[0] === "keyboard").length, 1);
  await writeFile(path.join(f.root, "browser-mode"), "normal");
  assert.ok((await f.generate()).bytes.length, "cancellation releases the queue");
});

webTest("web continuity opens its saved URL, reports binding before results and refuses missing or busy conversations", async (t) => {
  const f = await fixture(t), events = [], url = "https://chatgpt.com/c/fixture";
  let saved = "";
  const continuation = { read: () => url, save: (value) => { saved = value; } };
  await f.generate({}, { continuation, onProgress: e => events.push(e) });
  assert.equal((await f.commands()).find(c => c.args[0] === "open").args[1], url);
  assert.equal(events.find(e => e.type === "metadata").metadata.conversationUrl, url);
  assert.equal(saved, url);
  const commands = await f.commands();
  const confirm = commands.find(c => c.args[0] === "eval" && c.args[1].includes("const expected = normalize(")).args[1];
  const polling = commands.find(c => c.args[0] === "eval" && c.args[1].includes("new Set(")).args[1];
  const prompt = commands.find(c => c.args[0] === "keyboard").args[2];
  const oldUser = { order: 1, innerText: prompt }, newUser = { order: 4, innerText: prompt };
  for (const user of [oldUser, newUser]) user.compareDocumentPosition = node => node.order > user.order ? 4 : 2;
  const oldAssistant = { order: 2, textContent: "old reply" }, newAssistant = { order: 6, textContent: "new reply" };
  const oldImage = { order: 3, src: "https://chatgpt.com/backend-api/estuary/content?id=old", closest: () => null };
  const newImage = { order: 7, src: "https://chatgpt.com/backend-api/estuary/content?id=new", closest: () => null };
  let users = [oldUser], assistants = [oldAssistant], images = [oldImage];
  const context = { Node: { DOCUMENT_POSITION_FOLLOWING: 4 }, location: { href: url }, document: {
    body: { innerText: "" }, querySelector: selector => selector === "main" ? {} : null,
    querySelectorAll: selector => selector === '[data-message-author-role="user"]' ? users
      : selector === '[data-message-author-role="assistant"]' ? assistants : selector === "main img" ? images : [],
  } };
  assert.equal(JSON.parse(runInNewContext(confirm, context)), false, "same prompt in an old turn is not confirmation");
  users = [oldUser, newUser];
  assert.equal(JSON.parse(runInNewContext(confirm, context)), true);
  let state = JSON.parse(runInNewContext(polling, context));
  assert.equal(state.last, null, "an old image loading late is not this turn's output");
  assert.equal(state.assistant, false, "an old reply must not end a new request early");
  images.push(newImage); assistants.push(newAssistant);
  state = JSON.parse(runInNewContext(polling, context));
  assert.equal(state.last, newImage.src); assert.equal(state.atext, "new reply");
  const before = (await f.commands()).filter(c => c.args[0] === "keyboard").length;
  for (const mode of ["missing-conversation", "busy-conversation"]) {
    await writeFile(path.join(f.root, "browser-mode"), mode);
    await assert.rejects(f.generate({}, { continuation }), /未发送本轮消息/);
  }
  assert.equal((await f.commands()).filter(c => c.args[0] === "keyboard").length, before);
  await assert.rejects(f.generate({}, { continuation: { read: () => "https://example.com/c/fixture" } }), /无效的网页会话地址/);
});

webTest("a submitted web failure retains the conversation URL for the next turn", async (t) => {
  const f = await fixture(t), events = []; let saved = "";
  const continuation = { read: () => saved, save: (value) => { saved = value; } };
  await writeFile(path.join(f.root, "browser-mode"), "page-error");
  await assert.rejects(f.generate({}, { continuation, onProgress: e => events.push(e) }), /页面内容加载失败/);
  const url = events.find(e => e.type === "metadata").metadata.conversationUrl;
  assert.equal(url, "https://chatgpt.com/c/fixture");
  assert.equal(saved, url, "A failed request still persists its conversation binding");
  await writeFile(path.join(f.root, "browser-mode"), "normal");
  await f.generate({}, { continuation });
  assert.equal((await f.commands()).filter(c => c.args[0] === "open").at(-1).args[1], url);
});

webTest("queued web calls resolve the binding after the preceding call saves its new URL", async (t) => {
  const f = await fixture(t); let saved = "";
  const options = { continuation: { read: () => saved, save: (url) => { saved = url; } } };
  await Promise.all([f.generate({ prompt: "first image" }, options), f.generate({ prompt: "second image" }, options)]);
  assert.deepEqual((await f.commands()).filter(c => c.args[0] === "open").map(c => c.args[1]), ["https://chatgpt.com/", "https://chatgpt.com/c/fixture"]);
});
