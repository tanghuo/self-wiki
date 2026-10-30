import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { initDb } from '../../src/server/data/sqlite.js';
import { createAgentWorkbenchRepository } from '../../src/server/data/agentWorkbenchRepository.js';
import { createAgentWorkbenchService } from '../../src/server/application/agentWorkbench/service.js';
import { collectTurnChanges } from '../../src/server/application/agentWorkbench/changes.js';
import { textDiff, unifiedFiles } from '../../src/shared/domain/agentWorkbench/fileDiff.js';

const hash = text => createHash('sha256').update(text).digest('hex');
async function until(predicate) { for (let n = 0; n < 400; n++) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Change condition timed out'); }
async function fixture(t, prompt) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-workbench-changes-')); await mkdir(path.join(root, 'data'));
  const db = initDb(':memory:'), repo = createAgentWorkbenchRepository(db);
  const service = await createAgentWorkbenchService({ repo, dataDir: path.join(root, 'data'), initiallyEnabled: true, executionConfig: () => ({}), async openEngine(_settings, callbacks) {
    return { sessionId: 'changes-test', version: 'test', capabilities: { verified: true, approvalMode: callbacks.approvalMode }, cancel() {}, async close() {}, async prompt(text, delivery) { delivery('attempted'); await prompt(callbacks, text); return {}; } };
  } });
  t.after(async () => { await service.close(); db.close(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('wiki-workbench-changes-')); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const workspace = await service.workspace({ kind: 'scratch', trusted: true });
  const session = service.createSession({ engine: 'grok-build', workspaceId: workspace.id, approvalMode: 'allow' });
  return { root, service, workspace, session, repo };
}
const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n old\n-before\n+after\n';

test('line diffs compute net counts, context and final newline changes, with bounded work', () => {
  assert.deepEqual(textDiff('a\nb\n', 'a\nc\n').rows.filter(row => row.type !== 'hunk').map(row => [row.type, row.oldLine, row.newLine]), [['context', 1, 1], ['remove', 2, null], ['add', null, 2]]);
  assert.equal(textDiff('', 'hello\n').added, 1);
  assert.equal(textDiff('a\n', 'a').removed, 1);
  assert.equal(textDiff('a\n', 'a').added, 1);
  assert.equal(textDiff('a\n'.repeat(2000), 'b\n'.repeat(2000)).added, null);
  assert.equal(unifiedFiles(patch)[0].added, 1);
  assert.equal(unifiedFiles(patch)[0].removed, 1);
  assert.equal(unifiedFiles(patch)[0].path, 'a.txt');
});

test('native aggregate snapshots replace earlier diffs; workspace observations never inflate edited-file totals', () => {
  const result = collectTurnChanges([
    { type: 'engine.diff', data: { diff: patch + patch.replaceAll('a.txt', 'b.txt') } },
    { type: 'engine.diff', data: { diff: patch } },
    { type: 'workspace.changed', data: { current: { git: true, status: ['?? external.txt'], diff: patch.replaceAll('a.txt', 'external.txt') } } },
  ], { path: process.cwd() });
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].canUndo, false);
  assert.equal(result.files[0].added, 1);
  assert.match(result.workspaceDiff, /external.txt/);
});

test('repeated host writes collapse to net changes; gaps in snapshots disable undo', () => {
  const file = path.join(process.cwd(), 'a.txt');
  const event = (before, after) => ({ type: 'file.changed', data: { source: 'host', path: file, before, after, beforeHash: hash(before), afterHash: hash(after) } });
  const result = collectTurnChanges([event('one\n', 'two\n'), event('two\n', 'three\n')], { path: process.cwd() });
  assert.equal(result.files[0].before, 'one\n'); assert.equal(result.files[0].added, 1); assert.equal(result.files[0].removed, 1);
  assert.equal(collectTurnChanges([event('one\n', 'two\n'), event('external\n', 'three\n')], { path: process.cwd() }).files[0].canUndo, false);
  assert.equal(collectTurnChanges([event('one\n', 'two\n'), event('two\n', 'one\n')], { path: process.cwd() }).files.length, 0);
});

