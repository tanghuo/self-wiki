import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright-core";
import { resolveBrowserPath } from "../resolveBrowserPath.js";
import sharp from "sharp";
import { createServer } from "../../src/server/server.js";
import { chooseOption, selectedValue, openViewMenu, closeViewMenu, openDetailMenu, openRelationAdvanced } from "../ui-select.js";

const browserPath = resolveBrowserPath();
async function setup(t, { realClipboard = false } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wiki-ui-"));
  const app = await createServer({ port: 0, dataDir });
  let browser;
  t.after(async () => {
    await browser?.close(); await app.close();
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("wiki-ui-"));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
  });
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  if (!realClipboard) await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => { window.copiedText = text; } } });
  });
  const create = async (body) => (await fetch(new URL("api/elements", app.url), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }),
  })).json();
  await page.goto(`${app.url}#wiki`);
  return { page, app, create };
}

const options = { timeout: 60000, skip: !browserPath && "Browser required" };

test("list cards show successful copies and refresh with the default sorting", options, async (t) => {
  const { page, create } = await setup(t);
  const element = await create("复制次数展示");
  await page.reload();
  const card = page.locator(`article[data-element-id="${element.id}"]`);
  await card.waitFor();
  assert.equal(await card.locator(".wiki-card-copy-count").count(), 0);
  await card.getByRole("button", { name: `打开内容：${element.body}`, exact: true }).click();
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith(`/elements/${element.id}/usage`) && response.ok()),
    page.getByRole("button", { name: "复制文字", exact: true }).click(),
  ]);
  await page.getByRole("region", { name: "内容详情", exact: true }).getByRole("button", { name: "返回", exact: true }).click();
  await card.locator(".wiki-card-copy-count").getByText("复制 1 次", { exact: true }).waitFor();
});

test("material actions, batch editing and remembered filtering work across categories", options, async (t) => {
  const { page, app, create } = await setup(t);
  const a = await create("常用人物设定"), b = await create("待整理产物");
  await page.reload();
  const card = (id) => page.locator(`article[data-element-id="${id}"]`);
  await card(a.id).click({ button: "right" });
  await page.getByRole("menuitem", { name: "设为资料", exact: true }).click();
  await card(a.id).locator(".wiki-material-badge").waitFor();
  await openViewMenu(page);
  await page.getByRole("checkbox", { name: "仅看资料", exact: true }).check();
  await card(b.id).waitFor({ state: "detached" });
  await page.getByRole("complementary", { name: "内容导航" }).getByRole("button", { name: "文字", exact: true }).click();
  await openViewMenu(page);
  assert.equal(await page.getByRole("checkbox", { name: "仅看资料", exact: true }).isChecked(), true);
  await page.reload();
  await openViewMenu(page);
  assert.equal(await page.getByRole("checkbox", { name: "仅看资料", exact: true }).isChecked(), true);
  await card(a.id).locator(".wiki-card-open").click();
  const detail = page.getByRole("region", { name: "内容详情", exact: true });
  await detail.getByRole("checkbox", { name: "用作资料", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "已取消资料标记" }).waitFor();
  await detail.getByRole("button", { name: "返回", exact: true }).click();
  await card(a.id).waitFor({ state: "detached" });
  await openViewMenu(page);
  await page.getByRole("checkbox", { name: "仅看资料", exact: true }).uncheck();
  await page.getByLabel("更多操作", { exact: true }).click();
  await page.getByRole("button", { name: "批量管理", exact: true }).click();
  const batch = page.getByRole("region", { name: "批量管理", exact: true });
  await batch.getByRole("button", { name: "全选已加载内容", exact: true }).click();
  await batch.getByRole("button", { name: "设为资料", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "已设为资料" }).waitFor();
  await page.locator(".wiki-material-badge").nth(1).waitFor();
  assert.equal(await page.locator(".wiki-material-badge").count(), 2);
  await batch.getByRole("button", { name: "全选已加载内容", exact: true }).click();
  await batch.getByRole("button", { name: "取消资料标记", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "已取消资料标记" }).waitFor();
  await page.locator(".wiki-material-badge").first().waitFor({ state: "detached" });
  const res = await fetch(new URL("api/elements/material", app.url), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [a.id, 999999], material: true }) });
  assert.equal(res.status, 409);
  assert.equal((await (await fetch(new URL(`api/elements/${a.id}`, app.url))).json()).material, false);
});

test("new mixed content can be saved as materials without changing the category navigation", options, async (t) => {
  const { page, app } = await setup(t);
  await page.locator(".wiki-page-header").getByRole("button", { name: "新增内容", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新增内容", exact: true });
  const material = dialog.getByRole("checkbox", { name: "本次内容用作资料", exact: true });
  assert.equal(await material.isChecked(), false);
  await material.check();
  await dialog.getByLabel("文字", { exact: true }).fill("可反复使用的人物设定");
  const image = await sharp({ create: { width: 120, height: 160, channels: 3, background: "#bca5ad" } }).png().toBuffer();
  await page.getByLabel("导入图片或视频文件").setInputFiles([
    { name: "人物参考.png", mimeType: "image/png", buffer: image },
    { name: "动作参考.webm", mimeType: "video/webm", buffer: await readFile(new URL("../fixtures/sample.webm", import.meta.url)) },
  ]);
  await dialog.getByRole("button", { name: "保存全部", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page.locator(".wiki-material-badge").nth(2).waitFor();
  const result = await (await fetch(new URL("api/elements?material=1", app.url))).json();
  assert.equal(result.pagination.total, 3);
  assert.deepEqual(new Set(result.elements.map((element) => element.kind)), new Set(["image", "text", "video"]));
  await openViewMenu(page);
  await page.getByRole("checkbox", { name: "仅看资料", exact: true }).check();
  await page.locator(".wiki-material-badge").nth(2).waitFor();
  if (process.env.MATERIAL_SCREENSHOT) await page.screenshot({ path: process.env.MATERIAL_SCREENSHOT, fullPage: true });
});

test("image detail wallpaper action handles desktop success and failure and stays hidden in browsers", options, async (t) => {
  const { page, app } = await setup(t);
  const bytes = await sharp({ create: { width: 12, height: 16, channels: 3, background: "#408d81" } }).png().toBuffer();
  const response = await fetch(new URL("api/images", app.url), {
    method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": "wallpaper.png" }, body: bytes,
  });
  assert.ok(response.ok);
  const image = await response.json();
  await page.reload();
  await page.locator(`[data-element-id="${image.id}"] .wiki-card-open`).click();
  await openDetailMenu(page);
  assert.equal(await page.getByRole("button", { name: "设为桌面壁纸", exact: true }).count(), 0);
  await page.addInitScript(() => {
    window.wikiDesktop = { setWallpaper: async (id) => {
      window.wallpaperRequestedId = id;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return window.wallpaperFails ? { ok: false, error: "壁纸测试失败" } : { ok: true };
    } };
  });
  await page.reload();
  await page.locator(`[data-element-id="${image.id}"] .wiki-card-open`).click();
  await openDetailMenu(page);
  const button = page.getByRole("button", { name: "设为桌面壁纸", exact: true });
  await button.click();
  assert.equal(await button.isDisabled(), true);
  await page.getByText("已设为桌面壁纸", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.wallpaperRequestedId), image.id);
  assert.equal(await button.isEnabled(), true);
  await page.evaluate(() => { window.wallpaperFails = true; });
  await button.click();
  await page.getByRole("alert").getByText("壁纸测试失败", { exact: true }).waitFor();
  assert.equal(await button.isEnabled(), true);
});

test("text editing from card menu and document persists full content and preserves relations", options, async (t) => {
  const { page, app, create } = await setup(t);
  const original = `可编辑长文字\n${"保留完整正文。".repeat(120)}\n最后一行`;
  const note = await create(original);
  const linked = await create("文字编辑的关联内容");
  const api = async (route, method = "GET", body) => {
    const response = await fetch(new URL(`api/${route}`, app.url), { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(response.ok); return response.json();
  };
  await api(`elements/${note.id}`, "PATCH", { tags: ["原标签"] });
  await api("relations", "POST", { sourceId: note.id, targetId: linked.id, name: "相关" });
  await page.reload();
  await page.locator(`[data-element-id="${note.id}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "编辑文字", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑内容", exact: true });
  const text = editor.getByRole("textbox", { name: "文字", exact: true });
  await text.waitFor();
  assert.equal(await text.inputValue(), original);
  assert.equal(await text.evaluate((node) => node === document.activeElement), true);
  await text.fill(`${original}\n卡片修改保存`);
  await editor.getByLabel("标签", { exact: true }).fill("新增标签");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  let saved = await api(`elements/${note.id}`);
  assert.equal(saved.body, `${original}\n卡片修改保存`);
  assert.deepEqual(saved.tags, ["原标签", "新增标签"]);
  assert.equal((await api(`elements/${note.id}/relations`)).relations[0].element.id, linked.id);
  await page.locator(`[data-element-id="${note.id}"] .wiki-card-open`).click();
  await page.getByRole("button", { name: "编辑文字", exact: true }).click();
  await text.fill("详情修改后保存\n保留换行");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector(".wiki-text-document pre")?.textContent === "详情修改后保存\n保留换行");
  await page.reload();
  await page.locator(`[data-element-id="${note.id}"] .wiki-card-open`).click();
  await page.waitForFunction(() => document.querySelector(".wiki-text-document pre")?.textContent === "详情修改后保存\n保留换行");
  saved = await api(`elements/${note.id}`);
  assert.deepEqual(saved.tags, ["原标签", "新增标签"]);
});

test("text editor protects unsaved changes, rejects blank body and retains draft on save failure", options, async (t) => {
  const { page, app, create } = await setup(t);
  const note = await create("文字编辑草稿保护");
  await page.reload();
  await page.getByRole("button", { name: `打开内容：${note.body}`, exact: true }).click();
  await page.getByRole("button", { name: "编辑文字", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑内容", exact: true });
  const text = editor.getByRole("textbox", { name: "文字", exact: true });
  await text.fill("   \n");
  assert.equal(await editor.getByRole("button", { name: "保存", exact: true }).isDisabled(), true);
  await text.fill("待保存的新正文");
  await page.keyboard.press("Escape");
  const discard = page.getByRole("dialog", { name: "放弃内容修改？", exact: true });
  await discard.getByRole("button", { name: "继续编辑", exact: true }).click();
  assert.equal(await text.inputValue(), "待保存的新正文");
  const route = `**/api/elements/${note.id}`;
  await page.route(route, (request) => request.request().method() === "PATCH"
    ? request.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "保存测试失败" }) }) : request.continue());
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await editor.getByRole("alert").getByText("保存测试失败", { exact: true }).waitFor();
  assert.equal(await text.inputValue(), "待保存的新正文");
  assert.equal((await (await fetch(new URL(`api/elements/${note.id}`, app.url))).json()).body, note.body);
  await page.unroute(route);
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "编辑文字", exact: true }).click();
  await text.fill("应放弃的修改");
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  await discard.getByRole("button", { name: "放弃修改", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  assert.equal((await (await fetch(new URL(`api/elements/${note.id}`, app.url))).json()).body, "待保存的新正文");
});

test("similar stacks show newest covers, expand all members, persist preference and flatten for management", options, async (t) => {
  const { page, app } = await setup(t);
  const images = [];
  for (const [index, color] of ["#688f87", "#a28768", "#6e82a2"].entries()) {
    const bytes = await sharp({ create: { width: 480, height: 360 + index * 120, channels: 3, background: color } }).png().toBuffer();
    const response = await fetch(new URL("api/images", app.url), { method: "POST",
      headers: { "x-file-name": `stack-${index}.png` }, body: bytes });
    assert.equal(response.status, 201);
    images.push(await response.json());
  }
  for (let index = 1; index < images.length; index++) {
    const response = await fetch(new URL("api/relations", app.url), { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: images[index - 1].id, targetId: images[index].id, name: "相似" }) });
    assert.equal(response.status, 200);
  }
  await page.reload();
  await openViewMenu(page);
  const toggle = page.getByRole("button", { name: "堆叠相似内容", exact: true });
  assert.equal(await toggle.getAttribute("aria-pressed"), "false");
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-pressed"), "true");
  const cover = page.getByRole("button", { name: "打开内容：stack-2.png", exact: true });
  await cover.waitFor();
  await openViewMenu(page);
  assert.equal(await toggle.getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(".wiki-main > div:not([hidden]) .wiki-grid .wiki-card").count(), 1);
  const expand = page.getByRole("button", { name: "展开相似堆叠：3 项", exact: true });
  await expand.click();
  const dialog = page.getByRole("dialog", { name: "相似堆叠", exact: true });
  await dialog.getByRole("heading", { name: "相似堆叠 · 3 项", exact: true }).waitFor();
  assert.deepEqual(await dialog.locator(".wiki-card").evaluateAll((nodes) => nodes.map((node) => Number(node.dataset.elementId))), images.map((e) => e.id).reverse());
  await dialog.getByRole("button", { name: "打开内容：stack-0.png", exact: true }).click();
  const detail = page.getByRole("region", { name: "内容详情", exact: true });
  await detail.waitFor();
  await detail.getByRole("button", { name: "返回", exact: true }).click();
  await expand.waitFor();
  await openViewMenu(page);
  await toggle.click();
  await page.getByRole("button", { name: "打开内容：stack-0.png", exact: true }).waitFor();
  assert.equal(await expand.count(), 0);
  await page.reload();
  await openViewMenu(page);
  assert.equal(await toggle.getAttribute("aria-pressed"), "false");
  await openViewMenu(page);
  await toggle.click();
  await expand.waitFor();
  await page.getByLabel("更多操作", { exact: true }).click();
  await page.getByRole("button", { name: "批量管理", exact: true }).click();
  await page.getByRole("checkbox", { name: "选择内容：stack-0.png", exact: true }).waitFor();
  assert.equal(await page.getByRole("checkbox", { name: /^选择内容：stack-/ }).count(), 3);
  assert.equal(await expand.count(), 0);
  await page.getByRole("button", { name: "退出管理", exact: true }).click();
  await expand.waitFor();
  await page.getByRole("textbox", { name: "搜索内容", exact: true }).fill("stack-0");
  await page.getByRole("button", { name: "打开内容：stack-0.png", exact: true }).waitFor();
  await expand.click();
  await dialog.getByRole("heading", { name: "相似堆叠 · 3 项", exact: true }).waitFor();
  assert.equal(await dialog.locator(".wiki-card").count(), 3, "Opening a search hit reveals the entire stack");
  await dialog.getByRole("button", { name: "关闭相似堆叠", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索内容", exact: true }).fill("");
  await cover.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await expand.click();
  await dialog.getByRole("heading", { name: "相似堆叠 · 3 项", exact: true }).waitFor();
  assert.equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  await dialog.getByRole("button", { name: "关闭相似堆叠", exact: true }).click();
  const videoResponse = await fetch(new URL("api/videos", app.url), { method: "POST", headers: { "x-file-name": "stack-video.webm" },
    body: await readFile(new URL("../fixtures/sample.webm", import.meta.url)) });
  assert.equal(videoResponse.status, 201);
  const video = await videoResponse.json();
  await fetch(new URL("api/relations", app.url), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceId: images[2].id, targetId: video.id, name: "相似" }) });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await page.locator(".wiki-media-stack .wiki-card-video img").waitFor();
  assert.equal(await page.locator(".wiki-media-stack .wiki-card").getAttribute("data-element-id"), String(video.id));
  await page.screenshot({ path: ".local/similar-stack-collapsed.png" });
  await page.getByRole("button", { name: "展开相似堆叠：4 项", exact: true }).click();
  await dialog.getByRole("heading", { name: "相似堆叠 · 4 项", exact: true }).waitFor();
  assert.equal(await dialog.locator(".wiki-card.is-video").count(), 1);
  assert.equal(await dialog.locator(".wiki-card.is-image").count(), 3);
  await page.screenshot({ path: ".local/similar-stack-expanded.png" });
});

test("text similarity scan queues existing content and text stacks follow usage, search and expand", options, async (t) => {
  const { page, app, create } = await setup(t);
  const api = async (route, body, method = body ? "POST" : "GET") => {
    const response = await fetch(new URL(`api/${route}`, app.url), { method, headers: { "content-type": "application/json" }, ...(body && { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  };
  const status = await api("organization/status");
  status.config.executor.codexCli.executable = path.join(path.dirname(status.configPath), "missing-codex.exe");
  await api("organization/config", status.config, "PUT");
  const frequent = await create("雨夜街景，透明雨伞，暖色侧光。旧版常用文字");
  const variant = await create("雨夜街景，透明雨伞，暖色侧光。新版相似文字");
  await create("另一份独立的文字");
  await api("relations", { sourceId: frequent.id, targetId: variant.id, name: "相似" });
  await api(`elements/${frequent.id}/usage`, { action: "copy" });
  await api(`elements/${frequent.id}/usage`, { action: "reference" });
  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: "自动整理与检索", exact: false }).click();
  await page.getByRole("button", { name: "检查已有文字相似关系", exact: true }).click();
  await page.getByText("已安排 3 条文字检查，已有待处理任务会复用。可在整理历史查看结果。", { exact: true }).waitFor();
  assert.equal((await api("organization/status")).counts.queued, 3);
  await page.getByRole("button", { name: "检查已有文字相似关系", exact: true }).click();
  await page.getByText("已安排 3 条文字检查，已有待处理任务会复用。可在整理历史查看结果。", { exact: true }).waitFor();
  assert.equal((await api("organization/status")).counts.queued, 3);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await chooseOption(page, "文字排序", "usage");
  await openViewMenu(page);
  const stackToggle = page.getByRole("button", { name: "堆叠相似内容", exact: true });
  if (await stackToggle.getAttribute("aria-pressed") !== "true") await stackToggle.click();
  const expand = page.getByRole("button", { name: "展开相似堆叠：2 项", exact: true });
  await expand.waitFor();
  await page.waitForFunction((id) => document.querySelector(".wiki-media-stack .wiki-card")?.dataset.elementId === String(id), frequent.id);
  assert.equal(await page.locator(`.wiki-media-stack article[data-element-id="${frequent.id}"] .wiki-card-copy-count`).innerText(), "复制 1 次");
  await expand.click();
  const dialog = page.getByRole("dialog", { name: "相似堆叠", exact: true });
  await dialog.getByRole("heading", { name: "相似堆叠 · 2 项", exact: true }).waitFor();
  assert.deepEqual(await dialog.locator(".wiki-card").evaluateAll((nodes) => nodes.map((node) => Number(node.dataset.elementId))), [frequent.id, variant.id]);
  await dialog.getByRole("button", { name: `打开内容：${variant.body}`, exact: true }).click();
  for (let i = 0; i < 3; i++) {
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/elements/${variant.id}/usage`) && r.ok()),
      page.getByRole("button", { name: "复制文字", exact: true }).click(),
    ]);
  }
  await page.getByRole("region", { name: "内容详情", exact: true }).getByRole("button", { name: "返回", exact: true }).click();
  await page.waitForFunction((id) => document.querySelector(".wiki-media-stack .wiki-card")?.dataset.elementId === String(id), variant.id);
  await expand.click();
  await page.waitForFunction((id) => document.querySelector('dialog .wiki-card')?.dataset.elementId === String(id), variant.id);
  await page.screenshot({ path: ".local/text-similarity-expanded.png" });
  await dialog.getByRole("button", { name: "关闭相似堆叠", exact: true }).click();
  await page.waitForFunction((id) => document.querySelector(".wiki-media-stack .wiki-card")?.dataset.elementId === String(id), variant.id);
  await page.screenshot({ path: ".local/text-similarity-collapsed.png" });
  await page.getByLabel("搜索内容", { exact: true }).fill("旧版常用");
  await page.waitForFunction((id) => document.querySelector(".wiki-media-stack .wiki-card")?.dataset.elementId === String(id), frequent.id);
  await expand.click();
  await dialog.getByRole("heading", { name: "相似堆叠 · 2 项", exact: true }).waitFor();
  assert.equal(await dialog.locator(".wiki-card").count(), 2);
  await dialog.getByRole("button", { name: "关闭相似堆叠", exact: true }).click();
  await page.getByLabel("搜索内容", { exact: true }).fill("");
  await openViewMenu(page);
  await page.getByRole("button", { name: "堆叠相似内容", exact: true }).click();
  await page.locator(`.wiki-card[data-element-id="${frequent.id}"]`).waitFor();
  assert.equal(await page.locator(".wiki-card").count(), 3);
});

test("detail previous and next follow filtered pages and return directly to the list", options, async (t) => {
  const { page, create } = await setup(t);
  const last = await create("导航测试 A"), middle = await create("导航测试 B"), first = await create("导航测试 C");
  await create("不应出现在导航中的内容");
  let allowNextPage = false;
  await page.route("**/api/elements?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("q") !== "导航测试") return route.continue();
    if (Number(url.searchParams.get("page")) > 1 && !allowNextPage) {
      return route.fulfill({ status: 503, json: { error: "分页暂不可用" } });
    }
    url.searchParams.set("pageSize", "2");
    const response = await route.fetch({ url: url.toString() });
    await route.fulfill({ response });
  });
  const search = page.getByRole("textbox", { name: "搜索内容", exact: true });
  await search.fill("导航测试");
  await page.getByRole("button", { name: `打开内容：${first.body}`, exact: true }).click();
  const detail = page.getByRole("region", { name: "内容详情", exact: true });
  const previous = detail.getByRole("button", { name: "上一条", exact: true });
  const next = detail.getByRole("button", { name: "下一条", exact: true });
  await detail.getByRole("heading", { name: first.body, exact: true }).waitFor();
  assert.equal(await previous.isDisabled(), true);
  await next.click();
  await detail.getByRole("heading", { name: middle.body, exact: true }).waitFor();
  await detail.getByRole("button", { name: "重试加载", exact: true }).waitFor();
  allowNextPage = true;
  await detail.getByRole("button", { name: "重试加载", exact: true }).click();
  await next.click();
  await detail.getByRole("heading", { name: last.body, exact: true }).waitFor();
  assert.equal(await next.isDisabled(), true);
  await previous.click();
  await detail.getByRole("heading", { name: middle.body, exact: true }).waitFor();
  await detail.getByRole("button", { name: "返回", exact: true }).click();
  await detail.waitFor({ state: "hidden" });
  assert.equal(await search.inputValue(), "导航测试");
  await page.getByRole("button", { name: `打开内容：${last.body}`, exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "打开内容：不应出现在导航中的内容", exact: true }).count(), 0);
});

