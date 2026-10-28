import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { resolveBrowserPath } from "../resolveBrowserPath.js";
import { createServer } from "../../src/server/server.js";
import { defaultOrganizationConfig } from "../../src/shared/domain/organization.js";

const browserPath = resolveBrowserPath();
const options = { timeout: 60000, skip: !browserPath && "Browser required" };

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-workspace-ui-"));
  const config = defaultOrganizationConfig();
  config.executor.codexCli.executable = path.join(dir, "app-server.mjs");
  await writeFile(config.executor.codexCli.executable, await readFile(new URL("../fixtures/chat-app-server.txt", import.meta.url)));
  await writeFile(path.join(dir, "organization.json"), JSON.stringify(config));
  const app = await createServer({ port: 0, dataDir: dir });
  let browser;
  t.after(async () => {
    await browser?.close(); await app.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("wiki-workspace-ui-"));
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const create = async (body) => {
    const response = await fetch(new URL("api/elements", app.url), { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ body }) });
    assert.equal(response.status, 201); return response.json();
  };
  return { page, app, create };
}

test("closing unsaved content asks before discarding and preserves failed batch drafts", options, async (t) => {
  const { page, app } = await setup(t);
  await page.goto(`${app.url}#wiki`);
  await page.locator(".wiki-page-header").getByRole("button", { name: "新增内容", exact: true }).click();
  const composer = page.getByRole("dialog", { name: "新增内容", exact: true });
  await composer.getByRole("textbox", { name: "文字", exact: true }).fill("不能误丢的长篇草稿");
  await page.keyboard.press("Escape");
  const confirmation = page.getByRole("dialog", { name: "放弃未保存内容？", exact: true });
  await confirmation.getByRole("button", { name: "继续编辑", exact: true }).click();
  assert.equal(await composer.getByRole("textbox", { name: "文字", exact: true }).inputValue(), "不能误丢的长篇草稿");
  await composer.getByRole("button", { name: "添加文字", exact: true }).click();
  await composer.getByRole("textbox", { name: "文字", exact: true }).nth(1).fill("模拟保存失败的草稿");
  await page.route("**/api/elements", async (route) => {
    if (route.request().method() === "POST" && route.request().postDataJSON().body === "模拟保存失败的草稿") {
      return route.fulfill({ status: 503, json: { error: "保存暂不可用" } });
    }
    return route.continue();
  });
  await composer.getByRole("button", { name: "保存全部", exact: true }).click();
  await composer.getByRole("button", { name: "重试未保存项", exact: true }).waitFor();
  await composer.getByRole("button", { name: "关闭", exact: true }).click();
  await confirmation.getByRole("button", { name: "继续编辑", exact: true }).click();
  assert.equal(await composer.getByRole("textbox", { name: "文字", exact: true }).nth(1).inputValue(), "模拟保存失败的草稿");
  await composer.getByRole("button", { name: "关闭新增内容", exact: true }).click();
  await confirmation.getByRole("button", { name: "放弃未保存内容", exact: true }).click();
  await composer.waitFor({ state: "hidden" });
  const saved = await (await fetch(new URL("api/elements", app.url))).json();
  assert.deepEqual(saved.elements.map((element) => element.body), ["不能误丢的长篇草稿"]);
});

test("workspace navigation and browser back retain Wiki search and detail context", options, async (t) => {
  const { page, app, create } = await setup(t);
  const element = await create("摄影计划：清晨的公园");
  await create("另一个没有匹配的记录");
  await page.goto(`${app.url}#wiki`);
  await page.getByRole("textbox", { name: "搜索内容", exact: true }).fill("摄影");
  await page.getByRole("button", { name: `打开内容：${element.body}`, exact: true }).click();
  await page.getByRole("heading", { name: element.body, exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector(".wiki-agent-entry")?.getAttribute("aria-disabled") === "false");
  await page.getByRole("link", { name: "Agent 对话", exact: true }).click();
  await page.getByRole("main", { name: "Agent 对话", exact: true }).waitFor();
  await page.getByRole("button", { name: "全部内容", exact: true }).click();
  await page.getByRole("heading", { name: element.body, exact: true }).waitFor();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  assert.equal(await page.getByRole("textbox", { name: "搜索内容", exact: true }).inputValue(), "摄影");
  await page.waitForFunction(() => document.querySelector(".wiki-agent-entry")?.getAttribute("aria-disabled") === "false");
  await page.getByRole("link", { name: "Agent 对话", exact: true }).click();
  await page.getByRole("main", { name: "Agent 对话", exact: true }).waitFor();
  await page.goBack();
  assert.equal(await page.getByRole("textbox", { name: "搜索内容", exact: true }).inputValue(), "摄影");
  await page.waitForFunction(() => document.querySelector(".wiki-agent-entry")?.getAttribute("aria-disabled") === "false");
  await page.getByRole("link", { name: "Agent 对话", exact: true }).click();
  await page.getByRole("main", { name: "Agent 对话", exact: true }).waitFor();
  await page.getByRole("button", { name: "图片", exact: true }).click();
  await page.getByRole("heading", { name: "图片", exact: true }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "搜索内容", exact: true }).inputValue(), "");
});

