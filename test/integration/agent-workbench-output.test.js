import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createAgentCommandStore } from '../../src/server/assets/agentCommandStore.js';
import { createTerminalRuntime } from '../../src/agent/engines/terminalRuntime.js';
import { grokTerminalOperation } from '../../src/agent/engines/grokTerminal.js';
import { workbenchGitSnapshot } from '../../src/agent/engines/workbenchGit.js';

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-workbench-output-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('wiki-workbench-output-')); await rm(root, { recursive: true, force: true, maxRetries: 3 }); }); return root;
}
test('command output pages and previews preserve UTF-8 and reject forged cursors', async t => {
  const store = createAgentCommandStore(await temporary(t)), id = randomUUID(), output = '中文🙂'.repeat(15000);
  const saved = await store.save(1, id, { output, exitCode: 0 }); assert.ok(!saved.output.includes('\ufffd'));
  let cursor = 0, actual = '';
  for (;;) { const page = await store.page(1, id, cursor); actual += page.output; cursor = page.next; if (page.done) break; }
  assert.equal(actual, output); await assert.rejects(store.page(1, id, 1), { code: 'INVALID_CURSOR' });
  await assert.rejects(store.page(1, '../outside', 0), { code: 'INVALID_COMMAND' });
});
test('an approved command can write outside cwd: the host does not claim an OS sandbox', async t => {
  const root = await temporary(t), cwd = path.join(root, 'project'), outside = path.join(root, 'outside.txt'); await mkdir(cwd);
  const host = createTerminalRuntime({ approve: () => true }); t.after(() => host.close());
  const { terminalId } = await host.create(grokTerminalOperation({ command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(outside)},'synthetic boundary evidence')`], cwd }));
  assert.equal((await host.request('terminal/wait_for_exit', terminalId)).exitCode, 0);
  assert.equal(await readFile(outside, 'utf8'), 'synthetic boundary evidence');
});
test('Git snapshots preserve a dirty index and disclose binary, untracked and non-Git states', async t => {
  const root = await temporary(t), project = path.join(root, 'project'); await mkdir(project);
  const git = (...args) => promisify(execFile)('git', ['-c', 'core.hooksPath=NUL', ...args], { cwd: project, windowsHide: true });
  await git('init'); await writeFile(path.join(project, 'tracked.txt'), 'initial\n'); await writeFile(path.join(project, 'binary.bin'), Buffer.from([0, 1, 2]));
  await git('add', '.'); await git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  await writeFile(path.join(project, 'tracked.txt'), 'staged\n'); await git('add', 'tracked.txt');
  await writeFile(path.join(project, 'tracked.txt'), 'external dirty content\n'); await writeFile(path.join(project, 'binary.bin'), Buffer.from([0, 1, 3])); await writeFile(path.join(project, 'new.txt'), 'untracked');
  const before = await readFile(path.join(project, '.git/index')), snapshot = await workbenchGitSnapshot(project);
  assert.equal(snapshot.git, true); assert.ok(snapshot.status.some(value => value.includes('new.txt'))); assert.match(snapshot.diff, /external dirty content/); assert.match(snapshot.diff, /Binary files/);
  assert.deepEqual(await readFile(path.join(project, '.git/index')), before);
  assert.equal((await workbenchGitSnapshot(root)).git, false);
});