test("detail navigation keeps the current image until data and the next original are ready, and retries failures", options, async (t) => {
  const { page, app } = await setup(t);
  const images = [];
  for (const [name, color] of [["last-image.png", "#74829b"], ["next-image.png", "#688f87"], ["current-image.png", "#a28768"]]) {
    const bytes = await sharp({ create: { width: 480, height: 360, channels: 3, background: color } }).png().toBuffer();
    const response = await fetch(new URL("api/images", app.url), { method: "POST", headers: { "x-file-name": name }, body: bytes });
    assert.equal(response.status, 201);
    images.push(await response.json());
  }
  const [, nextImage] = images;
  await page.reload();
  await page.getByRole("button", { name: "打开内容：current-image.png", exact: true }).click();
  const detail = page.getByRole("region", { name: "内容详情", exact: true });
  const currentHeading = detail.getByRole("heading", { name: "current-image.png", exact: true, includeHidden: true });
  const nextHeading = detail.getByRole("heading", { name: "next-image.png", exact: true });
  await currentHeading.waitFor();
  await page.waitForFunction(() => document.querySelector(".wiki-original img")?.naturalWidth > 0);
  const initialHeight = (await page.locator(".wiki-original").boundingBox()).height;
  const nextButton = await detail.getByRole("button", { name: "下一条", exact: true }).elementHandle();
  const editButton = await detail.getByRole("button", { name: "编辑", exact: true }).elementHandle();
  const initialOpacity = await editButton.evaluate((node) => getComputedStyle(node).opacity);
  let dataRequests = 0;
  let releaseData, releaseImage, fail = false;
  const dataGate = new Promise((resolve) => { releaseData = resolve; });
  const imageGate = new Promise((resolve) => { releaseImage = resolve; });
  t.after(() => { releaseData(); releaseImage(); });
  await page.route(`**/api/elements/${nextImage.id}`, async (route) => {
    dataRequests++;
    if (fail) return route.fulfill({ status: 503, json: { error: "详情暂不可用" } });
    await dataGate;
    await route.continue();
  });
  await page.route(`**/api/elements/${nextImage.id}/image?attempt=0`, async (route) => {
    await imageGate;
    await route.continue();
  });
  const dataRequested = page.waitForRequest((request) => new URL(request.url()).pathname === `/api/elements/${nextImage.id}`);
  const imageRequested = page.waitForRequest((request) => new URL(request.url()).pathname === `/api/elements/${nextImage.id}/image`);
  await detail.getByRole("button", { name: "下一条", exact: true }).click();
  await dataRequested;
  assert.equal(await currentHeading.isVisible(), true, "Keep current content while fetching the next detail");
  assert.equal(await detail.getByRole("button", { name: "下一条", exact: true }).isDisabled(), true);
  assert.equal(await nextButton.evaluate((node) => getComputedStyle(node).opacity), "1", "Pending navigation must not dim the fixed buttons");
  assert.equal(await editButton.evaluate((node) => getComputedStyle(node).opacity), initialOpacity);
  assert.equal(await editButton.evaluate((node) => Boolean(node.closest("[inert]"))), true, "Content actions remain blocked while switching");
  await nextButton.evaluate((node) => node.click());
  assert.equal(await detail.getByText("正在读取内容…", { exact: true }).count(), 0);
  releaseData();
  await imageRequested;
  assert.equal(await currentHeading.isVisible(), true, "Keep current content until the original image has decoded");
  assert.equal((await page.locator(".wiki-original").boundingBox()).height, initialHeight);
  releaseImage();
  await nextHeading.waitFor();
  assert.equal(dataRequests, 1, "Repeated navigation clicks must not start duplicate requests");
  assert.equal(await nextButton.evaluate((node) => node.isConnected && node === document.activeElement), true, "Keep the navigation button and keyboard focus across the switch");
  assert.equal(await editButton.evaluate((node) => node.isConnected), true, "Keep the toolbar's existing DOM nodes");
  await page.waitForFunction(() => {
    const image = document.querySelector(".wiki-original img");
    return image?.complete && image.naturalWidth > 0 && getComputedStyle(image).opacity === "1";
  });
  assert.equal((await page.locator(".wiki-original").boundingBox()).height, initialHeight);
  assert.equal(await detail.getByText("正在读取内容…", { exact: true }).count(), 0);
  await page.locator(".wiki-original img").hover();
  await page.mouse.wheel(0, -100);
  await page.locator(".wiki-original img.is-zoomed").waitFor();
  await detail.getByRole("button", { name: "恢复全图", exact: true }).click();
  assert.equal(await detail.getByRole("button", { name: "恢复全图", exact: true }).isDisabled(), true);
  await page.screenshot({ path: ".local/detail-navigation-fixed.png" });
  await detail.getByRole("button", { name: "上一条", exact: true }).click();
  await currentHeading.waitFor();
  fail = true;
  await detail.getByRole("button", { name: "下一条", exact: true }).click();
  await detail.getByText(/详情暂不可用/).waitFor();
  assert.equal(await currentHeading.isVisible(), true, "A failed navigation must retain the current detail");
  fail = false;
  await detail.getByRole("button", { name: "重试加载", exact: true }).click();
  await nextHeading.waitFor();
  await detail.getByRole("button", { name: "添加标签", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑标签", exact: true });
  await editor.getByLabel("标签", { exact: true }).fill("切换后保存");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await detail.locator(".wiki-detail-tags .wiki-tag").filter({ hasText: "切换后保存" }).waitFor();
  // Saving moves this item to the front of the library's recent-update ordering.
  await detail.getByRole("button", { name: "下一条", exact: true }).click();
  await currentHeading.waitFor();
  assert.equal(await detail.locator(".wiki-detail-tags .wiki-tag").count(), 0, "Do not retain the previous item's tags or edit state");
});

test("returning to the list cancels a pending detail navigation", options, async (t) => {
  const { page, create } = await setup(t);
  const target = await create("取消切换目标");
  await create("取消切换当前");
  await page.reload();
  await page.getByRole("button", { name: "打开内容：取消切换当前", exact: true }).click();
  const detail = page.getByRole("region", { name: "内容详情", exact: true });
  await detail.getByRole("heading", { name: "取消切换当前", exact: true }).waitFor();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  await page.route(`**/api/elements/${target.id}`, async (route) => {
    await gate;
    await route.continue();
  });
  const requested = page.waitForRequest((request) => new URL(request.url()).pathname === `/api/elements/${target.id}`);
  const cancelled = page.waitForEvent("requestfailed", { predicate: (request) => new URL(request.url()).pathname === `/api/elements/${target.id}` });
  await detail.getByRole("button", { name: "下一条", exact: true }).click();
  await requested;
  await detail.getByRole("button", { name: "返回", exact: true }).click();
  await cancelled;
  release();
  await detail.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "打开内容：取消切换当前", exact: true }).waitFor();
});

test("manual sources show incoming references separately from their own creative sources", options, async (t) => {
  const { page, app, create } = await setup(t);
  const source = await create("手动添加的参考原稿"), output = await create("使用原稿的生成结果");
  await fetch(new URL("api/relations", app.url), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ leftId: output.id, rightId: source.id, name: "参考了", direction: "forward", reverseName: "被参考" }) });
  await page.reload();
  await page.getByRole("button", { name: `打开内容：${source.body}`, exact: true }).click();
  await page.locator(".wiki-element-meta").filter({ hasText: "手动添加" }).waitFor();
  const references = page.getByRole("region", { name: "被参考", exact: true });
  await references.getByText("以下内容使用了当前内容作为参考", { exact: true }).waitFor();
  assert.equal(await page.getByRole("region", { name: "创作来源", exact: true }).count(), 0);
  await references.getByRole("button", { name: `打开内容：${output.body}`, exact: true }).click();
  await page.getByRole("region", { name: "创作来源", exact: true }).getByText("参考了", { exact: true }).waitFor();
});

