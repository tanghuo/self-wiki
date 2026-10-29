import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { createServer } from '../src/server/server.js';
import { resolveBrowserPath } from '../test/resolveBrowserPath.js';
import { powershellUtf8Prefix } from '../src/agent/engines/grokTerminal.js';

if (!process.argv.includes('--live')) throw new Error('--live required; invokes one Grok text/vision turn, no image generation');
const output = process.argv[process.argv.indexOf('--output') + 1]; if (!output || output.startsWith('--')) throw new Error('--output required');
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'wiki-workbench-live-ui-'))), dataDir = path.join(root, 'data'), project = path.join(root, 'project');
await mkdir(dataDir); await mkdir(project);
const file = path.join(project, 'answer.txt'), verify = path.join(project, 'verify.mjs');
await writeFile(file, '41\n'); await writeFile(verify, `import fs from 'node:fs';import assert from 'node:assert/strict';assert.equal(fs.readFileSync(new URL('./answer.txt',import.meta.url),'utf8'),'42\\n');console.log('WORKBENCH_UI_OK');`);
const command = `& '${process.execPath}' '${verify}'`;
const report = { createdAt: new Date().toISOString(), root, modelCalls: 0, paidImageCalls: 0, checks: {}, approvals: [] };
let app, browser;
try {
  app = await createServer({ port: 0, dataDir, agentWorkbenchEnabled: true });
  const api = async (route, body, method = 'POST') => { const response = await fetch(new URL(`/api/agent${route}`, app.url), { method, headers: { ...app.managementHeaders(), 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) }); const value = await response.json(); if (!response.ok) throw new Error(value.message || value.error); return value; };
  const workspace = await api('/workspaces', { kind: 'project', path: project, trusted: true });
  const session = await api('/sessions', { workspaceId: workspace.id, engine: 'grok-build', title: '真实工作台验收', effort: 'low', model: 'grok-4.6' });
  const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#0000ff' } }).png().toBuffer();
  const uploaded = await fetch(new URL(`/api/agent/sessions/${session.id}/attachments`, app.url), { method: 'POST', headers: { ...app.managementHeaders(), 'content-type': 'image/png' }, body: image });
  if (!uploaded.ok) throw new Error('Synthetic reference upload failed'); const artifact = await uploaded.json();
  await api(`/sessions/${session.id}/draft`, { revision: 0, attachments: [artifact.id], text: `Synthetic software acceptance. Identify the dominant color of the attached image in one sentence. Then read ONLY ${file} and modify 41 plus newline to exactly 42 plus newline using the client file tool. Run EXACTLY this PowerShell command with the terminal tool: ${command}\nReport the observed WORKBENCH_UI_OK and exit code. Do not generate or edit images. Do not use other tools, agents, web, alternate commands or files. If rejected, stop.` }, 'PUT');
  browser = await chromium.launch({ executablePath: resolveBrowserPath(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const paired = await fetch(new URL('/api/auth/bootstrap', app.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: app.createBootstrapCode() }) });
  const cookie = paired.headers.get('set-cookie').split(';')[0], at = cookie.indexOf('=');
  await context.addCookies([{ name: cookie.slice(0, at), value: cookie.slice(at + 1), url: app.url, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  await page.goto(app.url + '#workbench'); await page.getByRole('button', { name: /真实工作台验收/ }).click();
  await page.getByRole('button', { name: /^参考图/ }).waitFor();
  await page.getByRole('button', { name: '发送', exact: true }).click(); report.modelCalls = 1;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const detail = await api(`/sessions/${session.id}`, undefined, 'GET');
    const approval = detail.approvals[0];
    if (approval) {
      const op = approval.operation;
      const allowed = op.kind === 'file.write' ? op.path === file && op.before === '41\n' && op.after === '42\n' : op.kind === 'command' ? op.cwd === project && op.args.at(-1) === powershellUtf8Prefix + command : op.kind === 'engine.permission' && ['read_file', 'search_replace', 'write', 'run_terminal_cmd'].includes(op.tool);
      if (!allowed) throw new Error(`Unexpected operation: ${op.kind}`);
      await page.getByRole('region', { name: '待审批操作' }).first().getByRole('button', { name: '允许一次', exact: true }).click();
      report.approvals.push({ kind: op.kind, hash: approval.operationHash });
    }
    const turn = detail.turns.at(-1);
    if (turn && ['completed', 'failed', 'unknown', 'cancelled'].includes(turn.state)) { report.state = turn.state; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await page.getByText('命令输出 · 退出码 0', { exact: true }).waitFor();
  report.checks.completed = report.state === 'completed'; report.checks.fileChanged = await readFile(file, 'utf8') === '42\n';
  report.checks.outputVisible = await page.locator('.workbench-event pre').filter({ hasText: 'WORKBENCH_UI_OK' }).count() > 0;
  report.checks.referenceAccepted = (await api(`/sessions/${session.id}`, undefined, 'GET')).turns.at(-1).input.artifactIds[0] === artifact.id;
  await page.setViewportSize({ width: 390, height: 844 }); report.checks.narrow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  await page.screenshot({ path: '.local/agent-workbench-live-ui.png', fullPage: true });
  await page.reload(); await page.getByRole('button', { name: /真实工作台验收/ }).click();
  await page.getByText('命令输出 · 退出码 0', { exact: true }).waitFor(); report.checks.refresh = true;
} catch (error) { report.error = error.message; }
finally { await browser?.close(); await app?.close(); }
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report));
if (report.error || !Object.values(report.checks).every(Boolean)) process.exitCode = 1;
