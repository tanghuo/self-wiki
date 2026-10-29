import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initDb } from '../../src/server/data/sqlite.js';
import { createAgentWorkbenchRepository } from '../../src/server/data/agentWorkbenchRepository.js';
import { createAgentTaskRepository } from '../../src/server/data/agentTaskRepository.js';
import { createAgentArtifactStore } from '../../src/server/assets/agentArtifactStore.js';
import { createAgentTaskService } from '../../src/server/application/agentTasks/service.js';
import { createAgentWorkbenchService } from '../../src/server/application/agentWorkbench/service.js';
import { createWorkflowRepository } from '../../src/server/data/workflowRepository.js';
import { createWorkflowStore } from '../../src/server/assets/workflowStore.js';
import { createWorkflowService } from '../../src/server/application/workflow/service.js';
import { createAgentTools } from '../../src/server/application/agentTools/service.js';
import { workflowCallChain } from '../../src/shared/domain/agentWorkbench/workflow.js';
import { workflowNode as n, output as o, constant as c } from '../../src/shared/domain/workflow/examples.js';
import { createChatRepository } from '../../src/server/data/chatRepository.js';
import { createAgentWikiRepository } from '../../src/server/data/agentWikiRepository.js';
import { migrateAgentWorkflow } from '../../src/server/data/agentWorkflowMigration.js';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { withExternalResource } from '../../src/agent/executors/resourceGate.js';
import { elementContent } from '../../src/shared/domain/elements.js';
const key = () => randomUUID();
const config = () => ({ chat: { grokBuild: { model: 'fixture' } } });
async function until(fn) { for (let i = 0; i < 500; i++) { const result = fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('timeout'); }
async function fixture(t, extra = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wiki-agent-workflow-')), db = initDb(':memory:');
  const sessions = createAgentWorkbenchRepository(db), repo = createAgentTaskRepository(db), workflowRepo = createWorkflowRepository(db);
  const workflow = createWorkflowService({ repo: workflowRepo, store: createWorkflowStore(dir), executionConfig: config, ...extra });
  const tasks = createAgentTaskService({ repo, sessions, store: createAgentArtifactStore(dir), workflow, wiki: { create: value => ({ id: elementContent(value).body.length }) }, executionConfig: config });
  const workspace = sessions.createWorkspace({ kind: 'scratch', userPath: dir, path: dir, identity: dir });
  const session = sessions.createSession({ workspaceId: workspace.id, engine: 'fixture', policy: {} });
  const turn = sessions.startTurn(sessions.queueTurn(session.id, key(), { text: 'fixture' }).id);
  workflow.start();
  t.after(async () => { await tasks.close(); await workflow.close(); db.close(); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('wiki-agent-workflow-')); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); });
  return { dir, db, sessions, repo, workflowRepo, workflow, tasks, session, turn };
}
const definition = { schemaVersion: 1, nodes: [n('source', 'input', { parameter: 'text', valueType: 'text' }), n('result', 'preview', { valueType: 'text' }, { value: o('source') })], outputs: {} };

