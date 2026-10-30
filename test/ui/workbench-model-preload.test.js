import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, chromium } from '../helpers/authenticatedServer.js';
import { resolveBrowserPath } from '../resolveBrowserPath.js';

const executablePath = resolveBrowserPath();
test('workbench preloads all catalogs concurrently, reuses requests and ignores late results for another engine', { timeout: 30000, skip: !executablePath }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-model-preload-'));
  let app, browser;
  const gates = {}, counts = {}, started = {}, errors = [];
  t.after(async () => {
    for (const gate of Object.values(gates)) gate.resolve();
    await browser?.close(); await app?.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('wiki-model-preload-'));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  app = await createServer({ port: 0, dataDir: root, agentWorkbenchEnabled: true });
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  for (const engine of ['grok-build', 'codex-cli', 'antigravity-acp']) {
    gates[engine] = Promise.withResolvers(); started[engine] = Promise.withResolvers(); counts[engine] = 0;
    await page.route(`**/api/agent/engines/${engine}/models`, async route => {
      counts[engine]++;
      started[engine].resolve();
      await gates[engine].promise;
      await route.fulfill({ json: { models: [{ id: `${engine}-model`, label: `${engine} model` }], defaultModel: `${engine}-model` } });
    });
  }
  let logins = 0;
  await page.route('**/api/agent/engines/antigravity-acp/connect', route => { logins++; return route.abort(); });
  const allRequested = Promise.all(Object.values(started).map(entry => entry.promise));
  await page.goto(app.url + '#workbench'); await allRequested;
  assert.deepEqual(counts, { 'grok-build': 1, 'codex-cli': 1, 'antigravity-acp': 1 });
  await page.getByLabel('选择模型与推理强度').click();
  await page.getByRole('status').filter({ hasText: '正在读取模型' }).waitFor();
  await page.getByRole('button', { name: 'Antigravity', exact: true }).click();
  assert.equal(await page.getByLabel('任务内容').isEditable(), true);
  await page.getByRole('button', { name: 'Codex', exact: true }).click();
  gates['antigravity-acp'].resolve();
  await page.waitForResponse('**/api/agent/engines/antigravity-acp/models');
  assert.equal(await page.getByRole('button', { name: 'antigravity-acp model', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Grok', exact: true }).click();
  gates['codex-cli'].resolve();
  await page.waitForResponse('**/api/agent/engines/codex-cli/models');
  assert.equal(await page.getByRole('button', { name: 'codex-cli model', exact: true }).count(), 0);
  gates['grok-build'].resolve();
  await page.getByRole('button', { name: 'grok-build model', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Codex', exact: true }).click();
  await page.getByRole('button', { name: 'codex-cli model', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Antigravity', exact: true }).click();
  await page.getByRole('button', { name: 'antigravity-acp model', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Grok', exact: true }).click();
  assert.deepEqual(counts, { 'grok-build': 1, 'codex-cli': 1, 'antigravity-acp': 1 });
  assert.equal(logins, 0); assert.deepEqual(errors, []);
});

test('a failed background catalog is local to its engine and can be retried', { timeout: 30000, skip: !executablePath }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-model-retry-'));
  let app, browser, attempts = 0;
  t.after(async () => {
    await browser?.close(); await app?.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('wiki-model-retry-'));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  app = await createServer({ port: 0, dataDir: root, agentWorkbenchEnabled: true });
  browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage();
  await page.route('**/api/agent/engines/*/models', route => {
    if (route.request().url().includes('/codex-cli/')) {
      if (++attempts === 1) return route.fulfill({ status: 503, json: { error: 'Codex 暂时不可用' } });
      return route.fulfill({ json: { models: [{ id: 'codex-ready', label: 'Codex Ready' }], defaultModel: 'codex-ready' } });
    }
    return route.fulfill({ json: { models: [{ id: 'fixture-model', label: 'Fixture Model' }], defaultModel: 'fixture-model' } });
  });
  const failed = page.waitForResponse(response => response.url().includes('/codex-cli/models'));
  await page.goto(app.url + '#workbench'); await failed;
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.getByLabel('任务内容').fill('草稿仍可编辑');
  await page.getByLabel('选择模型与推理强度').click();
  await page.getByRole('button', { name: 'Codex', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Codex 暂时不可用' }).waitFor();
  await page.getByRole('button', { name: '重试读取模型' }).click();
  await page.getByRole('button', { name: 'Codex Ready', exact: true }).waitFor();
  assert.equal(attempts, 2);
  assert.equal(await page.getByLabel('任务内容').inputValue(), '草稿仍可编辑');
});
