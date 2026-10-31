import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, chromium } from '../helpers/authenticatedServer.js';
import { resolveBrowserPath } from '../resolveBrowserPath.js';
import { stubWorkbenchModels } from '../helpers/workbenchModels.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-aionui-ui-'));
  const app = await createServer({ port: 0, dataDir: root, agentWorkbenchEnabled: true });
  const browser = await chromium.launch({ executablePath: resolveBrowserPath(), headless: true });
  t.after(async () => {
    await browser.close(); await app.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('wiki-aionui-ui-'));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  await stubWorkbenchModels(page);
  return { app, page };
}

test('desktop entry embeds automatically and hides the native view when switching or opening settings', { timeout: 30000, skip: !resolveBrowserPath() }, async t => {
  const { app, page } = await fixture(t);
  await page.addInitScript(() => { window.embeds = []; window.wikiDesktop = { async embedAionui(value) { window.embeds.push(value); return { state: 'running' }; }, openAionui() { throw new Error('Must not open another window'); } }; });
  await page.goto(app.url + '#wiki');
  // The secondary Agent surfaces sit under 「更多」 in the sidebar.
  await page.getByRole('complementary', { name: '内容导航' }).getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('link', { name: 'AionUi 实验版', exact: true }).click();
  await page.waitForFunction(() => window.embeds.some(value => value.type === 'show'));
  assert.equal(await page.getByRole('button', { name: '打开 AionUi 实验版' }).count(), 0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.waitForFunction(() => window.embeds.at(-1).type === 'hide');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.embeds.at(-1).type !== 'hide');
  await page.getByRole('link', { name: '切换原工作台' }).click();
  await page.waitForFunction(() => window.embeds.at(-1).type === 'hide');
  await page.getByRole('link', { name: 'AionUi 实验版', exact: true }).click();
  await page.waitForFunction(() => window.embeds.at(-1).type !== 'hide');
  assert.equal(page.context().pages().length, 1);
});

test('browser embeds an iframe in place and preserves it while comparing the original workbench', { timeout: 30000, skip: !resolveBrowserPath() }, async t => {
  const { app, page } = await fixture(t);
  let starts = 0;
  await page.route('**/api/aionui/start', route => { starts++; return route.fulfill({ json: { state: 'running', url: app.url } }); });
  await page.route('**/guid', route => route.fulfill({ contentType: 'text/html', body: '<input aria-label="草稿"><p>Embedded AionUi fixture</p>' }));
  await page.goto(app.url + '#aionui');
  const frame = page.frameLocator('iframe[title="AionUi 工作台"]');
  await frame.getByLabel('草稿').fill('保留比较前的草稿');
  await page.getByRole('link', { name: '切换原工作台' }).click();
  await page.evaluate(() => { location.hash = 'aionui'; });
  await frame.getByLabel('草稿').waitFor();
  assert.equal(await frame.getByLabel('草稿').inputValue(), '保留比较前的草稿');
  assert.equal(starts, 1);
  assert.equal((await page.context().pages()).length, 1);
});
