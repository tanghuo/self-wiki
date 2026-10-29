import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initDb } from '../src/server/data/sqlite.js';
import { createAgentWorkbenchRepository } from '../src/server/data/agentWorkbenchRepository.js';
import { createAgentWikiRepository } from '../src/server/data/agentWikiRepository.js';
import { createElementRepository } from '../src/server/data/elementRepository.js';
import { createAgentWorkbenchService } from '../src/server/application/agentWorkbench/service.js';
import { createAgentTools } from '../src/server/application/agentTools/service.js';

if (!process.argv.includes('--live')) throw new Error('--live required');
const output = process.argv[process.argv.indexOf('--output') + 1]; if (!output || output.startsWith('--')) throw new Error('--output required');
const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-workbench-wiki-')), dataDir = path.join(root, 'data'); await mkdir(dataDir);
const db = initDb(path.join(dataDir, 'library.sqlite3')), repo = createAgentWorkbenchRepository(db), wiki = createElementRepository(db), wikiRepo = createAgentWikiRepository(db);
const source = wiki.createText({ body: 'SELF_WIKI_SDK_FIXTURE: synthetic content for a safe tool integration test.', tags: [], creationSource: 'manual' });
const tasks = { list: () => [], artifacts: () => [], operations: () => [], schedule() {}, hasActive: () => false, expireTurn() {}, submit() { throw new Error('Synthetic Wiki probe never permits image tasks'); } };
const tools = createAgentTools({ wiki, repo: wikiRepo, tasks });
const service = await createAgentWorkbenchService({ repo, dataDir, tools, tasks, applicationToolsVerified: true, initiallyEnabled: true, executionConfig: () => ({ chat: { grokBuild: { model: 'grok-4.6', effort: 'low' } } }) });
const report = { modelCalls: 1, paidImageCalls: 0, checks: {} };
try {
  const workspace = await service.workspace({ kind: 'scratch', trusted: true }), session = service.createSession({ workspaceId: workspace.id, engine: 'grok-build', effort: 'low' });
  const turn = service.submit(session.id, { requestKey: 'real-wiki-smoke', text: 'Synthetic integration test: discover wiki_search, wiki_read and wiki_propose. Search for SELF_WIKI_SDK_FIXTURE; read that entry; propose adding exactly the tag sdk-verified using kind add_tags, reason synthetic compatibility evidence, sourceIds [], requestKey sdk-proposal-01. Do not apply the suggestion. Do not use files, terminal, images, web, other agents or other tools. If rejected, stop without alternatives.' });
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    const t = repo.turn(turn.id);
    if (['completed', 'failed', 'unknown', 'cancelled'].includes(t.state)) { report.turn = { state: t.state, data: t.data }; break; }
    for (const approval of service.detail(session.id).approvals) service.decide(approval.id, { decision: 'reject', operationHash: approval.operationHash, revision: approval.policyRevision });
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const proposals = wikiRepo.list(session.id);
  report.checks.completed = report.turn?.state === 'completed'; report.checks.proposed = proposals.length === 1;
  report.checks.notAutoApplied = !wiki.get(source.id).tags.includes('sdk-verified');
  if (proposals[0]) { tools.decideProposal(proposals[0].id, session.id, { requestKey: 'user-accept-01', decision: 'accept' }); report.checks.acceptedByUser = wiki.get(source.id).tags.includes('sdk-verified'); }
  report.events = repo.events(session.id, 0, 1000).map(event => ({ type: event.type, ...(event.type === 'tool.updated' && { title: event.data.title, status: event.data.status, content: event.data.content }) }));
  if (!report.turn) { await service.cancel(turn.id); report.error = 'timeout'; }
} catch (error) { report.error = error.message; }
finally { await service.close(); db.close(); }
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ checks: report.checks, turn: report.turn, error: report.error, output }));
if (report.error || !Object.values(report.checks).every(Boolean)) process.exitCode = 1;
