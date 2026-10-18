import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { chromium } from "playwright-core";
import { createServer } from "../src/server/server.js";
import { defaultOrganizationConfig } from "../src/shared/domain/organization.js";

const browserPath = [process.env.RENDERER_BROWSER_PATH, chromium.executablePath(), "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium"].find((value) => value && existsSync(value));
const options = { timeout: 60000, skip: !browserPath && "Browser required" };

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-composer-ui-"));
  const config = defaultOrganizationConfig(); config.executor.codexCli.executable = path.join(dir, "app-server.mjs");
  await writeFile(config.executor.codexCli.executable, await readFile(new URL("./fixtures/chat-app-server.txt", import.meta.url)));
  await writeFile(path.join(dir, "organization.json"), JSON.stringify(config));
  let app = await createServer({ port: 0, dataDir: dir });
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 950 } }); page.setDefaultTimeout(10000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => { await browser.close(); await app.close(); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith("wiki-composer-ui-")); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); });
  const api = async (route, body) => {
    const response = await fetch(new URL(`api/${route}`, app.url), { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  };
  return { page, api, errors, get url() { return app.url; }, async restart() { const old = app.url; await app.close(); app = await createServer({ port: 0, dataDir: dir }); assert.notEqual(app.url, old); },
    async image(index, attachment = false) {
      const bytes = await sharp({ create: { width: 16 + index, height: 16, channels: 3, background: "#758" } }).png().toBuffer();
      const response = await fetch(new URL(attachment ? "api/chat/attachments" : "api/images", app.url), { method: "POST", headers: { "x-file-name": `image-${index}.png` }, body: bytes });
      assert.ok(response.ok); return response.json();
    } };
}

async function eventually(read, predicate) {
  for (let i = 0; i < 200; i++) { const value = await read(); if (predicate(value)) return value; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error("Persisted state did not converge");
}

test("legacy new and image drafts migrate to the server and restore in a different browser origin", options, async (t) => {
  const f = await fixture(t), { page, api } = f;
  const source = await api("elements", { body: "随草稿保留的资料" }), image = await f.image(1, true), session = await api("chat/sessions", {});
  await page.goto(`${f.url}#agent?new=1`);
  await page.getByLabel("会话消息").waitFor();
  await page.evaluate(({ source, image, session }) => {
    localStorage.setItem("wikiChatDraft:/api/chat/sessions/new", JSON.stringify({ text: "  跨端口的新会话草稿\n保留换行  ", revision: Date.now(), sources: [{ id: source.id, kind: "text", label: source.body }], attachments: [image] }));
    localStorage.setItem(`wikiChatAttachments:/api/chat/sessions/${session.id}`, JSON.stringify([image]));
  }, { source, image, session });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/chat/sessions/new/draft", async (route) => { if (route.request().method() === "GET") await gate; await route.continue(); });
  await page.reload();
  assert.equal(await page.getByLabel("会话消息").count(), 0, "No writable composer is exposed before the durable draft arrives");
  release();
  await page.waitForFunction(() => document.querySelector('[aria-label="会话消息"]')?.value.includes("跨端口"));
  const expected = await eventually(() => api("chat/sessions/new/draft"), (value) => value.text.includes("跨端口"));
  assert.deepEqual(expected.attachments, [image]); assert.equal(expected.sources[0].id, source.id);
  await page.goto(`${f.url}#agent?session=${session.id}`);
  await page.getByLabel("本轮图片附件").locator("img").waitFor();
  await eventually(() => api(`chat/sessions/${session.id}`), (value) => value.session.imageDraft.attachments.length === 1);
  await f.restart();
  await page.goto(`${f.url}#agent?new=1`);
  await page.waitForFunction((text) => document.querySelector('[aria-label="会话消息"]')?.value === text, expected.text);
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("wikiChatDraft:"))), [], "The new origin restores from the server");
  await page.getByLabel("本轮选择资料").getByText(source.body, { exact: true }).waitFor();
  await page.getByLabel("本轮图片附件").locator("img").waitFor();
  await page.goto(`${f.url}#agent?session=${session.id}`);
  await page.getByLabel("本轮图片附件").locator("img").waitFor();
  assert.deepEqual(f.errors, []);
});