test('undo preflights the batch, preserves dirty originals, removes new files and persists idempotent progress', async t => {
  const hold = Promise.withResolvers();
  const f = await fixture(t, async callbacks => {
    for (const content of ['intermediate\n', 'final\n']) await callbacks.onRequest('fs/write_text_file', { path: path.join(callbacks.cwd, 'existing.txt'), content });
    await callbacks.onRequest('fs/write_text_file', { path: path.join(callbacks.cwd, 'new.txt'), content: 'new\n' });
    await hold.promise;
  });
  const existing = path.join(f.workspace.path, 'existing.txt'), added = path.join(f.workspace.path, 'new.txt');
  await writeFile(existing, 'dirty original\n');
  const turn = f.service.submit(f.session.id, { text: 'edit', requestKey: 'changes-first-turn' });
  const live = await until(async () => { const result = await f.service.changes(turn.id); return result.files.length === 2 && result; });
  assert.equal(live.active, true);
  await assert.rejects(f.service.undoChanges(turn.id, { version: live.version }), { code: 'ACTIVE_TURN' });
  hold.resolve(); await until(() => f.repo.turn(turn.id).state === 'completed');
  const changes = await f.service.changes(turn.id);
  assert.equal(changes.files[0].before, 'dirty original\n');
  assert.equal(changes.files[0].after, 'final\n');
  await writeFile(existing, 'edited after turn\n');
  await assert.rejects(f.service.undoChanges(turn.id, { version: changes.version }), { code: 'CHANGE_CONFLICT' });
  assert.equal(await readFile(added, 'utf8'), 'new\n');
  assert.equal(await readFile(existing, 'utf8'), 'edited after turn\n');
  await writeFile(existing, 'final\n');
  await writeFile(added, 'later change\n');
  await assert.rejects(f.service.undoChanges(turn.id, { version: changes.version }), { code: 'CHANGE_CONFLICT' });
  assert.equal(await readFile(existing, 'utf8'), 'final\n');
  await writeFile(added, 'new\n');
  await assert.rejects(f.service.undoChanges(turn.id, { version: 'stale' }), { code: 'CHANGE_CONFLICT' });
  const result = await f.service.undoChanges(turn.id, { version: changes.version });
  assert.equal(result.undoState, 'undone');
  assert.equal(await readFile(existing, 'utf8'), 'dirty original\n');
  assert.equal(await stat(added).catch(() => null), null);
  await writeFile(existing, 'later user edit\n');
  assert.equal((await f.service.undoChanges(turn.id, { version: changes.version })).undoState, 'undone');
  assert.equal(await readFile(existing, 'utf8'), 'later user edit\n');
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'data', 'agent-changes', `${turn.id}.json`), 'utf8')).state, 'undone');
});

test('interrupted undo resumes from a journal and never rewrites an already restored file', async t => {
  const f = await fixture(t, async callbacks => {
    for (const name of ['a.txt', 'b.txt']) await callbacks.onRequest('fs/write_text_file', { path: path.join(callbacks.cwd, name), content: 'new\n' });
  });
  for (const name of ['a.txt', 'b.txt']) await writeFile(path.join(f.workspace.path, name), 'old\n');
  const turn = f.service.submit(f.session.id, { text: 'edit', requestKey: 'changes-recovery-turn' });
  await until(() => f.repo.turn(turn.id).state === 'completed');
  const changes = await f.service.changes(turn.id);
  await mkdir(path.join(f.root, 'data', 'agent-changes'));
  await writeFile(path.join(f.root, 'data', 'agent-changes', `${turn.id}.json`), JSON.stringify({ version: changes.version, state: 'undoing', entries: changes.files.map((file, index) => ({ path: file.path, state: index === 0 ? 'applying' : 'pending' })) }));
  await writeFile(path.join(f.workspace.path, 'a.txt'), 'old\n');
  assert.equal((await f.service.undoChanges(turn.id, { version: changes.version })).undoState, 'undone');
  assert.equal(await readFile(path.join(f.workspace.path, 'b.txt'), 'utf8'), 'old\n');
});
