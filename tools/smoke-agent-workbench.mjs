import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initDb } from '../src/server/data/sqlite.js';
import { createAgentWorkbenchRepository } from '../src/server/data/agentWorkbenchRepository.js';
import { createAgentWorkbenchService } from '../src/server/application/agentWorkbench/service.js';
import { powershellUtf8Prefix } from '../src/agent/engines/grokTerminal.js';

if (!process.argv.includes('--live')) throw new Error('--live required; this invokes the installed Grok model');
const output = process.argv[process.argv.indexOf('--output') + 1];
if (!output || output.startsWith('--')) throw new Error('--output required');
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'wiki-workbench-smoke-'))), data = path.join(root, 'data'), project = path.join(root, 'project');
await Promise.all([data, project].map(dir => mkdir(dir)));
const file = path.join(project, 'answer.txt'), verify = path.join(project, 'verify.mjs');
await writeFile(file, '41\n');
await writeFile(verify, `import fs from 'node:fs';import assert from 'node:assert/strict';assert.equal(fs.readFileSync(new URL('./answer.txt',import.meta.url),'utf8'),'42\\n');console.log('WORKBENCH_P2_OK');\n`);
const db = initDb(path.join(data, 'library.sqlite3')), repo = createAgentWorkbenchRepository(db);
const service = await createAgentWorkbenchService({ repo, dataDir: data, executionConfig: () => ({ chat: { grokBuild: { model: 'grok-4.6', effort: 'low' } } }), initiallyEnabled: true });
const report = { createdAt: new Date().toISOString(), root, modelCalls: 1, paidImageCalls: 0, approvals: [], checks: {} };
let turn;
try {
  const workspace = await service.workspace({ kind: 'project', path: project, trusted: true });
  const session = service.createSession({ workspaceId: workspace.id, engine: 'grok-build', model: 'grok-4.6', effort: 'low' });
  const command = `& '${process.execPath}' '${verify}'`;
  turn = service.submit(session.id, { requestKey: 'p2-real-smoke-01', text: `Synthetic compatibility test. First read ONLY ${file}, then modify its text from 41 plus newline to exactly 42 plus newline using the file tool. Then execute EXACTLY this PowerShell command using the terminal tool: ${command}\nDo not use grep, directory search, images, subagents, web, alternate commands, or other files. Report the observed exit code and WORKBENCH_P2_OK marker. If rejected stop without alternatives.` });
  const end = Date.now() + 150000;
  while (Date.now() < end) {
    const detail = service.detail(session.id);
    for (const approval of detail.approvals) {
      const op = approval.operation;
      const allowed = op.kind === 'file.write' ? op.path === file && op.before === '41\n' && op.after === '42\n'
        : op.kind === 'command' ? op.cwd === project && op.args.at(-1) === powershellUtf8Prefix + command
          : op.kind === 'engine.permission' && ['read_file', 'search_replace', 'write', 'run_terminal_cmd'].includes(op.tool);
      report.approvals.push({ kind: op.kind, allowed, operationHash: approval.operationHash });
      service.decide(approval.id, { decision: allowed ? 'allow' : 'reject', operationHash: approval.operationHash, revision: approval.policyRevision });
    }
    const actual = repo.turn(turn.id);
    if (['completed', 'failed', 'unknown', 'cancelled'].includes(actual.state)) { report.turn = { state: actual.state, delivery: actual.delivery, data: actual.data }; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!report.turn) { await service.cancel(turn.id); report.error = 'timeout'; }
  const events = repo.events(session.id, 0, 1000);
  report.checks.clientWrite = await readFile(file, 'utf8') === '42\n' && events.some(e => e.type === 'file.changed');
  report.checks.commandExit = events.some(e => e.type === 'command.output' && e.data.exitCode === 0 && e.data.output?.includes('WORKBENCH_P2_OK'));
  report.checks.persistedEngineProfile = events.some(e => e.type === 'engine.connected' && e.data.capabilities.verified);
  report.checks.completed = report.turn?.state === 'completed';
  report.checks.eventsContiguous = events.every((e, i) => e.seq === i + 1);
  report.eventTypes = events.map(e => e.type);
} catch (error) { report.error = error.message; }
finally { await service.close(); db.close(); }
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ checks: report.checks, error: report.error, output }));
if (report.error || !Object.values(report.checks).every(Boolean)) process.exitCode = 1;
