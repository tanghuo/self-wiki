import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { resolveBrowserPath } from "../resolveBrowserPath.js";
import { createServer } from "../../src/server/server.js";
import { openDetailMenu } from "../ui-select.js";

const browserPath = resolveBrowserPath();
const options = { timeout: 60000, skip: !browserPath && "Browser required" };

async function setup(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wiki-video-ui-"));
  const app = await createServer({ port: 0, dataDir });
  let browser;
  t.after(async () => {
    await browser?.close(); await app.close();
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("wiki-video-ui-"));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
  });
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(12000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const bytes = await readFile(new URL("../fixtures/sample.webm", import.meta.url));
  const api = async (route) => (await fetch(new URL(`api/${route}`, app.url))).json();
  await page.goto(`${app.url}#wiki`);
  return { app, page, bytes, api };
}

test("video imports keep original bytes, play and seek, support tags, relations, trash and restore", options, async (t) => {
  const { app, page, bytes, api } = await setup(t);
  const videoRequests = [];
  page.on("request", (request) => { if (/\/api\/elements\/\d+\/video(?:\?|$)/.test(request.url())) videoRequests.push(request.url()); });
  const input = page.getByLabel("导入图片或视频文件");
  await input.setInputFiles({ name: "本地动画.webm", mimeType: "video/webm", buffer: bytes });
  const dialog = page.getByRole("dialog", { name: "新增内容", exact: true });
  await dialog.getByLabel("视频内容 1", { exact: true }).waitFor();
  await dialog.getByLabel("本次标签", { exact: true }).fill("动画");
  await dialog.getByLabel("文字", { exact: true }).fill("这段动画的关联说明");
  await dialog.getByRole("button", { name: "保存全部", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "打开内容：本地动画.webm", exact: true }).waitFor();
  const preview = page.locator(".wiki-card-video").first();
  await preview.locator("img").waitFor();
  await preview.locator(".wiki-card-video-duration").waitFor();
  assert.ok(videoRequests.length > 0, "Visible cards extract a video cover");
  assert.ok(await preview.locator("img").getAttribute("src"));
  await preview.hover();
  await page.waitForFunction(() => document.querySelector(".wiki-card-video video")?.paused === false);
  assert.equal(await preview.locator("video").evaluate((node) => node.muted), true);
  await preview.locator("video").evaluate((node) => { node.pause(); node.currentTime = 0.65; });
  await page.waitForFunction(() => {
    const video = document.querySelector(".wiki-card-video video");
    return video && !video.seeking && Math.abs(video.currentTime - 0.65) < 0.05;
  });
  const stoppedFrame = await preview.locator("video").evaluate((node) => {
    const canvas = document.createElement("canvas");
    const scale = Math.min(480 / node.videoWidth, 480 / node.videoHeight, 1);
    canvas.width = Math.max(1, Math.round(node.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(node.videoHeight * scale));
    canvas.getContext("2d", { willReadFrequently: true }).drawImage(node, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.8);
  });
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => !document.querySelector(".wiki-card-video video")?.getAttribute("src"));
  assert.equal(await preview.locator("img").isVisible(), true);
  assert.equal(await preview.locator("img").getAttribute("src"), stoppedFrame, "Leaving hover displays the last preview frame");
  await preview.locator("video").evaluate((node) => {
    node.addEventListener("playing", () => { node.dataset.resumedAt = String(node.currentTime); }, { once: true });
  });
  await preview.hover();
  await page.waitForFunction(() => document.querySelector(".wiki-card-video video")?.dataset.resumedAt !== undefined);
  const resumedAt = await preview.locator("video").evaluate((node) => Number(node.dataset.resumedAt));
  assert.ok(Math.abs(resumedAt - 0.65) < 0.15, `Hover resumes at the previous position, got ${resumedAt}`);
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => !document.querySelector(".wiki-card-video video")?.getAttribute("src"));
  await preview.screenshot({ path: ".local/video-card-preview.png" });
  let video = (await api("elements?kind=video")).elements[0];
  await page.waitForFunction(async (id) => (await (await fetch(`/api/elements/${id}/video-cover`)).json()).cover !== null, video.id);
  const savedCover = (await api(`elements/${video.id}/video-cover`)).cover;
  videoRequests.length = 0;
  await page.reload();
  await page.locator(".wiki-card-video img").waitFor();
  await page.locator(".wiki-card-video-duration").waitFor();
  assert.equal(await page.locator(".wiki-card-video img").getAttribute("src"), savedCover.url, "Reload displays the saved cover instead of the temporary paused frame");
  assert.equal(videoRequests.length, 0, "Reload reads the saved cover without requesting original video bytes");
  await page.locator(".wiki-card-video").hover();
  await page.waitForFunction(() => document.querySelector(".wiki-card-video video")?.paused === false);
  await page.mouse.move(0, 0);
  assert.equal(video.video.byteSize, bytes.length);
  assert.deepEqual(video.tags, ["动画"]);
  const downloaded = await fetch(new URL(`api/elements/${video.id}/download`, app.url));
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);

  await input.setInputFiles({ name: "同一视频.webm", mimeType: "video/webm", buffer: bytes });
  await dialog.getByRole("button", { name: "保存全部", exact: true }).click();
  await page.getByText("已复用已有视频，标签已合并", { exact: true }).waitFor();
  assert.equal((await api("elements?kind=video")).pagination.total, 1);
  await page.getByRole("complementary", { name: "内容导航" }).getByRole("button", { name: "视频", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "打开内容：这段动画的关联说明", exact: true }).count(), 0);
  await page.getByRole("button", { name: "打开内容：本地动画.webm", exact: true }).click();
  const player = page.getByLabel("播放视频：本地动画.webm", { exact: true });
  await player.waitFor();
  assert.equal(await player.getAttribute("preload"), "metadata");
  assert.equal(await player.getAttribute("controls"), "");
  await player.evaluate(async (element) => { element.muted = true; await element.play(); });
  await page.waitForFunction(() => document.querySelector(".wiki-detail video")?.currentTime > 0.2);
  await player.evaluate((element) => { element.pause(); element.currentTime = 0.7; });
  await page.waitForFunction(() => { const video = document.querySelector(".wiki-detail video"); return video && !video.seeking && video.currentTime >= 0.65; });
  assert.equal(await page.getByRole("button", { name: "加入资料", exact: true }).count(), 0);
  await page.getByRole("link", { name: "保存原视频", exact: true }).waitFor();
  await player.dispatchEvent("error");
  await page.getByRole("link", { name: "下载原视频", exact: true }).waitFor();

  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑内容", exact: true });
  assert.equal(await editor.getByRole("textbox", { name: "文字", exact: true }).count(), 0);
  await editor.getByLabel("标签", { exact: true }).fill("演示");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  assert.deepEqual((await api(`elements/${video.id}`)).tags, ["动画", "演示"]);
  await page.getByRole("button", { name: "添加关联", exact: true }).click();
  const relations = page.getByRole("dialog", { name: "添加关联", exact: true });
  await relations.getByRole("button", { name: "选择：这段动画的关联说明", exact: true }).click();
  await relations.getByRole("button", { name: "关联这 1 项内容", exact: true }).click();
  await relations.waitFor({ state: "hidden" });
  assert.equal((await api(`elements/${video.id}/relations`)).pagination.total, 1);

  await openDetailMenu(page);
  await page.getByRole("button", { name: "移入回收站", exact: true }).click();
  await page.getByRole("complementary", { name: "内容导航" }).getByRole("button", { name: "回收站", exact: true }).click();
  const card = page.locator(`[data-element-id="${video.id}"]`);
  await card.getByText("本地动画.webm", { exact: true }).waitFor();
  await card.getByRole("button", { name: "恢复内容", exact: true }).click();
  await card.waitFor({ state: "hidden" });
  assert.equal((await api("elements?kind=video")).pagination.total, 1);
});

