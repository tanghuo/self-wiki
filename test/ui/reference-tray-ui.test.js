import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "../helpers/authenticatedServer.js";
import { resolveBrowserPath } from "../resolveBrowserPath.js";
import sharp from "sharp";
import { createServer, fetch } from "../helpers/authenticatedServer.js";
import { chooseOption, selectedValue, openDetailMenu } from "../ui-select.js";

const browserPath = resolveBrowserPath();
const options = { timeout: 60000, skip: !browserPath && "Browser required" };

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-reference-ui-"));
  let app, context, page;
  const errors = [];
  async function launch() {
    app = await createServer({ port: 0, dataDir: path.join(dir, "data") });
    context = await chromium.launchPersistentContext(path.join(dir, "profile"), {
      executablePath: browserPath, headless: true, viewport: { width: 1360, height: 950 },
    });
    page = context.pages()[0]; page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => errors.push(error.message));
  }
  t.after(async () => {
    await context?.close(); await app?.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("wiki-reference-ui-"));
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    assert.deepEqual(errors, []);
  });
  await launch();
  return {
    get page() { return page; }, get app() { return app; },
    async restart() { await context.close(); await app.close(); await launch(); },
    async api(route, method = "GET", body) {
      const response = await fetch(new URL(`api/${route}`, app.url), { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
    },
  };
}

async function addCard(page, id) {
  await page.locator(`[data-element-id="${id}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "放进资料篮", exact: true }).click();
}
const trayFor = (page) => page.getByRole("complementary", { name: "资料篮", exact: true });
const savedIds = (page) => page.evaluate(() => JSON.parse(decodeURIComponent(document.cookie.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith("selfWikiReferences=")).split("=")[1])).ids);

test("usage records successful copies and new tray additions, with a quiet statistics entry", options, async (t) => {
  const fixture = await setup(t), page = fixture.page;
  const note = await fixture.api("elements", "POST", { body: "使用统计测试文字" });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { if (window.failCopy) throw new Error("denied"); } } });
  });
  await page.goto(`${fixture.app.url}#wiki`);
  const recorded = () => page.waitForResponse((r) => r.url().endsWith(`/elements/${note.id}/usage`) && r.status() === 200);
  await Promise.all([recorded(), addCard(page, note.id)]);
  await addCard(page, note.id);
  await page.reload();
  await trayFor(page).getByText(note.body, { exact: true }).waitFor();
  assert.equal((await fixture.api("element-usage")).summary.references, 1);
  await trayFor(page).getByRole("button", { name: `移除资料 ${note.id}`, exact: true }).click();
  await Promise.all([recorded(), addCard(page, note.id)]);
  await page.locator(`[data-element-id="${note.id}"]`).click({ button: "right" });
  await Promise.all([recorded(), page.getByRole("menuitem", { name: "复制", exact: true }).click()]);
  await page.locator(`[data-element-id="${note.id}"]`).click();
  await Promise.all([recorded(), page.getByRole("button", { name: "复制文字", exact: true }).click()]);
  await page.evaluate(() => { window.failCopy = true; });
  await page.getByRole("button", { name: "复制文字", exact: true }).click();
  await page.getByText("复制失败，请选中文字后手动复制", { exact: true }).waitFor();
  const stats = await fixture.api("element-usage");
  assert.deepEqual(stats.summary, { total: 4, copies: 2, references: 2, elements: 1 });
  assert.ok(stats.elements[0].lastUsedAt);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "查看内容使用统计" }).isVisible(), false);
  await page.getByText("本地记录", { exact: true }).click();
  await page.getByRole("button", { name: "查看内容使用统计" }).click();
  const panel = page.getByRole("dialog", { name: "内容使用统计", exact: true });
  await panel.getByRole("table", { name: "常用内容排行" }).waitFor();
  assert.match(await panel.textContent(), /复制 2 次 · 引用 2 次/);
  await page.screenshot({ path: ".local/element-usage.png" });
  await panel.getByLabel("时间范围", { exact: true }).selectOption("custom");
  await panel.getByLabel("开始时间").fill("2000-01-01T00:00");
  await panel.getByLabel("结束时间").fill("2000-01-02T00:00");
  await panel.getByText("这个时段还没有对应的使用记录。", { exact: true }).waitFor();
});

