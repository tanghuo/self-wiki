import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { startGrokAcp, grokCommand } from '../src/agent/executors/grokProcess.js';
import { childEnvironment } from '../src/shared/runtime/childEnvironment.js';
import { grokWorkbenchProfile, verifyGrokWorkbenchProfile } from '../src/agent/engines/grokWorkbenchProfile.js';

if (!process.argv.includes('--live')) throw new Error('--live required');
const output = process.argv[process.argv.indexOf('--output') + 1];
if (!output || output.startsWith('--')) throw new Error('--output required');
const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-agent-boundary-'));
const neutral = path.join(root, 'neutral'), project = path.join(root, 'project');
await mkdir(neutral); await mkdir(path.join(project, '.grok'), { recursive: true });
await promisify(execFile)('git', ['init', '--quiet'], { cwd: project, windowsHide: true, env: childEnvironment() });
await writeFile(path.join(project, 'AGENTS.md'), 'Synthetic test project only. Never browse or generate images.\n');
const sentinel = path.join(root, 'mcp-started.txt'), script = path.join(root, 'sentinel.mjs');
await writeFile(script, `import fs from 'node:fs'; import readline from 'node:readline';fs.appendFileSync(${JSON.stringify(sentinel)},'started\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'sentinel',version:'1'}}:{tools:[]}})+'\\n')});`);
await writeFile(path.join(project, '.grok/config.toml'), `[mcp_servers.p0_sentinel]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(script)}]\nenabled=true\nstartup_timeout_sec=3\n`);
const command = await grokCommand();
const version = (await promisify(execFile)(command.executable, ['--version'], { windowsHide: true, env: childEnvironment() })).stdout.trim();
const profile = grokWorkbenchProfile();
const report = { version, root, checks: {}, trace: [], modelCalls: 0, paidImageCalls: 0, denyRules: ['Grep', 'Glob'], profile };
let client, sessionId, phase = 'neutral-initialize', outputText = '', hookMode = 'error';
const started = async () => Boolean(await stat(sentinel).catch(() => null));
async function connect(cwd) {
  client = await startGrokAcp({ model: 'grok-4.6', denyRules: report.denyRules }, { cwd,
    onNotification(method, params) {
      if (method === 'session/update') {
        if (params.update?.content?.type === 'text') outputText = (outputText + params.update.content.text).slice(-10000);
        if (params.update?.sessionUpdate?.startsWith('tool_call')) report.trace.push({ phase, event: params.update.sessionUpdate, tool: params.update._meta?.['x.ai/tool']?.name, status: params.update.status });
      }
    }, onRequest(method, params) {
      report.trace.push({ phase, method, tool: params.toolName || params.tool_name });
      if (method.includes('hooks/run')) { if (hookMode === 'error') throw new Error('synthetic hook failure'); return { decision: 'deny', reason: 'synthetic probe denies all native tools' }; }
      if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } };
      throw new Error('Synthetic probe refuses host operation');
    },
  });
  const init = await client.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } });
  await client.request('authenticate', { methodId: 'cached_token', _meta: { headless: true } });
  return init;
}
try {
  await connect(neutral);
  report.checks.neutralInitDoesNotStartProjectMcp = !await started();
  phase = 'trusted-project-new';
  const session = await client.request('session/new', { cwd: project, mcpServers: [], _meta: { agentProfile: profile, yoloMode: false, autoMode: false, 'x.ai/hooks': { pre_tool_use: [{ hookCallbackIds: ['boundary-probe'], timeout: 1 }] } } }, 30000);
  report.sessionMeta = session._meta;
  sessionId = session.sessionId;
  report.profileVerification = await verifyGrokWorkbenchProfile({ cwd: project, sessionId, profile });
  report.checks.profileVerifiedBeforePrompt = report.profileVerification.verified;
  report.checks.projectMcpStartedOnNew = await started();
  await client.request('session/set_config_option', { sessionId, configId: 'reasoning_effort', value: 'low' });
  phase = 'denied-search'; report.modelCalls++;
  await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Synthetic probe: explicitly try the native grep content-search tool to search ONLY AGENTS.md in this synthetic cwd for Synthetic. Do not use terminal, read_file, MCP, web or any alternate tool if rejected. Report the actual rejection.' }] }, 90000);
  report.checks.nativeSearchNotExecuted = !report.trace.some(event => event.tool === 'grep' || event.tool === 'search_tool' || event.tool === 'use_tool');
  report.checks.fallbackHostRefused = report.trace.some(event => event.method === 'terminal/create' || event.method === 'session/request_permission');
  const definitionsFile = path.join(process.env.GROK_HOME || path.join(os.homedir(), '.grok'), 'sessions', encodeURIComponent(project), sessionId, 'tool_definitions.json');
  report.advertisedTools = JSON.parse(await readFile(definitionsFile, 'utf8')).map(tool => tool.function.name).sort();
  report.checks.exactNativeCatalog = JSON.stringify(report.advertisedTools) === JSON.stringify(['read_file', 'run_terminal_cmd', 'search_replace', 'write'].sort());
  phase = 'normal-cancel'; outputText = ''; report.modelCalls++;
  const prompt = client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Without tools, produce a long numbered list of 1000 arithmetic facts. This is a synthetic cancellation probe.' }] }, 30000);
  const cancelTimer = setTimeout(() => client.notify('session/cancel', { sessionId }), 500);
  try { report.cancelResult = await prompt; report.checks.cancelAcknowledged = report.cancelResult.stopReason === 'cancelled'; } finally { clearTimeout(cancelTimer); }
  await client.close();
  phase = 'project-initialize'; await connect(project);
  report.checks.projectMcpAtProcessStart = await started();
  phase = 'profile-load';
  await client.request('session/load', { sessionId, cwd: project, mcpServers: [], _meta: { agentProfile: profile, yoloMode: false } });
  report.checks.profilePreservedOnLoad = (await verifyGrokWorkbenchProfile({ cwd: project, sessionId, profile })).verified;
} catch (error) { report.error = { phase, category: /超时/.test(error.message) ? 'timeout' : 'protocol-or-process-error' }; }
finally { await client?.close(); }
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ checks: report.checks, error: report.error, modelCalls: report.modelCalls, output }));
