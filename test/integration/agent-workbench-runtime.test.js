import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDb } from '../../src/server/data/sqlite.js';
import { createAgentWorkbenchRepository } from '../../src/server/data/agentWorkbenchRepository.js';
import { createAgentWorkbenchService } from '../../src/server/application/agentWorkbench/service.js';

async function until(predicate) { for (let i = 0; i < 400; i++) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Runtime condition timed out'); }
test('runtime approvals survive snapshots; duplicate requests do not redispatch; cancellation revokes pending file writes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-workbench-runtime-')), data = path.join(root, 'data'); await mkdir(data);
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('wiki-workbench-runtime-')); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const db = initDb(':memory:'); t.after(() => db.close()); const repo = createAgentWorkbenchRepository(db);
  let calls = 0, workspace;
  const service = await createAgentWorkbenchService({ repo, dataDir: data, initiallyEnabled: true, executionConfig: () => ({ chat: { grokBuild: {} } }), async openEngine(_settings, callbacks) {
    return { sessionId: 'synthetic', version: 'synthetic', capabilities: {}, cancel() {}, async close() {}, async prompt(text, delivery) {
      calls++; delivery('attempted');
      await callbacks.onRequest('fs/write_text_file', { path: path.join(workspace.path, 'result.txt'), content: text });
      await callbacks.onEvent('message.delta', { text: 'done' }); return { stopReason: 'end_turn' };
    } };
  } });
  t.after(() => service.close());
  workspace = await service.workspace({ kind: 'scratch', trusted: true });
  const session = service.createSession({ engine: 'grok-build', workspaceId: workspace.id });
  const first = service.submit(session.id, { requestKey: 'runtime-first', text: 'first' });
  assert.equal(service.submit(session.id, { requestKey: 'runtime-first', text: 'first' }).id, first.id);
  const approval = await until(() => service.detail(session.id).approvals[0]);
  service.decide(approval.id, { decision: 'allow', operationHash: approval.operationHash, revision: approval.policyRevision });
  await until(() => repo.turn(first.id).state === 'completed'); assert.equal(calls, 1); assert.equal(await readFile(path.join(workspace.path, 'result.txt'), 'utf8'), 'first');
  const next = service.submit(session.id, { requestKey: 'runtime-second', text: 'second' });
  const pending = await until(() => service.detail(session.id).approvals[0]);
  await service.cancel(next.id); assert.equal(repo.turn(next.id).state, 'cancelled');
  assert.throws(() => service.decide(pending.id, { decision: 'allow', operationHash: pending.operationHash, revision: pending.policyRevision }), { statusCode: 409 });
  assert.equal(await readFile(path.join(workspace.path, 'result.txt'), 'utf8'), 'first');
});
test('grok workbench asks the live catalog instead of returning one configured id', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-workbench-models-')), data = path.join(root, 'data'); await mkdir(data);
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('wiki-workbench-models-')); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const db = initDb(':memory:'); t.after(() => db.close()); const repo = createAgentWorkbenchRepository(db);
  let requested;
  const service = await createAgentWorkbenchService({ repo, dataDir: data, initiallyEnabled: true, executionConfig: () => ({ chat: { grokBuild: { executable: 'grok', model: 'grok-4.6' } } }), async openEngine() { throw new Error('must not open a session'); }, async describeGrok(settings) {
    requested = settings;
    return { models: [{ id: 'grok-4.7', label: 'Grok 4.7' }, { id: 'grok-4.6', label: 'Grok 4.6' }], defaultModel: 'grok-4.7' };
  } });
  t.after(() => service.close());
  const result = await service.models('grok-build');
  assert.deepEqual(requested, { executable: 'grok', model: 'grok-4.6' });
  assert.deepEqual(result.models.map(model => model.id), ['grok-4.7', 'grok-4.6']);
  assert.equal(result.defaultModel, 'grok-4.7');
});
test('an existing session can change model and effort for the next turn', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-workbench-switch-')), data = path.join(root, 'data'); await mkdir(data);
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('wiki-workbench-switch-')); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const db = initDb(':memory:'); t.after(() => db.close()); const repo = createAgentWorkbenchRepository(db);
  const seen = [];
  const service = await createAgentWorkbenchService({ repo, dataDir: data, initiallyEnabled: true, executionConfig: () => ({ chat: { grokBuild: { model: 'grok-4.6' } } }), async openEngine(settings, callbacks) {
    seen.push({ model: settings.model, effort: settings.effort });
    return { sessionId: 'synthetic', version: 'synthetic', capabilities: {}, cancel() {}, async close() {}, async prompt(_text, delivery) {
      delivery('attempted'); await callbacks.onEvent('message.delta', { text: 'ok' }); return { stopReason: 'end_turn' };
    } };
  } });
  t.after(() => service.close());
  const workspace = await service.workspace({ kind: 'scratch', trusted: true });
  const session = service.createSession({ engine: 'grok-build', workspaceId: workspace.id, model: 'grok-4.6', effort: 'medium' });
  const updated = service.configureSession(session.id, { model: ' grok-4.7 ', effort: 'high' });
  assert.equal(updated.data.model, 'grok-4.7');
  assert.equal(updated.data.effort, 'high');
  assert.equal(service.detail(session.id).session.data.model, 'grok-4.7');
  const turn = service.submit(session.id, { requestKey: 'model-switch-turn', text: '继续' });
  await until(() => repo.turn(turn.id).state === 'completed');
  assert.deepEqual(seen, [{ model: 'grok-4.7', effort: 'high' }]);
  assert.throws(() => service.configureSession(session.id, { model: 'grok-4.7', effort: 'ultra' }), { code: 'INVALID_EFFORT' });
  assert.throws(() => service.configureSession(session.id, { model: '   ', effort: 'low' }), { code: 'INVALID_MODEL' });
  const workflow = repo.createSession({ workspaceId: workspace.id, engine: 'grok-build', purpose: 'workflow', policy: { write: 'ask' }, data: { model: 'frozen', effort: 'low' } });
  assert.throws(() => service.configureSession(workflow.id, { model: 'grok-4.7', effort: 'high' }), { code: 'MODEL_LOCKED' });
  assert.equal(repo.session(workflow.id).data.model, 'frozen');
});