test("possible matches appear separately, open details and clear with the query", options, async (t) => {
  const { page, create } = await setup(t);
  const candidate = await create("海边人物照片");
  await page.route('**/api/elements?*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('q') !== '女生') return route.continue();
    await route.fulfill({ json: { elements: [], pagination: { total: 0, page: 1, pageSize: 36, pageCount: 1 }, possible: [candidate] } });
  });
  await page.getByRole('textbox', { name: '搜索内容', exact: true }).fill('女生');
  const section = page.getByRole('region', { name: '可能相关', exact: true });
  await section.getByText('海边人物照片', { exact: true }).waitFor();
  assert.equal(await page.getByText('没有找到相关内容', { exact: true }).count(), 0);
  await section.getByText('海边人物照片', { exact: true }).click();
  await page.waitForFunction(() => Boolean(document.querySelector('.wiki-detail')));
  await page.reload();
  assert.equal(await page.getByRole('region', { name: '可能相关', exact: true }).count(), 0);
});

test("main search requests semantic matches and displays keyword fallback", options, async (t) => {
  const { page, create } = await setup(t);
  await create("海边女生");
  const searches = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/elements" && url.searchParams.get("q")) searches.push(url);
  });
  const input = page.getByRole("textbox", { name: "搜索内容", exact: true });
  await input.fill("海");
  await input.fill("海边女生");
  await page.getByText("当前仅匹配文字、文件名和已有图片描述：语义检索未启用", { exact: true }).waitFor();
  await page.getByText("1 条内容", { exact: true }).waitFor();
  assert.equal(searches.length, 1);
  assert.equal(searches[0].searchParams.get("semantic"), "1");
  assert.equal(searches[0].searchParams.get("q"), "海边女生");
});

test("tag filter supports multiple checked tags, individual removal and clearing", options, async (t) => {
  const { page, app } = await setup(t);
  for (const tags of [["人物", "雨夜"], ["人物"], ["雨夜"]]) {
    await fetch(new URL("api/elements", app.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: tags.join("-"), tags }) });
  }
  await page.reload();
  await page.getByRole("button", { name: "按标签筛选", exact: true }).click();
  assert.equal(await page.getByLabel("标签匹配方式", { exact: true }).count(), 0);
  await page.getByLabel("搜索标签", { exact: true }).focus();
  const personRow = page.locator(".wiki-tag-filter-options label").filter({ hasText: "人物" });
  const rowBox = await personRow.boundingBox();
  assert.ok(rowBox.height >= 44);
  await personRow.click({ position: { x: rowBox.width - 8, y: rowBox.height / 2 } });
  assert.equal(await page.getByRole("checkbox", { name: "人物", exact: true }).isChecked(), true);
  await page.locator(".wiki-tag-filter-options label span").getByText("雨夜", { exact: true }).click();
  assert.equal(await page.getByRole("checkbox", { name: "雨夜", exact: true }).isChecked(), true);
  await page.waitForFunction(() => document.querySelector('.wiki-toolbar')?.textContent.includes('3 条内容'));
  await chooseOption(page, "标签匹配方式", "all");
  await page.waitForFunction(() => document.querySelector('.wiki-toolbar')?.textContent.includes('1 条内容'));
  await chooseOption(page, "标签匹配方式", "any");
  await page.waitForFunction(() => document.querySelector('.wiki-toolbar')?.textContent.includes('3 条内容'));
  await page.getByRole("textbox", { name: "搜索内容", exact: true }).click();
  await page.getByRole("button", { name: "按标签筛选", exact: true }).click();
  await page.getByLabel("搜索标签", { exact: true }).fill("雨");
  assert.equal(await page.locator(".wiki-tag-filter-options").getByRole("checkbox").count(), 1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "取消筛选标签：雨夜", exact: true }).click();
  assert.equal(await page.getByLabel("标签匹配方式", { exact: true }).count(), 0);
  await page.waitForFunction(() => document.querySelector('.wiki-toolbar')?.textContent.includes('2 条内容'));
  await page.getByRole("button", { name: "按标签筛选", exact: true }).click();
  await page.getByRole("button", { name: "清空标签", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.wiki-toolbar')?.textContent.includes('3 条内容'));
});

test("token usage opens from the sidebar and shows filters, unknown coverage and costly call context", options, async (t) => {
  const { page } = await setup(t);
  await page.locator("details.workspace-tools-more").evaluate((el) => { el.open = true; });
  await page.getByRole("button", { name: "Token 用量", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Token 用量", exact: true });
  await dialog.getByText("还没有调用记录，使用 Agent 或语义索引后可在这里查看。").waitFor();
  const row = { id: "example", purpose: "organization", model: "fixture", state: "completed", started_at: Date.now(), elapsed_ms: 1200,
    input: 100, output: 50, cached: 80, reasoning: null, total: 150, context: { elementId: 42, round: 2, imageCount: 1 } };
  await page.route("**/api/token-usage?*", (route) => route.fulfill({ json: { summary: { calls: 2, measured: 1, total: 150 },
    groups: [{ ...row, uncached: 20, unsplitInput: 0, calls: 2, measured: 1 }], recent: Array.from({ length: 12 }, (_, i) => ({ ...row, id: String(i) })), costly: [row] } }));
  await dialog.getByLabel("时间范围").selectOption("30");
  await dialog.getByText("2 次调用 · 1 次有用量 · 1 次未知").waitFor();
  const calls = dialog.getByRole("table", { name: "调用明细", exact: true });
  assert.equal(await calls.locator("tbody tr").count(), 10);
  await dialog.getByRole("button", { name: "下一页", exact: true }).click();
  assert.equal(await calls.locator("tbody tr").count(), 2);
  await dialog.getByLabel("优先查看高消耗").check();
  await calls.getByRole("button", { name: "查看自动整理调用详情", exact: true }).click();
  assert.match(await calls.innerText(), /非缓存输入/);
  assert.equal(await calls.locator("tbody tr").first().locator("td").nth(3).innerText(), "20");
  assert.match(await dialog.innerText(), /内容：42 · 轮次：2 · 图片：1/);
  assert.match(await dialog.innerText(), /100.0%/);
  await page.setViewportSize({ width: 390, height: 844 });
  const box = await dialog.boundingBox(); assert.ok(box.width <= 390);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  assert.equal(await dialog.count(), 0);
});

test("List previews show loading placeholders, load visible images eagerly and keep failures accessible", options, async (t) => {
  const { page, app, create } = await setup(t);
  await create("加载图片时仍可阅读文字");
  const images = [];
  for (let i = 0; i < 2; i++) {
    const bytes = await sharp({ create: { width: 1800, height: 1200, channels: 3, background: i ? "#889944" : "#448899" } }).png().toBuffer();
    images.push(await (await fetch(new URL("api/images", app.url), { method: "POST", headers: { "x-file-name": `preview-${i}.png` }, body: bytes })).json());
  }
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  let originalRequests = 0;
  page.on("request", (request) => { if (/\/api\/elements\/\d+\/image$/.test(request.url())) originalRequests++; });
  await page.route("**/thumbnail?*", async (route) => {
    await pending;
    if (route.request().url().includes(`/${images[1].id}/`) && !new URL(route.request().url()).searchParams.has("retry")) await route.fulfill({ status: 404, body: "Missing preview" });
    else await route.continue();
  });
  await page.reload();
  await page.getByText("3 条内容", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "打开内容：加载图片时仍可阅读文字", exact: true }).isEnabled(), true);
  const cards = page.locator(".wiki-grid > .is-image");
  assert.equal(await cards.count(), 2);
  assert.equal(await cards.evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).opacity === "1" && !node.querySelector("button").disabled && getComputedStyle(node.querySelector("button")).opacity === "1")), true);
  assert.equal(await cards.locator(".wiki-card-image-loading").count(), 2);
  assert.equal(await cards.locator("img").evaluateAll((nodes) => nodes.every((img) => img.loading === "eager" && new URL(img.src).pathname.endsWith("/thumbnail") && img.srcset.includes("1600w"))), true);
  release();
  await page.waitForFunction(() => !document.querySelector(".wiki-grid .is-loading"));
  assert.equal(originalRequests, 0);
  assert.equal(await cards.evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).opacity === "1")), true);
  await page.getByText("预览无法加载", { exact: true }).waitFor();
  await page.getByRole("button", { name: "重试预览", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".wiki-grid .is-loading") && [...document.querySelectorAll(".wiki-grid img")].every((img) => img.complete && img.naturalWidth));
  assert.equal(await page.getByText("预览无法加载", { exact: true }).count(), 0);
  assert.equal(originalRequests, 0);
  const original = page.waitForResponse((response) => new URL(response.url()).pathname === images[1].image.url);
  await page.getByRole("button", { name: "打开内容：preview-1.png", exact: true }).click();
  assert.equal((await original).status(), 200);
});

test("Responsive list previews upgrade with card size and pixel density without downloading originals", options, async (t) => {
  const { page, app } = await setup(t);
  const bytes = await sharp({ create: { width: 1800, height: 2700, channels: 3, background: "#669988" } }).png().toBuffer();
  await fetch(new URL("api/images", app.url), { method: "POST", headers: { "x-file-name": "portrait.png" }, body: bytes });
  const originalRequests = [];
  page.context().on("request", (request) => { if (/\/api\/elements\/\d+\/image$/.test(request.url())) originalRequests.push(request.url()); });
  await page.reload();
  await page.getByText("1 条内容", { exact: true }).waitFor();
  async function expectWidth(target, width) {
    await target.waitForFunction((width) => {
      const image = document.querySelector(".wiki-grid .wiki-card img");
      return image?.complete && image.naturalWidth > 0 && new URL(image.currentSrc).searchParams.get("width") === String(width);
    }, width);
  }
  await expectWidth(page, 400);
  await openViewMenu(page);
  await page.getByRole("slider", { name: "瀑布流图片大小", exact: true }).fill("560");
  await expectWidth(page, 1200);
  const box = await page.locator(".wiki-grid .wiki-card img").boundingBox();
  assert.ok(Math.abs(box.width / box.height - 2 / 3) < .01);
  await openViewMenu(page);
  await page.getByRole("button", { name: "网格视图", exact: true }).click();
  assert.equal(await page.locator(".wiki-grid .wiki-card img").evaluate((image) => image.complete && image.naturalWidth > 0), true);
  assert.deepEqual(originalRequests, []);
  const retina = await page.context().browser().newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  try {
    retina.on("request", (request) => { if (/\/api\/elements\/\d+\/image$/.test(request.url())) originalRequests.push(request.url()); });
    const retinaPage = await retina.newPage();
    await retinaPage.goto(`${app.url}#wiki`);
    await expectWidth(retinaPage, 800);
    assert.deepEqual(originalRequests, []);
  } finally { await retina.close(); }
});

test("Masonry keeps card positions stable during preview upgrades and revisiting image filters", options, async (t) => {
  const { page, app, create } = await setup(t);
  await create("用于切换分类的文字");
  for (let i = 0; i < 6; i++) {
    const [width, height] = [[801, 1203], [1401, 901], [1103, 1601]][i % 3];
    const bytes = await sharp({ create: { width, height, channels: 3, background: { r: 80 + i, g: 130, b: 150 } } }).png().toBuffer();
    await fetch(new URL("api/images", app.url), { method: "POST", headers: { "x-file-name": `stable-${i}.png` }, body: bytes });
  }
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll(".wiki-card img").length === 6 && !document.querySelector(".wiki-card.is-loading"));
  let release, requested;
  const pending = new Promise((resolve) => { release = resolve; });
  const upgradeRequested = new Promise((resolve) => { requested = resolve; });
  t.after(() => release());
  await page.route("**/thumbnail?*", async (route) => { requested(); await pending; await route.continue(); });
  await openViewMenu(page);
  await page.getByRole("slider", { name: "瀑布流图片大小", exact: true }).fill("560");
  await upgradeRequested;
  async function positions() {
    return page.locator(".wiki-grid > .wiki-card").evaluateAll((cards) => cards.map((card) => {
      const box = card.getBoundingClientRect();
      return { top: box.top + scrollY, height: box.height };
    }));
  }
  const beforeUpgrade = await positions();
  release();
  await page.waitForFunction(() => [...document.querySelectorAll(".wiki-card img")].every((img) => img.complete && img.currentSrc.includes("width=1200")));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const afterUpgrade = await positions();
  assert.ok(afterUpgrade.every((box, i) => Math.abs(box.top - beforeUpgrade[i].top) < .5 && Math.abs(box.height - beforeUpgrade[i].height) < .5), JSON.stringify({ beforeUpgrade, afterUpgrade }));

  const sidebar = page.getByRole("complementary", { name: "内容导航", exact: true });
  await sidebar.getByRole("button", { name: "文字", exact: true }).click();
  await page.getByText("1 条内容", { exact: true }).waitFor();
  const reloading = new Promise((resolve) => { release = resolve; });
  await page.unroute("**/thumbnail?*");
  await page.route("**/thumbnail?*", async (route) => { await reloading; await route.continue(); });
  await sidebar.getByRole("button", { name: "图片", exact: true }).click();
  await page.getByText("6 条内容", { exact: true }).waitFor();
  const beforeReload = await positions();
  release();
  await page.waitForFunction(() => !document.querySelector(".wiki-card.is-loading"));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const afterReload = await positions();
  assert.ok(afterReload.every((box, i) => Math.abs(box.top - beforeReload[i].top) < .5 && Math.abs(box.height - beforeReload[i].height) < .5), JSON.stringify({ beforeReload, afterReload }));
});

test("Wide masonry shows all 20 pending images beside text and settles without overlap", options, async (t) => {
  const { page, app, create } = await setup(t);
  await page.setViewportSize({ width: 2650, height: 1080 });
  await openViewMenu(page);
  await page.getByRole("button", { name: "瀑布流视图", exact: true }).click();
  await create("图片加载时仍可阅读的文字。".repeat(40));
  for (let i = 0; i < 20; i++) {
    const bytes = await sharp({ create: { width: 600, height: 900, channels: 3, background: { r: 80 + i, g: 140, b: 160 } } }).png().toBuffer();
    await fetch(new URL("api/images", app.url), { method: "POST", headers: { "x-file-name": `wide-${i}.png` }, body: bytes });
  }
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  await page.route("**/thumbnail?*", async (route) => { await pending; await route.continue(); });
  await page.reload();
  await page.getByText("21 条内容", { exact: true }).waitFor();
  const cards = page.locator(".wiki-masonry > .wiki-card");
  assert.equal(await cards.count(), 21);
  assert.equal(await cards.locator(".wiki-card-image-loading").count(), 20);
  assert.equal(await cards.evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).opacity === "1" && node.getBoundingClientRect().height >= 140)), true);
  assert.equal(await page.locator(".wiki-card.is-text .wiki-card-open").isEnabled(), true);
  release();
  await page.waitForFunction(() => !document.querySelector(".wiki-card.is-loading") && [...document.querySelectorAll(".wiki-card img")].every((img) => img.complete && img.naturalWidth > 0));
  await page.waitForFunction(() => {
    const boxes = [...document.querySelectorAll(".wiki-masonry > .wiki-card")].map((card) => card.getBoundingClientRect());
    return boxes.every((box, i) => boxes.every((other, j) => i === j || box.right <= other.left + 1 || other.right <= box.left + 1 || box.bottom + 10 <= other.top || other.bottom + 10 <= box.top));
  });
  assert.equal(await cards.locator(".wiki-card-image-loading").count(), 0);
});

