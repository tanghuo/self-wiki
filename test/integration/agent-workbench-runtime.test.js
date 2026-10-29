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