test('approved workflow task binds one frozen run; scoped results and retrieval never resubmit', async t => {
  const f = await fixture(t), { tasks, workflow, session, turn, repo, db } = f;
  const w = workflow.create({ requestKey: key(), name: 'frozen', definition });
  const input = { operationId: key(), workflowId: w.id, revision: w.revision, inputs: { text: 'original' } };
  const operation = await tasks.submitWorkflow(session.id, turn.id, input);
  assert.equal(workflow.get(w.id).runs.length, 0);
  workflow.save(w.id, { name: 'edited', revision: w.revision, definition: { ...definition, nodes: [n('changed', 'template', { parts: [{ kind: 'text', text: 'changed' }] })] } });
  assert.equal((await tasks.submitWorkflow(session.id, turn.id, input)).id, operation.id);
  await assert.rejects(tasks.submitWorkflow(session.id, turn.id, { ...input, inputs: { text: 'other' } }), { statusCode: 409 });
  const approved = tasks.decide(operation.id, session.id, { requestKey: key(), decision: 'allow', hash: operation.hash });
  const result = await until(() => { const task = tasks.get(approved.taskId, session.id); return ['succeeded', 'failed', 'unknown'].includes(task.state) && task; });
  assert.equal(result.state, 'succeeded', JSON.stringify(result));
  const run = workflow.run(result.data.workflowRunId); assert.equal(run.inputs.text, 'original'); assert.deepEqual(run.definition.nodes.map(n => n.id), ['source', 'result']);
  tasks.decide(operation.id, session.id, { requestKey: key(), decision: 'allow', hash: operation.hash });
  assert.equal(db.prepare('SELECT count(*) n FROM agent_workflow_runs').get().n, 1); assert.equal(workflow.get(w.id).runs.length, 1);
  const artifact = tasks.artifact(result.data.artifactIds[0], session.id); assert.equal(artifact.type, 'text');
  assert.match((await tasks.content(artifact.id, session.id)).bytes.toString(), /original/);
  assert.throws(() => tasks.artifact(artifact.id, session.id + 100), { statusCode: 404 });
  assert.deepEqual(await tasks.saveToWiki(artifact.id, session.id), await tasks.saveToWiki(artifact.id, session.id));
  assert.equal((await tasks.reconcile(result.id, session.id, { requestKey: key() })).state, 'succeeded');
  assert.equal(repo.workflowChain(run.id).parentTaskId, result.id);
});

test('workflow run creation and task binding roll back together; chain and tools cannot be forged', async t => {
  const { workflow, repo, session, turn, tasks, db } = await fixture(t);
  const w = workflow.create({ requestKey: key(), name: 'atomic', definition });
  const snapshot = await workflow.freezeAgentRun(w.id, w.revision, { text: 'input' });
  assert.throws(() => workflow.startAgentRun(snapshot, key(), () => { throw new Error('binding failed'); }), /binding failed/);
  assert.equal(workflow.get(w.id).runs.length, 0); assert.equal(db.prepare('SELECT count(*) n FROM agent_workflow_runs').get().n, 0);
  const call = createAgentTools({ tasks }).forTurn({ sessionId: session.id, turnId: turn.id, assertLive() {}, onResourceWait() {}, allowedTools: ['workflow_read', 'workflow_submit'] });
  await assert.rejects(call({ name: 'wiki_search', input: { query: 'x' } }), { code: 'TOOL_DENIED' });
  await assert.rejects(call({ name: 'workflow_submit', input: { workflowId: w.id, revision: w.revision, inputs: {} } }), { code: 'READ_REQUIRED' });
  await call({ name: 'workflow_read', input: { workflowId: w.id } });
  await assert.rejects(call({ name: 'workflow_submit', input: { workflowId: w.id, revision: w.revision, inputs: {}, callChain: {} } }), { code: 'INVALID_TOOL_INPUT' });
  assert.throws(() => workflowCallChain(workflowCallChain({}, w.id), w.id), { code: 'WORKFLOW_RECURSION' });
  assert.throws(() => workflowCallChain({ depth: 2, ancestorWorkflowIds: [1, 2] }, 3), { code: 'WORKFLOW_RECURSION' });
  assert.throws(() => workflowCallChain({ depth: 0, ancestorWorkflowIds: [1] }, 2), { code: 'WORKFLOW_RECURSION' });
  assert.equal(repo.list(session.id).length, 0);
});

