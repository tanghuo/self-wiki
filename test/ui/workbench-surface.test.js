import { stubWorkbenchModels } from '../helpers/workbenchModels.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, chromium, fetch } from '../helpers/authenticatedServer.js';
import { resolveBrowserPath } from '../resolveBrowserPath.js';

const executablePath = resolveBrowserPath();
test('workbench renders markdown in a centered neutral surface and keeps mobile navigation usable', { timeout: 30000, skip: !executablePath }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-workbench-surface-'));
  let app, browser;
  t.after(async () => {
    await browser?.close(); await app?.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('wiki-workbench-surface-'));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  app = await createServer({ port: 0, dataDir: root, agentWorkbenchEnabled: true, async openWorkbenchEngine(_settings, callbacks) {
    return { sessionId: 'surface-fixture', version: 'test', capabilities: {}, cancel() {}, async close() {}, async prompt(_text, delivery) {
      delivery('attempted');
      await callbacks.onEvent('message.delta', { text: '这是 **Markdown 展示示例**。\n\n可以在这里讨论任务、查看执行结果，并继续追问。\n\n- **对话**：消息和输入框保持相同宽度。\n- **文件**：通过输入框左下角的加号添加参考图。\n- **会话设置**：点击右上角图标查看权限与恢复。\n\n代码示例：\n\n```js\nconst message = "Hello, world!";\nconsole.log(message);\n```' });
      return { stopReason: 'end_turn' };
    } };
  } });
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } }); page.setDefaultTimeout(8000);
  await stubWorkbenchModels(page);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url + '#workbench');
  await page.getByLabel('任务内容').fill('展示一下新的对话界面');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.locator('.workbench-markdown strong').filter({ hasText: 'Markdown 展示示例' }).waitFor();
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  assert.match(await page.locator('.workbench-markdown pre code').innerText(), /console.log/);
  assert.equal(await page.getByRole('complementary', { name: '会话详情' }).count(), 0);
  assert.equal(await page.locator('input[type=file]').isVisible(), false);
  const composer = await page.locator('.workbench-composer').boundingBox();
  const transcript = await page.locator('.workbench-timeline').boundingBox();
  assert.ok(composer.width <= 762 && Math.abs(composer.x - transcript.x) < 3);
  assert.equal(await page.locator('.workbench-message.user').evaluate(el => getComputedStyle(el).backgroundImage), 'none');
  const rail = await page.evaluate(() => {
    const hit = (element) => {
      const box = element.getBoundingClientRect();
      const target = document.elementFromPoint(box.x + 16, box.y + box.height / 2);
      return element === target || element.contains(target);
    };
    const recent = document.querySelector('.workbench-recent');
    const label = getComputedStyle(recent.querySelector('.workbench-thread-label'));
    const button = getComputedStyle(recent);
    const bubble = document.querySelector('.workbench-message.user').getBoundingClientRect();
    const sidebar = document.querySelector('.workbench-shell > .wiki-sidebar');
    const page = document.querySelector('.workbench-page');
    return {
      sidebar: hit(sidebar),
      embedded: sidebar.getBoundingClientRect().right <= page.getBoundingClientRect().left + 1,
      create: hit(document.querySelector('.workbench-new-chat')),
      recent: hit(recent),
      labelMatchesButton: label.color === button.color,
      bubbleInside: bubble.right <= innerWidth - 8,
      layout: getComputedStyle(document.querySelector('.workbench-layout')).display,
    };
  });
  assert.equal(rail.layout, 'grid');
  assert.equal(rail.sidebar, true);
  assert.equal(rail.embedded, true);
  assert.equal(rail.create, true);
  assert.equal(rail.recent, true);
  assert.equal(rail.labelMatchesButton, true);
  assert.equal(rail.bubbleInside, true);
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await page.getByRole('heading', { name: '今天想完成什么？' }).waitFor();
  await page.getByRole('button', { name: '展示一下新的对话界面' }).click();
  await page.locator('.workbench-markdown strong').filter({ hasText: 'Markdown 展示示例' }).waitFor();
  await mkdir('.local/workbench-ui', { recursive: true });
  await page.screenshot({ path: '.local/workbench-ui/redesign-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const mobileComposer = await page.locator('.workbench-composer').boundingBox();
  assert.ok(mobileComposer.y + mobileComposer.height <= 844);
  await page.screenshot({ path: '.local/workbench-ui/redesign-mobile.png' });
  await page.getByRole('button', { name: '切换会话列表' }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await page.getByRole('heading', { name: '今天想完成什么？' }).waitFor();
  assert.deepEqual(errors, []);
});

test('workbench preserves project expansion in localStorage and indents project threads', { timeout: 30000, skip: !executablePath }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-workbench-project-ui-'));
  let app, browser;
  t.after(async () => {
    await browser?.close(); await app?.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('wiki-workbench-project-ui-'));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const projectDir = path.join(root, 'demo-project');
  await mkdir(projectDir);
  app = await createServer({ port: 0, dataDir: path.join(root, 'data'), agentWorkbenchEnabled: true });
  const wsRes = await fetch(new URL('/api/agent/workspaces', app.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'project', path: projectDir, name: 'demo-project', trusted: true }) });
  const ws = await wsRes.json();
  await fetch(new URL('/api/agent/sessions', app.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: ws.id, title: '测试子会话', engine: 'grok-build' }) });

  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await stubWorkbenchModels(page);
  await page.goto(app.url + '#workbench');
  await page.locator('.workbench-project').waitFor();
  const thread = page.locator('.workbench-thread');
  await thread.waitFor();

  const threadPaddingLeft = await thread.evaluate(el => parseFloat(getComputedStyle(el).paddingLeft));
  const projectPaddingLeft = await page.locator('.workbench-project').evaluate(el => parseFloat(getComputedStyle(el).paddingLeft));
  assert.equal(threadPaddingLeft, 30);
  assert.equal(projectPaddingLeft, 8);
  assert.ok(threadPaddingLeft > projectPaddingLeft, 'thread is indented compared to project header');

  const storedOpen = await page.evaluate(() => JSON.parse(localStorage.getItem('workbenchOpenProjects')));
  assert.ok(Array.isArray(storedOpen) && storedOpen.includes(ws.id));

  await page.locator('.workbench-project').click();
  await thread.waitFor({ state: 'detached' });
  const storedCollapsed = await page.evaluate(() => JSON.parse(localStorage.getItem('workbenchOpenProjects')));
  assert.ok(Array.isArray(storedCollapsed) && !storedCollapsed.includes(ws.id));

  await page.reload();
  await page.locator('.workbench-project').waitFor();
  assert.equal(await page.locator('.workbench-thread').count(), 0);

  await page.locator('.workbench-project').click();
  await thread.waitFor();
  const storedReopen = await page.evaluate(() => JSON.parse(localStorage.getItem('workbenchOpenProjects')));
  assert.ok(Array.isArray(storedReopen) && storedReopen.includes(ws.id));
});
