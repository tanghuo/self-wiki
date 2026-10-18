import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright-core";
import { createServer } from "../src/server/server.js";

const browserPath = [process.env.RENDERER_BROWSER_PATH, chromium.executablePath(),
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium"]
  .find((file) => file && existsSync(file));
const options = { timeout: 60000, skip: !browserPath && "Browser required" };

async function setup(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vocabulary-ui-"));
  const app = await createServer({ port: 0, dataDir });
  let browser;
  t.after(async () => {
    await browser?.close(); await app.close();
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir())); assert.ok(path.basename(dataDir).startsWith("vocabulary-ui-"));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
  });
  const api = async (route, body, method = body ? "POST" : "GET") => {
    const response = await fetch(new URL(`/api/${route}`, app.url), { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json(); assert.equal(response.ok, true, JSON.stringify(result)); return result;
  };
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(12000);
  const errors = []; page.on("pageerror", (e) => errors.push(e.message)); t.after(() => assert.deepEqual(errors, []));
  return { app, page, api };
}

test("settings preview and apply tag aliases, refresh existing cards, search aliases and undo on mobile", options, async (t) => {
  const { app, page, api } = await setup(t);
  const a = await api("elements", { body: "雨夜城市", tags: ["Cyberpunk", "赛博朋克"] });
  await api("elements", { body: "霓虹街道", tags: ["赛博朋克"] });
  await page.goto(`${app.url}#wiki`);
  await page.getByRole("button", { name: "按标签筛选" }).click();
  await page.getByRole("checkbox", { name: "Cyberpunk", exact: true }).check();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "名称与别名 统一标签、关联叫法" }).click();
  await page.getByLabel("别名", { exact: true }).fill("Cyberpunk");
  await page.getByLabel("主名称", { exact: true }).fill("赛博朋克");
  await page.getByRole("button", { name: "预览归一", exact: true }).click();
  const preview = page.getByRole("region", { name: "归一预览", exact: true });
  await preview.getByText("雨夜城市", { exact: true }).waitFor();
  assert.deepEqual((await api(`elements/${a.id}`)).tags, ["Cyberpunk", "赛博朋克"], "Preview must not mutate");
  if (process.env.VOCABULARY_SCREENSHOT_PATH) await page.screenshot({ path: process.env.VOCABULARY_SCREENSHOT_PATH });
  await preview.getByRole("button", { name: "应用归一" }).click();
  await page.getByRole("status").filter({ hasText: "已统一名称" }).waitFor();
  assert.deepEqual((await api(`elements/${a.id}`)).tags, ["赛博朋克"]);
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByRole("button", { name: "取消筛选标签：赛博朋克", exact: true }).waitFor();
  await page.getByRole("button", { name: "按标签筛选" }).click();
  await page.getByLabel("搜索标签", { exact: true }).fill("cyber");
  assert.equal(await page.getByRole("checkbox", { name: "赛博朋克", exact: true }).isChecked(), true);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector(".wiki-toolbar")?.textContent.includes("2 条内容"));
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "名称与别名 统一标签、关联叫法" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "解除别名：Cyberpunk", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "别名已解除" }).waitFor();
  assert.deepEqual((await api(`elements/${a.id}`)).tags, ["Cyberpunk", "赛博朋克"]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
});

test("relation alias settings align directed pairs, preserve direction and expose actionable API validation", options, async (t) => {
  const { app, page, api } = await setup(t);
  const a = await api("elements", { body: "原文" }), b = await api("elements", { body: "整理稿" });
  await api("relations", { sourceId: b.id, targetId: a.id, name: "based on", direction: "forward", reverseName: "basis for" });
  await page.goto(`${app.url}#wiki`); await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "名称与别名 统一标签、关联叫法" }).click();
  await page.getByRole("button", { name: "关联名称", exact: true }).click();
  await page.getByLabel("名称对的类型").selectOption("forward");
  await page.getByLabel("别名", { exact: true }).fill("based on");
  await page.getByLabel("主名称", { exact: true }).fill("参考了");
  await page.getByLabel("别名的反向名称", { exact: true }).fill("basis for");
  await page.getByLabel("主名称的反向名称", { exact: true }).fill("被参考");
  await page.getByRole("button", { name: "预览归一", exact: true }).click();
  await page.getByRole("region", { name: "归一预览" }).getByText(/A — based on → B/).waitFor();
  await page.getByRole("button", { name: "应用归一", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "已统一名称" }).waitFor();
  const relation = (await api(`elements/${a.id}/relations`)).relations[0];
  assert.equal(relation.name, "参考了"); assert.equal(relation.reverseName, "被参考"); assert.equal(relation.direction, "reverse");
  const invalid = await fetch(new URL("/api/vocabulary/aliases", app.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "tag", alias: { name: "same" }, canonical: { name: "same" } }) });
  assert.equal(invalid.status, 400);
  const origin = await fetch(new URL("/api/vocabulary/aliases", app.url), { method: "POST", headers: { origin: "https://example.com" }, body: "{}" });
  assert.equal(origin.status, 403);
  await page.getByRole("button", { name: "解除别名：based on", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "别名已解除" }).waitFor();
  assert.equal((await api(`elements/${a.id}/relations`)).relations[0].name, "based on");
});
