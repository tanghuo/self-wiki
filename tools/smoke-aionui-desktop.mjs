import { _electron } from 'playwright-core';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.join(root, '.local/aionui-experiment/desktop-smoke-data');
const artifactDir = path.join(root, '.local/aionui-experiment');
const expected = `AIONUI_DESKTOP_ACP_OK_${Date.now()}`;
await mkdir(artifactDir, { recursive: true });
const application = await _electron.launch({
  executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'),
  args: [path.join(root, 'tools/aionui-ab-desktop.mjs')], cwd: root,
  env: { ...process.env, APP_DATA_DIR: dataDir }, timeout: 120000,
});
application.process().stdout.on('data', chunk => process.stdout.write(chunk));
application.process().stderr.on('data', chunk => process.stderr.write(chunk));
try {
  const page = await application.firstWindow({ timeout: 120000 });
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.getByText('Google 官方 ACP · self-wiki', { exact: true }).waitFor({ timeout: 120000 });
  assert.equal(await page.evaluate(() => Boolean(window.wikiDesktop)), false);
  await page.getByText('Google 官方 ACP · self-wiki', { exact: true }).click();
  await page.locator('textarea').first().fill(`只回复 ${expected}，不调用任何工具。`);
  await page.locator('textarea').first().press('Enter');
  const info = JSON.parse(await readFile(path.join(dataDir, 'aionui-experiment/experiment-instance.json'), 'utf8'));
  const api = async route => (await (await fetch(new URL(route, info.url))).json()).data;
  let conversation, messages;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const list = await api('/api/conversations');
    conversation = list.items.find(item => item.name.includes(expected));
    if (conversation) {
      messages = await api(`/api/conversations/${conversation.id}/messages`);
      if (messages.items.some(item => item.position === 'left' && item.content?.content?.trim() === expected)) break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(messages?.items.some(item => item.position === 'left' && item.content?.content?.trim() === expected), 'Official ACP must produce a real assistant response');
  await page.screenshot({ path: path.join(artifactDir, 'desktop-smoke.png') });
  assert.deepEqual(pageErrors, []);
  await writeFile(path.join(artifactDir, 'desktop-smoke.json'), JSON.stringify({ passed: true, conversationId: conversation.id, assistantReply: expected, wikiPreloadExposed: false, pageErrors }, null, 2));
  console.log('PASS: native AionUi window, isolated session, official ACP real response');
} finally { await application.close(); }