test("text usage sort ranks combined usage, persists selection, and refreshes after copying", options, async (t) => {
  const fixture = await setup(t), page = fixture.page;
  const frequent = await fixture.api("elements", "POST", { body: "常用文字" });
  const newer = await fixture.api("elements", "POST", { body: "新文字" });
  await fixture.api(`elements/${frequent.id}/usage`, "POST", { action: "copy" });
  await fixture.api(`elements/${frequent.id}/usage`, "POST", { action: "reference" });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => {} } });
  });
  await page.goto(`${fixture.app.url}#wiki`);
  await page.getByRole("button", { name: "文字", exact: true }).click();
  const firstId = () => page.locator(".wiki-card[data-element-id]").first().getAttribute("data-element-id");
  await page.locator(`.wiki-card[data-element-id="${newer.id}"]`).waitFor();
  assert.equal(await firstId(), String(newer.id));
  await chooseOption(page, "文字排序", "usage");
  await page.waitForFunction((id) => document.querySelector(".wiki-card[data-element-id]")?.dataset.elementId === String(id), frequent.id);
  await page.reload();
  await page.getByRole("button", { name: "文字", exact: true }).click();
  assert.equal(await selectedValue(page, "文字排序"), "usage");
  await page.waitForFunction((id) => document.querySelector(".wiki-card[data-element-id]")?.dataset.elementId === String(id), frequent.id);
  for (let i = 0; i < 3; i++) {
    await page.locator(`.wiki-card[data-element-id="${newer.id}"]`).click({ button: "right" });
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith(`/elements/${newer.id}/usage`) && response.ok()),
      page.getByRole("menuitem", { name: "复制", exact: true }).click(),
    ]);
  }
  await page.waitForFunction((id) => document.querySelector(".wiki-card[data-element-id]")?.dataset.elementId === String(id), newer.id);
  await page.getByLabel("搜索内容", { exact: true }).fill("常用");
  await page.locator(`.wiki-card[data-element-id="${newer.id}"]`).waitFor({ state: "hidden" });
  assert.equal(await firstId(), String(frequent.id));
});

test("detail image menu adds references and the tray survives browser and server restarts on a new port", options, async (t) => {
  const fixture = await setup(t);
  let page = fixture.page;
  const note = await fixture.api("elements", "POST", { body: "重启前的参考文字" });
  const png = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#bca5ad" } }).png().toBuffer();
  const response = await fetch(new URL("api/images", fixture.app.url), { method: "POST", headers: { "x-file-name": "reference.png" }, body: png });
  assert.ok(response.ok); const image = await response.json();
  await page.goto(`${fixture.app.url}#wiki`);
  await addCard(page, note.id);
  await page.locator(`[data-element-id="${image.id}"]`).click();
  const original = page.locator(".wiki-original img");
  await original.evaluate((node) => node.decode());
  await original.click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制", exact: true }).waitFor();
  await page.getByRole("menuitem", { name: "放进资料篮", exact: true }).click();
  let tray = trayFor(page);
  assert.equal(await tray.locator("li").count(), 2);
  await original.click({ button: "right" });
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "hidden" });
  await original.click({ button: "right" });
  await page.getByRole("menuitem", { name: "放进资料篮", exact: true }).click();
  assert.equal(await tray.locator("li").count(), 2, "Repeated additions are deduplicated");
  await tray.getByRole("button", { name: /资料篮/ }).click();
  await fixture.api(`elements/${note.id}`, "PATCH", { body: "重启后读取最新文字" });
  const previousUrl = fixture.app.url;
  await fixture.restart();
  assert.notEqual(fixture.app.url, previousUrl);
  page = fixture.page; tray = trayFor(page);
  await page.goto(`${fixture.app.url}#wiki`);
  await page.waitForFunction(() => document.querySelector('[aria-label="资料篮"]')?.getAttribute("aria-busy") === "false");
  assert.equal(await tray.getByRole("button", { name: /资料篮/ }).getAttribute("aria-expanded"), "false");
  await tray.getByRole("button", { name: /资料篮/ }).click();
  await tray.getByText("重启后读取最新文字", { exact: true }).waitFor();
  await tray.getByText("reference.png", { exact: true }).waitFor();
  assert.deepEqual(await savedIds(page), [note.id, image.id]);
  await tray.locator("img").evaluate((node) => node.decode());
  await tray.getByRole("button", { name: "预览资料：reference.png", exact: true }).click();
  await page.locator(".wiki-original img").click({ button: "right" });
  await page.screenshot({ path: ".local/reference-detail-menu.png" });
  await page.keyboard.press("Escape");
  await tray.getByRole("button", { name: `移除资料 ${note.id}`, exact: true }).click();
  await page.reload();
  await tray.getByText("reference.png", { exact: true }).waitFor();
  assert.deepEqual(await savedIds(page), [image.id]);
  await tray.getByRole("button", { name: "清空", exact: true }).click();
  await page.reload();
  await page.getByRole("heading", { name: "全部内容", exact: true }).waitFor();
  assert.equal(await tray.count(), 0);
  assert.deepEqual(await savedIds(page), []);
});

