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
import { chooseOption, selectedValue, openRelationAdvanced } from "../ui-select.js";

const browserPath = resolveBrowserPath();
const options = { timeout: 60000, skip: !browserPath && "Browser required" };

async function setup(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wiki-picker-"));
  const app = await createServer({ port: 0, dataDir });
  let browser;
  t.after(async () => {
    await browser?.close(); await app.close();
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("wiki-picker-"));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
  });
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const api = async (route, body) => (await fetch(new URL(route, app.url), {
    method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body && JSON.stringify(body),
  })).json();
  return { app, page, api };
}

test("directed relation presets, reverse-side editing and direction swap persist through the UI", options, async (t) => {
  const { app, page, api } = await setup(t);
  const original = await api("api/elements", { body: "方向测试原文" });
  const draft = await api("api/elements", { body: "方向测试改编" });
  await page.goto(`${app.url}#wiki`);
  await page.getByRole("button", { name: "打开内容：方向测试改编", exact: true }).click();
  await page.getByRole("button", { name: "添加关联", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "添加关联", exact: true });
  await openRelationAdvanced(picker);
  await picker.getByLabel("关系类型", { exact: true }).selectOption("参考");
  assert.match(await picker.getByLabel("关系预览").innerText(), /当前内容 — 参考了 → 所选内容/);
  await picker.getByRole("button", { name: "选择：方向测试原文", exact: true }).click();
  await picker.getByRole("button", { name: "关联这 1 项内容", exact: true }).click();
  await picker.waitFor({ state: "hidden" });
  const target = page.getByRole("button", { name: "重命名关联：方向测试原文", exact: true });
  await target.getByText("参考了", { exact: true }).waitFor();
  await page.getByRole("button", { name: "打开内容：方向测试原文", exact: true }).click();
  const reverse = page.getByRole("button", { name: "重命名关联：方向测试改编", exact: true });
  await reverse.getByText("被参考", { exact: true }).waitFor();
  await reverse.click();
  const editor = page.getByRole("dialog", { name: "重命名关联", exact: true });
  assert.match(await editor.getByLabel("关系预览").innerText(), /当前内容 — 被参考 → 对方内容/);
  await editor.getByRole("button", { name: "交换方向", exact: true }).click();
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await reverse.getByText("参考了", { exact: true }).waitFor();
  const saved = await api(`api/elements/${draft.id}/relations`);
  assert.equal(saved.relations.length, 1);
  assert.equal(saved.relations[0].sourceId, original.id);
  assert.equal(saved.relations[0].direction, "forward");
  assert.equal(saved.relations[0].reverseName, "被参考");
  await page.screenshot({ path: path.resolve(".local/relation-direction-ui.png") });
});

