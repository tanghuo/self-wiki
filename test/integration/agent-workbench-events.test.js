import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDb } from '../../src/server/data/sqlite.js';
import { createAgentWorkbenchRepository } from '../../src/server/data/agentWorkbenchRepository.js';
import { createAgentWorkbenchService } from '../../src/server/application/agentWorkbench/service.js';

test('common service preserves buffered message order, identity, phases and command linkage on replay', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-workbench-events-'));
  const db = initDb(':memory:'), repo = createAgentWorkbenchRepository(db);
  const service = await createAgentWorkbenchService({ repo, dataDir: root, initiallyEnabled: true, executionConfig: () => ({}),
    async openEngine(_settings, callbacks) {
      return { sessionId: 'events-fixture', version: 'fixture', capabilities: {}, async close() {}, async prompt(_text, delivery) {
        delivery('attempted');
        await callbacks.onEvent('message.delta', { text: 'Before tools', messageId: 'progress', phase: 'commentary' });
        await callbacks.onEvent('tool.updated', { id: 'command', title: 'Run test', status: 'in_progress' });
        await callbacks.onEvent('command.completed', { toolCallId: 'command', commandId: 'stored-output', output: 'ok', exitCode: 0 });
        await callbacks.onEvent('tool.updated', { id: 'command', status: 'completed' });
        await callbacks.onEvent('message.delta', { text: 'First', messageId: 'first' });
        await callbacks.onEvent('message.delta', { text: 'Final', messageId: 'final', phase: 'final_answer' });
        return { stopReason: 'end_turn' };
      } };
    },
  });
  t.after(async () => {
    await service.close(); db.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('wiki-workbench-events-'));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const workspace = await service.workspace({ kind: 'scratch', trusted: true });
  const session = service.createSession({ engine: 'grok-build', workspaceId: workspace.id });
  const turn = service.submit(session.id, { requestKey: 'event-order', text: 'Run' });
  for (let i = 0; i < 400 && !['completed', 'failed'].includes(repo.turn(turn.id).state); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(repo.turn(turn.id).state, 'completed');
  const events = repo.events(session.id).filter(event => ['message.delta', 'tool.updated', 'command.output'].includes(event.type));
  assert.deepEqual(events.map(event => event.type), ['message.delta', 'tool.updated', 'command.output', 'tool.updated', 'message.delta', 'message.delta']);
  assert.equal(events[1].data.status, 'running');
  assert.equal(events[2].data.toolCallId, 'command');
  assert.equal(events[4].data.messageId, 'first');
  assert.equal(events[5].data.phase, 'final_answer');
});
