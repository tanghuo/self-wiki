import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from '../src/server/server.js';
import { resolveBrowserPath } from '../test/resolveBrowserPath.js';
if (!process.argv.includes('--live')) throw new Error('--live required; one Codex text turn');
const output = process.argv[process.argv.indexOf('--output') + 1]; if (!output || output.startsWith('--')) throw new Error('--output required');
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'wiki-codex-ui-'))), dataDir = path.join(root, 'data'), project = path.join(root, 'project'); await mkdir(dataDir); await mkdir(project);
const file = path.join(project, 'answer.txt'), verify = path.join(project, 'verify.mjs');
await writeFile(file, '41\n'); await writeFile(verify, "import fs from 'node:fs';import assert from 'node:assert/strict';assert.equal(fs.readFileSync(new URL('./answer.txt',import.meta.url),'utf8'),'42\\n');console.log('CODEX_UI_OK');");
const report = { modelCalls: 0, paidImageCalls: 0, checks: {}, approvals: [] }; let app, browser;
try {
  app = await createServer({ port: 0, dataDir, agentWorkbenchEnabled: true });
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => { const response = await fetch(new URL('/api/agent' + route, app.url), { method, headers: { ...app.managementHeaders(), 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) }); const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value)); return value; };
  const models = await api('/engines/codex-cli/models'), workspace = await api('/workspaces', { kind: 'project', path: project, trusted: true });
  const session = await api('/sessions', { workspaceId: workspace.id, engine: 'codex-cli', nativeReadAccepted: true, applicationTools: false, model: models.defaultModel || models.models[0].id, effort: 'low', title: 'Codex 真实浏览器验收' });
  await api(`/sessions/${session.id}/draft`, { revision: 0, attachments: [], text: `Synthetic native approval compatibility test. Read ONLY ${file}; use apply_patch to change exactly 41 plus newline to 42 plus newline. Then run this exact PowerShell command using the native terminal: & '${process.execPath}' '${verify}'. Report observed CODEX_UI_OK and exit code. No other files, tools, network, images or subagents; if declined stop immediately without alternatives.` }, 'PUT');
  browser = await chromium.launch({ executablePath: resolveBrowserPath(), headless: true }); const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const paired = await fetch(new URL('/api/auth/bootstrap', app.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: app.createBootstrapCode() }) }); const cookie = paired.headers.get('set-cookie').split(';')[0], at = cookie.indexOf('=');
  await context.addCookies([{ name: cookie.slice(0, at), value: cookie.slice(at + 1), url: app.url, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage(); page.setDefaultTimeout(15000); await page.goto(app.url + '#workbench?session=' + session.id);
  await page.getByText('Codex 原生全盘读取；写入和危险命令原生审批', { exact: false }).waitFor(); report.checks.boundaryVisible = true;
  await page.getByRole('button', { name: '发送', exact: true }).click(); report.modelCalls++;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const detail = await api(`/sessions/${session.id}`), approval = detail.approvals[0];
    if (approval) {
      const op = approval.operation, command = op.command?.replaceAll('\\\\', '\\'); let script = command?.split(' -Command ').slice(1).join(' -Command '); if (script?.startsWith('"') && script.endsWith('"')) script = script.slice(1, -1).replaceAll('\\"', '"');
      const expected = op.kind === 'native.file' ? op.changes.every(change => change.path === file && !change.kind?.move_path) && op.changes.some(change => change.diff.includes('42')) : op.kind === 'native.command' && op.cwd === project && [`Get-Content -Raw -LiteralPath '${file}'`, `Get-Content -LiteralPath '${file}'`, `Get-Content -LiteralPath '${file}' -Raw`, `& '${process.execPath}' '${verify}'`].includes(script);
      await page.getByRole('region', { name: '待审批操作' }).first().getByRole('button', { name: expected ? '允许一次' : '拒绝', exact: true }).click(); report.approvals.push({ kind: op.kind, allowed: expected });
    }
    const turn = detail.turns.at(-1); if (turn && ['completed', 'failed', 'unknown', 'cancelled'].includes(turn.state)) { report.state = turn.state; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  report.checks.completed = report.state === 'completed'; report.checks.fileChanged = await readFile(file, 'utf8') === '42\n'; report.checks.nativeApprovals = report.approvals.some(a => a.kind === 'native.file') && report.approvals.every(a => a.allowed);
  await page.getByText('命令输出 · 退出码 0', { exact: true }).first().waitFor(); report.checks.outputVisible = await page.locator('.workbench-event pre').filter({ hasText: 'CODEX_UI_OK' }).count() > 0;
  await page.setViewportSize({ width: 390, height: 844 }); report.checks.narrow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  await page.reload(); await page.getByText('命令输出 · 退出码 0', { exact: true }).first().waitFor(); report.checks.refresh = true;
  await page.screenshot({ path: '.local/codex-workbench-ui.png', fullPage: true });
} catch (error) { report.error = error.message; } finally { await browser?.close(); await app?.close(); }
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify(report)); if (report.error || !Object.values(report.checks).every(Boolean)) process.exitCode = 1;