test("reference recovery retains temporary failures and respects concurrent additions and removals", options, async (t) => {
  const fixture = await setup(t), page = fixture.page;
  const notes = [];
  for (let i = 0; i < 4; i++) notes.push(await fixture.api("elements", "POST", { body: `恢复测试 ${i}` }));
  await page.goto(`${fixture.app.url}#wiki`);
  for (const note of notes.slice(0, 3)) await addCard(page, note.id);
  await fixture.api(`elements/${notes[2].id}`, "DELETE");
  let release, fail = true;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  await page.route(`**/api/elements/${notes[0].id}`, async (route) => {
    if (!fail) return route.continue();
    await gate;
    return route.fulfill({ status: 503, json: { error: "暂时不可用" } });
  });
  await page.route(`**/api/elements/${notes[1].id}`, async (route) => { await gate; return route.continue(); });
  await page.reload();
  const tray = trayFor(page);
  await tray.getByRole("button", { name: `移除资料 ${notes[1].id}`, exact: true }).click();
  await addCard(page, notes[3].id);
  release();
  await tray.getByRole("alert").filter({ hasText: "部分资料暂时无法读取，列表已保留，请重试。" }).waitFor();
  assert.equal(await tray.locator("li").count(), 2);
  assert.deepEqual(await savedIds(page), [notes[0].id, notes[3].id], "A late successful response must not restore a removed reference");
  assert.equal(await tray.getByRole("button", { name: "带着资料问 Agent", exact: true }).isDisabled(), true);
  fail = false;
  await tray.getByRole("button", { name: "重试", exact: true }).click();
  await tray.getByText(notes[0].body, { exact: true }).waitFor();
  assert.equal(await tray.getByRole("alert").count(), 0);
  assert.equal(await tray.getByRole("button", { name: "带着资料问 Agent", exact: true }).isEnabled(), true);
  await page.reload();
  await tray.getByText(notes[3].body, { exact: true }).waitFor();
  assert.deepEqual(await savedIds(page), [notes[0].id, notes[3].id]);
});

test("editing and deleting Wiki content invalidates already loaded references", options, async (t) => {
  const fixture = await setup(t), page = fixture.page;
  const note = await fixture.api("elements", "POST", { body: "参考修改前" });
  const other = await fixture.api("elements", "POST", { body: "保留的参考" });
  await page.goto(`${fixture.app.url}#wiki`);
  await addCard(page, note.id); await addCard(page, other.id);
  await page.locator(`[data-element-id="${note.id}"]`).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑内容", exact: true });
  await editor.getByRole("textbox", { name: "文字", exact: true }).fill("参考修改后的正文");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  const tray = trayFor(page);
  await tray.getByText("参考修改后的正文", { exact: true }).waitFor();
  await openDetailMenu(page);
  await page.getByRole("button", { name: "移入回收站", exact: true }).click();
  await tray.getByRole("button", { name: `移除资料 ${note.id}`, exact: true }).waitFor({ state: "hidden" });
  assert.deepEqual(await savedIds(page), [other.id]);
  await tray.getByText(other.body, { exact: true }).waitFor();
});

