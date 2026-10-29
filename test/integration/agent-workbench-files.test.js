import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFileGateway } from '../../src/server/application/agentWorkbench/files.js';
import { createWorkspaceScheduler, registerWorkspace } from '../../src/server/application/agentWorkbench/workspaces.js';
import { initDb } from '../../src/server/data/sqlite.js';
import { createAgentWorkbenchRepository } from '../../src/server/data/agentWorkbenchRepository.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-workbench-files-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('wiki-workbench-files-')); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const canonical = await realpath(root);
  const project = path.join(canonical, 'project'), outside = path.join(canonical, 'outside'), data = path.join(canonical, 'data');
  await Promise.all([project, outside, data].map(dir => mkdir(dir)));
  return { root, project, outside, data };
}
test('file gateway rejects outside roots, binary input, denied writes, approval conflicts and junction redirection', async t => {
  const { project, outside } = await fixture(t), file = path.join(project, 'existing.txt');
  await writeFile(file, 'dirty before\n');
  const changes = []; let decision = 'reject';
  const gateway = createFileGateway({ workspace: { path: project }, assertLive() {}, onChange: change => changes.push(change), async approve() {
    if (decision === 'conflict') await writeFile(file, 'user edit during approval\n');
    return decision !== 'reject';
  } });
  await assert.rejects(gateway.write({ path: file, content: 'agent edit' }), { code: 'APPROVAL_REJECTED' });
  assert.equal(await readFile(file, 'utf8'), 'dirty before\n');
  decision = 'conflict'; await assert.rejects(gateway.write({ path: file, content: 'agent edit' }), { code: 'FILE_CONFLICT' });
  assert.equal(await readFile(file, 'utf8'), 'user edit during approval\n');
  decision = 'allow'; const newFile = path.join(project, 'nested', 'new.txt');
  await gateway.write({ path: newFile, content: '新建文件\n' }); assert.equal((await gateway.read({ path: newFile })).content, '新建文件\n');
  assert.equal(changes.length, 1); assert.equal(changes[0].beforeHash, null);
  await assert.rejects(gateway.read({ path: path.join(outside, 'secret') }), { code: 'PATH_DENIED' });
  await assert.rejects(gateway.write({ path: path.join(project, '.git', 'config'), content: 'x' }), { code: 'PROTECTED_PATH' });
  await writeFile(path.join(project, 'binary'), Buffer.from([255, 0, 254]));
  await assert.rejects(gateway.read({ path: path.join(project, 'binary') }), { code: 'UNSUPPORTED_FILE' });
  await symlink(outside, path.join(project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(gateway.write({ path: path.join(project, 'escape', 'outside.txt'), content: 'x' }), { code: 'PATH_DENIED' });
});
test('workspace trust is explicit; protected roots fail; overlap queue can cancel without occupying idle locks', async t => {
  const { root, project, data } = await fixture(t), db = initDb(':memory:'); t.after(() => db.close());
  const repo = createAgentWorkbenchRepository(db);
  await assert.rejects(registerWorkspace(repo, data, { kind: 'project', path: project }), { code: 'TRUST_REQUIRED' });
  await assert.rejects(registerWorkspace(repo, data, { kind: 'project', path: root, trusted: true }), { code: 'PROTECTED_PATH' });
  const workspace = await registerWorkspace(repo, data, { kind: 'project', path: project, trusted: true }); assert.equal(workspace.path, project);
  const scheduler = createWorkspaceScheduler(), controller = new AbortController();
  const release = await scheduler.acquire(project, controller.signal);
  const waiting = new AbortController(), next = scheduler.acquire(path.join(project, 'nested'), waiting.signal);
  waiting.abort(); await assert.rejects(next, { name: 'AbortError' }); release();
  const releaseNext = await scheduler.acquire(project, controller.signal); releaseNext();
});
