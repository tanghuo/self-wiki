import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDb } from '../../src/server/data/sqlite.js';
import { createAgentWorkbenchRepository } from '../../src/server/data/agentWorkbenchRepository.js';
import { createAgentWorkbenchService } from '../../src/server/application/agentWorkbench/service.js';
import { grokApprovalPolicy } from '../../src/agent/engines/grokWorkbench.js';

async function until(predicate) {
  for (let i = 0; i < 400; i++) { const result = predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Policy condition timed out');
}
async function fixture(t, prompt, { verified = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-workbench-policy-'));
  const db = initDb(':memory:'), repo = createAgentWorkbenchRepository(db), opened = [];
  await mkdir(path.join(root, 'data'));
  const service = await createAgentWorkbenchService({ repo, dataDir: path.join(root, 'data'), initiallyEnabled: true, codexVerified: true, executionConfig: () => ({}), async openEngine(_settings, callbacks) {
    opened.push(callbacks.approvalMode);
    return { sessionId: 'synthetic', version: 'test', capabilities: { verified, approvalMode: callbacks.approvalMode }, cancel() {}, async close() {}, async prompt(text, delivery) { delivery('attempted'); await prompt(callbacks, text); return { stopReason: 'end_turn' }; } };
  } });
  t.after(async () => { await service.close(); db.close(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('wiki-workbench-policy-')); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const workspace = await service.workspace({ kind: 'scratch', trusted: true });
  return { service, repo, workspace, opened, root };
}
const permission = callbacks => callbacks.onRequest('session/request_permission', {
  toolCall: { toolName: 'write', title: '写入结果', rawInput: { path: 'result.txt' } },
  options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }],
});
const decide = (service, approval, decision = 'allow') => service.decide(approval.id, { decision, revision: approval.policyRevision, operationHash: approval.operationHash });

test('manual approval has no deadline, accepts a late decision, and cancellation revokes waiting writes', async t => {
  let writes = 0;
  const f = await fixture(t, async callbacks => {
    await callbacks.onRequest('fs/write_text_file', { path: path.join(callbacks.cwd, 'result.txt'), content: 'late approval' });
    writes++;
  });
  const session = f.service.createSession({ engine: 'grok-build', workspaceId: f.workspace.id });
  const turn = f.service.submit(session.id, { text: 'write', requestKey: 'late-approval' });
  const approval = await until(() => f.service.detail(session.id).approvals[0]);
  assert.equal(approval.expiresAt, 0);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  try {
    t.mock.timers.tick(24 * 60 * 60 * 1000);
    assert.equal(f.repo.approval(approval.id).state, 'pending');
    assert.equal(f.repo.turn(turn.id).state, 'awaiting_approval');
    assert.equal(writes, 0);
    decide(f.service, approval);
    assert.equal(f.repo.approval(approval.id).state, 'approved');
  } finally { t.mock.timers.reset(); }
  await until(() => f.repo.turn(turn.id).state === 'completed');
  assert.equal(writes, 1);
  const next = f.service.submit(session.id, { text: 'write again', requestKey: 'cancel-infinite-approval' });
  const pending = await until(() => f.service.detail(session.id).approvals[0]);
  await f.service.cancel(next.id);
  assert.equal(f.repo.turn(next.id).state, 'cancelled');
  assert.equal(writes, 1);
  assert.throws(() => decide(f.service, pending), { statusCode: 409 });
});

test('Grok maps unified modes and keeps restricted sessions out of bypass/auto', () => {
  assert.deepEqual(grokApprovalPolicy('ask'), { mode: 'ask', yoloMode: true, autoMode: false });
  assert.deepEqual(grokApprovalPolicy('auto'), { mode: 'auto', yoloMode: false, autoMode: true });
  assert.deepEqual(grokApprovalPolicy('allow'), { mode: 'allow', yoloMode: true, autoMode: false });
  for (const mode of ['ask', 'auto', 'allow']) assert.deepEqual(grokApprovalPolicy(mode, true), { mode: 'ask', yoloMode: false, autoMode: false });
  assert.throws(() => grokApprovalPolicy('typo'), { code: 'INVALID_POLICY' });
});

test('manual mode defers Grok permission and asks only for the actual write; policy changes are versioned and idle-only', async t => {
  const f = await fixture(t, async callbacks => {
    assert.equal((await permission(callbacks)).outcome.optionId, 'yes');
    await callbacks.onRequest('fs/write_text_file', { path: path.join(callbacks.cwd, 'result.txt'), content: 'approved' });
  });
  const session = f.service.createSession({ engine: 'grok-build', workspaceId: f.workspace.id });
  assert.equal(session.policy.approvalMode, 'ask');
  const turn = f.service.submit(session.id, { text: 'write', requestKey: 'manual-policy-turn' });
  const approval = await until(() => f.service.detail(session.id).approvals[0]);
  assert.equal(approval.operation.kind, 'file.write');
  await assert.rejects(f.service.policy(session.id, { revision: session.revision, approvalMode: 'auto' }), { code: 'ACTIVE_TURN' });
  decide(f.service, approval);
  await until(() => f.repo.turn(turn.id).state === 'completed');
  assert.equal(f.repo.events(session.id, 0).filter(event => event.type === 'approval.requested').length, 1);
  const revision = f.repo.session(session.id).revision;
  const updated = await f.service.policy(session.id, { revision, approvalMode: 'auto' });
  assert.equal(updated.policy.approvalMode, 'auto');
  assert.equal(updated.revision, revision + 1);
  await assert.rejects(f.service.policy(session.id, { revision, approvalMode: 'allow' }), { statusCode: 409 });
  await f.service.resume(session.id);
  assert.deepEqual(f.opened, ['ask', 'auto']);
  const legacy = f.repo.updatePolicy(session.id, f.repo.session(session.id).revision, { write: 'allow_workspace', readRoots: [] });
  const manual = await f.service.policy(session.id, { revision: legacy.revision, approvalMode: 'ask' });
  assert.equal(manual.policy.write, 'ask');
});

for (const mode of ['auto', 'allow']) test(`${mode} mode executes approved host operations without another prompt and preserves path boundaries`, async t => {
  const f = await fixture(t, async callbacks => {
    await callbacks.onRequest('fs/write_text_file', { path: path.join(callbacks.cwd, 'result.txt'), content: mode });
    await assert.rejects(callbacks.onRequest('fs/write_text_file', { path: path.join(callbacks.cwd, '.grok', 'config.toml'), content: 'bad' }), { code: 'PROTECTED_PATH' });
    await assert.rejects(callbacks.onRequest('fs/write_text_file', { path: path.join(f.root, 'outside.txt'), content: 'bad' }), { code: 'PATH_DENIED' });
    await assert.rejects(callbacks.onRequest('terminal/create', { command: process.execPath, args: ['-e', ''], cwd: f.root }), { code: 'PATH_DENIED' });
    const terminal = await callbacks.onRequest('terminal/create', { command: process.execPath, args: ['-e', "process.stdout.write('policy-ok')"], cwd: callbacks.cwd });
    await callbacks.onRequest('terminal/wait_for_exit', { terminalId: terminal.terminalId });
  });
  const session = f.service.createSession({ engine: 'grok-build', workspaceId: f.workspace.id, approvalMode: mode });
  const turn = f.service.submit(session.id, { text: 'execute', requestKey: `${mode}-policy-turn` });
  await until(() => ['completed', 'failed', 'unknown'].includes(f.repo.turn(turn.id).state));
  assert.equal(f.repo.turn(turn.id).state, 'completed', JSON.stringify(f.repo.turn(turn.id).data));
  assert.equal(await readFile(path.join(f.workspace.path, 'result.txt'), 'utf8'), mode);
  const events = f.repo.events(session.id, 0);
  assert.equal(events.filter(event => event.type === 'approval.requested').length, 0);
  assert.deepEqual(events.filter(event => event.type === 'approval.automatic').map(event => event.data.operation.kind), ['file.write', 'command']);
});

test('Auto asks once when Grok requests a decision; rejection prevents execution and acceptance needs no second approval', async t => {
  let writes = 0;
  const f = await fixture(t, async callbacks => {
    if ((await permission(callbacks)).outcome.optionId !== 'yes') return;
    await callbacks.onRequest('fs/write_text_file', { path: path.join(callbacks.cwd, 'result.txt'), content: 'accepted' }); writes++;
  });
  const session = f.service.createSession({ engine: 'grok-build', workspaceId: f.workspace.id, approvalMode: 'auto' });
  for (const decision of ['reject', 'allow']) {
    const turn = f.service.submit(session.id, { text: decision, requestKey: `auto-${decision}-turn` });
    const approval = await until(() => f.service.detail(session.id).approvals[0]);
    assert.equal(approval.operation.kind, 'engine.permission');
    decide(f.service, approval, decision);
    await until(() => f.repo.turn(turn.id).state === 'completed');
    assert.equal(writes, decision === 'allow' ? 1 : 0);
  }
  assert.equal(f.repo.events(session.id, 0).filter(event => event.type === 'approval.requested').length, 2);
});

test('unverified engines cannot enable automatic execution; unknown modes and unsupported engines fail explicitly', async t => {
  let dispatched = false;
  const f = await fixture(t, async () => { dispatched = true; }, { verified: false });
  assert.throws(() => f.service.createSession({ engine: 'grok-build', workspaceId: f.workspace.id, approvalMode: 'typo' }), { code: 'INVALID_POLICY' });
  assert.throws(() => f.service.createSession({ engine: 'codex-cli', workspaceId: f.workspace.id, approvalMode: 'auto', nativeReadAccepted: true, model: 'test' }), { code: 'UNSUPPORTED_POLICY' });
  const session = f.service.createSession({ engine: 'grok-build', workspaceId: f.workspace.id, approvalMode: 'auto' });
  const turn = f.service.submit(session.id, { text: 'do not dispatch', requestKey: 'unverified-policy-turn' });
  await until(() => f.repo.turn(turn.id).state === 'failed');
  assert.equal(f.repo.turn(turn.id).data.code, 'UNSUPPORTED_POLICY');
  assert.equal(f.repo.turn(turn.id).delivery, 'not_sent');
  assert.equal(dispatched, false);
  const restricted = f.repo.createSession({ workspaceId: f.workspace.id, engine: 'grok-build', purpose: 'workflow', policy: { write: 'ask', readRoots: [] }, data: {} });
  await assert.rejects(f.service.policy(restricted.id, { revision: restricted.revision, approvalMode: 'allow' }), { code: 'TOOL_DENIED' });
});