test("entering chat revalidates complete references and a transient failure can be retried without consuming them", options, async (t) => {
  const fixture = await setup(t), page = fixture.page;
  const note = await fixture.api("elements", "POST", { body: "进入前的旧参考" });
  const deleted = await fixture.api("elements", "POST", { body: "进入前已删除的参考" });
  await page.goto(`${fixture.app.url}#wiki`);
  await addCard(page, note.id); await addCard(page, deleted.id);
  await fixture.api(`elements/${note.id}`, "PATCH", { body: "进入时读取最新参考" });
  await fixture.api(`elements/${deleted.id}`, "DELETE");
  let fail = true, requests = 0;
  await page.route(`**/api/elements/${note.id}`, async (route) => {
    requests++;
    return fail ? route.fulfill({ status: 503, json: { error: "暂时不可用" } }) : route.continue();
  });
  const tray = trayFor(page);
  await tray.getByRole("button", { name: "带着资料问 Agent", exact: true }).click();
  await tray.getByRole("alert").filter({ hasText: "部分资料暂时无法读取，列表已保留，请重试。" }).waitFor();
  assert.equal(new URL(page.url()).hash, "#wiki", "A failed validation must not navigate or consume references");
  assert.deepEqual(await savedIds(page), [note.id], "Missing content is removed while transient failures remain");
  assert.equal(await tray.getByRole("button", { name: "带着资料问 Agent", exact: true }).isDisabled(), true);
  fail = false;
  await tray.getByRole("button", { name: "重试", exact: true }).click();
  await tray.getByText("进入时读取最新参考", { exact: true }).waitFor();
  await tray.getByRole("button", { name: "带着资料问 Agent", exact: true }).click();
  await page.locator('.chat-selected [title="进入时读取最新参考"]').waitFor();
  assert.equal(requests, 3, "Entry must revalidate again after a successful retry");
  assert.deepEqual(await savedIds(page), []);
  assert.equal(await page.locator(".chat-selected > span").count(), 1);
});

test("renaming a confirmed relation through vocabulary settings preserves both endpoint groups", options, async (t) => {
  const fixture = await setup(t), page = fixture.page;
  const source = await fixture.api("elements", "POST", { body: "别名分组的原始参考" });
  const output = await fixture.api("elements", "POST", { body: "别名分组的后续作品" });
  await fixture.api("relations", "POST", { sourceId: output.id, targetId: source.id, name: "参考了", direction: "forward", reverseName: "被参考" });
  await page.goto(`${fixture.app.url}#wiki`);
  await page.locator(`[data-element-id="${output.id}"]`).click();
  const sources = page.getByRole("region", { name: "创作来源", exact: true });
  await sources.getByText("参考了", { exact: true }).waitFor();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "名称与别名 统一标签、关联叫法" }).click();
  await page.getByRole("button", { name: "关联名称", exact: true }).click();
  await page.getByLabel("名称对的类型").selectOption("forward");
  await page.getByLabel("别名", { exact: true }).fill("参考了");
  await page.getByLabel("主名称", { exact: true }).fill("借鉴了");
  await page.getByLabel("别名的反向名称", { exact: true }).fill("被参考");
  await page.getByLabel("主名称的反向名称", { exact: true }).fill("被借鉴");
  await page.getByRole("button", { name: "预览归一", exact: true }).click();
  await page.getByRole("button", { name: "应用归一", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "已统一名称" }).waitFor();
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await sources.getByText("借鉴了", { exact: true }).waitFor();
  await sources.getByRole("button", { name: `打开内容：${source.body}`, exact: true }).click();
  const incoming = page.getByRole("region", { name: "被参考", exact: true });
  await incoming.getByText("被借鉴", { exact: true }).waitFor();
  await incoming.getByRole("button", { name: `打开内容：${output.body}`, exact: true }).waitFor();
  assert.equal(await sources.count(), 0);
});