test("Card tags remain overlays, obey hover and keyboard focus, persist, and stay visible on touch", options, async (t) => {
  const { page, app } = await setup(t);
  await fetch(new URL("api/elements", app.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "标签不应该占据额外的底栏。", tags: ["标签一", "标签二", "标签三"] }) });
  const bytes = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#8899aa" } }).png().toBuffer();
  await fetch(new URL("api/images", app.url), { method: "POST", headers: { "x-file-name": "tag-overlay.png", "x-image-tags": Buffer.from(JSON.stringify(["标签一", "标签二", "标签三"])).toString("base64") }, body: bytes });
  await page.reload();
  await page.getByText("2 条内容", { exact: true }).waitFor();
  await page.locator(".wiki-card.is-loading").waitFor({ state: "hidden" });
  const cards = page.locator(".wiki-grid > .wiki-card");
  const tags = cards.locator(".wiki-card-tags");
  async function preference(target, value) {
    const more = target.getByRole("button", { name: "更多工具", exact: true });
    if (await more.isVisible() && !await target.getByRole("button", { name: "设置", exact: true }).isVisible()) await more.click();
    await target.getByRole("button", { name: "设置", exact: true }).click();
    await target.getByLabel("标签显示", { exact: true }).selectOption(value);
    await target.getByRole("button", { name: "关闭", exact: true }).click();
  }
  await openViewMenu(page);
  for (const view of ["网格视图", "瀑布流视图"]) {
    await openViewMenu(page);
    await page.getByRole("button", { name: view, exact: true }).click();
    await preference(page, "hover");
    await page.mouse.move(0, 0);
    assert.equal(await tags.evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).position === "absolute" && getComputedStyle(node).opacity === "0")), true);
    assert.equal(await tags.locator(".wiki-card-tag-count").allTextContents().then((counts) => counts.every((count) => count === "+1")), true);
    const heights = await cards.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    await cards.first().hover();
    assert.equal(await tags.first().evaluate((node) => getComputedStyle(node).opacity), "1");
    assert.equal(await tags.last().evaluate((node) => getComputedStyle(node).opacity), "0");
    await page.mouse.move(0, 0);
    await cards.last().getByRole("button").focus();
    assert.equal(await tags.last().evaluate((node) => getComputedStyle(node).opacity), "1");
    assert.equal(await tags.first().evaluate((node) => getComputedStyle(node).opacity), "0");
    await page.getByLabel("搜索内容", { exact: true }).focus();
    assert.equal(await tags.evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).opacity === "0")), true);
    await preference(page, "always");
    assert.equal(await tags.evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).opacity === "1")), true);
    assert.deepEqual(await cards.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height)), heights);
  }
  await preference(page, "hover");
  await page.reload();
  await page.getByText("2 条内容", { exact: true }).waitFor();
  await page.mouse.move(0, 0);
  assert.equal(await tags.evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).opacity === "0")), true);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  assert.equal(await page.getByLabel("标签显示", { exact: true }).inputValue(), "hover");
  const touch = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const touchPage = await touch.newPage();
    await touchPage.goto(`${app.url}#wiki`);
    await touchPage.getByText("2 条内容", { exact: true }).waitFor();
    await preference(touchPage, "hover");
    assert.equal(await touchPage.locator(".wiki-card-tags").evaluateAll((nodes) => nodes.length === 2 && nodes.every((node) => getComputedStyle(node).opacity === "1")), true);
    assert.equal(await touchPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await touch.close(); }
});

test("Visited list filters stay visible during revalidation and discard cached rows after deletion", options, async (t) => {
  const { page, app, create } = await setup(t);
  await create("切换分类时保留内容");
  const bytes = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#669988" } }).png().toBuffer();
  await fetch(new URL("api/images", app.url), { method: "POST", headers: { "x-file-name": "cached.png" }, body: bytes });
  await page.reload();
  await page.getByText("2 条内容", { exact: true }).waitFor();
  const sidebar = page.getByRole("complementary", { name: "内容导航", exact: true });
  await sidebar.getByRole("button", { name: "图片", exact: true }).click();
  await page.getByText("1 条内容", { exact: true }).waitFor();
  await page.locator(".wiki-grid .is-loading").waitFor({ state: "hidden" });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  await page.route("**/api/elements?*", async (route) => { await pending; await route.continue(); });
  await sidebar.getByRole("button", { name: "全部内容", exact: true }).click();
  await page.getByText("2 条内容", { exact: true }).waitFor();
  assert.equal(await page.locator(".wiki-grid > .wiki-card").count(), 2);
  assert.equal(await page.getByRole("button", { name: "打开内容：cached.png", exact: true }).isEnabled(), true);
  assert.equal(await page.getByText("正在读取内容…", { exact: true }).count(), 0);
  await sidebar.getByRole("button", { name: "图片", exact: true }).click();
  await page.getByText("1 条内容", { exact: true }).waitFor();
  assert.equal(await page.locator(".wiki-grid > .wiki-card").count(), 1);
  release();
  await page.getByRole("button", { name: "打开内容：cached.png", exact: true }).click();
  await openDetailMenu(page);
  await page.getByRole("button", { name: "移入回收站", exact: true }).click();
  await page.getByText("0 条内容", { exact: true }).waitFor();
  await sidebar.getByRole("button", { name: "全部内容", exact: true }).click();
  await page.getByText("1 条内容", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "打开内容：cached.png", exact: true }).count(), 0);
});

test("Content views retain selection and preference while masonry fits mixed images, resizes and returns from detail", options, async (t) => {
  const { page, app, create } = await setup(t);
  await create("瀑布流笔记：保留完整图片和简短文字。");
  const imageRatios = {};
  for (let i = 0; i < 13; i++) {
    const [width, height] = [[160, 300], [320, 180], [200, 200]][i % 3];
    imageRatios[`视图样本-${i}.png`] = width / height;
    const bytes = await sharp({ create: { width, height, channels: 3, background: { r: 80 + i * 8, g: 140, b: 160 } } }).png().toBuffer();
    await fetch(new URL("api/images", app.url), { method: "POST", headers: { "x-file-name": encodeURIComponent(`视图样本-${i}.png`), "x-image-tags": Buffer.from(JSON.stringify(["布局样本"])).toString("base64") }, body: bytes });
  }
  await page.reload();
  await page.getByText("14 条内容", { exact: true }).waitFor();
  const cards = page.locator(".wiki-grid > .wiki-card");
  const order = await cards.locator(".wiki-card-open").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
  await openViewMenu(page);
  assert.equal(await page.getByRole("button", { name: "瀑布流视图", exact: true }).getAttribute("aria-pressed"), "true");
  await openViewMenu(page);
  const size = page.getByRole("slider", { name: "瀑布流图片大小", exact: true });
  await openViewMenu(page);
  assert.equal(await size.inputValue(), "320");
  const defaultWidth = (await cards.first().boundingBox()).width;
  await openViewMenu(page);
  await size.fill("400");
  await page.waitForFunction((width) => document.querySelector(".wiki-grid > .wiki-card").getBoundingClientRect().width > width, defaultWidth);
  await openViewMenu(page);
  await size.focus();
  await openViewMenu(page);
  await size.press("ArrowRight");
  await openViewMenu(page);
  assert.equal(await size.inputValue(), "420");
  await openViewMenu(page);
  await page.getByRole("button", { name: "网格视图", exact: true }).click();
  assert.equal(await size.count(), 0);
  const original = await cards.first().boundingBox();
  await page.getByLabel("更多操作", { exact: true }).click();
  await page.getByRole("button", { name: "批量管理", exact: true }).click();
  const chosen = page.getByRole("checkbox", { name: "选择内容：视图样本-0.png", exact: true });
  await chosen.check();
  await openViewMenu(page);
  await page.getByRole("button", { name: "瀑布流视图", exact: true }).click();
  assert.equal(await chosen.isChecked(), true);
  await openViewMenu(page);
  await page.getByRole("button", { name: "网格视图", exact: true }).click();
  assert.equal(await chosen.isChecked(), true);
  assert.ok(Math.abs((await cards.first().boundingBox()).height - original.height) < 1);
  await closeViewMenu(page);
  await page.getByRole("button", { name: "退出管理", exact: true }).click();
  await openViewMenu(page);
  await page.getByRole("button", { name: "瀑布流视图", exact: true }).click();
  await page.reload();
  await page.getByText("14 条内容", { exact: true }).waitFor();
  await openViewMenu(page);
  assert.equal(await page.getByRole("button", { name: "瀑布流视图", exact: true }).getAttribute("aria-pressed"), "true");
  await openViewMenu(page);
  assert.equal(await size.inputValue(), "420");
  assert.deepEqual(await cards.locator(".wiki-card-open").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label"))), order);
  async function verifyLayout() {
    // Resolve offscreen previews too, so geometry checks include the whole page at larger sizes.
    await cards.locator("img").evaluateAll((images) => images.forEach((img) => { img.loading = "eager"; }));
    await page.waitForFunction(() => {
      const grid = document.querySelector(".wiki-masonry");
      const cards = [...grid.children];
      const images = [...grid.querySelectorAll("img")];
      if (!images.every((img) => img.complete && img.naturalWidth > 0)) return false;
      const boxes = cards.map((card) => card.getBoundingClientRect());
      return boxes.every((box, index) => box.height > 0 && boxes.every((other, j) => j === index ||
        box.right <= other.left + 1 || other.right <= box.left + 1 || box.bottom + 10 <= other.top || other.bottom + 10 <= box.top));
    });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    // srcset density-corrects and rounds naturalWidth/Height; compare with the original fixture ratio.
    assert.equal(await cards.locator("img").evaluateAll((images, ratios) => images.every((img) => {
      const box = img.getBoundingClientRect();
      return Math.abs(box.width / box.height - ratios[img.alt]) < .01;
    }), imageRatios), true);
  }
  await verifyLayout();
  await cards.last().scrollIntoViewIfNeeded();
  const previousScroll = await page.evaluate(() => scrollY);
  assert.ok(previousScroll > 0);
  await cards.last().getByRole("button").click();
  await page.getByRole("region", { name: "内容详情", exact: true }).waitFor();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.waitForFunction((expected) => Math.abs(scrollY - expected) < 5, previousScroll);
  await verifyLayout();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openViewMenu(page);
  await size.fill("200");
  await verifyLayout();
  assert.ok((await cards.evaluateAll((nodes) => new Set(nodes.map((node) => Math.round(node.getBoundingClientRect().left))).size)) >= 6);
  await openViewMenu(page);
  await size.fill("560");
  await verifyLayout();
  assert.equal(await cards.evaluateAll((nodes) => new Set(nodes.map((node) => Math.round(node.getBoundingClientRect().left))).size), 2);
  await page.setViewportSize({ width: 390, height: 844 });
  await verifyLayout();
  assert.equal(await cards.evaluateAll((nodes) => new Set(nodes.map((node) => Math.round(node.getBoundingClientRect().left))).size), 1);
  await page.getByLabel("搜索内容", { exact: true }).fill("瀑布流笔记");
  await page.getByText("1 条内容", { exact: true }).waitFor();
  await verifyLayout();
  await page.getByLabel("搜索内容", { exact: true }).fill("没有这种内容");
  await page.getByRole("heading", { name: "没有找到相关内容", exact: true }).waitFor();
  await openViewMenu(page);
  await page.getByRole("button", { name: "网格视图", exact: true }).click();
  await page.getByRole("button", { name: "清空筛选", exact: true }).click();
  await page.getByText("14 条内容", { exact: true }).waitFor();
  assert.equal(await cards.evaluateAll((nodes) => nodes.every((node) => !node.style.gridRowEnd)), true);
  await page.reload();
  await page.getByText("14 条内容", { exact: true }).waitFor();
  await openViewMenu(page);
  assert.equal(await page.getByRole("button", { name: "网格视图", exact: true }).getAttribute("aria-pressed"), "true");
  await page.evaluate(() => { localStorage.setItem("wikiContentView", "invalid"); localStorage.setItem("wikiMasonryCardWidth", "invalid"); });
  await page.reload();
  await page.getByText("14 条内容", { exact: true }).waitFor();
  await openViewMenu(page);
  assert.equal(await page.getByRole("button", { name: "瀑布流视图", exact: true }).getAttribute("aria-pressed"), "true");
  await openViewMenu(page);
  assert.equal(await size.inputValue(), "320");
});

test("relation rename supports cancellation, conflict recovery, saving from either side and clearing the name", options, async (t) => {
  const { page, app, create } = await setup(t);
  const source = await create("重命名来源"), target = await create("重命名目标");
  for (const name of ["", "已用名称"]) await fetch(new URL("api/relations", app.url), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceId: source.id, targetId: target.id, name }),
  });
  await page.reload();
  await page.getByRole("button", { name: "打开内容：重命名来源", exact: true }).click();
  const related = page.getByRole("region", { name: "关联内容", exact: true });
  const plain = related.locator(".wiki-related-item").filter({ has: page.getByText("普通关联", { exact: true }) });
  await plain.getByRole("button", { name: "重命名关联：重命名目标", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "重命名关联", exact: true });
  const input = dialog.getByLabel("关联名称", { exact: true });
  assert.equal(await input.inputValue(), "");
  await input.fill("取消这个名字");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await plain.getByRole("button", { name: "重命名关联：重命名目标", exact: true }).click();
  assert.equal(await input.inputValue(), "");
  await input.fill("已用名称");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.getByRole("alert").getByText("这两份内容之间已存在同名关联，请使用其他名称", { exact: true }).waitFor();
  assert.equal(await input.inputValue(), "已用名称");
  await input.fill("参考图");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await related.getByText("参考图", { exact: true }).waitFor();
  await related.getByText("已用名称", { exact: true }).waitFor();
  assert.equal(await related.getByRole("article").count(), 2);
  await page.screenshot({ path: "data/wiki-relation-rename-desktop.png", fullPage: true });
  await related.getByRole("button", { name: "打开内容：重命名目标", exact: true }).first().click();
  const renamed = related.locator(".wiki-related-item").filter({ has: page.getByText("参考图", { exact: true }) });
  await renamed.getByRole("button", { name: "重命名关联：重命名来源", exact: true }).click();
  assert.equal(await input.inputValue(), "参考图");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true);
  await page.screenshot({ path: "data/wiki-relation-rename-mobile.png", fullPage: true });
  await input.fill("");
  await input.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  await related.getByText("普通关联", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.reload();
  await page.getByRole("button", { name: "打开内容：重命名来源", exact: true }).click();
  await related.getByText("普通关联", { exact: true }).waitFor();
  await related.getByText("已用名称", { exact: true }).waitFor();
});

