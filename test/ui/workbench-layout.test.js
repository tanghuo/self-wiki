import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, chromium, fetch } from '../helpers/authenticatedServer.js';
import { resolveBrowserPath } from '../resolveBrowserPath.js';
import { stubWorkbenchModels } from '../helpers/workbenchModels.js';

const executablePath = resolveBrowserPath();
test('workbench keeps menus, long titles, activity and details usable across window sizes', { timeout: 45000, skip: !executablePath }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-workbench-layout-'));
  let app, browser;
  const finish = Promise.withResolvers();
  t.after(async () => {
    finish.resolve(); await browser?.close(); await app?.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('wiki-workbench-layout-'));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const project = path.join(root, 'project'); await mkdir(project);
  app = await createServer({ port: 0, dataDir: path.join(root, 'data'), agentWorkbenchEnabled: true, async openWorkbenchEngine(_settings, callbacks) {
    return { sessionId: 'layout-fixture', version: 'test', capabilities: {}, cancel() { finish.resolve(); }, async close() {}, async prompt(_text, delivery) {
      delivery('attempted');
      await callbacks.onEvent('tool.updated', { id: 'inspect', title: '检查项目文件', status: 'running' });
      await callbacks.onEvent('message.delta', { text: '## 检查结果\n\n这是 **正文**，包含一个[链接](https://example.com)。\n\n- 第一项\n- 第二项\n\n```js\nconst result = "ok";\n```\n' });
      await finish.promise;
      await callbacks.onEvent('tool.updated', { id: 'inspect', title: '检查项目文件', status: 'completed' });
      return {};
    } };
  } });
  const response = await fetch(new URL('/api/agent/workspaces', app.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'project', path: project, name: '长项目名称'.repeat(12), trusted: true }) });
  assert.equal(response.status, 200);
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(8000);
  await stubWorkbenchModels(page);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url + '#workbench');
  await mkdir('.local/workbench-ui', { recursive: true });
  const input = page.getByLabel('任务内容');
  const initialHeight = (await input.boundingBox()).height;
  await input.fill('多行任务\n'.repeat(12));
  assert.ok((await input.boundingBox()).height > initialHeight);
  assert.ok((await input.boundingBox()).height <= 180);
  await input.fill('');
  assert.equal((await input.boundingBox()).height, initialHeight);
  const inside = async locator => {
    const box = await locator.boundingBox(), viewport = page.viewportSize();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, JSON.stringify({ box, viewport }));
  };
  for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 640, height: 360 }]) {
    await page.setViewportSize(viewport);
    await inside(page.locator('.workbench-launcher'));
    for (const [label, dialog] of [['选择模型与推理强度', '选择模型'], ['选择推理强度', '推理强度'], ['审批模式', '选择审批模式'], ['选择项目', '选择项目']]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      const popup = page.getByRole('dialog', { name: dialog, exact: true });
      await popup.waitFor(); await inside(popup);
      await page.screenshot({ path: `.local/workbench-ui/audit-${viewport.width}-${dialog}.png` });
      await page.keyboard.press('Escape');
      assert.equal(await popup.count(), 0);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole('button', { name: '选择项目', exact: true }).click();
  await page.getByRole('dialog', { name: '选择项目', exact: true }).getByRole('button', { name: '新建项目', exact: true }).click();
  const createDialog = page.getByRole('dialog', { name: '创建项目', exact: true });
  await inside(createDialog);
  assert.deepEqual(await createDialog.evaluate(n => { const style = getComputedStyle(n); return [style.backgroundColor, style.backdropFilter]; }), ['rgb(255, 255, 255)', 'none']);
  await createDialog.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
  await page.screenshot({ path: '.local/workbench-ui/audit-create-project.png' });
  await page.getByRole('button', { name: '关闭创建项目', exact: true }).click();
  await page.locator('.workbench-project').click();
  await page.getByLabel('任务内容').fill('检查完整工作台的长标题、运行状态、Markdown 正文与输入框布局，确认窄窗口也能正常操作');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.locator('.workbench-markdown strong').waitFor();
  const composerInput = page.getByLabel('任务内容');
  const composerHeight = (await composerInput.boundingBox()).height;
  await composerInput.fill('执行期间的多行草稿\n'.repeat(12));
  assert.ok((await composerInput.boundingBox()).height > composerHeight);
  await composerInput.fill('');
  assert.equal((await composerInput.boundingBox()).height, composerHeight);
  await page.waitForFunction(() => document.querySelectorAll('.workbench-session-spinner').length === 2);
  const selected = page.locator('.workbench-thread[aria-current]');
  assert.notEqual(await selected.evaluate(n => getComputedStyle(n).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.equal(await page.locator('.workbench-execution').getAttribute('open'), '');
  const spinner = page.locator('.workbench-activity-spinner');
  const before = await spinner.evaluate(n => getComputedStyle(n).transform);
  await page.waitForTimeout(130);
  assert.notEqual(await spinner.evaluate(n => getComputedStyle(n).transform), before);
  for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 640, height: 360 }]) {
    await page.setViewportSize(viewport);
    await inside(page.getByRole('button', { name: '会话设置' }));
    await inside(page.getByRole('button', { name: '停止', exact: true }));
    await inside(page.locator('.workbench-composer'));
    await page.getByRole('button', { name: '会话设置' }).click();
    await inside(page.getByRole('complementary', { name: '会话详情' }));
    await page.screenshot({ path: `.local/workbench-ui/audit-conversation-${viewport.width}.png` });
    await page.getByRole('button', { name: '会话设置' }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await spinner.evaluate(n => getComputedStyle(n).animationName), 'none');
  finish.resolve();
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.workbench-session-spinner'));
  assert.equal(await page.locator('.workbench-activity-line').count(), 1);
  assert.match(await page.locator('.workbench-execution > summary').innerText(), /1 次操作/);
  assert.equal(await page.locator('.workbench-activity-spinner').count(), 0);
  assert.equal(await page.locator('.workbench-execution').getAttribute('open'), null);
  assert.deepEqual(errors, []);
});
