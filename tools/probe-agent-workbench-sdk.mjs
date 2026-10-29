import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { homedir } from 'node:os';
import { startGrokAcp } from '../src/agent/executors/grokProcess.js';
import { createGrokSdkTools } from '../src/agent/engines/grokSdkTools.js';
import { grokWorkbenchProfile, verifyGrokWorkbenchProfile } from '../src/agent/engines/grokWorkbenchProfile.js';
import { verifyWorkbenchMcpCatalog } from '../src/agent/engines/grokMcpPolicy.js';

if (!process.argv.includes('--live')) throw new Error('--live required');
const output = process.argv[process.argv.indexOf('--output') + 1];
if (!output || output.startsWith('--')) throw new Error('--output required');
const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-sdk-probe-')), cwd = path.join(root, 'project'); await mkdir(cwd);
await writeFile(path.join(cwd, 'AGENTS.md'), 'Synthetic file. No images, web, agents or alternate tools.\n');
const report = { modelCalls: 0, paidImageCalls: 0, checks: {}, toolCalls: 0, hostRequests: [], trace: [] };
const sdk = createGrokSdkTools([{ name: 'wiki_search', description: 'Search synthetic wiki entries only', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }], async call => { report.toolCalls++; return { marker: 'SELF_WIKI_SDK_OK', query: call.input.query }; });
const profile = grokWorkbenchProfile({ applicationTools: true }); let thread, phase = 'initialize';
const client = await startGrokAcp({ model: 'grok-4.6' }, { cwd: root, onNotification(method, params) {
  const value = params.update;
  if (method === 'session/update' && value?.sessionUpdate?.startsWith('tool_call')) report.trace.push({ phase, event: value.sessionUpdate, tool: value._meta?.['x.ai/tool']?.name, status: value.status, ...(value.status === 'failed' && { error: JSON.stringify(value.content || value.rawOutput || '').slice(0, 1500) }) });
}, onRequest(method, params) {
  if (method.replace(/^_/, '') === 'x.ai/mcp/sdk_call') return sdk.request(params);
  if (method.includes('hooks/run')) throw new Error('Synthetic hook error: native registry must remain restrictive');
  if (method === 'session/request_permission') {
    const name = params.toolCall?._meta?.['x.ai/tool']?.name || '', target = params.toolCall?.rawInput?.tool_name || '';
    report.trace.push({ phase, permissionTool: name, target });
    const syntheticGrep = phase === 'native-bypass' && target === 'grep';
    const option = params.options?.find(option => option.kind === (syntheticGrep || name.includes(sdk.definition.name) || target.startsWith(sdk.definition.name + '__') ? 'allow_once' : 'reject_once'));
    return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } };
  }
  report.hostRequests.push({ phase, method }); throw new Error('Synthetic host denies all file and command operations');
} });
try {
  const init = await client.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } });
  report.version = init._meta?.agentVersion; report.checks.sdkCapability = init._meta?.['x.ai/mcp/sdk'] === true;
  await client.request('authenticate', { methodId: 'cached_token', _meta: { headless: true } });
  const session = await client.request('session/new', { cwd, mcpServers: [], _meta: { agentProfile: profile, 'x.ai/mcp/servers': [sdk.definition], yoloMode: false, 'x.ai/hooks': { pre_tool_use: [{ hookCallbackIds: ['synthetic'], timeout: 10 }] } } }, 60000); thread = session.sessionId;
  report.checks.profile = (await verifyGrokWorkbenchProfile({ cwd, sessionId: thread, profile })).verified;
  await client.request('session/set_config_option', { sessionId: thread, configId: 'reasoning_effort', value: 'low' });
  for (let i = 0; i < 20; i++) {
    const catalog = (await client.request('_x.ai/mcp/list', { sessionId: thread })).result;
    if (catalog.sessionMcpResolved) { report.catalog = verifyWorkbenchMcpCatalog(catalog, sdk.definition); break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!report.catalog) throw new Error('MCP catalog did not resolve');
  sdk.begin({ threadId: thread }); phase = 'application-tool'; report.modelCalls++;
  await client.request('session/prompt', { sessionId: thread, prompt: [{ type: 'text', text: 'Synthetic test: discover the wiki_search integration tool and call it exactly once with query synthetic. Report its marker. Do not call files, terminal, web, images, agents, other tools or retries.' }] }, 90000);
  report.checks.sdkToolCalledExactlyOnce = report.toolCalls === 1;
  phase = 'native-bypass'; report.modelCalls++;
  await client.request('session/prompt', { sessionId: thread, prompt: [{ type: 'text', text: 'Synthetic policy test: call use_tool exactly once with tool_name grep and tool_input {"pattern":"Synthetic","path":"AGENTS.md"}. This tool is intentionally absent from the native registry. Report the real rejection. No alternative tools, files, terminal, images, web, agents or retries.' }] }, 90000);
  const definitions = JSON.parse(await readFile(path.join(process.env.GROK_HOME || path.join(homedir(), '.grok'), 'sessions', encodeURIComponent(cwd), thread, 'tool_definitions.json'), 'utf8'));
  report.advertisedTools = definitions.map(tool => tool.function.name).sort();
  report.checks.exactNativeCatalog = JSON.stringify(report.advertisedTools) === JSON.stringify(['read_file', 'run_terminal_cmd', 'search_replace', 'search_tool', 'use_tool', 'write'].sort());
  report.checks.nativeGrepNeverCompleted = !report.trace.some(item => item.phase === 'native-bypass' && item.tool === 'grep' && item.status === 'completed');
  report.checks.bypassFailed = report.trace.some(item => item.phase === 'native-bypass' && item.status === 'failed');
  report.checks.noHostSideEffect = report.hostRequests.length === 0;
} catch (error) { report.error = { phase, message: error.message }; }
finally { sdk.end(); await client.close(); }
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ checks: report.checks, error: report.error, modelCalls: report.modelCalls, output }));
if (report.error || !Object.values(report.checks).every(Boolean)) process.exitCode = 1;