test("tag relations rename from the source and show the saved name on members", options, async (t) => {
  const { page, app, create } = await setup(t);
  const source = await create("标签来源"), target = await create("标签成员");
  const api = (route, method, body) => fetch(new URL(route, app.url), { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  await api(`api/elements/${target.id}`, "PATCH", { tags: ["合集"] });
  await api("api/relations/batch", "POST", { sourceId: source.id, targetTags: ["合集"], name: "原型图" });
  await page.reload();
  await page.getByRole("button", { name: "打开内容：标签来源", exact: true }).click();
  await page.getByRole("button", { name: "重命名标签关联：合集：原型图", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "重命名关联", exact: true });
  await dialog.getByText(/此修改会应用到 #合集 下所有内容的对应标签关联，包括未在当前画布显示的内容及以后加入的内容/).waitFor();
  await dialog.getByLabel("关联名称", { exact: true }).fill("参考来源");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("article", { name: "标签关联：合集：参考来源", exact: true }).waitFor();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: "打开内容：标签成员", exact: true }).click();
  await page.getByText("参考来源 · 通过 #合集 关联", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: /^重命名/ }).count(), 0);
});

test("Relation picker selects multiple elements and tags, shows inherited relations and removes a tag rule", options, async (t) => {
  const { page, app, create } = await setup(t);
  const source = await create("关联来源"), a = await create("目标甲"), b = await create("目标乙");
  const api = (route, method = "GET", body) => fetch(new URL(route, app.url), { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  await api(`api/elements/${source.id}`, "PATCH", { tags: ["仪玄"] });
  await api(`api/elements/${a.id}`, "PATCH", { tags: ["仪玄"] });
  await api(`api/elements/${b.id}`, "PATCH", { tags: ["其他"] });
  await page.reload();
  await page.getByRole("button", { name: "打开内容：关联来源", exact: true }).click();
  await page.getByRole("button", { name: "添加关联", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "添加关联", exact: true });
  await openRelationAdvanced(picker);
  await picker.getByLabel("关系名称", { exact: true }).fill("配套内容");
  await picker.getByRole("button", { name: "选择：目标甲", exact: true }).click();
  await picker.getByLabel("搜索可关联内容").fill("目标乙");
  await picker.getByRole("button", { name: "选择：目标乙", exact: true }).click();
  await picker.getByRole("button", { name: "关联这 2 项内容", exact: true }).click();
  await picker.waitFor({ state: "hidden" });
  assert.equal((await (await api(`api/elements/${source.id}/relations`)).json()).relations.length, 2);
  await page.getByRole("button", { name: "添加关联", exact: true }).click();
  await openRelationAdvanced(picker);
  await picker.getByLabel("关系名称", { exact: true }).fill("参考图");
  await picker.getByRole("button", { name: "按标签关联", exact: true }).click();
  await picker.getByRole("button", { name: "选择标签：仪玄", exact: true }).click();
  await picker.getByRole("button", { name: "选择标签：其他", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await picker.evaluate((el) => el.scrollWidth <= el.clientWidth), true);
  await picker.getByRole("button", { name: "保存关联", exact: true }).click();
  await picker.waitFor({ state: "hidden" });
  const tagCard = page.getByRole("article", { name: "标签关联：仪玄：参考图", exact: true });
  await tagCard.waitFor();
  await tagCard.getByText("共 1 项", { exact: true }).waitFor();
  const related = page.getByRole("region", { name: "关联内容", exact: true });
  assert.equal(await related.getByRole("heading", { name: "关联内容 4", exact: true }).count(), 1);
  assert.equal(await related.getByRole("button", { name: "打开内容：目标甲", exact: true }).count(), 1);
  await tagCard.getByRole("button").click();
  const members = page.getByRole("dialog", { name: "标签内容：仪玄", exact: true });
  await members.getByRole("button", { name: "打开内容：目标甲", exact: true }).waitFor();
  assert.equal(await members.getByRole("button", { name: "打开内容：关联来源", exact: true }).count(), 0);
  await members.getByRole("button", { name: "关闭标签内容", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "解除关联：关联来源", exact: true }).count(), 0);
  await page.getByRole("button", { name: "解除标签关联：仪玄：参考图", exact: true }).click();
  await tagCard.waitFor({ state: "hidden" });
  const remaining = await (await api(`api/elements/${a.id}/relations`)).json();
  assert.deepEqual(remaining.relations.map((r) => r.name), ["配套内容"]);
  assert.equal((await (await api(`api/elements/${b.id}/relations`)).json()).relations.length, 2);
});

test("Tag collection covers stay compact, open paginated members and retain incoming content cards", options, async (t) => {
  const { page, app, create } = await setup(t);
  const api = (route, method = "GET", body) => fetch(new URL(route, app.url), { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const source = await create("原型图来源"), incoming = await create("反向关联来源");
  await api(`api/elements/${source.id}`, "PATCH", { tags: ["仪玄"] });
  await api(`api/elements/${incoming.id}`, "PATCH", { tags: ["仪玄"] });
  for (let i = 0; i < 4; i++) {
    const bytes = await sharp({ create: { width: 200, height: 260, channels: 3, background: ["#9bb7a2", "#a8b5ce", "#d7bd98", "#9db8b8"][i] } }).png().toBuffer();
    await fetch(new URL("api/images", app.url), { method: "POST", headers: { "x-file-name": encodeURIComponent(`封面-${i}.png`), "x-image-tags": Buffer.from(JSON.stringify(["仪玄"])).toString("base64") }, body: bytes });
  }
  for (let i = 0; i < 10; i++) await api("api/elements", "POST", { body: `合集成员 ${i}`, tags: ["仪玄"] });
  await api("api/relations/batch", "POST", { sourceId: source.id, targetTags: ["仪玄"], name: "原型图" });
  await api("api/relations/batch", "POST", { sourceId: incoming.id, targetTags: ["仪玄"], name: "原型图" });
  await page.reload();
  await page.getByRole("button", { name: "打开内容：原型图来源", exact: true }).click();
  const related = page.getByRole("region", { name: "关联内容", exact: true });
  const card = related.getByRole("article", { name: "标签关联：仪玄：原型图", exact: true });
  await card.getByText("共 15 项", { exact: true }).waitFor();
  assert.equal(await related.getByRole("heading", { name: "关联内容 2", exact: true }).count(), 1);
  assert.equal(await related.getByRole("article").count(), 2);
  assert.equal(await card.locator("img").count(), 4);
  await page.waitForFunction(() => [...document.querySelectorAll(".wiki-tag-cover img")].every((img) => img.complete && img.naturalWidth > 0));
  await related.getByText("原型图 · 通过 #仪玄 关联", { exact: true }).waitFor();
  await related.getByRole("button", { name: "打开内容：反向关联来源", exact: true }).waitFor();
  await page.screenshot({ path: "data/wiki-tag-cards-desktop.png", fullPage: true });
  await card.getByRole("button").click();
  const members = page.getByRole("dialog", { name: "标签内容：仪玄", exact: true });
  await members.getByText("共 15 项", { exact: true }).waitFor();
  assert.equal(await members.getByRole("article").count(), 12);
  assert.equal(await members.getByRole("button", { name: "打开内容：原型图来源", exact: true }).count(), 0);
  await members.getByRole("button", { name: "下一页", exact: true }).click();
  await members.getByText("2 / 2", { exact: true }).waitFor();
  assert.equal(await members.getByRole("article").count(), 3);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await members.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true);
  await page.screenshot({ path: "data/wiki-tag-members-mobile.png", fullPage: true });
  await members.getByRole("button", { name: "打开内容：反向关联来源", exact: true }).click();
  await members.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "反向关联来源", exact: true }).waitFor();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await card.waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: "data/wiki-tag-cards-mobile.png", fullPage: true });
});

test("Trash supports selected permanent deletion, cancellation and clearing outside filters", options, async (t) => {
  const { page, app, create } = await setup(t);
  const first = await create("删除这一条"), second = await create("筛选外内容"), keep = await create("保留正常内容");
  for (const item of [first, second]) await fetch(new URL(`api/elements/${item.id}`, app.url), { method: "DELETE" });
  await page.getByRole("complementary", { name: "内容导航" }).getByRole("button", { name: "回收站", exact: true }).click();
  await page.getByText("2 条内容", { exact: true }).waitFor();
  await page.getByLabel("更多操作", { exact: true }).click();
  await page.getByRole("button", { name: "批量管理", exact: true }).click();
  await page.getByRole("button", { name: "选择内容：删除这一条", exact: true }).click();
  await page.getByRole("button", { name: "删除选中项", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认永久删除" });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await page.getByRole("checkbox", { name: "选择内容：删除这一条", exact: true }).isChecked(), true);
  await page.getByRole("button", { name: "删除选中项", exact: true }).click();
  await dialog.getByPlaceholder("永久删除").fill("永久删除");
  await dialog.getByRole("button", { name: "确认永久删除", exact: true }).click();
  await page.getByText("1 条内容", { exact: true }).waitFor();
  assert.equal((await fetch(new URL(`api/elements/${first.id}/restore`, app.url), { method: "POST" })).status, 404);
  await page.getByRole("textbox", { name: "搜索内容" }).fill("没有匹配");
  await page.getByRole("heading", { name: "没有找到相关内容" }).waitFor();
  await page.getByRole("button", { name: "清空回收站", exact: true }).click();
  await dialog.getByText(/包括尚未加载/).waitFor();
  await dialog.getByPlaceholder("永久删除").fill("永久删除");
  await dialog.getByRole("button", { name: "确认永久删除", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "清空筛选", exact: true }).click();
  await page.getByRole("heading", { name: "回收站是空的", exact: true }).waitFor();
  assert.equal((await fetch(new URL(`api/elements/${keep.id}`, app.url))).status, 200);
});

async function sendImageEvent(page, type, bytes, name) {
  return page.evaluate(({ type, bytes, name }) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], name, { type: "image/png" }));
    const target = type === "paste" ? document.activeElement : document.querySelector("dialog .wiki-draft-list");
    const event = type === "paste" ? new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
      : new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true });
    return target.dispatchEvent(event);
  }, { type, bytes: [...bytes], name });
}

for (const missingPaste of [false, true]) test(`Ctrl+V opens image drafts before and after saving with ${missingPaste ? "missing" : "native"} paste events`, options, async (t) => {
  const { page } = await setup(t, { realClipboard: true });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("heading", { name: "全部内容", exact: true }).waitFor();
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#a5bd9c" } }).png().toBuffer();
  await page.evaluate(async (bytes) => {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(bytes)], { type: "image/png" }) })]);
  }, [...image]);
  if (missingPaste) await page.evaluate(() => {
    window.addEventListener("paste", (event) => { event.preventDefault(); event.stopImmediatePropagation(); }, true);
  });
  await page.getByRole("heading", { name: "全部内容", exact: true }).click();
  await page.keyboard.press("Control+v");
  const dialog = page.getByRole("dialog", { name: "新增内容", exact: true });
  await dialog.locator("img").waitFor();
  assert.equal(await dialog.locator("img").count(), 1);
  await dialog.getByRole("button", { name: "保存全部", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "全部内容", exact: true }).click();
  await page.keyboard.press("Control+v");
  await dialog.locator("img").waitFor();
  assert.equal(await dialog.locator("img").count(), 1);
});

test("a failed clipboard fallback shows an error instead of silently doing nothing", options, async (t) => {
  const { page } = await setup(t, { realClipboard: true });
  await page.getByRole("heading", { name: "全部内容", exact: true }).waitFor();
  await page.evaluate(() => {
    window.addEventListener("paste", (event) => { event.preventDefault(); event.stopImmediatePropagation(); }, true);
    Object.defineProperty(navigator, "clipboard", { value: { read: async () => { throw new Error("Clipboard unavailable"); } } });
  });
  await page.getByRole("heading", { name: "全部内容", exact: true }).click();
  await page.keyboard.press("Control+v");
  await page.getByText(/无法读取剪贴板图片：Clipboard unavailable/).waitFor();
  assert.equal(await page.getByRole("dialog", { name: "新增内容", exact: true }).count(), 0);
});

