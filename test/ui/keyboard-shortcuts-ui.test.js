import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "../helpers/authenticatedServer.js";
import { resolveBrowserPath } from "../resolveBrowserPath.js";
import { createServer, fetch } from "../helpers/authenticatedServer.js";

const browserPath = resolveBrowserPath();
const options = { timeout: 60000, skip: !browserPath && "Browser required" };

test("keyboard shortcuts: Ctrl+K / and Esc drive search, detail navigation and the shortcut list", options, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-shortcuts-ui-"));
  const app = await createServer({ port: 0, dataDir: dir });
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  t.after(async () => { await browser.close(); await app.close(); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); });
  for (const body of ["第一条笔记", "第二条笔记", "第三条笔记"]) {
    const response = await fetch(new URL("api/elements", app.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }) });
    assert.equal(response.status, 201);
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${app.url}#agent`);
  await page.getByLabel("会话消息").waitFor();
  const search = page.getByLabel("搜索内容", { exact: true });
  // Ctrl+K from the agent page jumps to the library search.
  await page.locator("body").press("Control+k");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "搜索内容");
  assert.equal(await page.evaluate(() => location.hash), "#wiki");
  await search.fill("笔记");
  await search.press("Escape");
  assert.equal(await search.inputValue(), "", "Esc clears the query");
  // Open a detail, move with arrows, return with Esc.
  await page.locator(".wiki-card").filter({ hasText: "第三条笔记" }).first().click();
  await page.getByRole("button", { name: "返回", exact: true }).waitFor();
  await page.locator("body").press("ArrowRight");
  await page.locator(".wiki-detail").filter({ hasText: "第二条笔记" }).first().waitFor();
  await page.locator("body").press("Escape");
  await search.waitFor();
  // "/" focuses the search; "?" lists the shortcuts and Esc closes the dialog.
  await page.locator("body").press("/");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "搜索内容");
  await page.locator("body").click({ position: { x: 5, y: 790 } });
  await page.keyboard.press("Shift+?");
  const dialog = page.getByRole("dialog", { name: "键盘快捷键" });
  await dialog.waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
});
