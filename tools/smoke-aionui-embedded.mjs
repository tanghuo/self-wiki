import { _electron } from 'playwright-core';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, '.local/aionui-experiment');
const dataDir = path.join(output, 'embedded-smoke-data');
const env = { ...process.env, APP_DATA_DIR: dataDir };
for (const key of ['ELECTRON_RUN_AS_NODE', 'EXTERNAL_API_URL', 'VITE_DEV_SERVER_URL', 'API_PORT', 'NODE_BINARY']) delete env[key];
await mkdir(dataDir, { recursive: true });
const application = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root, `--user-data-dir=${path.join(dataDir, 'profile')}`], cwd: root, env, timeout: 120000 });
application.process().stderr.on('data', chunk => process.stderr.write(chunk));
try {
  const main = await application.firstWindow();
  await main.getByRole('link', { name: 'AionUi 实验版', exact: true }).click();
  let page;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    page = application.context().pages().find(candidate => candidate !== main && /\/guid$/.test(candidate.url()));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(page, 'AionUi must load as an embedded WebContentsView');
  await page.getByRole('button', { name: 'Grok Build', exact: true }).waitFor();
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  assert.equal(await page.evaluate(() => Boolean(window.wikiDesktop)), false);
  const nativeView = () => application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const view = window.contentView.children.find(child => child.webContents && child.webContents !== window.webContents);
    return { visible: view.getVisible(), bounds: view.getBounds(), url: view.webContents.getURL() };
  });
  assert.equal((await nativeView()).visible, true);
  const original = await nativeView();
  await main.getByRole('link', { name: '切换原工作台' }).click();
  await main.waitForTimeout(300);
  assert.equal((await nativeView()).visible, false);
  await main.evaluate(() => { location.hash = 'aionui'; });
  await main.waitForTimeout(700);
  assert.equal((await nativeView()).visible, true);
  assert.equal((await nativeView()).url, original.url);
  await main.getByRole('button', { name: '设置', exact: true }).click();
  await main.waitForTimeout(300);
  assert.equal((await nativeView()).visible, false);
  await main.keyboard.press('Escape');
  await main.waitForTimeout(700);
  assert.equal((await nativeView()).visible, true);
  const info = JSON.parse(await readFile(path.join(dataDir, 'aionui-experiment/experiment-instance.json'), 'utf8'));
  const api = async route => (await (await fetch(new URL(route, info.url))).json()).data;
  const results = [];
  for (const engine of ['Grok Build', 'Google 官方 ACP · self-wiki']) {
    await page.getByText('新会话', { exact: true }).click();
    await page.getByRole('button', { name: 'Grok Build', exact: true }).waitFor();
    const choice = page.getByRole('button', { name: engine, exact: true });
    if (!await choice.count()) {
      await page.getByRole('button', { name: '更多', exact: true }).click();
      await page.getByText(engine, { exact: true }).last().click();
    } else await choice.click();
    const marker = `EMBEDDED_${engine === 'Grok Build' ? 'GROK' : 'ACP'}_OK_${Date.now()}`;
    await page.locator('textarea').first().fill(`只回复 ${marker}，不要调用任何工具。`);
    await page.locator('textarea').first().press('Enter');
    const limit = Date.now() + 120000;
    let found = false, conversationId;
    while (Date.now() < limit) {
      const list = await api('/api/conversations');
      const conversation = list.items.find(item => item.name.includes(marker));
      if (conversation) {
        const messages = await api(`/api/conversations/${conversation.id}/messages`);
        if (messages.items.some(item => item.position === 'left' && item.content?.content?.includes(marker))) {
          assert.equal(conversation.extra.backend, engine === 'Grok Build' ? 'grok' : 'acp');
          if (engine !== 'Grok Build') assert.equal(conversation.extra.agent_id, info.agentId);
          found = true; conversationId = conversation.id; break;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(found, true, `${engine} must produce a real response`);
    await page.getByText(marker, { exact: true }).waitFor({ timeout: 15000 });
    await page.screenshot({ path: path.join(output, `embedded-${engine === 'Grok Build' ? 'grok' : 'acp'}.png`) });
    results.push({ engine, marker, conversationId, displayed: true, passed: true });
    console.log(`PASS: embedded ${engine} real response`);
  }
  await writeFile(path.join(output, 'embedded-smoke.json'), JSON.stringify({ passed: true, windows: 1, nativeView: await nativeView(), wikiPreloadExposed: false, comparisonPreservesPage: true, settingsHideView: true, results }, null, 2));
} finally { await application.close(); }