test("inactive Wiki does not intercept paste in the Agent workspace", options, async (t) => {
  const { page, app } = await setup(t);
  await page.goto(app.url + "#wiki");
  await page.waitForFunction(() => document.querySelector(".wiki-agent-entry")?.getAttribute("aria-disabled") === "false");
  await page.getByRole("link", { name: "Agent 对话", exact: true }).click();
  await page.getByRole("main", { name: "Agent 对话", exact: true }).waitFor();
  await page.evaluate(() => {
    const data = new DataTransfer(); data.items.add(new File(["test"], "paste.png", { type: "image/png" }));
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  assert.equal(await page.getByRole("dialog", { name: "新增内容", exact: true }).count(), 0);
});

test("canvas selection remains when returning from the Agent workspace", options, async (t) => {
  const { page, app, create } = await setup(t);
  const element = await create("需要保留的画布选择");
  await page.goto(`${app.url}#wiki`);
  await page.getByRole("button", { name: "关系画布", exact: true }).click();
  await page.getByRole("button", { name: `选择内容：${element.body}`, exact: true }).click();
  await page.getByRole("button", { name: "编辑内容", exact: true }).waitFor();
  // Let the selection's deliberate centering complete before the user adjusts zoom.
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await page.waitForTimeout(300);
  const viewport = await page.locator(".react-flow__viewport").getAttribute("style");
  await page.waitForFunction(() => document.querySelector(".wiki-agent-entry")?.getAttribute("aria-disabled") === "false");
  await page.getByRole("link", { name: "Agent 对话", exact: true }).click();
  await page.getByRole("main", { name: "Agent 对话", exact: true }).waitFor();
  await page.getByRole("button", { name: "关系画布", exact: true }).click();
  await page.getByRole("button", { name: "编辑内容", exact: true }).waitFor();
  await page.waitForTimeout(650);
  assert.equal(await page.locator(`.react-flow__node.selected[data-id="${element.id}"]`).isVisible(), true);
  assert.equal(await page.locator(".react-flow__viewport").getAttribute("style"), viewport);
});

test("returning to a long detail preserves scroll while its data refreshes", options, async (t) => {
  const { page, app, create } = await setup(t);
  const element = await create(Array.from({ length: 130 }, (_, index) => `第 ${index + 1} 行：需要保留阅读位置的长文。`).join("\n"));
  await page.goto(`${app.url}#wiki`);
  await page.locator(`[data-element-id="${element.id}"] button`).click();
  await page.locator(".wiki-text-document pre").waitFor();
  await page.evaluate(() => window.scrollTo(0, 700));
  await page.waitForFunction(() => window.scrollY === 700);
  await page.waitForFunction(() => document.querySelector(".wiki-agent-entry")?.getAttribute("aria-disabled") === "false");
  await page.getByRole("link", { name: "Agent 对话", exact: true }).click();
  await page.getByRole("main", { name: "Agent 对话", exact: true }).waitFor();
  await page.route(`**/api/elements/${element.id}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  const refreshed = page.waitForResponse((response) => response.url() === `${app.url}api/elements/${element.id}`);
  await page.getByRole("button", { name: "全部内容", exact: true }).click();
  await refreshed;
  await page.locator(".wiki-text-document pre").waitFor();
  await page.waitForFunction(() => window.scrollY === 700);
});

test("late initial relations cannot reset a long detail after restoring its workspace scroll", options, async (t) => {
  const { page, app, create } = await setup(t);
  const element = await create(Array.from({ length: 130 }, (_, index) => `第 ${index + 1} 行：先阅读长文，再等待关联内容。`).join("\n"));
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  await page.route(`**/api/elements/${element.id}/relations?*`, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(`${app.url}#wiki`);
  await page.locator(`[data-element-id="${element.id}"] button`).click();
  await page.locator(".wiki-text-document pre").waitFor();
  const related = page.getByRole("region", { name: "关联内容", exact: true });
  await related.getByText("正在读取关联…", { exact: true }).waitFor();
  await page.evaluate(() => window.scrollTo(0, 700));
  await page.waitForFunction(() => window.scrollY === 700);
  await page.waitForFunction(() => document.querySelector(".wiki-agent-entry")?.getAttribute("aria-disabled") === "false");
  await page.getByRole("link", { name: "Agent 对话", exact: true }).click();
  await page.getByRole("main", { name: "Agent 对话", exact: true }).waitFor();
  await page.getByRole("button", { name: "全部内容", exact: true }).click();
  await page.locator(".wiki-text-document pre").waitFor();
  await page.waitForFunction(() => window.scrollY === 700);
  // Release only after workspace restoration, so the response always arrives late.
  release();
  await related.getByText("还没有关联。把参考图、文字或人物连接到这里。", { exact: true }).waitFor();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => window.scrollY), 700);
});