test("12000 Chinese characters can save, send and retry lost start and clear acknowledgements without duplicate turns", options, async (t) => {
  const f = await fixture(t), { page, api } = f;
  await page.goto(`${f.url}#agent?new=1`);
  const input = page.getByLabel("会话消息"), send = page.getByRole("button", { name: "发送消息", exact: true });
  await input.waitFor();
  const text = "长".repeat(12000), attempts = [];
  let lostStart = true, lostClear = true;
  await page.route("**/api/chat/sessions/start", async (route) => {
    attempts.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (lostStart) { lostStart = false; await route.fulfill({ status: 503, json: { error: "start acknowledgement lost" } }); }
    else await route.fulfill({ response });
  });
  await page.route("**/api/chat/sessions/new/draft", async (route) => {
    if (route.request().method() === "PUT" && route.request().postDataJSON().text === "" && lostClear) {
      const response = await route.fetch(); assert.ok(response.ok()); lostClear = false;
      await route.fulfill({ status: 503, json: { error: "clear acknowledgement lost" } });
    } else await route.continue();
  });
  for (const size of [11000, 11500, 11900, 12000]) await input.fill(text.slice(0, size));
  await eventually(() => api("chat/sessions/new/draft"), (value) => value.text === text);
  await send.click(); await page.getByRole("alert").filter({ hasText: "start acknowledgement lost" }).first().waitFor();
  let saved = await api("chat/sessions/new/draft");
  assert.equal(saved.text, text); assert.ok(saved.pending.key.length < 1000, "The retry key must not duplicate a 36 KiB message");
  const started = (await api("chat/sessions")).sessions[0];
  await eventually(() => api(`chat/sessions/${started.id}`), (value) => value.turns[0]?.state === "completed");
  await f.restart(); await page.goto(`${f.url}#agent?new=1`);
  await page.waitForFunction((text) => document.querySelector('[aria-label="会话消息"]')?.value === text, text);
  await send.click(); await page.getByRole("alert").filter({ hasText: "clear acknowledgement lost" }).first().waitFor();
  assert.equal(await input.inputValue(), text);
  await send.click();
  await page.locator('.chat-process[data-state="completed"]').waitFor({ state: "attached" });
  assert.equal(await input.inputValue(), "");
  const sessions = (await api("chat/sessions")).sessions;
  assert.equal(sessions.length, 1); assert.equal((await api(`chat/sessions/${sessions[0].id}`)).turns.length, 1);
  assert.equal(new Set(attempts.map((attempt) => attempt.requestKey)).size, 1);
  saved = await api("chat/sessions/new/draft"); assert.equal(saved.text, ""); assert.equal(saved.pending, undefined);
  assert.deepEqual(f.errors, []);
});

test("picker and paste share the eight-image budget while retaining space for text sources", options, async (t) => {
  const f = await fixture(t), { page, api } = f, images = [];
  for (let i = 0; i < 9; i++) images.push(await f.image(i));
  const text = await api("elements", { body: "第九份可以是文字" });
  await page.goto(`${f.url}#agent?new=1`);
  await page.getByRole("button", { name: "选择资料", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "选择会话资料" });
  for (let i = 0; i < 8; i++) await picker.getByRole("button", { name: images[i].image.originalName, exact: true }).click();
  assert.equal(await picker.getByRole("button", { name: images[8].image.originalName, exact: true }).isDisabled(), true);
  await picker.getByRole("button", { name: text.body, exact: true }).click();
  await picker.getByText(/当前还可选择 0 张/).waitFor();
  await page.getByRole("button", { name: "完成选择", exact: true }).click();
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#123" } }).png().toBuffer();
  await page.getByLabel("会话消息").evaluate((input, bytes) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(bytes)], "paste.png", { type: "image/png" }));
    input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, [...png]);
  await page.getByRole("alert").filter({ hasText: "本轮图片合计最多 8 张" }).waitFor();
  assert.equal(await page.getByLabel("本轮图片附件").count(), 0);
  assert.equal((await api("chat/sessions")).sessions.length, 0);
  assert.deepEqual(f.errors, []);
});

test("an existing conversation replays a lost send acknowledgement after both drafts were cleared", options, async (t) => {
  const f = await fixture(t), { page, api } = f;
  const session = await api("chat/sessions", {}), attachment = await f.image(1, true);
  const saved = await fetch(new URL(`api/chat/sessions/${session.id}/image-draft`, f.url), {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ attachments: [attachment], revision: Date.now() }),
  });
  assert.ok(saved.ok);
  await page.goto(`${f.url}#agent?session=${session.id}`);
  await page.getByLabel("本轮图片附件").locator("img").waitFor();
  const input = page.getByLabel("会话消息"), send = page.getByRole("button", { name: "发送消息", exact: true });
  await input.fill("已接收但回执丢失的图片消息");
  const attempts = [];
  await page.route(`**/api/chat/sessions/${session.id}/turns`, async (route) => {
    attempts.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (attempts.length === 1) await route.fulfill({ status: 503, json: { error: "turn acknowledgement lost" } });
    else await route.fulfill({ response });
  });
  await send.click();
  await page.getByRole("alert").filter({ hasText: "turn acknowledgement lost" }).first().waitFor();
  await page.locator('.chat-process[data-state="completed"]').waitFor({ state: "attached" });
  const accepted = await api(`chat/sessions/${session.id}`);
  assert.equal(accepted.session.draft.text, "");
  assert.deepEqual(accepted.session.imageDraft.attachments, []);
  assert.equal(await input.inputValue(), "已接收但回执丢失的图片消息");
  await send.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="会话消息"]')?.value === "");
  assert.equal(await page.getByLabel("本轮图片附件").count(), 0);
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
  assert.equal((await api(`chat/sessions/${session.id}`)).turns.length, 1);
  assert.deepEqual(f.errors, []);
});
