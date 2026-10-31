import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workbenchTimeline } from '../../src/shared/domain/agentWorkbench/events.js';
import { createAcpWorkbenchEvents } from '../../src/agent/engines/acpWorkbenchEvents.js';

const event = (type, data, seq) => ({ type, data, seq, turnId: 'turn' });
const turn = { id: 'turn', state: 'completed' };

test('partial tool updates merge across messages without losing titles or message boundaries', () => {
  const events = [
    event('tool.updated', { id: 'read', title: 'Read file', status: 'in_progress' }, 1),
    event('message.delta', { text: 'Checking' }, 2),
    event('tool.updated', { id: 'read', title: undefined, status: 'completed' }, 3),
    event('tool.updated', { id: 'read', content: [] }, 3.5),
    event('message.delta', { text: 'Finished' }, 4),
  ];
  const groups = workbenchTimeline(events, turn);
  assert.equal(groups[0].items.length, 1);
  assert.equal(groups[0].items[0].data.title, 'Read file');
  assert.equal(groups[0].items[0].data.status, 'completed');
  assert.deepEqual(groups.slice(1).map(group => group.items[0].data.text), ['Checking', 'Finished']);
  assert.equal(events[0].data.status, 'in_progress');
  assert.deepEqual(workbenchTimeline(events, turn), groups);
});

test('message identity and phase separate native messages; plan updates keep latest snapshot', () => {
  const groups = workbenchTimeline([
    event('message.delta', { text: 'A', messageId: 'one', phase: 'commentary' }, 1),
    event('message.delta', { text: 'B', messageId: 'one', phase: 'commentary' }, 2),
    event('plan.updated', { entries: [{ content: 'Read', status: 'pending' }] }, 3),
    event('plan.updated', { entries: [{ content: 'Read', status: 'completed' }] }, 4),
    event('message.delta', { text: 'Done', messageId: 'two', phase: 'final_answer' }, 5),
    { ...event('message.delta', { text: 'Other turn' }, 6), turnId: 'other' },
  ], turn);
  assert.equal(groups[0].items[0].data.text, 'AB');
  assert.equal(groups[1].items.length, 1);
  assert.equal(groups[1].items[0].data.entries[0].status, 'completed');
  assert.equal(groups[2].items[0].data.phase, 'final_answer');
});

test('native command output attaches to its tool while legacy output remains readable', () => {
  const groups = workbenchTimeline([
    event('tool.updated', { id: 'cmd', title: 'Test', status: 'running' }, 1),
    event('command.output', { toolCallId: 'cmd', commandId: 'stored', output: 'ok' }, 2),
    event('tool.updated', { id: 'cmd', status: 'completed' }, 3),
    event('command.output', { commandId: 'legacy', output: 'legacy output' }, 4),
  ], turn);
  assert.equal(groups[0].items.length, 2);
  assert.equal(groups[0].items[0].output.data.commandId, 'stored');
  assert.equal(groups[0].items[1].data.commandId, 'legacy');
});

test('a nonzero command exit overrides a completed tool status on replay without changing stored events', () => {
  for (const exitCode of [0, 1, 2, null]) {
    const events = [
      event('tool.updated', { id: 'cmd', title: 'Execute rg missing', status: 'completed' }, 1),
      event('command.output', { toolCallId: 'cmd', output: 'result', exitCode }, 2),
    ];
    const item = workbenchTimeline(events, turn)[0].items[0];
    assert.equal(item.data.status, exitCode === 1 || exitCode === 2 ? 'failed' : 'completed');
    assert.equal(events[0].data.status, 'completed');
    assert.equal(workbenchTimeline(events, turn)[0].items.length, 1);
  }
});

test('unfinished tools do not keep spinning or claim success after a turn ends', () => {
  for (const [state, status] of [['running', 'running'], ['cancelled', 'cancelled'], ['failed', 'unknown'], ['completed', 'unknown']]) {
    assert.equal(workbenchTimeline([event('tool.updated', { id: 'tool', status: 'in_progress' }, 1)], { ...turn, state })[0].items[0].data.status, status);
  }
});

test('Grok and Gemini ACP share message segmentation and status normalization without invented phases', async () => {
  const events = [], emit = createAcpWorkbenchEvents((type, data) => events.push({ type, data }));
  const text = text => emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  await text('A'); await text('B');
  await emit({ sessionUpdate: 'tool_call', toolCallId: 'one', title: 'Read', status: 'in_progress' });
  await emit({ sessionUpdate: 'tool_call_update', toolCallId: 'one', status: 'completed' });
  await text('Done');
  assert.equal(events[0].data.messageId, events[1].data.messageId);
  assert.notEqual(events[0].data.messageId, events[4].data.messageId);
  assert.equal(events[2].data.status, 'running');
  assert.equal(events[4].data.phase, undefined);
});