test("Clipboard images and dropped files join the same draft as consecutive independent text elements", options, async (t) => {
  const { page, app } = await setup(t);
  await page.getByRole("heading", { name: "全部内容", exact: true }).waitFor();
  const image = await sharp({ create: { width: 80, height: 110, channels: 3, background: "#a5bd9c" } }).png().toBuffer();
  const second = await sharp(image).rotate(90).png().toBuffer();
  const third = await sharp(image).resize(40,40).png().toBuffer();
  assert.equal(await sendImageEvent(page, "paste", image, "粘贴图片.png"), false);
  const dialog = page.getByRole("dialog", { name: "新增内容", exact: true });
  await dialog.getByRole("img", { name: "粘贴图片.png", exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.matches('dialog textarea'));
  assert.equal(await dialog.getByLabel("文字", { exact: true }).evaluate((node) => node === document.activeElement), true);
  await dialog.getByLabel("本次标签", { exact: true }).fill("仪玄");
  await dialog.getByLabel("本次标签", { exact: true }).press("Enter");
  await dialog.getByLabel("文字", { exact: true }).fill("第一段文字\n  保留空格");
  await dialog.getByRole("button", { name: "添加文字", exact: true }).click();
  await dialog.getByLabel("文字", { exact: true }).last().fill("第二段文字");
  assert.equal(await sendImageEvent(page, "paste", second, "继续粘贴.png"), false);
  await dialog.getByRole("img", { name: "继续粘贴.png", exact: true }).waitFor();
  await sendImageEvent(page, "drop", third, "拖入图片.png");
  await dialog.getByRole("img", { name: "拖入图片.png", exact: true }).waitFor();
  assert.deepEqual(await dialog.getByLabel("文字", { exact: true }).evaluateAll((nodes) => nodes.map((node) => node.value)), ["第一段文字\n  保留空格", "第二段文字", ""]);
  const acceptsText = await dialog.getByLabel("文字", { exact: true }).last().evaluate((node) => {
    const data = new DataTransfer(); data.setData("text/plain", "普通文字粘贴");
    return node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  assert.equal(acceptsText, true);
  await dialog.locator(".wiki-form-fields").evaluate((node) => { node.scrollTop = 0; });
  await page.screenshot({ path: "data/wiki-mixed-composer.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await dialog.locator(".wiki-form-fields").evaluate((node) => { node.scrollTop = 0; });
  await page.screenshot({ path: "data/wiki-mixed-composer-mobile.png", fullPage: true, animations: "disabled" });
  await dialog.getByRole("button", { name: "保存全部", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const data = await (await fetch(new URL("api/elements", app.url))).json();
  assert.equal(data.pagination.total, 5);
  assert.ok(data.elements.every((element) => element.tags.includes("仪玄")));
  const pasted = data.elements.find((element) => element.image?.originalName === "粘贴图片.png");
  assert.deepEqual(Buffer.from(await (await fetch(new URL(pasted.image.url, app.url))).arrayBuffer()), image);
  await page.getByRole("button", { name: "打开内容：第二段文字", exact: true }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  assert.equal(await sendImageEvent(page, "paste", image, "不应拦截.png"), true);
  assert.equal(await page.getByRole("dialog", { name: "新增内容", exact: true }).count(), 0);
});

test("A mixed save retains failed text for editing and retry without repeating confirmed text or image saves", options, async (t) => {
  const { page, app } = await setup(t);
  await page.locator(".wiki-page-header").getByRole("button", { name: "新增内容", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新增内容", exact: true });
  await dialog.getByLabel("本次标签", { exact: true }).fill("仪玄");
  await dialog.getByLabel("文字", { exact: true }).fill("已经保存的文字");
  await dialog.getByRole("button", { name: "添加文字", exact: true }).click();
  await dialog.getByLabel("文字", { exact: true }).last().fill("待重试文字");
  const image = await sharp({ create: { width: 8, height: 10, channels: 3, background: "#bca5ad" } }).png().toBuffer();
  await page.getByLabel("导入图片或视频文件").setInputFiles({ name: "重试样本.png", mimeType: "image/png", buffer: image });
  let fail = true, textCalls = [], imageCalls = 0;
  await page.route("**/api/elements", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON().body; textCalls.push(body);
    if (body === "待重试文字" && fail) { fail = false; return route.fulfill({ status: 503, json: { error: "模拟文字保存失败" } }); }
    return route.continue();
  });
  await page.route("**/api/images", (route) => { imageCalls++; return route.continue(); });
  await dialog.getByRole("button", { name: "保存全部", exact: true }).click();
  await dialog.getByText("模拟文字保存失败", { exact: true }).waitFor();
  await dialog.getByText(/1 项未保存，草稿已保留/).waitFor();
  assert.equal((await (await fetch(new URL("api/elements", app.url))).json()).pagination.total, 2);
  assert.equal(await dialog.getByLabel("本次标签", { exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByLabel("文字", { exact: true }).first().isDisabled(), true);
  await dialog.getByLabel("文字", { exact: true }).nth(1).fill("修改后的重试文字");
  await dialog.getByRole("button", { name: "重试未保存项", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(textCalls, ["已经保存的文字", "待重试文字", "修改后的重试文字"]);
  assert.equal(imageCalls, 1);
  const data = await (await fetch(new URL("api/elements", app.url))).json();
  assert.equal(data.pagination.total, 3);
  assert.ok(data.elements.every((element) => element.tags.includes("仪玄")));
  assert.ok(data.elements.some((element) => element.body === "修改后的重试文字"));
});

test("One composer saves interleaved image and text elements with common and individual tags", options, async (t) => {
  const { page, app } = await setup(t);
  const actions = page.locator(".wiki-page-header .wiki-actions");
  assert.equal(await actions.getByRole("button").count(), 1);
  await actions.getByRole("button", { name: "新增内容", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新增内容", exact: true });
  assert.equal(await dialog.getByLabel("标题", { exact: true }).count(), 0);
  await dialog.getByLabel("文字", { exact: true }).fill("保留\n  文字草稿");
  await dialog.getByLabel("本次标签", { exact: true }).fill("人物 A");
  const picker = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "导入图片或视频", exact: true }).click();
  const image = await sharp({ create: { width: 40, height: 60, channels: 3, background: "#a5bd9c" } }).png().toBuffer();
  await (await picker).setFiles({ name: "从统一入口导入.png", mimeType: "image/png", buffer: image });
  await dialog.getByText("从统一入口导入.png", { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel("文字", { exact: true }).first().inputValue(), "保留\n  文字草稿");
  assert.equal(await dialog.getByLabel("本次标签").inputValue(), "人物 A");
  await dialog.getByLabel("文字", { exact: true }).last().fill("第二段独立文字");
  const first = dialog.getByRole("article", { name: "文字内容 1", exact: true });
  await first.locator("summary").click();
  await first.getByLabel("此项标签", { exact: true }).fill("Prompt");
  const photo = dialog.getByRole("article", { name: "图片内容 2", exact: true });
  await photo.locator("summary").click();
  await photo.getByLabel("此项标签", { exact: true }).fill("参考图");
  await dialog.getByRole("button", { name: "添加文字", exact: true }).click();
  await dialog.getByLabel("文字", { exact: true }).last().fill("可移除的草稿");
  await dialog.getByRole("button", { name: "移除待保存内容 4", exact: true }).click();
  assert.equal((await (await fetch(new URL("api/elements", app.url))).json()).pagination.total, 0);
  await page.screenshot({ path: "data/wiki-add-content.png", fullPage: true });
  await dialog.getByRole("button", { name: "保存全部", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "打开内容：从统一入口导入.png", exact: true }).waitFor();
  const data = await (await fetch(new URL("api/elements", app.url))).json();
  assert.equal(data.pagination.total, 3);
  assert.deepEqual(data.elements.find((element) => element.kind === "image").tags, ["人物 A", "参考图"]);
  assert.deepEqual(data.elements.find((element) => element.body === "保留\n  文字草稿").tags, ["提示词", "人物 A"]);
  assert.deepEqual(data.elements.find((element) => element.body === "第二段独立文字").tags, ["人物 A"]);
  for (const element of data.elements) assert.equal((await (await fetch(new URL(`api/elements/${element.id}/relations`, app.url))).json()).relations.length, 0);
});

test("Tag input turns Enter into inline chips, keeps focus, respects IME and wraps long tags", options, async (t) => {
  const { page, app } = await setup(t);
  await page.locator(".wiki-page-header").getByRole("button", { name: "新增内容", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新增内容", exact: true });
  await page.waitForFunction(() => document.activeElement?.matches("dialog textarea"));
  await dialog.getByLabel("文字", { exact: true }).fill("标签输入练习");
  const input = dialog.getByLabel("本次标签", { exact: true });
  const chips = dialog.locator(".wiki-tag-field .wiki-tag-token > span");
  await input.fill("仪玄");
  await input.evaluate((node) => node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true })));
  assert.equal(await input.inputValue(), "仪玄");
  assert.equal(await chips.count(), 0);
  await input.evaluate((node) => node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true })));
  assert.equal(await chips.count(), 0);
  await input.press("Enter");
  assert.deepEqual(await chips.allTextContents(), ["仪玄"]);
  assert.equal(await input.inputValue(), "");
  assert.equal(await input.evaluate((node) => document.activeElement === node), true);
  await input.press("Enter");
  assert.equal((await (await fetch(new URL("api/elements", app.url))).json()).pagination.total, 0);
  await input.fill("参考图"); await input.press("Enter");
  await input.fill("仪玄"); await input.press("Enter");
  assert.deepEqual(await chips.allTextContents(), ["仪玄", "参考图"]);
  await dialog.getByRole("button", { name: "移除标签：参考图", exact: true }).click();
  assert.equal(await input.evaluate((node) => document.activeElement === node), true);
  await input.fill("光影"); await input.press("Enter");
  assert.deepEqual(await chips.allTextContents(), ["仪玄", "光影"]);
  assert.notEqual(await chips.first().evaluate((node) => getComputedStyle(node.parentElement).backgroundColor), "rgba(0, 0, 0, 0)");
  await dialog.locator(".wiki-tag-input").screenshot({ path: "data/wiki-tag-chips.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  const longTag = "长".repeat(60);
  await input.fill(longTag); await input.press("Enter");
  assert.equal(await dialog.locator(".wiki-tag-field").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: "data/wiki-tag-chips-mobile.png", fullPage: true, animations: "disabled" });
  await input.fill("草稿标签");
  await dialog.getByRole("button", { name: "保存全部", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const saved = (await (await fetch(new URL("api/elements", app.url))).json()).elements[0];
  assert.deepEqual(saved.tags, ["仪玄", "光影", longTag, "草稿标签"]);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑内容", exact: true });
  assert.deepEqual(await editor.locator(".wiki-tag-field .wiki-tag-token > span").allTextContents(), saved.tags);
});

test("Custom relation names connect independent editable text and appear on both sides", options, async (t) => {
  const { page, app, create } = await setup(t);
  const target = await create("海边散步时记录的一段文字。");
  const other = await create("另一次散步的记录。");
  await page.reload();
  await page.locator(".wiki-page-header").getByRole("button", { name: "新增内容", exact: true }).click();
  const creation = page.getByRole("dialog", { name: "新增内容", exact: true });
  await creation.getByLabel("文字", { exact: true }).fill("每段文字都是独立内容");
  assert.equal(await creation.getByLabel("标题", { exact: true }).count(), 0);
  await page.screenshot({ path: "data/wiki-neutral-text-create.png", fullPage: true, animations: "disabled" });
  await creation.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "放弃未保存内容", exact: true }).click();
  await page.getByRole("button", { name: `打开内容：${target.body}`, exact: true }).click();
  await page.getByRole("button", { name: "添加关联", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "添加关联", exact: true });
  await openRelationAdvanced(picker);
  await picker.getByLabel("关系名称", { exact: true }).fill("散步主题");
  await picker.getByRole("button", { name: "新建文字", exact: true }).click();
  assert.equal(await picker.getByLabel("标题", { exact: true }).count(), 0);
  await picker.getByLabel("文字", { exact: true }).fill("海边散步");
  await picker.getByLabel("标签", { exact: true }).fill("散步");
  await picker.getByRole("button", { name: "保存并关联", exact: true }).click();
  await picker.waitFor({ state: "hidden" });
  await page.getByText("散步主题", { exact: true }).waitFor();
  assert.equal(await page.locator(".wiki-text-document pre").innerText(), target.body);
  await page.getByRole("button", { name: "打开内容：海边散步", exact: true }).click();
  await page.getByText("散步主题", { exact: true }).waitFor();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑内容", exact: true });
  assert.equal(await editor.getByLabel("文字", { exact: true }).inputValue(), "海边散步");
  await editor.getByLabel("文字", { exact: true }).fill("傍晚的海边散步");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "傍晚的海边散步", exact: true }).waitFor();
  await page.getByRole("button", { name: "添加关联", exact: true }).click();
  await openRelationAdvanced(picker);
  await picker.getByLabel("关系名称", { exact: true }).fill("参考来源");
  await picker.getByRole("button", { name: `选择：${other.body}`, exact: true }).click();
  await picker.getByRole("button", { name: "关联这 1 项内容", exact: true }).click();
  await picker.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelectorAll('.wiki-relation-label').length === 2);
  await page.getByRole("button", { name: `打开内容：${target.body}`, exact: true }).click();
  await page.getByRole("button", { name: "打开内容：傍晚的海边散步", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: "data/wiki-title-relation-mobile.png", fullPage: true });
  await page.getByLabel("关联操作：傍晚的海边散步", { exact: true }).click();
  await page.getByRole("button", { name: "解除关联：傍晚的海边散步", exact: true }).click();
  await page.getByText("还没有关联。把参考图、文字或人物连接到这里。", { exact: true }).waitFor();
  const read = async (route) => (await (await fetch(new URL(route, app.url))).json());
  assert.deepEqual(await read(`api/elements/${target.id}`), target);
  const remaining = (await read(`api/elements/${other.id}/relations`)).relations;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].element.body, "傍晚的海边散步");
  assert.equal((await read("api/elements")).pagination.total, 3);
});

test("Deletion lives behind bulk management, handles partial failures and undoes an image/text batch with relations", options, async (t) => {
  const { page, app, create } = await setup(t);
  const note = await create("可以删除的文字");
  const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#71896a" } }).png().toBuffer();
  const image = await (await fetch(new URL("api/images", app.url), { method: "POST", headers: { "x-file-name": "delete-me.png" }, body: bytes })).json();
  await fetch(new URL("api/relations", app.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leftId: image.id, rightId: note.id }) });
  await page.reload();
  let calls = 0;
  await page.route(`**/api/elements/${image.id}`, async (route) => {
    if (route.request().method() === "DELETE" && ++calls === 1) return route.fulfill({ status: 500, json: { error: "模拟删除失败" } });
    return route.continue();
  });
  assert.equal(await page.getByRole("button", { name: /^删除内容：/ }).count(), 0);
  assert.equal(await page.getByRole("checkbox", { name: /^选择内容：/ }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "批量管理", exact: true }).isVisible(), false);
  await page.screenshot({ path: "data/wiki-clean-cards.png", fullPage: true });
  await page.getByLabel("更多操作", { exact: true }).click();
  await page.getByRole("button", { name: "批量管理", exact: true }).click();
  const batch = page.getByRole("region", { name: "批量管理", exact: true });
  const remove = batch.getByRole("button", { name: "移入回收站", exact: true });
  assert.equal(await remove.isDisabled(), true);
  await page.getByRole("checkbox", { name: "选择内容：delete-me.png", exact: true }).check();
  await page.getByRole("button", { name: "选择内容：可以删除的文字", exact: true }).click();
  await batch.getByText("已选 2 项", { exact: true }).waitFor();
  await remove.click();
  await page.getByRole("alert").getByText(/1 条未删除：模拟删除失败/).waitFor();
  await batch.getByText("已选 1 项", { exact: true }).waitFor();
  assert.equal(await page.getByRole("checkbox", { name: "选择内容：delete-me.png", exact: true }).isChecked(), true);
  assert.equal((await fetch(new URL(`api/elements/${note.id}`, app.url))).status, 404);
  assert.equal((await fetch(new URL(image.image.url, app.url))).status, 200);
  await page.getByRole("button", { name: "撤销删除", exact: true }).click();
  await page.getByRole("checkbox", { name: "选择内容：可以删除的文字", exact: true }).waitFor();
  await remove.click();
  await page.getByRole("checkbox", { name: "选择内容：delete-me.png", exact: true }).waitFor({ state: "hidden" });
  assert.equal(calls, 2);
  assert.equal((await fetch(new URL(image.image.url, app.url))).status, 404);
  await page.getByRole("button", { name: "撤销删除", exact: true }).click();
  await page.getByRole("checkbox", { name: "选择内容：delete-me.png", exact: true }).waitFor();
  assert.deepEqual(Buffer.from(await (await fetch(new URL(image.image.url, app.url))).arrayBuffer()), bytes);
  assert.equal((await (await fetch(new URL(`api/elements/${note.id}/relations`, app.url))).json()).relations[0].element.id, image.id);
  await batch.getByRole("button", { name: "全选已加载内容", exact: true }).click();
  await batch.getByText("已选 2 项", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: "data/wiki-batch-manage-mobile.png", fullPage: true });
  await remove.click();
  await page.getByText("2 条内容已移入回收站", { exact: true }).waitFor();
  assert.equal((await fetch(new URL(`api/elements/${note.id}`, app.url))).status, 404);
  assert.equal((await fetch(new URL(image.image.url, app.url))).status, 404);
  let failRestore = true;
  await page.route(`**/api/elements/${image.id}/restore`, (route) => {
    if (failRestore) { failRestore = false; return route.fulfill({ status: 500, json: { error: "模拟恢复失败" } }); }
    return route.continue();
  });
  await page.getByRole("button", { name: "撤销删除", exact: true }).click();
  await page.getByRole("alert").getByText(/1 条恢复失败：模拟恢复失败/).waitFor();
  assert.equal((await fetch(new URL(`api/elements/${note.id}`, app.url))).status, 200);
  await page.getByRole("button", { name: "撤销删除", exact: true }).click();
  await page.getByRole("checkbox", { name: "选择内容：delete-me.png", exact: true }).waitFor();
  assert.equal((await (await fetch(new URL(`api/elements/${note.id}/relations`, app.url))).json()).relations[0].element.id, image.id);
  await batch.getByRole("button", { name: "退出管理", exact: true }).click();
  assert.equal(await page.getByRole("checkbox", { name: /^选择内容：/ }).count(), 0);
  await page.getByRole("button", { name: "打开内容：可以删除的文字", exact: true }).click();
  await openDetailMenu(page);
  await page.getByRole("button", { name: "移入回收站", exact: true }).click();
  await page.getByRole("complementary", { name: "内容导航" }).getByRole("button", { name: "回收站", exact: true }).click();
  await page.getByRole("button", { name: "恢复内容", exact: true }).click();
  await page.getByRole("heading", { name: "回收站是空的", exact: true }).waitFor();
  await page.getByRole("complementary", { name: "内容导航" }).getByRole("button", { name: "全部内容", exact: true }).click();
  await page.getByRole("button", { name: "打开内容：可以删除的文字", exact: true }).waitFor();
  assert.equal((await (await fetch(new URL(`api/elements/${note.id}/relations`, app.url))).json()).relations.length, 1);
});

test("Bulk selection survives automatic loading and is cleared by filters and navigation", options, async (t) => {
  const { page, create } = await setup(t);
  for (let i = 0; i < 80; i++) await create(`批量选择 ${i}`);
  await page.reload();
  await page.getByLabel("更多操作", { exact: true }).click();
  await page.getByRole("button", { name: "批量管理", exact: true }).click();
  const batch = page.getByRole("region", { name: "批量管理", exact: true });
  await batch.getByRole("button", { name: "全选已加载内容", exact: true }).click();
  const selected = Number((await batch.innerText()).match(/已选 (\d+) 项/)[1]);
  assert.ok(selected > 0 && selected < 80);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.locator(".wiki-load-more").scrollIntoViewIfNeeded();
    await page.waitForFunction(() => !document.querySelector('.wiki-load-more [role="status"]')?.textContent.includes("正在"));
  }
  await page.waitForFunction(() => document.querySelectorAll('.wiki-card-select').length === 80);
  assert.equal(await page.getByRole("checkbox", { checked: true }).count(), selected);
  await batch.getByRole("button", { name: "全选已加载内容", exact: true }).click();
  await batch.getByText("已选 80 项", { exact: true }).waitFor();
  await page.getByLabel("搜索内容", { exact: true }).fill("批量选择 37");
  await batch.getByText("已选 0 项", { exact: true }).waitFor();
  await page.getByRole("checkbox", { name: "选择内容：批量选择 37", exact: true }).check();
  await batch.getByRole("button", { name: "清空选择", exact: true }).click();
  assert.equal(await batch.getByRole("button", { name: "移入回收站", exact: true }).isDisabled(), true);
  await page.getByRole("checkbox", { name: "选择内容：批量选择 37", exact: true }).check();
  await page.getByRole("complementary", { name: "内容导航" }).getByRole("button", { name: "文字", exact: true }).click();
  await batch.waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("checkbox", { name: /^选择内容：/ }).count(), 0);
});

