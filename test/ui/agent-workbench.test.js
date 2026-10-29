import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, chromium, fetch } from '../helpers/authenticatedServer.js';
import { resolveBrowserPath } from '../resolveBrowserPath.js';
import sharp from 'sharp';

const executablePath = resolveBrowserPath();
test('enabled workbench converts old drafts through the UI without prompting or mutating legacy history', { timeout: 30000, skip: !executablePath }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-workbench-convert-ui-')); let app, browser, prompts = 0;
  t.after(async () => { await browser?.close(); await app?.close(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('wiki-workbench-convert-ui-')); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  app = await createServer({ port: 0, dataDir: root, agentWorkbenchEnabled: true, async openWorkbenchEngine(_settings, callbacks) { assert.equal(callbacks.restricted, true); return { sessionId: 'converted-fixture', version: 'test', capabilities: {}, cancel() {}, async close() {}, async prompt(text, delivery) { prompts++; assert.match(text, /显式从旧聊天转换/); delivery('attempted'); await callbacks.onEvent('message.delta', { text: '转换后的独立回答' }); return {}; } }; } });
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => { const response = await fetch(new URL('/api/' + route, app.url), { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) }); assert.equal(response.status, 200); return response.json(); };
  const legacy = await api('chat/sessions', {});
  await api(`chat/sessions/${legacy.id}/draft`, { text: '保留旧草稿', revision: 20 }, 'PUT');
  browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(10000);
  await page.goto(app.url + '#agent?session=' + legacy.id); await page.getByLabel('会话消息').fill('保留旧草稿');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByLabel('任务内容').waitFor(); assert.equal(await page.getByLabel('任务内容').inputValue(), '保留旧草稿');
  await page.getByText('已转换上下文，使用新的原生会话。', { exact: false }).waitFor(); assert.equal(prompts, 0);
  assert.equal((await api(`chat/sessions/${legacy.id}`)).session.draft.text, '保留旧草稿'); assert.equal((await api(`chat/sessions/${legacy.id}`)).turns.length, 0);
  await page.getByRole('button', { name: '发送', exact: true }).click(); await page.getByText('转换后的独立回答', { exact: true }).waitFor(); assert.equal(prompts, 1);
});
test('workbench creates trusted scratch, restores approval on refresh, rejects write, and fits a narrow viewport', { timeout: 30000, skip: !executablePath }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-workbench-ui-')); let app, browser, file;
  t.after(async () => { await browser?.close(); await app?.close(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('wiki-workbench-ui-')); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  let generated = 0;
  const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#3366ff' } }).png().toBuffer();
  app = await createServer({ port: 0, dataDir: root, workbenchImageExecutor: { async generate(_input, callbacks) { generated++; callbacks.onDispatch({ sessionId: 'fixture-image' }); return { bytes: image }; } }, async openWorkbenchEngine(_settings, callbacks) {
    file = path.join(callbacks.cwd, 'draft.txt');
    return { sessionId: 'synthetic', version: 'test', capabilities: {}, cancel() {}, close: async () => {}, async prompt(_text, delivery) {
      delivery('attempted');
      if (_text === '生成合成图片') { await callbacks.onToolCall({ name: 'image_submit', input: { prompt: 'blue fixture square' } }); return { stopReason: 'end_turn' }; }
      try { await callbacks.onRequest('fs/write_text_file', { path: file, content: 'synthetic write\n' }); }
      catch { await callbacks.onEvent('message.delta', { text: '用户拒绝了写入，文件没有创建。' }); }
      return { stopReason: 'end_turn' };
    } };
  } });
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(8000);
  await page.goto(app.url + '#workbench');
  await page.getByRole('button', { name: '启用工作台', exact: true }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await page.getByLabel('工作区', { exact: true }).selectOption('scratch');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '创建会话', exact: true }).click();
  await page.getByRole('textbox', { name: '任务内容' }).fill('写入合成文件');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('region', { name: '待审批操作' }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: '临时工作区', exact: false }).click();
  await page.getByRole('region', { name: '待审批操作' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await page.getByText('用户拒绝了写入，文件没有创建。', { exact: true }).waitFor();
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  await page.getByRole('textbox', { name: '任务内容' }).fill('保留刷新后的草稿');
  await page.getByText('草稿已保存', { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: '临时工作区', exact: false }).click();
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="任务内容"]')?.value === '保留刷新后的草稿');
  await page.getByRole('textbox', { name: '任务内容' }).fill('生成合成图片');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('region', { name: '待批准图片任务' }).waitFor(); assert.equal(generated, 0);
  await page.reload();
  await page.getByRole('button', { name: '临时工作区', exact: false }).click();
  await page.getByRole('button', { name: '批准并执行', exact: true }).click();
  await page.getByRole('img', { name: '已保存图片' }).waitFor(); assert.equal(generated, 1);
  await page.getByRole('button', { name: '带结果继续', exact: true }).click();
  await page.getByRole('button', { name: /^参考图/ }).waitFor();
  await page.getByRole('button', { name: '保存到 Wiki', exact: true }).click();
  await page.getByRole('button', { name: '已存入 Wiki', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const response = await fetch(new URL('/api/agent/sessions', app.url)); assert.equal(response.status, 200);
});