test("Image selection survives pages, filters, preview, removal and failed saves; only chosen images are related", options, async (t) => {
  const { app, page, api } = await setup(t);
  const images = [];
  for (let i = 0; i < 40; i++) {
    const bytes = await sharp({ create: { width: 80 + i, height: 160, channels: 3, background: "#91afa0" } }).png().toBuffer();
    images.push(await (await fetch(new URL("api/images", app.url), { method: "POST", headers: {
      "x-file-name": encodeURIComponent(`样例-${i}.png`), "x-image-tags": Buffer.from(JSON.stringify([i % 2 ? "奇数" : "偶数"])).toString("base64"),
    }, body: bytes })).json());
  }
  const source = await api("api/elements", { body: "提示词样例" });
  await page.goto(`${app.url}#wiki`);
  await page.getByRole("button", { name: "打开内容：提示词样例", exact: true }).click();
  await page.getByRole("button", { name: "添加关联", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "添加关联", exact: true });
  assert.equal(await picker.getByRole("button", { name: "选择：提示词样例", exact: true }).count(), 0);
  await chooseOption(picker, "筛选关联内容类型", "image");
  await picker.getByRole("button", { name: "选择：样例-39.png", exact: true }).waitFor();
  assert.equal(await picker.getByRole("button", { name: /^选择：/ }).count(), 36);
  for (let i = 39; i >= 29; i--) await picker.getByRole("button", { name: `选择：样例-${i}.png`, exact: true }).click();
  await picker.getByRole("button", { name: "下一页", exact: true }).click();
  for (const i of [3, 2]) await picker.getByRole("button", { name: `选择：样例-${i}.png`, exact: true }).click();
  await picker.getByRole("button", { name: "关联这 13 张图片", exact: true }).waitFor();
  assert.equal((await api(`api/elements/${source.id}/relations`)).pagination.total, 0);

  await chooseOption(picker, "筛选关联内容标签", "偶数");
  await picker.getByRole("button", { name: "选择：样例-38.png", exact: true }).waitFor();
  assert.equal(await picker.getByRole("button", { name: /^选择：/ }).count(), 20);
  await picker.getByLabel("搜索可关联内容").fill("没有匹配的图片");
  await picker.getByText("没有匹配的内容，试试其他关键词、类型或标签。", { exact: true }).waitFor();
  await picker.getByRole("button", { name: "只看已选", exact: true }).click();
  assert.equal(await picker.locator(".wiki-relation-body").evaluate((el) => el.scrollTop), 0);
  assert.equal(await picker.getByRole("button", { name: /^选择：/ }).count(), 13);
  await picker.getByRole("button", { name: "移除已选：样例-2.png", exact: true }).click();
  assert.equal(await picker.getByRole("button", { name: /^选择：/ }).count(), 12);
  await picker.getByRole("button", { name: "放大预览：样例-3.png", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "图片预览", exact: true });
  await preview.getByRole("img", { name: "样例-3.png", exact: true }).waitFor();
  await preview.getByRole("button", { name: "取消选择", exact: true }).click();
  await preview.getByRole("button", { name: "选择这张图片", exact: true }).click();
  await preview.press("Escape");
  await preview.waitFor({ state: "hidden" });
  assert.equal(await picker.isVisible(), true);
  await picker.getByRole("button", { name: "关联这 12 张图片", exact: true }).waitFor();

  for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 640 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    const layout = await picker.evaluate((el) => {
      const footer = el.querySelector(".wiki-dialog-footer").getBoundingClientRect();
      const body = el.querySelector(".wiki-relation-body").getBoundingClientRect();
      const tray = el.querySelector(".wiki-relation-selection").getBoundingClientRect();
      return { fits: el.scrollWidth <= el.clientWidth, footerVisible: footer.bottom <= innerHeight && footer.top >= 0,
        bodyUsable: body.height >= 70, noOverlap: body.bottom <= tray.top + 1 };
    });
    assert.deepEqual(layout, { fits: true, footerVisible: true, bodyUsable: true, noOverlap: true }, JSON.stringify(size));
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await openRelationAdvanced(picker);
  await picker.getByLabel("关系名称", { exact: true }).fill("提示词");
  let attempts = 0;
  await page.route("**/api/relations/batch", async (route) => {
    attempts++;
    if (attempts === 1) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "稍后重试" }) });
    else await route.continue();
  });
  await picker.getByRole("button", { name: "关联这 12 张图片", exact: true }).click();
  await picker.getByRole("alert").getByText("稍后重试", { exact: true }).waitFor();
  assert.equal(await picker.getByRole("button", { name: /^移除已选：/ }).count(), 12);
  await picker.getByRole("button", { name: "关联这 12 张图片", exact: true }).click();
  await picker.waitFor({ state: "hidden" });
  const related = await api(`api/elements/${source.id}/relations`);
  assert.deepEqual(new Set(related.relations.map((r) => r.element.id)), new Set([...images.slice(29).map((e) => e.id), images[3].id]));
  assert.equal(related.tagRelations.length, 0);
  assert.ok(related.relations.every((r) => r.name === "提示词"));
});

test("Select page refuses to truncate at the limit, selections can be cleared, and cancelling writes nothing", options, async (t) => {
  const { app, page, api } = await setup(t);
  for (let i = 0; i < 105; i++) await api("api/elements", { body: `候选文字 ${i}` });
  const source = await api("api/elements", { body: "来源文字" });
  await page.goto(`${app.url}#wiki`);
  await page.getByRole("button", { name: "打开内容：来源文字", exact: true }).click();
  await page.getByRole("button", { name: "添加关联", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "添加关联", exact: true });
  await picker.getByLabel("搜索可关联内容").fill("候选文字");
  await picker.getByRole("button", { name: "全选当前页", exact: true }).click();
  await picker.getByRole("button", { name: "下一页", exact: true }).click();
  await picker.getByRole("button", { name: "全选当前页", exact: true }).click();
  await picker.getByRole("button", { name: "关联这 72 项内容", exact: true }).waitFor();
  await picker.getByRole("button", { name: "下一页", exact: true }).click();
  await picker.getByRole("button", { name: "全选当前页", exact: true }).click();
  await picker.getByRole("alert").getByText(/还能选择 28 项/).waitFor();
  await picker.getByRole("button", { name: "关联这 72 项内容", exact: true }).waitFor();
  for (let i = 32; i >= 5; i--) await picker.getByRole("button", { name: `选择：候选文字 ${i}`, exact: true }).click();
  await picker.getByRole("button", { name: "关联这 100 项内容", exact: true }).waitFor();
  assert.equal(await picker.getByRole("button", { name: "选择：候选文字 4", exact: true }).isDisabled(), true);
  await picker.getByRole("button", { name: "选择：候选文字 5", exact: true }).click();
  await picker.getByRole("button", { name: "选择：候选文字 4", exact: true }).click();
  await picker.getByRole("button", { name: "关联这 100 项内容", exact: true }).waitFor();
  await picker.getByRole("button", { name: "清空选择", exact: true }).click();
  assert.equal(await picker.getByRole("button", { name: "关联这 0 项内容", exact: true }).isDisabled(), true);
  await picker.getByRole("button", { name: "选择：候选文字 4", exact: true }).click();
  await picker.getByRole("button", { name: "关闭关联选择", exact: true }).click();
  assert.equal((await api(`api/elements/${source.id}/relations`)).pagination.total, 0);
});