test('restart reconciliation reads the bound workflow and never creates another run', async t => {
  const { workflow, repo, tasks, session, turn } = await fixture(t);
  const w = workflow.create({ requestKey: key(), name: 'recover bound run', definition });
  const operation = await tasks.submitWorkflow(session.id, turn.id, { workflowId: w.id, revision: w.revision, inputs: { text: 'already executed' } });
  const approved = repo.decide(operation.id, { requestKey: key(), decision: 'allow', hash: operation.hash }), task = repo.start(approved.taskId);
  repo.dispatch(task.id, task.attemptId);
  const run = workflow.startAgentRun(operation.executor.snapshot, key(), value => repo.bindWorkflow(task.id, task.attemptId, value, operation.input.callChain));
  await until(() => workflow.run(run.id).state === 'succeeded');
  repo.recover(); assert.equal(repo.task(task.id).state, 'unknown');
  const retry = tasks.reexecute(task.id, session.id, { operationId: key(), requestKey: key(), revision: repo.task(task.id).revision });
  assert.deepEqual(retry.input.submission, operation.input.submission); assert.deepEqual(retry.executor.snapshot, operation.executor.snapshot);
  tasks.decide(retry.id, session.id, { requestKey: key(), decision: 'reject', hash: retry.hash });
  const result = await tasks.reconcile(task.id, session.id, { requestKey: key() });
  assert.equal(result.state, 'succeeded'); assert.equal(result.data.workflowRunId, run.id); assert.equal(workflow.get(w.id).runs.length, 1);
});

test('long workflow output keeps its full original and publishes a Wiki-compatible marked preview', async t => {
  const { workflow, tasks, session, turn } = await fixture(t), text = '长输出'.repeat(6000);
  const w = workflow.create({ requestKey: key(), name: 'long output', definition });
  const operation = await tasks.submitWorkflow(session.id, turn.id, { workflowId: w.id, revision: w.revision, inputs: { text } });
  const approved = tasks.decide(operation.id, session.id, { requestKey: key(), hash: operation.hash, decision: 'allow' });
  const task = await until(() => tasks.get(approved.taskId, session.id).state === 'succeeded' && tasks.get(approved.taskId, session.id));
  const id = task.data.artifactIds[0], preview = await tasks.content(id, session.id);
  assert.equal(preview.artifact.metadata.truncated, true); assert.match(preview.bytes.toString(), /摘要已截取/);
  assert.ok((await tasks.saveToWiki(id, session.id)).elementId); assert.equal(workflow.run(task.data.workflowRunId).inputs.text, text);
});

test('workflow Agent gets a fresh restricted session and host denies files, shell and undeclared tools', async t => {
  let workbench, sessions, calls = 0;
  const f = await fixture(t, { executeAgent: (...args) => workbench.executeWorkflowAgent(...args) }); sessions = f.sessions;
  const tools = createAgentTools({ tasks: f.tasks, repo: { list: () => [], draft: () => ({}) } });
  workbench = await createAgentWorkbenchService({ repo: sessions, dataDir: f.dir, executionConfig: config, initiallyEnabled: true, applicationToolsVerified: true, tasks: f.tasks, tools,
    async openEngine(_settings, options) {
      calls++; assert.equal(options.restricted, true); assert.deepEqual(options.tools.map(t => t.name), ['workflow_list']);
      return { sessionId: 'restricted-fixture', version: 'fixture', capabilities: {}, async prompt(_text, delivery) {
        delivery('attempted');
        await assert.rejects(options.onRequest('terminal/create', { command: 'evil' }), { code: 'TOOL_DENIED' });
        await assert.rejects(options.onRequest('fs/write_text_file', { path: 'evil' }), { code: 'TOOL_DENIED' });
        await assert.rejects(options.onToolCall({ name: 'image_submit', input: { prompt: 'evil' } }), { code: 'TOOL_DENIED' });
        await options.onToolCall({ name: 'workflow_list', input: {} });
        await options.onEvent('message.delta', { text: '{"ok":true}' }); return {};
      }, async close() {}, cancel() {} };
    } });
  t.after(() => workbench.close());
  const agent = n('agent', 'agent', { adapterId: 'grok-agent', outputType: 'json', jsonSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }, adapterConfig: { tools: ['workflow_list'] } }, { prompt: c('read'), images: c([]) });
  const w = f.workflow.create({ requestKey: key(), name: 'agent', definition: { schemaVersion: 1, nodes: [agent], outputs: {} } });
  const run = await f.workflow.createRun(w.id, { requestKey: key(), revision: w.revision, inputs: {} });
  const result = await until(() => { const r = f.workflow.run(run.id); return ['succeeded', 'needs_attention', 'failed'].includes(r.state) && r; });
  assert.equal(result.state, 'succeeded', JSON.stringify(result)); assert.equal(calls, 1);
  const child = sessions.list().find(s => s.purpose === 'workflow'); assert.ok(child); assert.equal(child.data.callChain.depth, 1);
  await assert.rejects(workbench.policy(child.id, { revision: child.revision, write: 'allow_workspace', readRoots: [] }), { code: 'TOOL_DENIED' });
});