test("Batch import waits for confirmation, assigns tags, reuses duplicates, distinguishes names and filters both kinds", options, async (t) => {
  const { page, app } = await setup(t);
  const image = await sharp({ create: { width: 40, height: 60, channels: 3, background: "#a5bd9c" } }).png().toBuffer();
  const different = await sharp({ create: { width: 60, height: 60, channels: 3, background: "#bd9caa" } }).png().toBuffer();
  const file = (name, buffer) => ({ name, mimeType: "image/png", buffer });
  const fileInput = page.getByLabel("导入图片或视频文件");
  const dialog = page.getByRole("dialog", { name: "新增内容", exact: true });
  await fileInput.setInputFiles([file("共同名字.png", image), file("第二张.png", different)]);
  await dialog.waitFor();
  assert.equal((await (await fetch(new URL("api/elements", app.url))).json()).pagination.total, 0);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "放弃未保存内容", exact: true }).click();
  await fileInput.setInputFiles([file("共同名字.png", image), file("第二张.png", different)]);
  await dialog.getByLabel("本次标签", { exact: true }).fill("人物 A");
  await dialog.getByLabel("本次标签", { exact: true }).press("Enter");
  await dialog.getByLabel("本次标签", { exact: true }).fill("参考图");
  await dialog.getByRole("button", { name: "保存全部", exact: true }).click();
  await page.getByRole("button", { name: "打开内容：第二张.png", exact: true }).waitFor();
  let data = await (await fetch(new URL("api/elements", app.url))).json();
  assert.equal(data.pagination.total, 2);
  assert.ok(data.elements.every((element) => element.tags.includes("人物 A") && element.tags.includes("参考图")));
  await fileInput.setInputFiles(file("换个名字.png", image));
  await dialog.getByLabel("本次标签", { exact: true }).fill("新标签");
  await dialog.getByRole("button", { name: "保存全部", exact: true }).click();
  await page.getByText("已复用已有图片，标签已合并", { exact: true }).waitFor();
  await page.getByRole("button", { name: "查看保存结果：换个名字.png", exact: true }).click();
  await page.getByRole("heading", { name: "共同名字.png", exact: true }).waitFor();
  assert.deepEqual(await page.locator(".wiki-detail-tags .wiki-tag").allTextContents(), ["人物 A", "参考图", "新标签"]);
  await fileInput.setInputFiles(file("详情页再次导入.png", image));
  await dialog.getByLabel("本次标签", { exact: true }).fill("详情补充");
  await dialog.getByRole("button", { name: "保存全部", exact: true }).click();
  await page.locator(".wiki-detail-tags").getByText("详情补充", { exact: true }).waitFor();
  await page.getByRole("button", { name: "编辑标签", exact: true }).click();
  let editor = page.getByRole("dialog", { name: "编辑标签", exact: true });
  await editor.getByRole("button", { name: "移除标签：参考图", exact: true }).click();
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await page.waitForFunction(() => !document.querySelector('.wiki-detail-tags')?.textContent.includes('参考图'));
  await page.getByRole("button", { name: "返回", exact: true }).click();
  const third = await sharp(image).rotate(90).png().toBuffer();
  await fileInput.setInputFiles(file("共同名字.png", third));
  await dialog.getByRole("button", { name: "保存全部", exact: true }).click();
  await page.getByText("同名不同内容，已另存", { exact: true }).waitFor();
  await page.locator(".wiki-page-header").getByRole("button", { name: "新增内容", exact: true }).click();
  editor = page.getByRole("dialog", { name: "新增内容", exact: true });
  await editor.getByLabel("文字", { exact: true }).fill("a portrait with soft light");
  await editor.getByLabel("本次标签", { exact: true }).fill("人物 A, Prompt");
  await editor.getByRole("button", { name: "保存全部", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await page.getByRole("region", { name: "内容详情", exact: true }).getByText("提示词", { exact: true }).waitFor();
  const savedText = (await (await fetch(new URL("api/elements", app.url))).json()).elements.find((element) => element.kind === "text");
  assert.equal(savedText.body, "a portrait with soft light");
  assert.deepEqual(savedText.tags, ["提示词", "人物 A"]);
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: "按标签筛选", exact: true }).click();
  await page.getByRole("checkbox", { name: "人物 A", exact: true }).check();
  await page.getByRole("button", { name: "按标签筛选", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.wiki-toolbar')?.textContent.includes('3 条内容'));
  await page.screenshot({ path: "data/wiki-tags-filter.png", fullPage: true });
  await page.getByRole("complementary", { name: "内容导航" }).getByRole("button", { name: "文字", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.wiki-toolbar')?.textContent.includes('1 条内容'));
  await page.getByRole("button", { name: "打开内容：a portrait with soft light", exact: true }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  editor = page.getByRole("dialog", { name: "编辑内容", exact: true });
  await editor.getByRole("button", { name: "移除标签：人物 A", exact: true }).click();
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("heading", { name: "没有找到相关内容", exact: true }).waitFor();
  await page.getByRole("button", { name: "清空筛选", exact: true }).click();
  await page.getByRole("button", { name: "打开内容：a portrait with soft light", exact: true }).waitFor();
  data = await (await fetch(new URL("api/elements", app.url))).json();
  assert.equal(data.pagination.total, 4);
  assert.equal(data.elements.filter((e) => e.kind === "text")[0].tags[0], "提示词");
});

test("Tags and import dialog fit a narrow viewport; invalid tags stay editable and never upload", options, async (t) => {
  const { page, app } = await setup(t);
  await page.setViewportSize({ width: 390, height: 844 });
  const image = await sharp({ create: { width: 4, height: 6, channels: 3, background: "#9cabaa" } }).png().toBuffer();
  await page.getByLabel("导入图片或视频文件").setInputFiles({ name: "很长的文件名".repeat(8) + ".png", mimeType: "image/png", buffer: image });
  const dialog = page.getByRole("dialog", { name: "新增内容", exact: true });
  const input = dialog.getByLabel("本次标签", { exact: true });
  await input.fill("长".repeat(61));
  await dialog.getByRole("button", { name: "保存全部", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  assert.equal((await (await fetch(new URL("api/elements", app.url))).json()).pagination.total, 0);
  await input.fill("标签".repeat(30));
  await input.press("Enter");
  assert.equal(await page.evaluate(() => document.querySelector('dialog').scrollWidth <= document.querySelector('dialog').clientWidth + 1), true);
  await page.screenshot({ path: "data/wiki-tags-import-mobile.png", fullPage: true });
  await dialog.getByRole("button", { name: "保存全部", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: /打开内容：很长的文件名/ }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test("Wiki UI completes image/text association, copy, edit, navigation, detach and trash/restore", options, async (t) => {
  const { page } = await setup(t);
  const image = await sharp({ create: { width: 40, height: 60, channels: 3, background: "#a5bd9c" } }).png().toBuffer();
  await page.getByLabel("导入图片或视频文件").setInputFiles({ name: "人物练习.png", mimeType: "image/png", buffer: image });
  await page.getByRole("dialog", { name: "新增内容", exact: true }).getByRole("button", { name: "保存全部", exact: true }).click();
  await page.getByRole("button", { name: "打开内容：人物练习.png", exact: true }).click();
  await page.getByRole("button", { name: "添加关联", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "添加关联", exact: true });
  await picker.getByRole("button", { name: "新建文字", exact: true }).click();
  const prompt = "portrait\n\n  warm light, 50% contrast";
  await picker.getByLabel("文字", { exact: true }).fill(prompt);
  await picker.getByRole("button", { name: "保存并关联", exact: true }).click();
  await picker.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: /^打开内容：portrait/ }).click();
  assert.equal(await page.locator(".wiki-text-document pre").innerText(), prompt);
  await page.locator(".wiki-text-document").getByRole("button", { name: "复制文字", exact: true }).click();
  await page.waitForFunction((expected) => window.copiedText === expected, prompt);
  await page.screenshot({ path: "data/wiki-text-copy-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑内容" });
  assert.equal(await editor.getByLabel("标题", { exact: true }).count(), 0);
  const edited = `人物 A 的设定\n${prompt}`;
  await editor.getByLabel("文字", { exact: true }).fill(edited);
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  assert.equal(await page.locator(".wiki-text-document pre").innerText(), edited);
  await page.getByLabel("关联操作：人物练习.png", { exact: true }).click();
  await page.getByRole("button", { name: "解除关联：人物练习.png", exact: true }).click();
  await page.getByText("还没有关联。把参考图、文字或人物连接到这里。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "添加关联", exact: true }).click();
  await page.getByRole("dialog", { name: "添加关联" }).getByRole("button", { name: "选择：人物练习.png", exact: true }).click();
  await page.getByRole("dialog", { name: "添加关联" }).getByRole("button", { name: "关联这 1 张图片", exact: true }).click();
  await page.getByRole("dialog", { name: "添加关联" }).waitFor({ state: "hidden" });
  await openDetailMenu(page);
  await page.getByRole("button", { name: "移入回收站", exact: true }).click();
  await page.getByRole("complementary", { name: "内容导航" }).getByRole("button", { name: "回收站", exact: true }).click();
  await page.getByRole("button", { name: "恢复内容", exact: true }).click();
  await page.getByRole("heading", { name: "回收站是空的" }).waitFor();
  await page.getByRole("complementary", { name: "内容导航" }).getByRole("button", { name: "全部内容", exact: true }).click();
  await page.getByLabel("搜索内容", { exact: true }).fill("contrast");
  await page.getByRole("button", { name: /^打开内容：人物 A 的设定/ }).click();
  await page.getByRole("button", { name: "打开内容：人物练习.png", exact: true }).waitFor();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  assert.equal(await page.getByLabel("搜索内容", { exact: true }).inputValue(), "contrast");
  await page.getByRole("link", { name: "Agent 对话", exact: true }).click();
  await page.getByRole("main", { name: "Agent 对话", exact: true }).waitFor();
});

test("Wiki retains created text after relation failure, retries once, and shares a person across two images", options, async (t) => {
  const { page, app, create } = await setup(t);
  const a = await create("关联入口");
  await page.reload();
  await page.getByRole("button", { name: "打开内容：关联入口", exact: true }).click();
  let calls = 0;
  await page.route("**/api/relations", (route) => {
    if (route.request().method() === "POST" && ++calls === 1) return route.fulfill({ status: 500, json: { error: "模拟关联失败" } });
    return route.continue();
  });
  await page.getByRole("button", { name: "添加关联", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "添加关联", exact: true });
  await picker.getByRole("button", { name: "新建文字", exact: true }).click();
  await picker.getByLabel("文字", { exact: true }).fill("人物 B");
  await picker.getByRole("button", { name: "保存并关联", exact: true }).click();
  await picker.getByText("模拟关联失败", { exact: true }).waitFor();
  await picker.getByRole("button", { name: "重试关联", exact: true }).click();
  await picker.waitFor({ state: "hidden" });
  const data = await (await fetch(new URL("api/elements", app.url))).json();
  assert.equal(data.pagination.total, 2);
  const person = data.elements.find((e) => e.id !== a.id);
  for (const [index, name] of ["第一张.png", "第二张.png"].entries()) {
    const image = await sharp({ create: { width: 15 + index, height: 20, channels: 3, background: "#b38e75" } }).png().toBuffer();
    const saved = await (await fetch(new URL("api/images", app.url), { method: "POST", headers: { "x-file-name": encodeURIComponent(name) }, body: image })).json();
    await fetch(new URL("api/relations", app.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leftId: person.id, rightId: saved.id }) });
  }
  await page.getByRole("button", { name: "打开内容：人物 B", exact: true }).click();
  await page.getByRole("button", { name: "打开内容：第一张.png", exact: true }).waitFor();
  await page.getByRole("button", { name: "打开内容：第二张.png", exact: true }).waitFor();
});

test("Wiki search ignores late replies and remains usable at narrow width", options, async (t) => {
  const { page, create } = await setup(t);
  await create("先前文字"); await create("最新文字");
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  await page.route("**/api/elements?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("q") === "先前") { await wait; await route.continue().catch(() => {}); }
    else await route.continue();
  });
  await page.getByLabel("搜索内容", { exact: true }).fill("先前");
  await page.getByLabel("搜索内容", { exact: true }).fill("最新");
  await page.getByRole("button", { name: "打开内容：最新文字", exact: true }).waitFor();
  release();
  await page.setViewportSize({ width: 390, height: 740 });
  assert.equal(await page.locator("body").evaluate((body) => body.scrollWidth <= innerWidth), true);
  await page.getByRole("button", { name: "打开内容：最新文字", exact: true }).click();
  await page.getByRole("button", { name: "添加关联", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加关联", exact: true });
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
});

test("Wiki restores relation pagination when following a link and returning", options, async (t) => {
  const { page, create, app } = await setup(t);
  const a = await create("多关联入口\n" + "line\n".repeat(30));
  for (let i = 0; i < 40; i++) {
    const b = await create(`关联 ${i}`);
    await fetch(new URL("api/relations", app.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leftId: a.id, rightId: b.id }) });
  }
  await page.reload();
  await page.getByLabel("搜索内容", { exact: true }).fill("多关联入口");
  await page.getByRole("button", { name: /^打开内容：多关联入口/ }).click();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByRole("button", { name: "打开内容：关联 0", exact: true }).click();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: "打开内容：关联 0", exact: true }).waitFor();
  assert.equal(await page.locator(".wiki-detail .wiki-paging span").innerText(), "2 / 2");
  await page.waitForFunction(() => window.scrollY > 0);
});

test("Mixed drafts keep per-item failures and block closing or navigation while saving", options, async (t) => {
  const { page, create } = await setup(t);
  await create("导入入口"); await page.reload();
  await page.getByRole("button", { name: "打开内容：导入入口", exact: true }).click();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  await page.route("**/api/images", async (route) => { await held; await route.continue(); });
  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#999999" } }).png().toBuffer();
  await page.getByLabel("导入图片或视频文件").setInputFiles([
    { name: "正常.png", mimeType: "image/png", buffer: image },
    { name: "损坏.png", mimeType: "image/png", buffer: Buffer.from("bad") },
  ]);
  await page.getByRole("dialog", { name: "新增内容", exact: true }).getByRole("button", { name: "保存全部", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新增内容", exact: true });
  await dialog.getByText("正在保存这项内容…", { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector(".wiki-agent-entry").getAttribute("aria-disabled") === "true");
  await page.locator(".wiki-agent-entry").dispatchEvent("click");
  assert.equal(await page.evaluate(() => window.location.hash), "#wiki");
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await page.getByRole("region", { name: "内容详情", exact: true }).isVisible(), true);
  release();
  await dialog.getByText("已保存", { exact: true }).waitFor();
  await dialog.getByText(/图片无法读取/).waitFor();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "放弃未保存内容", exact: true }).click();
  assert.equal(await page.getByRole("region", { name: "保存结果", exact: true }).count(), 0);
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("region", { name: "保存结果", exact: true }).getByText("已保存", { exact: true }).waitFor();
  await page.getByRole("button", { name: "打开内容：正常.png", exact: true }).waitFor();
});

test("Returning to an image waits for its original before restoring the previous scroll position", options, async (t) => {
  const { page, create, app } = await setup(t);
  // The stacked mobile layout keeps related content below the original image.
  await page.setViewportSize({ width: 390, height: 844 });
  const text = await create("关联文字");
  const bytes = await sharp({ create: { width: 300, height: 900, channels: 3, background: "#71896a" } }).png().toBuffer();
  const image = await (await fetch(new URL("api/images", app.url), { method: "POST", headers: { "x-file-name": "tall.png" }, body: bytes })).json();
  await fetch(new URL("api/relations", app.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leftId: text.id, rightId: image.id }) });
  await page.reload();
  await page.getByRole("button", { name: "打开内容：tall.png", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.wiki-original img')?.naturalHeight > 0);
  const linked = page.getByRole("button", { name: "打开内容：关联文字", exact: true });
  await linked.scrollIntoViewIfNeeded();
  const previousScroll = await page.evaluate(() => scrollY);
  assert.ok(previousScroll > 100);
  await linked.click();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  await page.route(`**/api/elements/${image.id}/image?**`, async (route) => { await held; await route.continue(); });
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("heading", { name: "tall.png", exact: true }).waitFor();
  release();
  await page.waitForFunction((expected) => {
    const img = document.querySelector('.wiki-original img');
    return img?.naturalHeight > 0 && Math.abs(scrollY - expected) < 5;
  }, previousScroll);
});


test("Detail tag shortcut saves only tags and allows cancelling changes", options, async (t) => {
  const { page, create, app } = await setup(t);
  const element = await create("保留原始正文");
  await page.reload();
  await page.getByRole("button", { name: "打开内容：保留原始正文", exact: true }).click();
  await page.getByRole("button", { name: "添加标签", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑标签", exact: true });
  assert.equal(await dialog.getByLabel("文字", { exact: true }).count(), 0);
  await dialog.getByLabel("标签", { exact: true }).fill("参考, 灵感");
  const patch = page.waitForRequest((req) => req.method() === "PATCH");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  assert.deepEqual((await patch).postDataJSON(), { tags: ["参考", "灵感"] });
  await dialog.waitFor({ state: "hidden" });
  await page.locator(".wiki-detail-tags").getByText("灵感", { exact: true }).waitFor();
  const saved = await (await fetch(new URL(`api/elements/${element.id}`, app.url))).json();
  assert.equal(saved.body, "保留原始正文");
  assert.deepEqual(saved.tags, ["参考", "灵感"]);
  await page.getByRole("button", { name: "编辑标签", exact: true }).click();
  await dialog.getByRole("button", { name: "移除标签：参考", exact: true }).click();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("dialog", { name: "放弃内容修改？", exact: true }).getByRole("button", { name: "放弃修改", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(await page.locator(".wiki-detail-tags .wiki-tag").allTextContents(), ["参考", "灵感"]);
});


test("Continuous list retries failed pages and discards pending pages after filtering", options, async (t) => {
  const { page, create } = await setup(t);
  for (let i = 0; i < 40; i++) await create(`连续加载 ${i}`);
  let attempts = 0, release;
  const held = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  await page.route("**/api/elements?*", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("page") !== "2" || query.get("q")) return route.continue();
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 503, json: { error: "临时加载失败" } });
    await held;
    await route.continue().catch(() => {});
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.wiki-card').length === 36);
  await page.locator(".wiki-load-more").scrollIntoViewIfNeeded();
  await page.getByRole("alert").filter({ hasText: "临时加载失败" }).waitFor();
  assert.equal(await page.locator(".wiki-card").count(), 36);
  await page.getByRole("button", { name: "重试加载", exact: true }).click();
  await page.getByLabel("搜索内容", { exact: true }).fill("连续加载 39");
  await page.waitForFunction(() => document.querySelectorAll('.wiki-card').length === 1);
  release();
  await page.getByText("已显示全部 1 条内容", { exact: true }).waitFor();
  assert.equal(await page.locator(".wiki-card").count(), 1);
  assert.equal(await page.locator(".wiki-paging:visible").count(), 0);
});


test("image details show descriptions, preserve failed edits and replace text only after recognition succeeds", options, async (t) => {
  const { page, app } = await setup(t);
  const executable = path.join(app.dataDir, "description-cli.mjs");
  await writeFile(executable, await readFile(new URL("../fixtures/description-cli.txt", import.meta.url), "utf8"));
  await writeFile(path.join(app.dataDir, "mode.txt"), "slow");
  const status = await (await fetch(new URL("api/organization/status", app.url))).json();
  status.config.executor.codexCli = { ...status.config.executor.codexCli, executable, codexHome: path.join(app.dataDir, "wiki-codex"), model: "gpt-5.6-terra" };
  const configured = await fetch(new URL("api/organization/config", app.url), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(status.config) });
  assert.ok(configured.ok);
  const png = await sharp({ create: { width: 240, height: 180, channels: 3, background: "#7290a2" } }).png().toBuffer();
  const image = await (await fetch(new URL("api/images", app.url), { method: "POST", headers: { "x-file-name": encodeURIComponent("说明入口.png") }, body: png })).json();
  await page.reload();
  await page.getByRole("button", { name: "打开内容：说明入口.png", exact: true }).click();
  const section = page.getByRole("region", { name: "图片说明", exact: true });
  await section.getByText("暂无图片说明。", { exact: true }).waitFor();
  await section.getByRole("button", { name: "修改说明", exact: true }).click();
  const input = section.getByRole("textbox", { name: "图片说明内容", exact: true });
  await input.fill("手工补充：一把蓝色雨伞和街灯。");
  let failSave = true;
  await page.route(`**/api/elements/${image.id}/description`, async (route) => {
    if (route.request().method() === "PATCH" && failSave) { failSave = false; return route.fulfill({ status: 500, json: { error: "模拟保存失败" } }); }
    await route.continue();
  });
  await section.getByRole("button", { name: "保存说明", exact: true }).click();
  await section.getByRole("alert").getByText("模拟保存失败", { exact: false }).waitFor();
  assert.equal(await input.inputValue(), "手工补充：一把蓝色雨伞和街灯。");
  await section.getByRole("button", { name: "保存说明", exact: true }).click();
  await section.getByText("已手动修改", { exact: true }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "打开内容：说明入口.png", exact: true }).click();
  await section.getByText("手工补充：一把蓝色雨伞和街灯。", { exact: true }).waitFor();
  await section.getByRole("button", { name: "重新识别", exact: true }).click();
  await section.getByText("正在识别图片，完成后更新说明。", { exact: true }).waitFor();
  assert.equal(await section.getByRole("button", { name: "重新识别", exact: true }).isDisabled(), true);
  assert.equal(await section.getByText("手工补充：一把蓝色雨伞和街灯。", { exact: true }).count(), 1);
  await section.getByText("重新识别：蓝色雨伞下的人物，远处有街灯。", { exact: true }).waitFor();
  await section.getByText("识别模型：gpt-5.6-terra", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await section.screenshot({ path: "data/image-description-controls-mobile.png" });
});


test("long lists unmount distant blocks, retain scroll on detail return and refresh the loaded range once", options, async (t) => {
  const { page, create } = await setup(t);
  for (let index = 0; index < 220; index++) await create(`窗口浏览 ${index}`);
  const queries = [];
  page.on("request", (req) => { const url = new URL(req.url()); if (url.pathname === "/api/elements") queries.push(url.searchParams); });
  await page.reload();
  await page.getByText("220 条内容", { exact: true }).waitFor();
  for (let index = 0; index < 9; index++) {
    if (await page.getByText("已显示全部 220 条内容", { exact: true }).count()) break;
    await page.locator(".wiki-load-more").scrollIntoViewIfNeeded();
    await page.waitForFunction(() => !document.querySelector('.wiki-load-more [role="status"]')?.textContent.includes("正在"));
  }
  await page.getByText("已显示全部 220 条内容", { exact: true }).waitFor();
  await page.locator(".wiki-load-more").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelectorAll('.wiki-card').length < 180);
  const last = page.locator(".wiki-card-open").last();
  await last.scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => scrollY);
  await last.click();
  await page.getByRole("region", { name: "内容详情", exact: true }).waitFor();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑内容", exact: true });
  await editor.getByLabel("文字", { exact: true }).fill("窗口浏览 已修改");
  queries.length = 0;
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.waitForFunction((value) => Math.abs(scrollY - value) < 5, scroll);
  assert.ok(queries.some((query) => query.get("throughPage") === "7"));
  assert.equal(queries.filter((query) => Number(query.get("page")) > 1).length, 0);
  await page.evaluate(() => scrollTo(0, 0));
  await page.getByRole("button", { name: "打开内容：窗口浏览 已修改", exact: true }).waitFor();
});


test("image previews preload and decode beyond the viewport before rapid scrolling with bounded concurrency", options, async (t) => {
  const { page } = await setup(t);
  const bytes = await sharp({ create: { width: 800, height: 1200, channels: 3, background: "#688e95" } }).webp().toBuffer();
  const elements = Array.from({ length: 240 }, (_, index) => ({ id: 10000 + index, kind: "image", body: "", tags: [],
    image: { width: 1200, height: 1800, originalName: `scroll-${index}.webp`, url: `/api/elements/${10000 + index}/image` } }));
  const requested = new Set();
  let active = 0, maxActive = 0;
  await page.route("**/api/elements?*", (route) => {
    const query = new URL(route.request().url()).searchParams;
    const current = Number(query.get("page") || 1), last = Number(query.get("throughPage") || current);
    return route.fulfill({ json: { elements: elements.slice((current - 1) * 36, last * 36), pagination: { page: last, pageSize: 36, pageCount: 7, total: 240 } } });
  });
  await page.route("**/thumbnail?*", async (route) => {
    const id = Number(new URL(route.request().url()).pathname.split("/")[3]);
    requested.add(id);
    if (id >= 10008) { active++; maxActive = Math.max(maxActive, active); }
    await new Promise((resolve) => setTimeout(resolve, 80));
    await route.fulfill({ contentType: "image/webp", body: bytes }).catch(() => {});
    if (id >= 10008) active--;
  });
  await page.reload();
  await page.getByText("240 条内容", { exact: true }).waitFor();
  const target = await page.locator(".wiki-card").evaluateAll((cards) => {
    const card = cards.find((node) => { const top = node.getBoundingClientRect().top; return top > innerHeight + 1800 && top < innerHeight + 3200; });
    return card ? Number(card.dataset.elementId) : null;
  });
  assert.ok(target, "Fixture contains a card several screens ahead");
  await page.waitForFunction((id) => {
    const card = document.querySelector(`[data-element-id="${id}"]`);
    return card && !card.classList.contains("is-loading") && card.querySelector("img")?.naturalWidth > 0;
  }, target);
  assert.ok(requested.has(target));
  assert.ok(maxActive <= 4, `Too many speculative image requests: ${maxActive}`);
  await page.evaluate(async () => {
    window.scrollLongTasks = [];
    const observer = new PerformanceObserver((list) => window.scrollLongTasks.push(...list.getEntries().map((entry) => entry.duration)));
    observer.observe({ type: "longtask" });
    for (let index = 0; index < 24; index++) { scrollBy(0, 250); await new Promise(requestAnimationFrame); }
    observer.disconnect();
  });
  await page.waitForFunction(() => [...document.querySelectorAll('.wiki-card.is-image')].filter((card) => {
    const rect = card.getBoundingClientRect(); return rect.bottom > 0 && rect.top < innerHeight;
  }).every((card) => !card.classList.contains("is-loading")));
  t.diagnostic(JSON.stringify(await page.evaluate(() => ({ scrollY, cards: document.querySelectorAll('.wiki-card').length, longTasks: window.scrollLongTasks }))));
});
