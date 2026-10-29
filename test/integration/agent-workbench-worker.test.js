import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { initDb } from '../../src/server/data/sqlite.js';
import { createAgentWorkbenchRepository } from '../../src/server/data/agentWorkbenchRepository.js';
import { createAgentTaskRepository } from '../../src/server/data/agentTaskRepository.js';
import { createAgentArtifactStore } from '../../src/server/assets/agentArtifactStore.js';
import { createAgentTaskService } from '../../src/server/application/agentTasks/service.js';

async function until(fn) { for (let i = 0; i < 400; i++) { const value = fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('worker timeout'); }
test('worker never generates before approval; a storage failure reconciles saved bytes without another generation', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wiki-agent-worker-'));
  t.after(async () => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('wiki-agent-worker-')); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); });
  const db = initDb(':memory:'); t.after(() => db.close());
  const sessions = createAgentWorkbenchRepository(db), repo = createAgentTaskRepository(db), store = createAgentArtifactStore(dir);
  let calls = 0, failSave = true;
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#7d9960' } }).png().toBuffer();
  const service = createAgentTaskService({ repo, sessions, store: { ...store, async saveImage(...args) { if (failSave) throw new Error('injected storage failure'); return store.saveImage(...args); } }, executionConfig: () => ({}), imageExecutor: { async generate(_input, options) { calls++; options.onDispatch(); return { bytes }; } } });
  t.after(() => service.close());
  const workspace = sessions.createWorkspace({ kind: 'scratch', path: dir, userPath: dir, identity: dir });
  const session = sessions.createSession({ workspaceId: workspace.id, engine: 'fixture', policy: {} });
  const turn = sessions.startTurn(sessions.queueTurn(session.id, 'worker-one', { text: 'fixture' }).id);
  const op = service.submit(session.id, turn.id, { prompt: 'fixture' }); service.schedule(); assert.equal(calls, 0);
  sessions.finish(turn.id, 'completed');
  const approved = service.decide(op.id, session.id, { requestKey: 'worker-approve', hash: op.hash, decision: 'allow' });
  await until(() => service.get(approved.taskId, session.id).state === 'unknown');
  await until(() => !service.hasActive()); assert.equal(calls, 1);
  failSave = false;
  const result = await service.reconcile(approved.taskId, session.id, { requestKey: 'worker-retrieve' });
  assert.equal(result.state, 'succeeded'); assert.equal(calls, 1);
  assert.deepEqual((await service.content(result.data.artifactIds[0], session.id)).bytes, bytes);
  assert.equal((await service.reconcile(result.id, session.id, { requestKey: 'worker-retrieve' })).state, 'succeeded'); assert.equal(calls, 1);
});