test('legacy conversion preserves branch, original drafts, images and source history; retries keep edited new drafts', async t => {
  const f = await fixture(t), legacy = createChatRepository(f.db), original = legacy.create('legacy source');
  const attachment = legacy.addAttachment('synthetic.png', 'original image');
  const started = legacy.begin(original.id, { requestKey: key(), text: 'historical question', sourceIds: [], attachmentIds: [attachment.id], model: 'fixture', branchRevision: original.branchRevision });
  legacy.writeTrace(started.turn.id, 'request', { marker: 'preserved trace' });
  legacy.updateTurn({ ...started.turn, state: 'completed', answer: 'historical answer', events: [{ id: 'image-1', type: 'image', artifact: 'synthetic.png' }] });
  const source = legacy.fork(started.turn.id, key(), legacy.session(original.id).branchRevision);
  legacy.setDraft(source.id, { text: '  原始未发草稿\n', revision: 10 }); legacy.setImageDraft(source.id, { attachments: [attachment], revision: 11 }); legacy.setThread(source.id, 'do-not-reuse-native-thread');
  const old = legacy.detail(source.id), png = await sharp({ create: { width: 5, height: 5, channels: 3, background: '#36f' } }).png().toBuffer();
  const tools = createAgentTools({ tasks: f.tasks, repo: createAgentWikiRepository(f.db) });
  let prompts = 0;
  const workbench = await createAgentWorkbenchService({ repo: f.sessions, dataDir: f.dir, initiallyEnabled: true, applicationToolsVerified: true, executionConfig: config, tasks: f.tasks, tools, wiki: {}, legacyChat: { detail: id => ({ ...legacy.detail(id), running: false }), newDraft: () => legacy.newDraft(), attachmentImage: async () => png }, openEngine: async () => { prompts++; throw new Error('must not prompt'); } });
  t.after(() => workbench.close());
  const converted = await workbench.continueLegacy(source.id);
  assert.equal(converted.engineSessionId, null); assert.equal(converted.data.restricted, true); assert.equal(converted.data.provenance.sessionId, source.id);
  assert.equal(converted.data.provenance.branchRevision, source.branchRevision); assert.equal(prompts, 0);
  assert.deepEqual(converted.data.provenance.forkedFrom, { ...source.forkedFrom }); assert.match(converted.data.initialContext, /historical answer/); assert.match(converted.data.initialContext, /requestTraceVersion/);
  const draft = tools.draft(converted.id); assert.equal(draft.text, '  原始未发草稿\n'); assert.equal(draft.attachments.length, 1);
  assert.deepEqual((await f.tasks.content(draft.attachments[0], converted.id)).bytes, png);
  tools.saveDraft(converted.id, { revision: draft.revision, text: 'new edited draft', attachments: draft.attachments });
  assert.equal((await workbench.continueLegacy(source.id)).id, converted.id); assert.equal(tools.draft(converted.id).text, 'new edited draft');
  assert.deepEqual(legacy.detail(source.id), old); assert.equal(prompts, 0);
  await workbench.configure({ agentWorkbenchEnabled: false });
  await assert.rejects(workbench.continueLegacy(source.id), { code: 'WORKBENCH_DISABLED' });
  assert.deepEqual(legacy.detail(source.id), old);
});

