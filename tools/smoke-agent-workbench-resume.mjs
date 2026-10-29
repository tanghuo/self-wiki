import { readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initDb } from '../src/server/data/sqlite.js';
import { createAgentWorkbenchRepository } from '../src/server/data/agentWorkbenchRepository.js';
import { createAgentWorkbenchService } from '../src/server/application/agentWorkbench/service.js';

if (!process.argv.includes('--live')) throw new Error('--live required; loads an existing synthetic Grok context without prompting');
const argument = name => process.argv[process.argv.indexOf(name) + 1];
const input = argument('--input'), output = argument('--output');
if (!input || !output || input.startsWith('--') || output.startsWith('--')) throw new Error('--input and --output required');
const source = JSON.parse(await readFile(input, 'utf8')), root = await realpath(source.root);
if (path.dirname(root).toLowerCase() !== (await realpath(os.tmpdir())).toLowerCase() || !path.basename(root).startsWith('wiki-workbench-smoke-')) throw new Error('Only a synthetic workbench smoke directory may be used');
const dataDir = path.join(root, 'data'), db = initDb(path.join(dataDir, 'library.sqlite3')), repo = createAgentWorkbenchRepository(db);
const service = await createAgentWorkbenchService({ repo, dataDir, initiallyEnabled: true, executionConfig: () => ({ chat: { grokBuild: {} } }) });
const report = { createdAt: new Date().toISOString(), modelCalls: 0, paidImageCalls: 0, checks: {} };
try {
  const session = repo.list()[0], before = repo.detail(session.id), cursor = session.seq;
  const resumed = await service.resume(session.id), after = repo.detail(session.id), events = repo.events(session.id, cursor);
  report.checks.sameContext = resumed.engineSessionId === session.engineSessionId;
  report.checks.noNewTurn = before.turns.length === after.turns.length;
  report.checks.onlyResumeEvent = events.length === 1 && events[0].type === 'session.resumed';
  report.checks.verifiedProfile = resumed.capabilities.verified === true;
} catch (error) { report.error = error.message; }
finally { await service.close(); db.close(); }
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report));
if (report.error || !Object.values(report.checks).every(Boolean)) process.exitCode = 1;
