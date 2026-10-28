import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer as createHttpServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright-core";
import { resolveBrowserPath } from "../resolveBrowserPath.js";
import sharp from "sharp";
import { createServer } from "../../src/server/server.js";
import { chooseOption, selectedValue, openRelationAdvanced } from "../ui-select.js";

const browserPath = resolveBrowserPath();
const options = { timeout: 60000, skip: !browserPath && "Browser required" };

async function setup(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wiki-canvas-ui-"));
  const app = await createServer({ port: 0, dataDir });
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  t.after(async () => {
    await page.screenshot({ path: `data/wiki-canvas-${t.name.startsWith("Canvas") ? "last-desktop" : "last-mobile"}.png`, fullPage: true });
    await browser.close(); await app.close();
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("wiki-canvas-ui-"));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const request = (route, method = "GET", body) => fetch(new URL(route, app.url), { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const create = async (content, body = "", tags = []) => (await request("api/elements", "POST", { body: body ? `${content}\n${body}` : content, tags })).json();
  const openCanvas = async (url = `${app.url}#wiki`) => {
    // Re-entering the same fragment is a same-document navigation, so reload to start a fresh canvas.
    if (page.url() === url) await page.reload(); else await page.goto(url);
    await page.getByRole("complementary", { name: "内容导航" }).getByRole("button", { name: "关系画布", exact: true }).click();
    await page.locator(".canvas-footer").waitFor();
    await page.getByText("正在读取画布…", { exact: true }).waitFor({ state: "hidden" });
  };
  return { app, page, request, create, openCanvas };
}

test("Canvas loading failures keep navigation available and recover after reloading", options, async (t) => {
  const { app, page, create } = await setup(t);
  await create("画布异常后仍可浏览的内容");
  await page.route("**/assets/WikiCanvas-*.js", (route) => route.abort("failed"));
  await page.goto(`${app.url}#wiki`);
  await page.getByRole("complementary", { name: "内容导航" }).getByRole("button", { name: "关系画布", exact: true }).click();
  const error = page.getByRole("alert");
  await error.getByRole("heading", { name: "关系画布暂时无法显示" }).waitFor();
  await error.getByText("错误信息", { exact: true }).click();
  assert.match(await error.locator("pre").textContent(), /module|fetch|load/i);
  await error.getByRole("button", { name: "返回内容库", exact: true }).click();
  await page.getByRole("heading", { name: "全部内容", exact: true }).waitFor();
  await page.getByRole("complementary", { name: "内容导航" }).getByRole("button", { name: "关系画布", exact: true }).click();
  await error.getByRole("heading", { name: "关系画布暂时无法显示" }).waitFor();
  await page.unroute("**/assets/WikiCanvas-*.js");
  await error.getByRole("button", { name: "重新加载页面", exact: true }).click();
  await page.getByRole("heading", { name: "全部内容", exact: true }).waitFor();
  await page.getByRole("complementary", { name: "内容导航" }).getByRole("button", { name: "关系画布", exact: true }).click();
  await page.getByRole("button", { name: "选择内容：画布异常后仍可浏览的内容", exact: true }).waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
});

test("Canvas render failures stay inside the canvas and allow returning to the library", options, async (t) => {
  const { app, page, create } = await setup(t);
  await create("可恢复的画布内容");
  await page.route("**/api/canvas?*", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.elements[0].tags = null;
    await route.fulfill({ response, json: data });
  });
  await page.goto(`${app.url}#wiki`);
  await page.getByRole("complementary", { name: "内容导航" }).getByRole("button", { name: "关系画布", exact: true }).click();
  const error = page.getByRole("alert");
  await error.getByRole("heading", { name: "关系画布暂时无法显示" }).waitFor();
  await error.getByRole("button", { name: "返回内容库", exact: true }).click();
  await page.getByRole("heading", { name: "全部内容", exact: true }).waitFor();
  await page.unroute("**/api/canvas?*");
  await page.getByRole("complementary", { name: "内容导航" }).getByRole("button", { name: "关系画布", exact: true }).click();
  await page.getByRole("button", { name: "选择内容：可恢复的画布内容", exact: true }).waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
});

test("Canvas previews keep readable text with many relations and open full details without losing the canvas", options, async (t) => {
  const { app, page, request, create, openCanvas } = await setup(t);
  const source = await create("长文阅读检查", "正文需要完整保留，不能被关联列表挤成一条细线。\n".repeat(80), ["阅读"]);
  for (let i = 0; i < 18; i++) {
    const related = await create(`关联笔记 ${i + 1}`, "", ["阅读"]);
    await request("api/relations", "POST", { leftId: source.id, rightId: related.id });
  }
  const bytes = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#8da98b" } }).png().toBuffer();
  const photo = await (await fetch(new URL("api/images", app.url), { method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("阅读色卡.png") }, body: bytes })).json();
  await request("api/relations", "POST", { leftId: source.id, rightId: photo.id });
  await openCanvas();
  await page.getByRole("button", { name: /^选择内容：长文阅读检查/ }).dblclick({ delay: 120 });
  await page.getByRole("region", { name: "内容详情", exact: true }).getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: /^选择内容：长文阅读检查/ }).click();
  const inspector = page.getByRole("complementary", { name: "画布内容详情", exact: true });
  const preview = inspector.getByLabel("正文预览", { exact: true });
  await preview.waitFor();
  assert.equal(await page.getByRole("region", { name: "内容详情", exact: true }).count(), 0, "A single click only previews the content");
  assert.equal(await preview.textContent(), source.body);
  const size = await preview.evaluate((element) => ({ height: element.clientHeight, contentHeight: element.scrollHeight }));
  assert.ok(size.height >= 200, `Long text keeps a readable preview height, got ${size.height}`);
  assert.ok(size.contentHeight > size.height, "The complete text can scroll inside the preview");
  assert.ok(await inspector.locator(".canvas-inspector-body").evaluate((element) => element.scrollHeight > element.clientHeight), "The sidebar scrolls to reach all relations");
  await preview.press("Control+End");
  await page.waitForFunction(() => document.querySelector('.canvas-inspector pre')?.scrollTop > 0);
  assert.ok(await preview.evaluate((element) => element.scrollTop > 0), "The text preview supports keyboard scrolling");
  await page.waitForTimeout(800); // Finish the delayed selection animation before comparing the viewport.
  const viewport = await page.locator(".react-flow__viewport").getAttribute("style");
  await page.getByRole("button", { name: /^选择内容：长文阅读检查/ }).dblclick();
  const detail = page.getByRole("region", { name: "内容详情", exact: true });
  await detail.locator(".wiki-text-document pre").waitFor();
  assert.equal(await detail.locator(".wiki-text-document pre").textContent(), source.body);
  await detail.getByRole("button", { name: "返回", exact: true }).click();
  await preview.waitFor();
  assert.equal(await page.locator(".react-flow__viewport").getAttribute("style"), viewport);
  assert.ok(await page.locator(`.react-flow__node[data-id="${source.id}"]`).evaluate((element) => element.classList.contains("selected")));

  await inspector.getByRole("button", { name: /^阅读色卡.png/ }).click();
  await inspector.locator(".canvas-inspector-image").waitFor();
  await page.getByRole("button", { name: "选择内容：阅读色卡.png", exact: true }).dblclick();
  await detail.locator(".wiki-original img").waitFor();
  assert.ok((await detail.locator(".wiki-original img").getAttribute("src")).includes(photo.image.url));
  await detail.getByRole("button", { name: "返回", exact: true }).click();
  await inspector.getByRole("button", { name: /^长文阅读检查/ }).click();
  await chooseOption(page, "筛选画布标签", "阅读");
  await page.getByRole("button", { name: /^选择内容：长文阅读检查/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await preview.waitFor();
  assert.ok(await preview.evaluate((element) => element.clientHeight >= 200), "The phone panel also preserves the text height");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await inspector.getByRole("button", { name: "打开详情页", exact: true }).press("Enter");
  await detail.locator(".wiki-text-document pre").waitFor();
  await detail.getByRole("button", { name: "返回", exact: true }).click();
  await preview.waitFor();
  assert.equal(await selectedValue(page, "筛选画布标签"), "阅读");
});

test("Canvas tag management retains every rule independently of grouped detail pagination", options, async (t) => {
  const { page, request, create, openCanvas } = await setup(t);
  const source = await create("标签关联来源", "", ["仪玄"]);
  await create("标签成员", "", ["仪玄", "合集"]);
  await request("api/relations/batch", "POST", { sourceId: source.id, targetTags: ["仪玄", "合集"], name: "参考图" });
  const grouped = await (await request(`api/elements/${source.id}/relations?pageSize=1`)).json();
  assert.equal(grouped.tagRelations.length, 1);
  await openCanvas();
  await page.getByRole("button", { name: "选择内容：标签关联来源", exact: true }).click();
  const inspector = page.getByRole("complementary", { name: "画布内容详情", exact: true });
  await inspector.getByRole("button", { name: "解除标签关联：仪玄：参考图", exact: true }).waitFor();
  await inspector.getByRole("button", { name: "解除标签关联：合集：参考图", exact: true }).click();
  await inspector.getByRole("button", { name: "解除标签关联：合集：参考图", exact: true }).waitFor({ state: "hidden" });
  await inspector.getByRole("button", { name: "解除标签关联：仪玄：参考图", exact: true }).waitFor();
  assert.equal((await (await request(`api/elements/${source.id}/tag-relations`)).json()).tagRelations.length, 1);
});

test("Canvas connects by dragging, edits full text, persists layout, retries saves, restores trash and creates new content", options, async (t) => {
  const { app, page, request, create, openCanvas } = await setup(t);
  const a = await create("林间光影", "午后的森林，光落在苔藓与叶片上。\n" + "保留完整正文。".repeat(80), ["灵感", "自然"]);
  const b = await create("色彩笔记", "浅绿与暖白，保留安静的留白。", ["灵感"]);
  const c = await create("周末散步", "带上相机，寻找身边的形状。", ["生活"]);
  const bytes = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#8da98b" } }).png().toBuffer();
  const image = await (await fetch(new URL("api/images", app.url), { method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("森林色卡.png") }, body: bytes })).json();
  await request("api/relations", "POST", { leftId: a.id, rightId: b.id });
  await request("api/relations", "POST", { leftId: b.id, rightId: c.id });
  await openCanvas();
  await page.getByRole("button", { name: "平铺视图", exact: true }).click();
  await page.getByRole("button", { name: /^选择内容：林间光影/ }).waitFor();
  const source = page.locator(`.react-flow__node[data-id="${b.id}"] .react-flow__handle-right`);
  const target = page.locator(`.react-flow__node[data-id="${image.id}"] .react-flow__handle-left`);
  const start = await source.boundingBox(), end = await target.boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 16 });
  const connected = page.waitForResponse((response) => response.url().endsWith("/api/relations") && response.request().method() === "POST");
  await page.mouse.up();
  await page.getByRole("button", { name: "保存关联", exact: true }).click();
  assert.equal((await connected).status(), 200);
  await page.waitForFunction(() => document.querySelector(".canvas-footer")?.textContent.includes("3 条关联"));

  await page.getByRole("button", { name: /^选择内容：林间光影/ }).click();
  await page.getByRole("button", { name: "编辑内容", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑内容", exact: true });
  assert.equal(await editor.getByLabel("文字", { exact: true }).inputValue(), a.body);
  const editedBody = a.body.replace("林间光影", "林间光影 · 灵感");
  await editor.getByLabel("文字", { exact: true }).fill(editedBody);
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: /^选择内容：林间光影 · 灵感/ }).waitFor();
  assert.equal((await (await request(`api/elements/${a.id}`)).json()).body, editedBody);
  await page.getByRole("button", { name: "关闭画布详情" }).click();
  await page.getByRole("button", { name: "适应画面", exact: true }).first().click();
  await page.getByRole("button", { name: "保存布局", exact: true }).click();
  await page.getByText("布局已保存", { exact: true }).waitFor();
  await page.waitForTimeout(300);

  let fail = true;
  await page.route("**/api/canvas/layout", (route) => {
    if (fail) { fail = false; return route.fulfill({ status: 500, json: { error: "模拟保存失败" } }); }
    return route.continue();
  });
  const before = (await (await request("api/canvas")).json()).elements.find((element) => element.id === b.id).position;
  const grip = await page.locator(`.react-flow__node[data-id="${b.id}"] .canvas-node-grip`).boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down(); await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 120, { steps: 12 }); await page.mouse.up();
  await page.getByRole("alert").getByText(/布局未保存/).waitFor();
  assert.equal(await page.getByRole("complementary", { name: "内容导航" }).getByRole("button", { name: "全部内容", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "重试保存", exact: true }).click();
  await page.getByRole("alert").waitFor({ state: "hidden" });
  await page.waitForFunction(() => !document.querySelector('.canvas-toolbar button:last-child')?.disabled);
  const moved = (await (await request("api/canvas")).json()).elements.find((element) => element.id === b.id).position;
  assert.ok(moved.y > before.y + 80);
  await openCanvas();
  await page.getByRole("button", { name: "平铺视图", exact: true }).click();
  const position = await page.locator(`.react-flow__node[data-id="${b.id}"]`).evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).m42);
  assert.ok(Math.abs(position - moved.y) < 0.01);

  await page.getByRole("button", { name: /^选择内容：色彩笔记/ }).click();
  await page.getByRole("button", { name: "解除普通关联：森林色卡.png", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".canvas-footer")?.textContent.includes("2 条关联"));
  assert.equal((await request(`api/elements/${image.id}`)).status, 200);
  await page.getByRole("button", { name: "移入回收站", exact: true }).click();
  await page.getByRole("button", { name: "撤销删除", exact: true }).click();
  await page.getByRole("button", { name: /^选择内容：色彩笔记/ }).waitFor();
  await page.waitForFunction(() => document.querySelector(".canvas-footer")?.textContent.includes("2 条关联"));
  await page.getByRole("button", { name: "添加内容", exact: true }).click();
  const creation = page.getByRole("dialog", { name: "添加内容", exact: true });
  await creation.getByLabel("文字", { exact: true }).fill("画布中新建的笔记");
  await creation.getByRole("button", { name: "保存全部", exact: true }).click();
  await creation.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "画布中新建的笔记", exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭画布详情" }).click();
  await page.getByRole("button", { name: "适应画面", exact: true }).first().click();
  await page.getByRole("button", { name: /^选择内容：林间光影 · 灵感/ }).click();
  await page.locator(".canvas-inspector h2").waitFor();
  await page.waitForTimeout(300); // Let the viewport animation settle for visual inspection.
  await page.screenshot({ path: "data/wiki-canvas-desktop.png", fullPage: true });
  await page.getByLabel("搜索画布内容", { exact: true }).fill("林间光影");
  await page.waitForFunction(() => document.querySelector(".canvas-footer")?.textContent.includes("1 条内容"));
  await page.getByRole("button", { name: /^选择内容：林间光影 · 灵感/ }).click();
  await page.getByRole("button", { name: "展开关联", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".canvas-footer")?.textContent.includes("2 条内容"));
  await page.getByRole("button", { name: "添加关联", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "添加关联", exact: true });
  await openRelationAdvanced(picker);
  await picker.getByLabel("关系名称", { exact: true }).fill("灵感来源");
  await picker.getByRole("button", { name: /^选择：色彩笔记/ }).click();
  await picker.getByRole("button", { name: "关联这 1 项内容", exact: true }).click();
  await picker.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: /^解除灵感来源：色彩笔记/ }).waitFor();
  const relationData = await (await request(`api/canvas?ids=${a.id},${b.id}&limit=0`)).json();
  const titleRelation = relationData.relations.find((relation) => relation.name === "灵感来源");
  assert.equal(titleRelation.sourceId, a.id);
  assert.equal(titleRelation.targetId, b.id);
  assert.equal(relationData.relations.length, 2);
  await page.getByRole("button", { name: /^解除灵感来源：色彩笔记/ }).click();
  await page.waitForFunction(() => document.querySelector(".canvas-footer")?.textContent.includes("1 条关联"));
});