test('workflow migration rolls back atomically and is repeatable', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE wiki_schema(version INTEGER PRIMARY KEY); CREATE TRIGGER reject44 BEFORE INSERT ON wiki_schema WHEN NEW.version=44 BEGIN SELECT RAISE(ABORT,'injected'); END");
    assert.throws(() => migrateAgentWorkflow(db), /injected/);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_workflow_runs'").get(), undefined);
    db.exec('DROP TRIGGER reject44'); migrateAgentWorkflow(db); migrateAgentWorkflow(db);
    assert.equal(db.prepare('SELECT count(*) n FROM wiki_schema WHERE version=44').get().n, 1);
  } finally { db.close(); }
});

test('Agent to workflow to Agent yields the shared engine and rejects the ancestor workflow', async t => {
  let workbench, childWorkflow, parentWorkflow, childTask, childCalled = false;
  const f = await fixture(t, { executeAgent: (...args) => workbench.executeWorkflowAgent(...args) });
  const tools = createAgentTools({ tasks: f.tasks, repo: { list: () => [], draft: () => ({}) } });
  workbench = await createAgentWorkbenchService({ repo: f.sessions, dataDir: f.dir, initiallyEnabled: true, applicationToolsVerified: true, executionConfig: config, tasks: f.tasks, tools,
    async openEngine(_settings, options) {
      let stop; const stopped = new Promise(resolve => { stop = resolve; });
      return { sessionId: key(), version: 'fixture', capabilities: {}, cancel: stop, close: async () => stop(),
        prompt: (text, delivery) => withExternalResource('grok', options.signal, async () => {
          delivery('attempted'); const call = (name, input) => options.onToolCall({ name, input });
          if (text === 'parent') {
            await call('workflow_read', { workflowId: childWorkflow.id });
            const operation = await call('workflow_submit', { workflowId: childWorkflow.id, revision: childWorkflow.revision, inputs: {}, operationId: key() });
            const approved = f.tasks.decide(operation.id, f.repo.operation(operation.id).sessionId, { decision: 'allow', hash: operation.hash, requestKey: key() }); childTask = approved.taskId;
            for (let i = 0; i < 3; i++) await call('task_status', { taskId: childTask });
            await stopped; return { stopReason: 'cancelled' };
          }
          childCalled = true;
          await call('workflow_read', { workflowId: parentWorkflow.id });
          await assert.rejects(call('workflow_submit', { workflowId: parentWorkflow.id, revision: parentWorkflow.revision, inputs: {}, operationId: key() }), { code: 'WORKFLOW_RECURSION' });
          await options.onEvent('message.delta', { text: 'child succeeded' }); return {};
        }),
      };
    } });
  t.after(() => workbench.close());
  const agent = text => ({ schemaVersion: 1, outputs: {}, nodes: [n('agent', 'agent', { adapterId: 'grok-agent', outputType: 'text', adapterConfig: { tools: ['workflow_read', 'workflow_submit', 'task_status'] } }, { prompt: c(text), images: c([]) })] });
  childWorkflow = f.workflow.create({ requestKey: key(), name: 'child', definition: agent('child') });
  parentWorkflow = f.workflow.create({ requestKey: key(), name: 'parent', definition: agent('parent') });
  await f.workflow.createRun(parentWorkflow.id, { requestKey: key(), revision: parentWorkflow.revision, inputs: {} });
  const task = await until(() => childTask && f.repo.task(childTask).state === 'succeeded' && f.repo.task(childTask));
  assert.equal(childCalled, true); assert.equal(f.repo.workflowChain(task.data.workflowRunId).depth, 2);
});
