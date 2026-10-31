import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openCodexWorkbench, verifyCodexWorkbenchPolicy } from '../../src/agent/engines/codexWorkbench.js';

test('Codex translates native approval snapshots, output, SDK tools, cancellation and load without replay', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-codex-workbench-fixture-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('wiki-codex-workbench-fixture-')); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const executable = path.join(root, 'codex.mjs'); await writeFile(executable, await readFile(new URL('../fixtures/codex-workbench.txt', import.meta.url)));
  const events = [], approvals = []; let tools = 0;
  const callbacks = { cwd: root, neutralCwd: root, signal: AbortSignal.timeout(10000), tools: [{ name: 'wiki_search', description: 'fixture', inputSchema: { type: 'object' } }],
    onEvent: (type, data) => events.push({ type, data }), onExit() {},
    onRequest(method, operation) {
      assert.equal(method, 'engine/native_approval'); approvals.push(operation);
      // Human waiting must not exhaust the 30-minute execution budget.
      t.mock.timers.tick(31 * 60 * 1000);
      return operation.kind === 'native.command';
    },
    onToolCall({ name, input }) { assert.equal(name, 'wiki_search'); assert.equal(input.query, 'fixture'); tools++; return { result: [] }; },
  };
  const config = { codexCli: { executable, codexHome: root, model: 'fixture-model' } };
  const client = await openCodexWorkbench(config, callbacks);
  assert.equal(client.capabilities.fileReads, 'native_full_disk');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try { assert.equal((await client.prompt('fixture')).stopReason, 'end_turn'); }
  finally { t.mock.timers.reset(); await client.close(); }
  await assert.rejects(readFile(path.join(root, 'result.txt')), { code: 'ENOENT' });
  assert.deepEqual(approvals.map(op => op.kind), ['native.file', 'native.command']); assert.match(approvals[0].changes[0].diff, /fixture/);
  assert.ok(events.some(event => event.type === 'command.completed' && event.data.exitCode === 0 && event.data.output === 'fixture command output')); assert.equal(tools, 1);
  assert.ok(events.some(event => event.type === 'message.delta' && event.data.messageId === 'answer-1' && event.data.phase === 'final_answer'));
  assert.ok(events.some(event => event.type === 'command.completed' && event.data.toolCallId === 'command-1'));
  const resumed = await openCodexWorkbench(config, { ...callbacks, sessionId: client.sessionId });
  assert.ok(!events.some(event => event.data.text?.includes('REPLAY')));
  const hanging = resumed.prompt('HANG'); await new Promise(resolve => setTimeout(resolve, 30)); await resumed.cancel();
  assert.equal((await hanging).stopReason, 'cancelled'); await resumed.close();
});
test('Codex refuses mismatched native policy and silently widened permission settings', () => {
  const policy = { cwd: process.cwd(), approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false } };
  assert.doesNotThrow(() => verifyCodexWorkbenchPolicy(policy, process.cwd()));
  for (const override of [{ approvalPolicy: 'never' }, { approvalsReviewer: 'auto_review' }, { sandbox: { type: 'workspaceWrite', networkAccess: false } }, { sandbox: { type: 'readOnly', networkAccess: true } }]) assert.throws(() => verifyCodexWorkbenchPolicy({ ...policy, ...override }, process.cwd()), /禁止发送任务/);
});
