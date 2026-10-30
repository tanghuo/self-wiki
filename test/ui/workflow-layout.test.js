import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, createServer, fetch } from '../helpers/authenticatedServer.js';
import { resolveBrowserPath } from '../resolveBrowserPath.js';
import { workflowNode as n, output as o } from '../../src/shared/domain/workflow/examples.js';

const browserPath = resolveBrowserPath();
test('run cards fill unequal columns and reflow after editing, disclosure and viewport changes', { timeout: 45000, skip: !browserPath && 'Browser required' }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wiki-workflow-layout-'));
  const app = await createServer({ port: 0, dataDir: dir });
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  t.after(async () => {
    await browser.close(); await app.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('wiki-workflow-layout-'));
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const nodes = [
    n('first', 'element', { source: 'fixed', parameter: 'first', valueType: 'text', default: '简短内容' }),
    n('tall', 'element', { source: 'fixed', parameter: 'tall', valueType: 'text', parts: [{ kind: 'ref', ref: o('first') }, { kind: 'text', text: '较长内容\n'.repeat(12) }] }),
    n('third', 'element', { source: 'fixed', parameter: 'third', valueType: 'text', default: '第三步' }),
    n('fourth', 'element', { source: 'fixed', parameter: 'fourth', valueType: 'text', default: '第四步' }),
    n('review', 'review', { valueType: 'text' }, { value: o('tall') }),
  ];
  const created = await fetch(new URL('api/workflows', app.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestKey: crypto.randomUUID(), name: '紧凑布局验证', definition: { schemaVersion: 1, nodes, outputs: {} } }) });
  assert.ok(created.ok, await created.clone().text());
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${app.url}#workflow`);
  await page.locator('.workflow-list article').filter({ hasText: '紧凑布局验证' }).getByRole('button', { name: '运行', exact: true }).click();
  await page.getByRole('button', { name: '开始运行', exact: true }).click();
  await page.locator('.workflow-run h2 [data-state="waiting_review"]').waitFor();
  const row = id => page.locator(`.workflow-result-row:has([data-node-id="${id}"])`);
  const assertCompact = async () => {
    await page.waitForFunction(() => {
      const box = id => document.querySelector(`.workflow-result-row:has([data-node-id="${id}"])`).getBoundingClientRect();
      const a = box('first'), b = box('tall'), c = box('third'), d = box('fourth'), review = box('review');
      return Math.abs(a.y - b.y) < 2 && c.x === a.x && Math.abs(c.y - a.bottom - 12) < 2
        && c.y < b.bottom && d.y >= c.bottom && review.y >= Math.max(b.bottom, d.bottom)
        && review.width > a.width * 1.9;
    });
  };
  await assertCompact();
  // Editing changes textarea rows; the next card must follow the new natural height.
  await row('tall').locator('textarea').fill('较长内容\n'.repeat(20));
  await assertCompact();
  await row('tall').locator('.workflow-composed-source summary').click();
  await assertCompact();
  // Native textarea resizing must also move the following cards without overlapping.
  const before = await row('third').boundingBox();
  await row('first').locator('textarea').evaluate(el => { el.style.height = '280px'; });
  await page.waitForFunction(previousY => document.querySelector('.workflow-result-row:has([data-node-id="third"])').getBoundingClientRect().y > previousY + 80, before.y);
  await assertCompact();
  await page.screenshot({ path: '.local/workflow-compact-layout.png', fullPage: true });
  await page.setViewportSize({ width: 650, height: 1000 });
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.workflow-result-row')].map(el => el.getBoundingClientRect());
    return rows.every((box, index) => box.x === rows[0].x && (!index || box.y >= rows[index - 1].bottom + 11));
  });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1500, height: 1000 });
  await assertCompact();
  assert.deepEqual(await page.locator('.workflow-result-row .workflow-node-result').evaluateAll(rows => rows.map(el => el.dataset.nodeId)), nodes.map(node => node.id));
  assert.deepEqual(errors, []);
});