test("Canvas relationship groups expand, focus real relations and leave saved layouts intact", options, async (t) => {
  const { app, page, request, create, openCanvas } = await setup(t);
  const first = await create("参考说明", "", ["色彩"]);
  const second = await create("另一份参考", "", ["色彩"]);
  const loose = await create("独立笔记");
  await request("api/relations", "POST", { leftId: first.id, rightId: second.id });
  const photos = [];
  for (let index = 0; index < 6; index++) {
    const bytes = await sharp({ create: { width: 100, height: 120, channels: 3, background: { r: 110 + index * 12, g: 155, b: 170 } } }).png().toBuffer();
    const name = `12345678-1234-1234-1234-00000000000${index}.png`;
    const response = await fetch(new URL("api/images", app.url), { method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": name, "x-image-tags": Buffer.from(JSON.stringify(["色彩"])).toString("base64") }, body: bytes });
    photos.push(await response.json());
    for (const ref of [first, second]) await request("api/relations", "POST", { leftId: ref.id, rightId: photos.at(-1).id, name: "参考" });
  }
  const position = { x: 840, y: 260 };
  await request("api/canvas/layout", "PUT", { positions: [{ id: first.id, ...position }] });
  let writes = 0;
  page.on("request", (entry) => { if (entry.url().endsWith("/api/canvas/layout") && entry.method() === "PUT") writes++; });
  await openCanvas();
  await page.getByRole("button", { name: "展开图片组：6 张图片", exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__edge").length === 3);
  assert.equal(await page.getByRole("button", { name: `选择内容：色彩 · ${photos[0].id}`, exact: true }).count(), 0);
  await page.getByRole("button", { name: "选择内容：参考说明", exact: true }).click();
  assert.equal(await page.locator(`.react-flow__node[data-id="${loose.id}"]`).getAttribute("class").then((value) => value.includes("is-muted")), true);
  assert.equal(await page.locator(".react-flow__edge.is-highlighted").count(), 2);
  await page.getByRole("button", { name: "关闭画布详情", exact: true }).click();
  await page.getByRole("button", { name: "展开图片组：6 张图片", exact: true }).click();
  await page.getByRole("button", { name: "收起图片组：6 张图片", exact: true }).waitFor();
  await page.getByRole("button", { name: `选择内容：色彩 · ${photos[0].id}`, exact: true }).waitFor();
  assert.equal(await page.locator(".react-flow__edge").count(), 13);
  await page.getByRole("button", { name: "收起图片组：6 张图片", exact: true }).click();
  await page.getByRole("button", { name: "选择内容：参考说明", exact: true }).click();
  await page.locator(".canvas-linked-list").getByRole("button", { name: new RegExp(`^色彩 · ${photos[0].id}`) }).click();
  await page.getByRole("button", { name: "收起图片组：6 张图片", exact: true }).waitFor();
  await page.getByRole("heading", { name: "12345678-1234-1234-1234-000000000000.png", exact: true }).waitFor();
  assert.equal(writes, 0);
  assert.deepEqual((await (await request("api/canvas")).json()).elements.find((entry) => entry.id === first.id).position, position);
});

test("Canvas retains relation labels when refreshing unchanged node geometry", options, async (t) => {
  const { page, request, create, openCanvas } = await setup(t);
  await page.addInitScript(() => {
    const NativeResizeObserver = window.ResizeObserver;
    const sizes = new WeakMap();
    window.ResizeObserver = class extends NativeResizeObserver {
      constructor(callback) {
        super((entries, observer) => {
          const changed = entries.filter((entry) => {
            if (!entry.target.classList.contains("react-flow__node")) return true;
            const size = `${entry.contentRect.width}:${entry.contentRect.height}`;
            const previous = sizes.get(entry.target);
            sizes.set(entry.target, size);
            // A content refresh with unchanged geometry must not need another size notification.
            return !window.canvasIgnoreRepeatedSizes || previous !== size;
          });
          if (changed.length) callback(changed, observer);
        });
      }
    };
  });
  const source = await create("刷新前的来源"), target = await create("刷新后的目标");
  await request("api/relations", "POST", { sourceId: source.id, targetId: target.id, name: "保持的关联" });
  await openCanvas();
  await page.getByRole("button", { name: "全部连线", exact: true }).click();
  const label = page.getByRole("button", { name: "重命名关联：保持的关联", exact: true });
  await label.waitFor();
  await page.evaluate(() => { window.canvasIgnoreRepeatedSizes = true; });
  await label.click();
  const dialog = page.getByRole("dialog", { name: "重命名关联", exact: true });
  await dialog.getByLabel("关联名称", { exact: true }).fill("刷新后的关联");
  const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/canvas");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  assert.equal((await refreshed).status(), 200);
  await dialog.waitFor({ state: "hidden" });
  await page.getByText("正在读取画布…", { exact: true }).waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "重命名关联：刷新后的关联", exact: true }).click();
  await dialog.waitFor();
});

test("Canvas renames bundled and individual relations with cancellation, conflict recovery and tag scope", options, async (t) => {
  const { app, page, request, create, openCanvas } = await setup(t);
  const source = await create("生成说明"), tagSource = await create("参考说明");
  const photos = [], direct = [];
  for (let index = 0; index < 4; index++) {
    const bytes = await sharp({ create: { width: 120, height: 160, channels: 3, background: { r: 110 + index * 25, g: 155, b: 170 } } }).png().toBuffer();
    const photo = await (await fetch(new URL("api/images", app.url), { method: "POST", headers: {
      "content-type": "application/octet-stream", "x-file-name": `sample-${index}.png`, "x-image-tags": Buffer.from(JSON.stringify(["合集"])).toString("base64"),
    }, body: bytes })).json();
    photos.push(photo);
    direct.push(await (await request("api/relations", "POST", { sourceId: source.id, targetId: photo.id })).json());
  }
  await request("api/relations/batch", "POST", { sourceId: tagSource.id, targetTags: ["合集"], name: "原型图" });
  await openCanvas();
  const bundle = page.getByRole("button", { name: "批量重命名关联：关联 · 4", exact: true });
  await bundle.click();
  const batch = page.getByRole("dialog", { name: "批量重命名关联", exact: true });
  await batch.getByText("将修改这组的 4 条关联。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "收起图片组：4 张图片", exact: true }).count(), 0, "Editing a label must not expand its group");
  await batch.getByLabel("关联名称", { exact: true }).fill("取消的名称");
  await batch.getByRole("button", { name: "取消", exact: true }).click();
  const related = async () => (await (await request(`api/elements/${source.id}/relations`)).json()).relations;
  assert.ok((await related()).every((entry) => entry.name === ""));
  const conflict = await (await request("api/relations", "POST", { sourceId: source.id, targetId: photos[3].id, name: "生成结果" })).json();
  await bundle.click();
  await batch.getByLabel("关联名称", { exact: true }).fill("生成结果");
  await batch.getByRole("button", { name: "保存全部", exact: true }).click();
  await batch.getByRole("alert").filter({ hasText: "本次未修改任何关联" }).waitFor();
  assert.ok((await related()).filter((entry) => entry.id !== conflict.id).every((entry) => entry.name === ""));
  await request(`api/relations/${conflict.id}`, "DELETE");
  await batch.getByRole("button", { name: "保存全部", exact: true }).click();
  await batch.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "批量重命名关联：生成结果 · 4", exact: true }).waitFor();
  assert.ok((await related()).every((entry) => entry.name === "生成结果"));
  await page.screenshot({ path: "data/wiki-canvas-rename-desktop.png", fullPage: true });

  // This member is created after loading the canvas, but the tag rule still covers it.
  const unseen = await create("未显示的成员", "", ["合集"]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".canvas-toolbar").getByRole("button", { name: "适应画面", exact: true }).click();
  await page.getByRole("button", { name: "批量重命名关联：原型图 · 4", exact: true }).click();
  await batch.getByText(/包括未在当前画布显示的内容及以后加入的内容/).waitFor();
  await batch.getByLabel("关联名称", { exact: true }).fill("参考图");
  await page.screenshot({ path: "data/wiki-canvas-rename-mobile.png", fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await batch.getByRole("button", { name: "保存全部", exact: true }).click();
  await batch.waitFor({ state: "hidden" });
  const unseenRelations = (await (await request(`api/elements/${unseen.id}/relations`)).json()).relations;
  assert.equal(unseenRelations[0].name, "参考图");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "展开图片组：4 张图片", exact: true }).click();
  await page.getByRole("button", { name: "全部连线", exact: true }).click();
  const single = page.locator(`.react-flow__edge[data-id="${direct[0].id}"]`).getByRole("button", { name: "重命名关联：生成结果", exact: true });
  await single.focus();
  await single.press("Enter");
  const dialog = page.getByRole("dialog", { name: "重命名关联", exact: true });
  await dialog.getByLabel("关联名称", { exact: true }).fill("");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const saved = await related();
  assert.equal(saved.find((entry) => entry.id === direct[0].id).name, "");
  assert.ok(saved.filter((entry) => entry.id !== direct[0].id).every((entry) => entry.name === "生成结果"));
  await openCanvas();
  await page.getByRole("button", { name: "全部连线", exact: true }).click();
  await page.locator(`.react-flow__edge[data-id="${direct[0].id}"]`).getByRole("button", { name: "重命名关联：关联", exact: true }).waitFor();
});

test("Canvas selection preserves manual zoom on desktop and phone", options, async (t) => {
  const { page, create, openCanvas } = await setup(t);
  await create("缩放保持测试");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await openCanvas();
    const card = page.locator(".canvas-card");
    for (const [control, clicks] of [["放大", 4], ["缩小", 9]]) {
      for (let index = 0; index < clicks; index++) await page.getByRole("button", { name: control, exact: true }).click();
      await page.waitForTimeout(300);
      const before = await card.boundingBox();
      await page.getByRole("button", { name: "选择内容：缩放保持测试", exact: true }).click();
      await page.getByRole("heading", { name: "缩放保持测试", exact: true }).waitFor();
      await page.waitForTimeout(300);
      const after = await card.boundingBox();
      assert.ok(Math.abs(after.width - before.width) < 0.1, `${width}px / ${control}: selecting must keep card size (${before.width} → ${after.width})`);
      await page.getByRole("button", { name: "关闭画布详情", exact: true }).click();
    }
  }
});

