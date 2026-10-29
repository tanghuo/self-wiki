import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { initDb } from '../../src/server/data/sqlite.js';
import { createAgentWorkbenchRepository } from '../../src/server/data/agentWorkbenchRepository.js';
import { createAgentTaskRepository } from '../../src/server/data/agentTaskRepository.js';
import { createAgentArtifactStore } from '../../src/server/assets/agentArtifactStore.js';
import { createAgentWorkbenchService } from '../../src/server/application/agentWorkbench/service.js';
import { createAgentTaskService } from '../../src/server/application/agentTasks/service.js';
import { createAgentTools } from '../../src/server/application/agentTools/service.js';
import { acquireExternalResource } from '../../src/agent/executors/resourceGate.js';

async function until(fn) { for (let i = 0; i < 500; i++) { const value = fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('resource handoff timeout'); }
test('a polling Grok turn yields its real resource slot and the approved independent image task completes once', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-workbench-resource-')), dataDir = path.join(root, 'data'); await mkdir(dataDir);
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('wiki-workbench-resource-')); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const db = initDb(':memory:'); t.after(() => db.close());
  const repo = createAgentWorkbenchRepository(db), taskRepo = createAgentTaskRepository(db);
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#4488cc' } }).png().toBuffer();
  let calls = 0, workbench;
  const tasks = createAgentTaskService({ repo: taskRepo, sessions: repo, store: createAgentArtifactStore(dataDir), executionConfig: () => ({}), imageExecutor: { async generate(_input, options) {
    const release = await acquireExternalResource('grok', options.signal);
    try { options.onDispatch(); calls++; return { bytes: image }; } finally { release(); }
  } } });
  const tools = createAgentTools({ repo: { list: () => [], draft: () => ({ text: '', attachments: [], revision: 0 }) }, wiki: {}, tasks });
  workbench = await createAgentWorkbenchService({ repo, dataDir, tools, tasks, applicationToolsVerified: true, initiallyEnabled: true, executionConfig: () => ({}), async openEngine(_settings, options) {
    const cancelled = Promise.withResolvers();
    return { sessionId: 'fixture', version: 'fixture', capabilities: {}, cancel: () => cancelled.resolve(), close: async () => {}, async prompt(_text, delivery) {
      const release = await acquireExternalResource('grok', options.signal);
      try {
        delivery('attempted'); const op = await options.onToolCall({ name: 'image_submit', input: { prompt: 'fixture image' } });
        const approved = await until(() => taskRepo.operation(op.id).taskId);
        for (let i = 0; i < 3; i++) await options.onToolCall({ name: 'task_status', input: { taskId: approved } });
        await cancelled.promise; return { stopReason: 'cancelled' };
      } finally { release(); }
    } };
  } });
  t.after(async () => { await workbench.close(); await tasks.close(); });
  const workspace = await workbench.workspace({ kind: 'scratch', trusted: true }), session = workbench.createSession({ workspaceId: workspace.id, engine: 'grok-build' });
  const turn = workbench.submit(session.id, { requestKey: 'resource-test', text: 'fixture' });
  const op = await until(() => taskRepo.operations(session.id)[0]);
  const approved = tasks.decide(op.id, session.id, { requestKey: 'resource-approve', hash: op.hash, decision: 'allow' });
  await until(() => taskRepo.task(approved.taskId).state === 'succeeded');
  await until(() => repo.turn(turn.id).state === 'cancelled');
  assert.equal(calls, 1); assert.ok(repo.events(session.id).some(event => event.type === 'task.resource_wait'));
  assert.equal(taskRepo.task(approved.taskId).data.artifactIds.length, 1);
});
