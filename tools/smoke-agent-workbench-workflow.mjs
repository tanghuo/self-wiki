import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../src/server/server.js';
import { workflowNode as n, constant as c } from '../src/shared/domain/workflow/examples.js';
if (!process.argv.includes('--live')) throw new Error('--live required; two Grok text turns, no images');
const output = process.argv[process.argv.indexOf('--output') + 1]; if (!output || output.startsWith('--')) throw new Error('--output required');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wiki-workflow-live-')), report = { modelCalls: 0, paidImageCalls: 0, checks: {} }; let app;
try {
  app = await createServer({ port: 0, dataDir, agentWorkbenchEnabled: true });
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => { const response = await fetch(new URL('/api/' + route, app.url), { method, headers: { ...app.managementHeaders(), 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) }); const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value)); return value; };
  await api('elements', { body: 'WORKFLOW_AGENT_LIVE_MARKER synthetic acceptance content', tags: [] });
  const workflow = await api('workflows', { requestKey: randomUUID(), name: '合成 Agent 桥接验收', definition: { schemaVersion: 1, outputs: {}, nodes: [n('agent', 'agent', { adapterId: 'grok-agent', outputType: 'text', adapterConfig: { tools: ['wiki_search'] } }, { prompt: c('Synthetic acceptance: discover wiki_search and call exactly once with query WORKFLOW_AGENT_LIVE_MARKER. Report its matching excerpt including marker. No other tool calls, images, files, terminal, web, agents, retries or workflow submission.'), images: c([]) })] } });
  const workspace = await api('agent/workspaces', { kind: 'scratch', trusted: true }), session = await api('agent/sessions', { workspaceId: workspace.id, engine: 'grok-build', model: 'grok-4.6', effort: 'low', title: '真实工作流桥接验收' });
  await api(`agent/sessions/${session.id}/turns`, { requestKey: randomUUID(), text: `Synthetic acceptance. Discover workflow_read and workflow_submit application tools. Read workflowId ${workflow.id}, then submit exactly once its returned revision with inputs {} and operationId ${randomUUID()}. Report pending approval then finish your turn immediately to release the Grok resource. Do not poll task_status, generate images, call native files/terminal/web/agents, submit other workflows, or retry.` }); report.modelCalls++;
  const deadline = Date.now() + 210000; let task, approved = false;
  while (Date.now() < deadline) {
    const detail = await api(`agent/sessions/${session.id}`);
    for (const operation of detail.operations.filter(op => op.state === 'pending')) {
      if (approved || operation.kind !== 'workflow.submit' || operation.input.submission.workflowId !== workflow.id || operation.input.maxCalls !== 1) throw new Error('Unexpected operation, refusing further dispatch');
      const value = await api(`agent/operations/${operation.id}/decision?sessionId=${session.id}`, { decision: 'allow', hash: operation.hash, requestKey: randomUUID() }); report.taskId = value.taskId; approved = true;
    }
    task = detail.tasks[0]; if (task && ['succeeded', 'failed', 'unknown', 'cancelled'].includes(task.state)) break;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  const parent = await api(`agent/sessions/${session.id}`), children = (await api('agent/sessions')).sessions.filter(s => s.purpose === 'workflow');
  report.modelCalls += children.filter(s => s.engineSessionId).length;
  report.state = task?.state; report.checks = { parentCompleted: parent.turns.at(-1)?.state === 'completed', approvedOnce: approved && parent.tasks.length === 1, workflowSucceeded: task?.state === 'succeeded', restrictedChild: children.length === 1 && children[0].data.allowedTools.join() === 'wiki_search', artifactsSaved: task?.data.artifactIds?.length > 0 };
  if (task?.state === 'succeeded') { const response = await fetch(new URL(`/api/agent/artifacts/${task.data.artifactIds[0]}/content?sessionId=${session.id}`, app.url), { headers: app.managementHeaders() }); report.checks.markerSaved = (await response.text()).includes('WORKFLOW_AGENT_LIVE_MARKER'); }
  report.task = task;
} catch (error) { report.error = error.message; } finally { await app?.close(); }
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ checks: report.checks, error: report.error, modelCalls: report.modelCalls, paidImageCalls: 0 })); if (report.error || !Object.values(report.checks).every(Boolean)) process.exitCode = 1;
