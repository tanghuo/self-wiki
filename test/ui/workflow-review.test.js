import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { resolveBrowserPath } from '../resolveBrowserPath.js';
import { createServer } from '../../src/server/server.js';
import { workflowNode as n } from '../../src/shared/domain/workflow/examples.js';

const browserPath = resolveBrowserPath();
const options = { timeout: 20000, skip: !browserPath && 'Browser required' };
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function setup(t, nodes) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wiki-workflow-audit-'));
  const app = await createServer({ port: 0, dataDir: dir });
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  t.after(async () => { await browser.close(); await app.close(); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('wiki-workflow-audit-')); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); });
  const response = await fetch(new URL('api/workflows', app.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '审查复现', requestKey: 'audit-create', definition: { schemaVersion: 1, nodes, outputs: {} } }) });
  assert.equal(response.status, 200); const workflow = await response.json();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } }); page.setDefaultTimeout(6000);
  await page.goto(`${app.url}#workflow`);
  await page.getByRole('button', { name: /审查复现/ }).click();
  return { page, app, workflow };
}
async function begin(page) { await page.getByRole('button', { name: '运行', exact: true }).click(); }
async function finish(page) { await page.getByRole('button', { name: '开始运行', exact: true }).click(); await page.locator('.workflow-run h2 [data-state="succeeded"]').waitFor(); }

test('edits made while saving remain dirty after the earlier save completes', options, async (t) => {
  const { page, workflow } = await setup(t, [n('source', 'element', { source: 'fixed', parameter: 'source', valueType: 'text', default: 'source' })]);
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  await page.route(`**/api/workflows/${workflow.id}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    const response = await route.fetch(); entered.resolve(); await release.promise; await route.fulfill({ response });
  });
  await page.getByLabel('工作流名称', { exact: true }).fill('第一次保存');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await entered.promise;
  await page.getByLabel('工作流名称', { exact: true }).fill('保存期间继续修改');
  release.resolve();
  await page.getByRole('status').filter({ hasText: '已保存草稿' }).waitFor();
  assert.equal(await page.locator('.workflow-save-state').textContent(), '未保存');
});

test('finishing an upload after leaving a run form cannot modify a newly opened form', options, async (t) => {
  const { page } = await setup(t, [n('images', 'element', { source: 'runtime', parameter: 'images', valueType: 'list<image>' })]);
  const entered = deferred(), release = deferred(), completed = deferred(); t.after(() => release.resolve());
  await page.route('**/api/workflow-input-images', async (route) => {
    const response = await route.fetch(); entered.resolve(); await release.promise;
    try { await route.fulfill({ response }); } finally { completed.resolve(); }
  });
  await begin(page);
  const png = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#886644' } }).png().toBuffer();
  await page.locator('.workflow-input-form input[type=file]').setInputFiles({ name: 'late.png', mimeType: 'image/png', buffer: png });
  await entered.promise;
  await page.getByRole('button', { name: '返回编辑', exact: true }).click();
  await begin(page);
  release.resolve(); await completed.promise;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('.workflow-input-form img').count(), 0);
});

test('invalid JSON cannot silently run using the previous valid input', options, async (t) => {
  const { page, app, workflow } = await setup(t, [n('data', 'element', { source: 'runtime', parameter: 'data', valueType: 'json', default: { before: true } })]);
  await begin(page);
  await page.locator('.workflow-input-form textarea').fill('{');
  await page.getByRole('button', { name: '开始运行', exact: true }).click();
  const loaded = await (await fetch(new URL(`api/workflows/${workflow.id}`, app.url))).json();
  assert.equal(loaded.runs.length, 0);
  assert.equal(await page.locator('.workflow-input-form [aria-invalid="true"]').count(), 1);
});

test('submitted snapshots show fixed content as well as runtime inputs', options, async (t) => {
  const { page } = await setup(t, [n('fixed', 'element', { source: 'fixed', parameter: 'fixed', valueType: 'text', default: '固定要求' }), n('runtime', 'element', { source: 'runtime', parameter: 'runtime', valueType: 'text', default: '本次内容' })]);
  await begin(page);
  await page.getByLabel('第 1 步 · fixed', { exact: true }).fill('提交前修改的固定要求');
  await finish(page);
  const snapshot = page.locator('.workflow-run-snapshot');
  assert.equal(await snapshot.getByLabel('第 1 步 · fixed（本次快照）', { exact: true }).count(), 1);
  assert.equal(await snapshot.getByLabel('第 1 步 · fixed（本次快照）', { exact: true }).inputValue(), '提交前修改的固定要求');
  assert.equal(await snapshot.getByLabel('第 2 步 · runtime（本次快照）', { exact: true }).inputValue(), '本次内容');
});

test('result headings retain the step number and name used by the canvas and run form', options, async (t) => {
  const source = n('source', 'element', { source: 'runtime', parameter: 'source', valueType: 'text', default: '内容' }); source.name = '元素';
  const { page } = await setup(t, [source]);
  await begin(page); await finish(page);
  assert.equal(await page.locator('.workflow-result-heading>strong').first().textContent(), '第 1 步 · 文字');
});

test('library text cannot be replaced by an empty string or an error while its preview is unavailable', options, async (t) => {
  const { page, app } = await setup(t, [n('text', 'element', { source: 'runtime', parameter: 'text', valueType: 'text', default: { elementId: 1 } })]);
  const created = await fetch(new URL('api/elements', app.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: '应该保留的资料库原文' }) });
  assert.equal(created.status, 201);
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  await page.route('**/api/elements/1', async (route) => { entered.resolve(); await release.promise; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试：文字暂时不可用' }) }); });
  await begin(page); await entered.promise;
  const copy = page.getByRole('button', { name: '复制为可编辑文字', exact: true });
  assert.equal(await copy.isDisabled(), true, 'copy must wait for the actual text, rather than replacing the reference with a blank string');
  release.resolve();
  await page.getByRole('alert').filter({ hasText: '测试：文字暂时不可用' }).waitFor();
  assert.equal(await copy.isDisabled(), true, 'fetch errors must not become editable workflow content');
});
