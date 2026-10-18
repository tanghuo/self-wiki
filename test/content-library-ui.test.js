import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { createServer } from "../src/server/server.js";

const browserPath = [process.env.RENDERER_BROWSER_PATH, chromium.executablePath(),
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium"]
  .find((file) => file && existsSync(file));
const options = { timeout: 60000, skip: !browserPath && "Browser required" };

async function setup(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wiki-content-ui-"));
  const app = await createServer({ port: 0, dataDir });
  let browser;
  t.after(async () => {
    await browser?.close(); await app.close();
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("wiki-content-ui-"));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
  });
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(12000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const api = async (route, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(new URL(`api/${route}`, app.url), {
      method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json(); assert.equal(response.ok, true, JSON.stringify(result)); return result;
  };
  return { app, page, api };
}

test("tag confirmation and direct submission both retain the entered alias when its rule is removed", options, async (t) => {
  const { app, page, api } = await setup(t);
  await api("elements", { body: "主标签已有内容", tags: ["主标签"] });
  const alias = await api("vocabulary/aliases", { kind: "tag", alias: { name: "原始标签" }, canonical: { name: "主标签" } });
  const elements = [];
  for (const body of ["回车确认标签", "直接提交标签"]) elements.push(await api("elements", { body }));
  await page.goto(`${app.url}#wiki`);
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index];
    await page.getByRole("button", { name: `打开内容：${element.body}`, exact: true }).click();
    await page.getByRole("button", { name: "添加标签", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "编辑标签", exact: true });
    await page.waitForFunction(() => [...document.querySelectorAll("dialog datalist option")].some((option) => option.value === "原始标签"));
    await editor.getByLabel("标签", { exact: true }).fill("原始标签");
    if (!index) {
      await editor.getByLabel("标签", { exact: true }).press("Enter");
      await editor.getByRole("button", { name: "移除标签：原始标签", exact: true }).waitFor();
    }
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await editor.waitFor({ state: "hidden" });
    assert.deepEqual((await api(`elements/${element.id}`)).tags, ["主标签"]);
    await page.getByRole("button", { name: "返回", exact: true }).click();
  }
  await api(`vocabulary/aliases/tag/${alias.id}`, undefined, "DELETE");
  for (const element of elements) assert.deepEqual((await api(`elements/${element.id}`)).tags, ["原始标签"]);
});

test("the editor saves body changes with over-limit historical tags and allows reducing them", options, async (t) => {
  const { app, page, api } = await setup(t);
  const element = await api("elements", { body: "超限标签正文", tags: ["A", "B"] });
  const alias = await api("vocabulary/aliases", { kind: "tag", alias: { name: "A" }, canonical: { name: "B" } });
  await api(`elements/${element.id}`, { tags: ["B", ...Array.from({ length: 29 }, (_,i) => `T${i}`)] }, "PATCH");
  await api(`vocabulary/aliases/tag/${alias.id}`, undefined, "DELETE");
  await page.goto(`${app.url}#wiki`);
  await page.getByRole("button", { name: "打开内容：超限标签正文", exact: true }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑内容", exact: true });
  await editor.getByText(/当前有 31 个历史标签/).waitFor();
  await editor.getByRole("textbox", { name: "文字", exact: true }).fill("正文修改成功");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  const updated = await api(`elements/${element.id}`);
  assert.equal(updated.body, "正文修改成功"); assert.equal(updated.tags.length, 31);
  await page.getByRole("button", { name: "编辑标签", exact: true }).click();
  const tags = page.getByRole("dialog", { name: "编辑标签", exact: true });
  await tags.getByRole("button", { name: "移除标签：A", exact: true }).click();
  await tags.getByRole("button", { name: "保存", exact: true }).click();
  await tags.waitFor({ state: "hidden" });
  assert.equal((await api(`elements/${element.id}`)).tags.length, 30);
});

test("trash cards distinguish same-name images with loaded previews and visible deletion metadata", options, async (t) => {
  const { app, page, api } = await setup(t);
  const images = [];
  for (const background of ["red", "blue"]) {
    const bytes = await sharp({ create: { width: 80, height: 120, channels: 3, background } }).png().toBuffer();
    const image = await (await fetch(new URL("api/images", app.url), { method: "POST", headers: { "x-file-name": "same.png" }, body: bytes })).json();
    images.push(image); await api(`elements/${image.id}`, undefined, "DELETE");
  }
  await page.goto(`${app.url}#wiki`);
  await page.getByRole("complementary", { name: "内容导航" }).getByRole("button", { name: "回收站", exact: true }).click();
  await page.getByText("2 条内容", { exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll(".wiki-card.is-trashed img")].filter((image) => image.complete && image.naturalWidth > 0).length === 2);
  for (const image of images) {
    const card = page.locator(`[data-element-id="${image.id}"]`);
    await card.getByText("same.png", { exact: true }).waitFor();
    assert.match(await card.locator("time").innerText(), /删除于/);
    assert.match(await card.locator("img").getAttribute("src"), /scope=trash/);
    assert.equal(await card.getByRole("button", { name: "打开内容：same.png", exact: true }).isDisabled(), true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator(`[data-element-id="${images[0].id}"]`).getByRole("button", { name: "恢复内容", exact: true }).click();
  await page.getByText("1 条内容", { exact: true }).waitFor();
  assert.deepEqual((await api("elements?scope=trash")).elements.map((element) => element.id), [images[1].id]);
});