test("pasted videos offer first-frame organization while staying unavailable as chat sources", options, async (t) => {
  const { page, bytes, api } = await setup(t);
  await page.evaluate((bytes) => {
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([new Uint8Array(bytes)], "粘贴视频.webm", { type: "video/webm" }));
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, [...bytes]);
  const dialog = page.getByRole("dialog", { name: "新增内容", exact: true });
  await dialog.getByLabel("视频内容 1", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "保存全部", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal((await api("elements?kind=video")).pagination.total, 1);
  await page.getByRole("button", { name: "打开内容：粘贴视频.webm", exact: true }).click();
  await page.getByRole("button", { name: "整理记录", exact: true }).click();
  const organization = page.getByRole("dialog", { name: "整理记录", exact: true });
  await organization.getByText("整理会比较视频首帧", { exact: false }).waitFor();
  await organization.getByRole("button", { name: "整理此内容", exact: true }).waitFor();
  await organization.getByRole("button", { name: "关闭整理记录", exact: true }).click();
  await page.getByRole("button", { name: "问 Agent", exact: true }).click();
  await page.getByRole("button", { name: "加入当前内容", exact: true }).click();
  await page.getByText("视频暂不支持作为 AI 资料，可在内容库播放。", { exact: false }).waitFor();
  await page.getByRole("button", { name: "从库中选择", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "选择会话资料", exact: true });
  const video = picker.getByRole("button", { name: "粘贴视频.webm", exact: true });
  await video.waitFor(); assert.equal(await video.isDisabled(), true);
  await picker.getByText("视频暂不支持作为 AI 资料", { exact: true }).waitFor();
});

test("dropped video remains labeled in the canvas and its inspector can play it", options, async (t) => {
  const { page, bytes } = await setup(t);
  await page.evaluate((bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], "画布视频.webm", { type: "video/webm" }));
    document.querySelector(".wiki-shell").dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, [...bytes]);
  const dialog = page.getByRole("dialog", { name: "新增内容", exact: true });
  await dialog.getByLabel("视频内容 1", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "保存全部", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("complementary", { name: "内容导航" }).getByRole("button", { name: "关系画布", exact: true }).click();
  const node = page.getByRole("button", { name: "选择内容：画布视频.webm", exact: true });
  await node.waitFor();
  assert.equal(await page.locator("video").count(), 0);
  await node.click();
  const inspector = page.getByRole("complementary", { name: "画布内容详情", exact: true });
  const player = inspector.getByLabel("播放视频：画布视频.webm", { exact: true });
  await player.waitFor();
  await player.evaluate(async (element) => { element.muted = true; await element.play(); });
  await page.waitForFunction(() => document.querySelector(".canvas-inspector video")?.currentTime > 0.1);
  await inspector.getByRole("link", { name: "保存原视频", exact: true }).waitFor();
  await player.evaluate((element) => { element.loop = true; });
  await inspector.getByRole("button", { name: "打开详情页", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".canvas-inspector video")?.paused === true);
  const detailPlayer = page.locator(".wiki-detail video");
  await detailPlayer.evaluate(async (element) => { element.muted = true; element.loop = true; await element.play(); });
  await page.waitForFunction(() => document.querySelector(".wiki-detail video")?.currentTime > 0.1);
  await page.screenshot({ path: ".local/video-ui.png", fullPage: true });
  await page.getByRole("link", { name: "Agent 对话", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("video")].every((element) => element.paused));
});


