import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openCodexWorkbench, describeCodexWorkbench } from '../src/agent/engines/codexWorkbench.js';
import { defaultOrganizationConfig } from '../src/shared/domain/organization.js';

if (!process.argv.includes('--live')) throw new Error('--live required; one Codex text turn');
const output = process.argv[process.argv.indexOf('--output') + 1]; if (!output || output.startsWith('--')) throw new Error('--output required');
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'wiki-codex-sdk-'))), cwd = path.join(root, 'project'), neutralCwd = path.join(root, 'neutral'); await mkdir(cwd); await mkdir(neutralCwd);
const config = defaultOrganizationConfig().executor; config.codexCli = { ...config.codexCli, codexHome: path.join(root, 'home'), reuseLocalAuth: true }; config.effort = 'low';
const report = { root, modelCalls: 0, paidImageCalls: 0, checks: {}, calls: [] }; let client, cancelTimer;
try {
  const models = await describeCodexWorkbench(config, { cwd: neutralCwd, signal: AbortSignal.timeout(30000) }); config.codexCli.model = models.defaultModel;
  client = await openCodexWorkbench(config, { cwd, neutralCwd, signal: AbortSignal.timeout(120000), tools: [{ name: 'wiki_search', description: 'Search synthetic fixture only. Read-only, no shell or filesystem.', inputSchema: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' } }, required: ['query'] } }],
    onRequest: async () => false, onExit() {},
    onToolCall(call) { if (call.name !== 'wiki_search' || call.input?.query !== 'NATIVE_SDK_FIXTURE') throw new Error('Unexpected synthetic query'); report.calls.push({ name: call.name, query: call.input.query, bound: !!call.callId }); return { entries: [{ reference: 'wiki:synthetic', body: 'NATIVE_SDK_RESULT' }] }; },
    onEvent(type) { if (type === 'message.delta' && report.calls.length && !cancelTimer) cancelTimer = setTimeout(() => { report.cancelRequested = true; void client.cancel(); }, 50); },
  });
  const result = await client.prompt('Synthetic SDK compatibility test. First call wiki_search with exactly query NATIVE_SDK_FIXTURE. Then mention NATIVE_SDK_RESULT and write a numbered list of 1000 short sentences about circles until cancelled. Do not use files, shell, network, images, other tools or agents.', () => report.modelCalls = 1);
  report.stopReason = result.stopReason;
  report.checks.applicationTool = report.calls.length === 1 && report.calls[0].bound;
  report.checks.cancelled = report.cancelRequested === true && result.stopReason === 'cancelled';
} catch (error) { report.error = error.message; }
finally { clearTimeout(cancelTimer); await client?.close(); }
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify(report));
if (report.error || !Object.values(report.checks).every(Boolean)) process.exitCode = 1;
