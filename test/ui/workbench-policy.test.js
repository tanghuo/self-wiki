import { stubWorkbenchModels } from '../helpers/workbenchModels.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, chromium } from '../helpers/authenticatedServer.js';
import { resolveBrowserPath } from '../resolveBrowserPath.js';

const executablePath = resolveBrowserPath();
test('workbench selects a unified approval mode, persists changes and asks once after switching back to manual', { timeout: 30000, skip: !executablePath }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-workbench-policy-ui-'));
  let app, browser;
  t.after(async () => { await browser?.close(); await app?.close(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('wiki-workbench-policy-ui-')); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const modes = [];
  app = await createServer({ port: 0, dataDir: root, agentWorkbenchEnabled: true, async openWorkbenchEngine(_settings, callbacks) {
    modes.push(callbacks.approvalMode);
    return { sessionId: 'policy-ui', version: 'test', capabilities: { verified: true, approvalMode: callbacks.approvalMode }, cancel() {}, async close() {}, async prompt(text, delivery) {
      delivery('attempted');
      // Even a Grok permission callback must not create a second card in Ask mode.
      if (callbacks.approvalMode === 'ask') await callbacks.onRequest('session/request_permission', { toolCall: { toolName: 'write' }, options: [{ kind: 'allow_once', optionId: 'yes' }] });
      try { await callbacks.onRequest('fs/write_text_file', { path: path.join(callbacks.cwd, 'result.txt'), content: text }); }
      catch { await callbacks.onEvent('message.delta', { text: '已拒绝写入' }); return {}; }
      await callbacks.onEvent('message.delta', { text: '完成：' + text }); return {};
    } };
  } });
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await stubWorkbenchModels(page);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url + '#workbench');
  await page.locator('.workbench-launcher').getByLabel('审批模式').selectOption('auto');
  await page.getByLabel('任务内容').fill('检查自动审批');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByText('完成：检查自动审批', { exact: true }).waitFor();
  await page.locator('.workbench-turn-state[data-state="completed"]').waitFor({ state: 'attached' });
  assert.equal(await page.getByRole('region', { name: '待审批操作' }).count(), 0);
  const picker = () => page.locator('.workbench-composer').getByLabel('审批模式');
  assert.equal(await picker().inputValue(), 'auto');
  await picker().selectOption('allow');
  await page.waitForFunction(() => document.querySelector('.workbench-composer select[aria-label="审批模式"]')?.disabled === false);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.workbench-composer select[aria-label="审批模式"]')?.value === 'allow');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const composer = await page.locator('.workbench-composer').boundingBox();
  assert.ok(composer.y + composer.height <= 844);
  await mkdir('.local/workbench-ui', { recursive: true });
  await page.screenshot({ path: '.local/workbench-ui/approval-mode-mobile.png' });
  await picker().selectOption('ask');
  await page.waitForFunction(() => document.querySelector('.workbench-composer select[aria-label="审批模式"]')?.disabled === false);
  await page.getByLabel('任务内容').fill('这次手动确认');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('heading', { name: '写入文件' }).waitFor();
  assert.equal(await page.getByRole('region', { name: '待审批操作' }).count(), 1);
  assert.equal(await picker().isDisabled(), true);
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await page.getByText('已拒绝写入', { exact: true }).waitFor();
  assert.deepEqual(modes, ['auto', 'ask']);
  assert.deepEqual(errors, []);
});