test("nearby uncached video covers share two extraction slots and release them after capture", options, async (t) => {
  const { page, bytes } = await setup(t);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const elements = Array.from({ length: 8 }, (_, i) => ({ id: i + 100, kind: "video", body: "", tags: [],
    video: { url: `/api/elements/${i + 100}/video`, originalName: `cover-${i}.webm`, byteSize: bytes.length } }));
  await page.route("**/api/elements?*", (route) => route.fulfill({ json: { elements, pagination: { page: 1, pageSize: 36, pageCount: 1, total: elements.length } } }));
  await page.route("**/video-cover", (route) => route.fulfill({ json: { cover: null } }));
  await page.route("**/video", async (route) => {
    await pending;
    await route.fulfill({ contentType: "video/webm", body: bytes }).catch(() => {});
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.wiki-card-video video[src]').length === 2);
  assert.equal(await page.locator('.wiki-card-video video[src]').count(), 2);
  // At least one not-yet-visible card starts looking up its saved cover.
  assert.ok(await page.locator('.wiki-card-video').count() > 2);
  release();
  await page.waitForFunction(() => document.querySelectorAll('.wiki-card-video-cover > img').length >= 4);
  await page.waitForFunction(() => document.querySelectorAll('.wiki-card-video video[src]').length === 0);
});