test("Canvas keeps newly created relation text after a failed connection and retries without duplicating it", options, async (t) => {
  const { page, request, create, openCanvas } = await setup(t);
  await create("关联起点");
  await openCanvas();
  await page.getByRole("button", { name: "选择内容：关联起点", exact: true }).click();
  await page.getByRole("button", { name: "添加关联", exact: true }).click();
  let attempts = 0;
  await page.route("**/api/relations", (route) => ++attempts === 1 ? route.fulfill({ status: 500, json: { error: "关联暂时失败" } }) : route.continue());
  const picker = page.getByRole("dialog", { name: "添加关联", exact: true });
  await picker.getByRole("button", { name: "新建文字", exact: true }).click();
  await picker.getByLabel("文字", { exact: true }).fill("新关联文字");
  await picker.getByRole("button", { name: "保存并关联", exact: true }).click();
  await picker.getByText("关联暂时失败", { exact: true }).waitFor();
  await picker.getByRole("button", { name: "重试关联", exact: true }).click();
  await picker.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector(".canvas-footer")?.textContent.includes("2 条内容 · 1 条关联"));
  assert.equal((await (await request("api/elements")).json()).pagination.total, 2);
});

test("Canvas batch controls enforce the node limit while rendering only the visible area", options, async (t) => {
  const { app, page, openCanvas } = await setup(t);
  const db = new DatabaseSync(path.join(app.dataDir, "library.sqlite3"));
  try {
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO elements(kind,body,created_at,updated_at) VALUES (1,?,'now','now')");
    for (let i = 0; i < 350; i++) insert.run(`测试内容 ${i}`);
    const relate = db.prepare("INSERT INTO element_relations(source_id,target_id,kind,created_at) VALUES (?,?,1,'now')");
    for (let id = 51; id <= 350; id++) for (let step = 1; step <= 5 && id + step <= 350; step++) relate.run(id, id + step);
    db.exec("COMMIT");
  } finally { db.close(); }
  await openCanvas();
  for (const count of [100, 200]) {
    await page.waitForFunction((count) => document.querySelector(".canvas-footer")?.textContent.includes(`${count} 条内容`), count);
    await page.getByRole("button", { name: "加载更多", exact: true }).click();
  }
  await page.waitForFunction(() => document.querySelector(".canvas-footer")?.textContent.includes("300 条内容 · 1200 条关联"));
  assert.equal(await page.getByRole("button", { name: "加载更多", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length < 300);
  await page.getByLabel("搜索画布内容", { exact: true }).fill("测试内容 349");
  await page.waitForFunction(() => document.querySelector(".canvas-footer")?.textContent.includes("1 条内容 · 0 条关联"));
});

test("Canvas includes every element from a mixed save even when its active filter excludes them", options, async (t) => {
  const { page, create, openCanvas } = await setup(t);
  await create("已有元素");
  await openCanvas();
  await page.getByLabel("搜索画布内容", { exact: true }).fill("已有元素");
  await page.getByRole("button", { name: "添加内容", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加内容", exact: true });
  await dialog.getByLabel("文字", { exact: true }).fill("新文字甲");
  await dialog.getByRole("button", { name: "添加文字", exact: true }).click();
  await dialog.getByLabel("文字", { exact: true }).last().fill("新文字乙");
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#8598ab" } }).png().toBuffer();
  await page.getByLabel("导入图片或视频文件").setInputFiles({ name: "新增图片.png", mimeType: "image/png", buffer: bytes });
  await dialog.getByRole("button", { name: "保存全部", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector('.canvas-footer')?.textContent.includes('4 条内容'));
  for (const name of ["新文字甲", "新文字乙", "新增图片.png"]) await page.locator('.react-flow__node').getByText(name, { exact: true }).first().waitFor();
});

test("Canvas tag folders share edits, regroup untagged content, preserve flat layout and restore the overview viewport", options, async (t) => {
  const { app, page, request, create, openCanvas } = await setup(t);
  const shared = await create("海边的光", "蓝色、白色与午后阳光。", ["旅行", "自然"]);
  const travel = await create("出发清单", "相机、水壶和笔记本。", ["旅行"]);
  const loose = await create("待整理的想法");
  const bytes = await sharp({ create: { width: 400, height: 280, channels: 3, background: "#9aaebd" } }).png().toBuffer();
  const photo = await (await fetch(new URL("api/images", app.url), { method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("天空色卡.png"), "x-image-tags": Buffer.from(JSON.stringify(["自然"])).toString("base64") }, body: bytes })).json();
  const position = { x: 840, y: 260 };
  await request("api/canvas/layout", "PUT", { positions: [{ id: shared.id, ...position }] });
  let layoutWrites = 0;
  page.on("request", (request) => { if (request.url().endsWith("/api/canvas/layout") && request.method() === "PUT") layoutWrites++; });
  await openCanvas();
  let failOverview = true;
  await page.route("**/api/canvas?*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (failOverview && params.get("view") === "tags") { failOverview = false; return route.fulfill({ status: 500, json: { error: "分组读取暂时失败" } }); }
    return route.continue();
  });
  await page.getByRole("button", { name: "标签视图", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "分组读取暂时失败" }).waitFor();
  await page.getByRole("button", { name: "刷新画布", exact: true }).click();
  await page.getByRole("button", { name: "打开标签：旅行，2 条内容", exact: true }).waitFor();
  await page.getByRole("button", { name: "打开标签：自然，2 条内容", exact: true }).waitFor();
  await page.getByRole("button", { name: "选择内容：待整理的想法", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: /^选择内容：海边/ }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "保存布局", exact: true }).count(), 0);
  await page.locator(".canvas-tag-preview img").waitFor();
  await page.screenshot({ path: "data/wiki-canvas-tags-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await page.waitForTimeout(300);
  const viewport = await page.locator(".react-flow__viewport").evaluate((element) => getComputedStyle(element).transform);
  await page.getByRole("button", { name: "打开标签：旅行，2 条内容", exact: true }).click();
  await page.getByRole("button", { name: /^选择内容：海边/ }).click();
  await page.getByRole("button", { name: "添加关联", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "添加关联", exact: true });
  await openRelationAdvanced(picker);
  await picker.getByLabel("关系名称", { exact: true }).fill("灵感来源");
  await picker.getByRole("button", { name: /^选择：出发清单/ }).click();
  await picker.getByRole("button", { name: "关联这 1 项内容", exact: true }).click();
  await picker.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: /^解除灵感来源：出发清单/ }).waitFor();
  await page.getByRole("button", { name: "编辑内容", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑内容", exact: true });
  await editor.getByLabel("文字", { exact: true }).fill("海边的光 · 更新");
  await editor.getByRole("button", { name: "移除标签：旅行", exact: true }).click();
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector(".canvas-footer")?.textContent.includes("1 条内容"));
  await page.getByRole("button", { name: "标签总览", exact: true }).click();
  await page.getByRole("button", { name: "打开标签：旅行，1 条内容", exact: true }).waitFor();
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".react-flow__viewport").evaluate((element) => getComputedStyle(element).transform), viewport);
  await page.getByRole("button", { name: "打开标签：自然，2 条内容", exact: true }).click();
  await page.getByRole("button", { name: "选择内容：海边的光 · 更新", exact: true }).click();
  await page.getByRole("button", { name: "编辑内容", exact: true }).click();
  await editor.getByRole("button", { name: "移除标签：自然", exact: true }).click();
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "标签总览", exact: true }).click();
  await page.getByRole("button", { name: "打开标签：自然，1 条内容", exact: true }).waitFor();
  await page.getByRole("button", { name: "选择内容：待整理的想法", exact: true }).click();
  await page.getByRole("button", { name: "编辑内容", exact: true }).click();
  await editor.getByLabel("标签", { exact: true }).fill("旅行");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "打开标签：旅行，2 条内容", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "选择内容：待整理的想法", exact: true }).count(), 0);
  await page.getByRole("button", { name: "适应画面", exact: true }).first().click();
  await page.getByRole("button", { name: "选择内容：海边的光 · 更新", exact: true }).click();
  await page.getByRole("button", { name: "展开关联", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".canvas-footer")?.textContent.includes("2 条内容 · 1 条关联"));
  assert.equal(await page.getByRole("button", { name: "平铺视图", exact: true }).getAttribute("aria-pressed"), "true");
  const graph = await (await request("api/canvas")).json();
  assert.deepEqual(graph.elements.find((element) => element.id === shared.id).position, position);
  assert.deepEqual(new Set(graph.elements.map((element) => element.id)), new Set([shared.id, travel.id, loose.id, photo.id]));
  assert.equal(layoutWrites, 0);
  await page.getByRole("button", { name: "标签视图", exact: true }).click();
  await page.getByRole("button", { name: "打开标签：旅行，2 条内容", exact: true }).waitFor();
  await openCanvas();
  await page.getByRole("button", { name: "打开标签：旅行，2 条内容", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "标签视图", exact: true }).getAttribute("aria-pressed"), "true");
  await page.getByLabel("搜索画布内容", { exact: true }).fill("天空色卡");
  await page.waitForFunction(() => document.querySelector(".canvas-footer")?.textContent.includes("1 / 1 个标签 · 0 / 0 条无标签内容"));
  await page.getByRole("button", { name: "打开标签：自然，1 条内容", exact: true }).click();
  await page.getByRole("button", { name: "选择内容：天空色卡.png", exact: true }).waitFor();
});

