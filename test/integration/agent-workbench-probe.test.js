import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { probeAgentWorkbench } from '../../tools/probe-agent-workbench.mjs';

async function fixture(t, bypass, shellMode = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-p0-fixture-'));
  const script = path.join(root, 'grok.mjs');
  const source = await readFile(new URL('../fixtures/grok-workbench-probe.txt', import.meta.url), 'utf8');
  await writeFile(script, source.replace('const bypass = false;', `const bypass = ${bypass};`).replace('const shellMode = false;', `const shellMode = ${shellMode};`));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('wiki-p0-fixture-'));
    await rm(root, { recursive: true, force: true });
  });
  const report = await probeAgentWorkbench({ executable: script, timeoutMs: 5000 });
  t.after(async () => {
    // Windows realpath expands the 8.3 temp directory alias.
    assert.ok(path.basename(report.cwd).startsWith('wiki-agent-p0-'));
    const { realpath } = await import('node:fs/promises');
    assert.equal(path.dirname(report.cwd), await realpath(os.tmpdir()));
    await rm(report.cwd, { recursive: true, force: true });
  });
  return report;
}

test('P0 fixture distinguishes host execution, rejection and load, without claiming a real CLI gate', async t => {
  const report = await fixture(t, false);
  assert.equal(report.error, undefined, JSON.stringify(report));
  assert.equal(report.hostGatePassed, true, JSON.stringify(report.checks));
  assert.equal(report.checks.hookErrorStoppedTool, true);
  assert.equal(report.modelCalls, 6);
  assert.equal(report.paidImageCalls, 0);
  assert.equal(report.p0Complete, false);
  assert.equal(report.p2Blocked, true);
  assert.ok(report.untested.includes('project configuration loading before trust'));
  assert.ok(!JSON.stringify(report).includes('SELF_WIKI_P0_HOST'), 'No raw response content is persisted');
});

test('P0 rejects claimed terminal success without a host request and detects hook fail-open side effects', async t => {
  const report = await fixture(t, true);
  assert.equal(report.error, undefined);
  assert.equal(report.checks.clientTerminal, false);
  assert.equal(report.checks.hookErrorStoppedTool, false);
  assert.equal(report.hostGatePassed, false);
  assert.equal(report.p2Blocked, true);
});

test('P0 handles a Windows command string through an explicit approved PowerShell operation', { skip: process.platform !== 'win32' }, async t => {
  const report = await fixture(t, false, true);
  assert.equal(report.error, undefined);
  assert.equal(report.checks.clientTerminal, true, JSON.stringify(report.trace));
  const approval = report.trace.find(entry => entry.permission === 'synthetic-allow-once');
  assert.equal(approval.mode, 'shell');
  assert.ok(approval.program.endsWith('powershell.exe'));
  assert.deepEqual(approval.envNames, ['FORCE_COLOR']);
  assert.deepEqual(approval.omittedEnvNames, ['GRADLE_OPTS']);
  assert.ok(!JSON.stringify(report).includes('must-not-be-inherited'));
  assert.ok(report.trace.some(entry => entry.terminalExit?.exitCode === 0 && entry.terminalExit.markerObserved));
});
