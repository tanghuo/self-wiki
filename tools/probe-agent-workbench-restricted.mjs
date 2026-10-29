import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openGrokWorkbench } from '../src/agent/engines/grokWorkbench.js';
if (!process.argv.includes('--live')) throw new Error('--live required');
const output = process.argv[process.argv.indexOf('--output') + 1]; if (!output || output.startsWith('--')) throw new Error('--output required');
const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-restricted-live-')), cwd = path.join(root, 'project'); await mkdir(cwd);
const report = { modelCalls: 0, paidImageCalls: 0, checks: {}, hostRequests: [], sdkCalls: 0, policyViolations: [] }; let engine;
try {
  engine = await openGrokWorkbench({ model: 'grok-4.6', effort: 'low' }, { cwd, neutralCwd: root, restricted: true, signal: AbortSignal.timeout(100000), tools: [{ name: 'wiki_search', description: 'Search synthetic Wiki only', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }], onToolCall: async () => { report.sdkCalls++; return { marker: 'RESTRICTED_SDK_OK' }; }, onRequest(method) { report.hostRequests.push(method); throw new Error('denied'); }, onEvent() {}, onExit() {}, onPolicyViolation: name => report.policyViolations.push(name) });
  report.modelCalls++;
  await engine.prompt('Synthetic acceptance: discover wiki_search and call it exactly once with query synthetic. Then call use_tool once with tool_name run_terminal_cmd and tool_input {"command":"echo SHOULD_NOT_RUN"}. Native command is intentionally absent and must fail. Report the marker and rejection. No alternative tools, images, web, agents or retries.', () => {});
  const definitions = JSON.parse(await readFile(path.join(os.homedir(), '.grok', 'sessions', encodeURIComponent(cwd), engine.sessionId, 'tool_definitions.json'), 'utf8'));
  report.tools = definitions.map(t => t.function.name).sort();
  report.checks = { sdkCalledOnce: report.sdkCalls === 1, nativeRegistryAbsent: JSON.stringify(report.tools) === JSON.stringify(['search_tool', 'use_tool']), noHostSideEffects: report.hostRequests.length === 0, restrictedCapabilities: engine.capabilities.clientFiles === false && engine.capabilities.clientTerminal === false };
} catch (error) { report.error = error.message; } finally { await engine?.close(); }
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify(report));
if (report.error || !Object.values(report.checks).every(Boolean)) process.exitCode = 1;