test("LAN canvas supports editing, filters trash and fits a phone viewport", options, async (t) => {
  const { page, request, create, openCanvas } = await setup(t);
  const a = await create("自然观察", "把散步时看到的颜色记下来。", ["生活"]);
  const b = await create("一片叶子", "叶脉与光影。", ["自然"]);
  const hidden = await create("已删除的笔记", "", ["回收站标签"]);
  await request("api/relations", "POST", { leftId: a.id, rightId: b.id });
  await request(`api/elements/${hidden.id}`, "DELETE");
  const listener = createHttpServer();
  await new Promise((resolve) => listener.listen(0, "0.0.0.0", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  await request("api/lan-sharing", "PUT", { port, autoStart: false, allowWrite: true });
  const lanToken = (await (await request("api/lan-sharing")).json()).token;
  const lanFetch = (target, options = {}) => fetch(target, { ...options, headers: { "x-self-wiki-lan-token": lanToken, ...options.headers } });
  await request("api/lan-sharing", "POST", { enabled: true });
  const lan = `http://127.0.0.1:${port}`;
  await page.setViewportSize({ width: 390, height: 844 });
  await openCanvas(`${lan}/?pair=${lanToken}#wiki`);
  await page.getByRole("button", { name: /^选择内容：自然观察/ }).click();
  await page.getByRole("heading", { name: /^自然观察/ }).waitFor();
  assert.equal(await page.getByRole("button", { name: "编辑内容", exact: true }).count(), 1);
  assert.ok(await page.getByRole("button", { name: "添加内容", exact: true }).count() >= 1);
  assert.equal(await page.getByRole("button", { name: "保存布局", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: /重命名关联/ }).count(), 1);
  assert.equal((await lanFetch(`${lan}/api/relations/batch`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [1], name: "局域网修改" }) })).status, 200);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal((await lanFetch(`${lan}/api/canvas/layout`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ positions: [{ id: a.id, x: 1, y: 2 }] }) })).status, 200);
  assert.equal((await lanFetch(`${lan}/api/canvas?scope=trash`)).status, 200);
  assert.ok(!(await (await lanFetch(`${lan}/api/canvas?ids=${hidden.id}`)).json()).elements.some((element) => element.id === hidden.id));
  await page.waitForFunction((id) => {
    const card = document.querySelector(`.react-flow__node[data-id="${id}"]`)?.getBoundingClientRect();
    const panel = document.querySelector('.canvas-inspector')?.getBoundingClientRect();
    return card && panel && card.bottom <= panel.top + 1;
  }, a.id);
  const cardBox = await page.locator(`.react-flow__node[data-id="${a.id}"]`).boundingBox();
  const panelBox = await page.locator(".canvas-inspector").boundingBox();
  assert.ok(cardBox.y + cardBox.height <= panelBox.y + 1, "The selected card remains above the phone detail panel");
  await page.screenshot({ path: "data/wiki-canvas-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "打开详情页", exact: true }).click();
  const detail = page.getByRole("region", { name: "内容详情", exact: true });
  await detail.locator(".wiki-text-document pre").waitFor();
  assert.equal(await detail.locator(".wiki-text-document pre").textContent(), a.body);
  assert.equal(await detail.getByRole("button", { name: "编辑", exact: true }).count(), 1);
  await detail.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: "标签视图", exact: true }).click();
  await page.getByRole("button", { name: "打开标签：生活，1 条内容", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: /打开标签：回收站标签/ }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: "data/wiki-canvas-tags-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "打开标签：生活，1 条内容", exact: true }).click();
  await page.getByRole("button", { name: /^选择内容：自然观察/ }).click();
  await page.getByRole("heading", { name: /^自然观察/ }).waitFor();
  assert.equal(await page.getByRole("button", { name: "编辑内容", exact: true }).count(), 1);
  await page.getByRole("button", { name: "展开关联", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".canvas-footer")?.textContent.includes("2 条内容 · 1 条关联"));
  const grouped = await (await lanFetch(`${lan}/api/canvas?view=tags`)).json();
  assert.deepEqual(grouped.totals, { groups: 2, untagged: 0 });
  assert.equal((await lanFetch(`${lan}/api/canvas?view=tags&scope=trash`)).status, 200);
});
