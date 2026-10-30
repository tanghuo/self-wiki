import { stubWorkbenchModels } from '../helpers/workbenchModels.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, chromium } from '../helpers/authenticatedServer.js';
import { resolveBrowserPath } from '../resolveBrowserPath.js';

const executablePath = resolveBrowserPath();
test('Antigravity picker, inline native notice and one-time approval work without automatically starting login', { timeout: 30000, skip: !executablePath }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-antigravity-ui-'));
  let app, browser, opened, loginRequests = 0, catalogRequests = 0;
  t.after(async () => {
    await browser?.close(); await app?.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('wiki-antigravity-ui-'));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  app = await createServer({ port: 0, dataDir: root, agentWorkbenchEnabled: true,
    async openWorkbenchEngine(settings, callbacks) {
      opened = { settings, callbacks };
      return { sessionId: 'antigravity-ui', version: 'test', capabilities: { verified: true, approvalMode: 'ask', applicationTools: false }, cancel() {}, async close() {},
        async prompt(text, delivery) {
          delivery('attempted');
          const allow = await callbacks.onRequest('engine/antigravity_approval', { toolCall: { toolCallId: 'write-1', title: '写入 result.txt', kind: 'edit', rawInput: { path: 'result.txt' }, content: [{ type: 'diff', path: 'result.txt', oldText: '', newText: 'hello' }] } });
          await callbacks.onEvent('message.delta', { text: allow ? 'Antigravity 已批准' : 'Antigravity 已拒绝' });
          return { stopReason: 'end_turn' };
        },
      };
    },
  });
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await stubWorkbenchModels(page);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/agent/engines/antigravity-acp/models', route => { catalogRequests++; return route.fulfill({ json: { models: [{ id: 'fixture-model', label: 'Fixture Gemini' }], defaultModel: 'fixture-model' } }); });
  await page.route('**/api/agent/engines/antigravity-acp/connect', route => { loginRequests++; return route.fulfill({ json: { models: [{ id: 'fixture-model', label: 'Fixture Gemini' }], defaultModel: 'fixture-model' } }); });
  // The initial Grok picker still loads its own catalog on opening.
  await page.route('**/api/agent/engines/grok-build/models', route => route.fulfill({ json: { models: [{ id: 'grok-fixture', label: 'Grok Fixture' }], defaultModel: 'grok-fixture' } }));
  await page.goto(app.url + '#workbench');
  await page.getByLabel('选择模型与推理强度').click();
  await page.getByRole('button', { name: 'Antigravity', exact: true }).click();
  await page.getByRole('button', { name: 'Fixture Gemini', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '连接 Antigravity 账号' }).count(), 0);
  assert.equal(loginRequests, 0);
  await page.getByRole('button', { name: 'Fixture Gemini', exact: true }).click();
  await page.getByLabel('选择推理强度').click();
  assert.equal(await page.getByRole('button', { name: '极高', exact: true }).count(), 0);
  await page.getByRole('button', { name: '中', exact: true }).click();
  assert.equal(await page.locator('.workbench-launcher').getByLabel('审批模式').isDisabled(), true);
  await page.getByLabel('任务内容').fill('用 Antigravity 测试');
  await page.getByText(/发送即确认使用 Antigravity 已有配置/).waitFor();
  await page.getByRole('button', { name: '发送', exact: true }).click();
  assert.equal(await page.getByRole('dialog', { name: '信任此工作区？' }).count(), 0);
  await page.getByRole('heading', { name: 'Antigravity 原生审批' }).waitFor();
  await page.getByText(/仅允许本次原生操作.*不限时等待/).waitFor();
  assert.equal(opened.callbacks.engine, 'antigravity-acp'); assert.deepEqual(opened.callbacks.tools, []);
  assert.equal(opened.settings.model, 'fixture-model'); assert.equal(opened.settings.effort, 'medium');
  await page.getByRole('button', { name: '允许一次', exact: true }).click();
  await page.getByText('Antigravity 已批准', { exact: true }).waitFor();
  await page.locator('.workbench-turn-state[data-state="completed"]').waitFor({ state: 'attached' });
  await page.getByLabel('选择模型与推理强度').click();
  await page.getByRole('button', { name: 'Fixture Gemini', exact: true }).waitFor();
  assert.equal(catalogRequests, 1, 'existing sessions reuse the catalog loaded on entry');
  assert.equal(loginRequests, 0); assert.deepEqual(errors, []);
});

test('Antigravity login appears only for authentication errors and connection failures stay in the picker', { timeout: 30000, skip: !executablePath }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-antigravity-auth-ui-'));
  let app, browser, loginRequests = 0;
  t.after(async () => {
    await browser?.close(); await app?.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('wiki-antigravity-auth-ui-'));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  app = await createServer({ port: 0, dataDir: root, agentWorkbenchEnabled: true });
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  await stubWorkbenchModels(page);
  let authRequired = false;
  await page.route('**/api/agent/engines/antigravity-acp/models', route => route.fulfill({ status: authRequired ? 401 : 503, json: authRequired
    ? { error: 'Antigravity 需要连接账号', code: 'AUTH_REQUIRED' }
    : { error: 'Antigravity 暂时不可用', code: 'ACP_ERROR' } }));
  await page.route('**/api/agent/engines/antigravity-acp/connect', route => {
    assert.equal(route.request().method(), 'POST');
    if (++loginRequests === 1) return route.fulfill({ status: 409, json: { error: '请先停止 Antigravity 任务再连接账号', code: 'ACTIVE_TURN' } });
    return route.fulfill({ json: { models: [{ id: 'authorized-model', label: 'Authorized Gemini' }], defaultModel: 'authorized-model' } });
  });
  await page.goto(app.url + '#workbench');
  await page.getByLabel('任务内容').fill('保留这条草稿');
  await page.getByLabel('选择模型与推理强度').click();
  await page.getByRole('button', { name: 'Antigravity', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Antigravity 暂时不可用' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '连接 Antigravity 账号' }).count(), 0);
  authRequired = true;
  await page.getByRole('button', { name: '重试读取模型' }).click();
  const connect = page.getByRole('button', { name: '连接 Antigravity 账号' });
  await connect.waitFor();
  assert.equal(loginRequests, 0);
  await connect.click();
  await page.getByRole('dialog', { name: '选择模型', exact: true }).getByRole('alert').filter({ hasText: '请先停止 Antigravity 任务再连接账号' }).waitFor();
  await page.getByLabel('选择模型与推理强度').click();
  assert.equal(await page.getByRole('alert').count(), 0, 'closing the picker hides connection errors');
  await page.getByLabel('选择模型与推理强度').click();
  await page.getByRole('button', { name: 'Grok', exact: true }).click();
  assert.equal(await page.getByRole('alert').count(), 0, 'connection errors belong only to Antigravity');
  await page.getByRole('button', { name: 'Antigravity', exact: true }).click();
  await connect.click();
  await page.getByRole('button', { name: 'Authorized Gemini', exact: true }).waitFor();
  assert.equal(await connect.count(), 0, 'successful authorization hides the login entry');
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await page.getByLabel('任务内容').inputValue(), '保留这条草稿');
  assert.equal(loginRequests, 2);
});
