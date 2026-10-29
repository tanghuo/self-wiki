import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDb } from '../src/server/data/sqlite.js';
import { createAgentWorkbenchRepository } from '../src/server/data/agentWorkbenchRepository.js';
import { createAgentWorkbenchService } from '../src/server/application/agentWorkbench/service.js';
import { createAgentCommandStore } from '../src/server/assets/agentCommandStore.js';
import { defaultOrganizationConfig } from '../src/shared/domain/organization.js';

if (!process.argv.includes('--live')) throw new Error('--live required; invokes one Codex text turn');
const output = process.argv[process.argv.indexOf('--output') + 1]; if (!output || output.startsWith('--')) throw new Error('--output required');
const rejecting = process.argv.includes('--reject');
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'wiki-codex-workbench-smoke-'))), dataDir = path.join(root, 'data'), project = path.join(root, 'project'); await mkdir(dataDir); await mkdir(project);
const file = path.join(project, 'answer.txt'), verify = path.join(project, 'verify.mjs');
await writeFile(file, '41\n'); await writeFile(verify, `import fs from 'node:fs';import assert from 'node:assert/strict';assert.equal(fs.readFileSync(new URL('./answer.txt',import.meta.url),'utf8'),'42\\n');console.log('CODEX_WORKBENCH_OK');`);
const config = defaultOrganizationConfig().executor; config.codexCli = { ...config.codexCli, codexHome: path.join(dataDir, 'codex-home'), reuseLocalAuth: true };
const db = initDb(path.join(dataDir, 'library.sqlite3')), repo = createAgentWorkbenchRepository(db);
const service = await createAgentWorkbenchService({ repo, dataDir, initiallyEnabled: true, codexVerified: true, executionConfig: () => config, commandStore: createAgentCommandStore(dataDir) });
const report = { root, modelCalls: 0, paidImageCalls: 0, rejecting, approvals: [], checks: {} }; let turn;
try {
  const models = await service.models('codex-cli'), model = models.defaultModel || models.models.find(model => model.isDefault)?.id;
  const workspace = await service.workspace({ kind: 'project', path: project, trusted: true });
  const session = service.createSession({ engine: 'codex-cli', model, effort: 'low', workspaceId: workspace.id, nativeReadAccepted: true, applicationTools: false });
  turn = service.submit(session.id, { requestKey: 'codex-native-smoke', text: `Synthetic native approval compatibility test. Read ONLY ${file}; use apply_patch to change exactly 41 plus newline to 42 plus newline. Then run this exact PowerShell command using the native terminal: & '${process.execPath}' '${verify}'. Report the observed exit code and CODEX_WORKBENCH_OK. Do not use other files, tools, network, images or subagents. If any operation is declined, stop immediately without alternatives.` }); report.modelCalls = 1;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const detail = service.detail(session.id);
    for (const approval of detail.approvals) {
      const op = approval.operation;
      const command = op.command?.replaceAll('\\\\', '\\');
      let script = command?.split(' -Command ').slice(1).join(' -Command ');
      if (script?.startsWith('"') && script.endsWith('"')) script = script.slice(1, -1).replaceAll('\\"', '"');
      const expected = op.kind === 'native.file' ? op.changes.every(change => change.path === file && !change.kind?.move_path) && op.changes.some(change => change.diff.includes('42')) : op.kind === 'native.command' && op.cwd === project && [
        `Get-Content -Raw -LiteralPath '${file}'`, `Get-Content -LiteralPath '${file}'`, `Get-Content -LiteralPath '${file}' -Raw`, `& '${process.execPath}' '${verify}'`,
      ].includes(script);
      const allowed = expected && !rejecting; report.approvals.push({ kind: op.kind, allowed, hash: approval.operationHash, ...(op.kind === 'native.command' && { command: op.command }) });
      service.decide(approval.id, { decision: allowed ? 'allow' : 'reject', operationHash: approval.operationHash, revision: approval.policyRevision });
    }
    const actual = repo.turn(turn.id);
    if (['completed', 'failed', 'unknown', 'cancelled'].includes(actual.state)) { report.state = actual.state; report.data = actual.data; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!report.state) { await service.cancel(turn.id); throw new Error('Codex timeout; no automatic retry'); }
  const events = repo.events(session.id, 0, 1000);
  report.events = events.filter(event => !['message.delta', 'engine.diff'].includes(event.type)).map(event => ({ type: event.type, data: event.data }));
  report.checks.nativeApprovals = report.approvals.length > 0 && report.approvals.every(op => op.kind.startsWith('native.'));
  report.checks.fileState = await readFile(file, 'utf8') === (rejecting ? '41\n' : '42\n');
  report.checks.command = rejecting ? !events.some(event => event.type === 'command.output' && event.data.output?.includes('CODEX_WORKBENCH_OK')) : events.some(event => event.type === 'command.output' && event.data.exitCode === 0 && event.data.output?.includes('CODEX_WORKBENCH_OK'));
  report.checks.completed = report.state === 'completed';
  if (!rejecting) {
    const before = repo.detail(session.id).turns.length; await service.resume(session.id);
    report.checks.resumeWithoutPrompt = repo.detail(session.id).turns.length === before;
  }
} catch (error) { report.error = error.message; }
finally { await service.close(); report.modelCalls = turn && repo.turn(turn.id).delivery !== 'not_sent' ? 1 : 0; db.close(); }
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ checks: report.checks, approvals: report.approvals, state: report.state, error: report.error, modelCalls: report.modelCalls, paidImageCalls: 0 }));
if (report.error || !Object.values(report.checks).every(Boolean)) process.exitCode = 1;
