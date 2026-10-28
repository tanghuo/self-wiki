import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { resolveBrowserPath } from '../resolveBrowserPath.js';
import { createServer } from '../../src/server/server.js';
import { workflowNode as n, output as o } from '../../src/shared/domain/workflow/examples.js';

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
  await page.locator('.workflow-list article').filter({ hasText: '审查复现' }).getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('button', { name: '画布（高级）', exact: true }).click();
  return { page, app, workflow };
}
async function begin(page) { await page.getByRole('button', { name: '运行', exact: true }).click(); }
async function finish(page) { await page.getByRole('button', { name: '开始运行', exact: true }).click(); await page.locator('.workflow-run h2 [data-state="succeeded"]').waitFor(); }

test('image review previews full images with zoom and navigation independently of selection', options, async (t) => {
  const { page, app, workflow } = await setup(t, [n('images', 'element', { source: 'runtime', parameter: 'images', valueType: 'list<image>' }), n('check', 'review', { valueType: 'list<image>' }, { value: o('images') })]);
  await begin(page);
  const portrait = await sharp({ create: { width: 1000, height: 1500, channels: 3, background: '#886644' } }).png().toBuffer();
  const landscape = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#668844' } }).png().toBuffer();
  await page.locator('.workflow-input-form input[type=file]').setInputFiles([{ name: 'portrait.png', mimeType: 'image/png', buffer: portrait }, { name: 'landscape.png', mimeType: 'image/png', buffer: landscape }]);
  await page.getByText('已选择 2 张图片', { exact: true }).waitFor();
  await page.getByRole('button', { name: '开始运行', exact: true }).click();
  const cards = page.locator('.workflow-review-images');
  await cards.getByRole('button', { name: '查看图片 1 大图', exact: true }).waitFor();
  assert.equal(await cards.getByRole('checkbox', { name: '保留图片 1' }).isChecked(), true);
  assert.equal(await cards.locator('img').first().evaluate((image) => getComputedStyle(image).objectFit), 'contain');
  await cards.getByRole('button', { name: '查看图片 1 大图', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '审核图片预览', exact: true });
  const image = preview.getByRole('img', { name: '审核原图 1', exact: true });
  await preview.getByText('1000 × 1500', { exact: false }).waitFor();
  assert.ok((await image.boundingBox()).height > 500, 'preview is large enough to inspect');
  await page.screenshot({ path: '.local/workflow-review-large-preview.png', fullPage: true, animations: 'disabled' });
  assert.equal(await preview.getByRole('checkbox', { name: '保留这张图片' }).isChecked(), true, 'viewing does not toggle selection');
  await image.hover(); await page.mouse.wheel(0, -400);
  await page.waitForFunction(() => !!document.querySelector('.workflow-image-preview img.is-zoomed'));
  await preview.getByRole('button', { name: '恢复全图', exact: true }).click();
  await preview.getByRole('checkbox', { name: '保留这张图片' }).uncheck();
  await preview.getByRole('button', { name: '下一张', exact: true }).click();
  await preview.getByText('1600 × 900', { exact: false }).waitFor();
  assert.equal(await preview.getByRole('checkbox', { name: '保留这张图片' }).isChecked(), true);
  await page.keyboard.press('ArrowLeft');
  await preview.getByText('1000 × 1500', { exact: false }).waitFor();
  assert.equal(await preview.getByRole('checkbox', { name: '保留这张图片' }).isChecked(), false);
  await page.keyboard.press('Escape');
  await preview.waitFor({ state: 'hidden' });
  assert.equal(await cards.getByRole('checkbox', { name: '保留图片 1' }).isChecked(), false);
  assert.equal(await cards.locator('img').first().evaluate((img) => getComputedStyle(img).opacity), '1', 'unselected images stay visible');
  const loaded = await (await fetch(new URL(`api/workflows/${workflow.id}`, app.url))).json();
  const before = await (await fetch(new URL(`api/workflow-runs/${loaded.runs[0].id}`, app.url))).json();
  assert.equal(before.state, 'waiting_review', 'preview never approves the run');
  await page.getByRole('button', { name: '通过', exact: true }).click();
  await page.locator('.workflow-run h2 [data-state="succeeded"]').waitFor();
  const after = await (await fetch(new URL(`api/workflow-runs/${loaded.runs[0].id}`, app.url))).json();
  const outputId = after.rootInstances.find((instance) => instance.nodeId === 'check').outputs.value;
  const artifact = await (await fetch(new URL(`api/workflow-artifacts/${outputId}?runId=${after.id}`, app.url))).json();
  assert.equal(artifact.value.length, 1, 'only the selected image is retained');
});

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
  const card = page.locator('.workflow-preparation-card[data-node-id="fixed"]');
  await card.getByText('固定要求', { exact: true }).waitFor();
  assert.equal(await card.locator('textarea').count(), 0, 'fixed content starts read-only');
  await card.getByRole('button', { name: '修改这项固定内容', exact: true }).click();
  await page.getByLabel('第 1 步 · fixed', { exact: true }).fill('提交前修改的固定要求');
  await card.getByText('已修改：开始时会保存到流程，以后每次运行都用新内容。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '保存修改并开始运行', exact: true }).click();
  await page.locator('.workflow-run h2 [data-state="succeeded"]').waitFor();
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
