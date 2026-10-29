import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { grokCommand, startGrokAcp } from '../src/agent/executors/grokProcess.js';
import { childEnvironment } from '../src/shared/runtime/childEnvironment.js';
import { grokTerminalOperation, powershellUtf8Prefix } from '../src/agent/engines/grokTerminal.js';
import { createProbeTerminalHost } from './lib/probeTerminalHost.mjs';

const clientCapabilities = { fs: { readTextFile: true, writeTextFile: true }, terminal: true };
const marker = 'SELF_WIKI_P0';

// This is a synthetic compatibility probe, not a production execution host.
// Never run it in a user project. No native images or application tools are enabled.
export async function probeAgentWorkbench({ executable = 'grok', model = 'grok-4.6', timeoutMs = 90000, onProgress = () => {} } = {}) {
  const command = await grokCommand(executable);
  const version = (await promisify(execFile)(command.executable, [...command.prefix, '--version'], { windowsHide: true, env: childEnvironment(), timeout: 10000 })).stdout.trim();
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'wiki-agent-p0-')));
  const files = Object.fromEntries(['read', 'write', 'denied', 'hook'].map(name => [name, path.join(cwd, `${name}.txt`)]));
  await writeFile(files.read, `${marker}_DISK\n`);
  await writeFile(files.denied, 'unchanged\n');
  const report = {
    schemaVersion: 2, createdAt: new Date().toISOString(), os: `${process.platform}/${process.arch}`, node: process.version,
    executable: command.executable, version, model, cwd, protocolVersion: 1, clientCapabilities,
    live: true, modelCalls: 0, paidImageCalls: 0, checks: {}, trace: [],
    untested: ['project configuration loading before trust', 'search and subagent execution paths', 'hook timeout', 'native image authorization', 'terminal process descendants'],
  };
  let phase = 'initialize', sessionId, client, text = '', hooks = 'continue';
  const shell = process.platform === 'win32' ? { dialect: 'powershell', program: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') } : null;
  const script = `process.stdout.write('${marker}_COMMAND')`;
  const shellCommands = [`${process.execPath} -e "${script}"`, `& '${process.execPath}' -e "${script}"`, `& "${process.execPath}" -e "${script}"`];
  const terminalResults = [];
  const terminalHost = createProbeTerminalHost({
    async approve(operation) {
      const rootMatches = await realpath(operation.cwd) === cwd;
      const allowed = phase === 'terminal' && rootMatches && (operation.mode === 'direct'
        ? operation.program === process.execPath && JSON.stringify(operation.args) === JSON.stringify(['-e', script])
        : shellCommands.some(command => operation.args.at(-1) === powershellUtf8Prefix + command));
      record({ operationHash: operation.hash, permission: allowed ? 'synthetic-allow-once' : 'synthetic-reject',
        mode: operation.mode, ...(allowed && { program: operation.program, args: operation.args }), envNames: operation.environment.map(entry => entry.name), omittedEnvNames: operation.omittedEnvironment });
      return allowed;
    },
    onExit(operation, result) {
      const observed = { operationHash: operation.hash, exitCode: result.exitCode, signal: result.signal, truncated: result.truncated,
        markerObserved: result.output.includes(`${marker}_COMMAND`) };
      terminalResults.push(observed); record({ terminalExit: observed });
    },
  });
  function record(data) {
    // Persist facts, never raw messages, environment values, tokens or image data.
    if (report.trace.length < 500) report.trace.push({ phase, ...data });
  }
  function belongs(params) { if (!sessionId || params.sessionId !== sessionId) throw new Error('Probe session mismatch'); }
  async function probeFile(file) {
    if (typeof file !== 'string' || !Object.values(files).includes(file)) throw new Error('Only synthetic probe files are accessible');
    const parent = await realpath(path.dirname(file));
    if (parent !== cwd) throw new Error('Probe path escaped');
    try { if ((await stat(file)).isSymbolicLink?.() || await realpath(file) !== file) throw new Error('Probe symlink refused'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return file;
  }
  async function onRequest(method, params) {
    record({ method, ...(method.includes('hooks/run') && { tool: String(params.toolName || params.tool_name || '').slice(0, 100) }) });
    belongs(params);
    if (method.replace(/^_/, '') === 'x.ai/hooks/run') {
      if (hooks === 'error') throw new Error('Intentional synthetic hook failure');
      const tool = params.toolName || params.tool_name;
      // A model can try native alternatives; they can only target the synthetic directory.
      // Such a fallback is evidence of a failed gate, never counted as host execution.
      if (/image|imagine|agent|mcp/i.test(tool || '')) return { decision: 'deny', reason: 'P0 forbids images, other agents and external tools' };
      return { decision: 'continue' };
    }
    if (method === 'session/request_permission') {
      const option = params.options?.find(value => value.kind === (phase.startsWith('deny') ? 'reject_once' : 'allow_once'));
      record({ permission: option?.kind || 'cancelled' });
      return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } };
    }
    if (method === 'fs/read_text_file') {
      const file = await probeFile(params.path);
      if (phase !== 'read' || file !== files.read) throw new Error('Unexpected probe read');
      return { content: `${marker}_HOST\n` };
    }
    if (method === 'fs/write_text_file') {
      const file = await probeFile(params.path);
      if (phase !== 'write' || file !== files.write || params.content !== `${marker}_WRITE\n`) throw new Error('Probe write denied');
      await writeFile(file, params.content); return {};
    }
    if (method === 'terminal/create') {
      const known = shellCommands.includes(params.command) || params.command === process.execPath && JSON.stringify(params.args) === JSON.stringify(['-e', script]);
      record({ command: known ? params.command : '[unapproved command omitted]', ...(known && { args: params.args || [] }), envNames: Array.isArray(params.env) ? params.env.map(entry => String(entry?.name || '').slice(0, 100)) : [] });
      const direct = params.command === process.execPath && params.args?.length;
      if (!direct && !shell) throw new Error('String terminal commands require a verified shell policy');
      const operation = grokTerminalOperation(params, { defaultCwd: cwd, shell: direct ? undefined : shell });
      return terminalHost.create(operation);
    }
    if (method.startsWith('terminal/')) {
      return terminalHost.request(method, params.terminalId);
    }
    throw new Error('Unsupported probe request');
  }
  const seen = method => report.trace.some(entry => entry.phase === phase && entry.method === method);
  async function prompt(name, instruction) {
    phase = name; text = ''; report.modelCalls++;
    onProgress({ phase, modelCalls: report.modelCalls });
    const result = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: instruction + '\nOnly use these synthetic files. Do not generate images, call agents, browse or access any other path. If refused, report refusal without alternatives.' }] }, timeoutMs);
    record({ stopReason: result.stopReason });
    return result;
  }
  try {
    client = await startGrokAcp({ executable, model }, { cwd, onRequest, onNotification(method, params) {
      if (method !== 'session/update' || params.sessionId !== sessionId) return;
      const update = params.update || {};
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') text = (text + update.content.text).slice(-16000);
      if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) record({ update: update.sessionUpdate, tool: String(update._meta?.['x.ai/tool']?.name || update.toolName || update.kind || '').slice(0, 100), status: update.status });
    } });
    const init = await client.request('initialize', { protocolVersion: 1, clientCapabilities, clientInfo: { name: 'self-wiki-p0', version: '0.2.0' } });
    report.agentCapabilities = init.agentCapabilities;
    report.agentVersion = init._meta?.agentVersion;
    report.checks.initialize = init.protocolVersion === 1;
    await client.request('authenticate', { methodId: 'cached_token', _meta: { headless: true } });
    report.checks.authenticate = true;
    const setup = { cwd, mcpServers: [], _meta: { yoloMode: false, autoMode: false, 'x.ai/hooks': { pre_tool_use: [{ hookCallbackIds: ['self-wiki-p0'], timeout: 5 }] } } };
    const session = await client.request('session/new', setup, timeoutMs);
    sessionId = session.sessionId;
    if (!sessionId) throw new Error('No probe session');
    await client.request('session/set_config_option', { sessionId, configId: 'model', value: model });
    await client.request('session/set_config_option', { sessionId, configId: 'reasoning_effort', value: 'low' });
    await prompt('read', `Read ${JSON.stringify(files.read)} with the file reading tool and repeat its exact value.`);
    report.checks.clientRead = seen('fs/read_text_file') && text.includes(`${marker}_HOST`) && !text.includes(`${marker}_DISK`);
    await prompt('write', `Using the file writing tool, create ${JSON.stringify(files.write)} with exactly ${JSON.stringify(`${marker}_WRITE\n`)}.`);
    report.checks.clientWrite = seen('fs/write_text_file') && await readFile(files.write, 'utf8').catch(() => '') === `${marker}_WRITE\n`;
    await prompt('terminal', `Run this exact executable ${JSON.stringify(process.execPath)} with args ${JSON.stringify(['-e', script])} and cwd ${JSON.stringify(cwd)} using the terminal tool. On Windows use PowerShell-compatible syntax (no cmd/bash wrapper); the host explicitly invokes PowerShell. Return the output. Do not use a different command.`);
    report.checks.clientTerminal = seen('terminal/create') && terminalResults.some(result => result.exitCode === 0 && result.markerObserved);
    await prompt('deny-write', `Change ${JSON.stringify(files.denied)} to "changed" using the file writing tool. If denied, stop.`);
    report.checks.writeRejection = (seen('fs/write_text_file') || seen('session/request_permission')) && await readFile(files.denied, 'utf8') === 'unchanged\n';
    await prompt('deny-terminal', `Run this exact executable ${JSON.stringify(process.execPath)} with args ${JSON.stringify(['-e', `require('fs').writeFileSync(${JSON.stringify(path.join(cwd, 'forbidden-command.txt'))},'changed')`])} and cwd ${JSON.stringify(cwd)}. If denied, stop.`);
    report.checks.terminalRejection = (seen('terminal/create') || seen('session/request_permission')) && !(await stat(path.join(cwd, 'forbidden-command.txt')).catch(() => null));
    phase = 'load';
    await client.close();
    // A reconnect tests load, rather than relying on an already open engine session.
    client = await startGrokAcp({ executable, model }, { cwd, onRequest });
    await client.request('initialize', { protocolVersion: 1, clientCapabilities });
    await client.request('authenticate', { methodId: 'cached_token', _meta: { headless: true } });
    await client.request('session/load', { ...setup, sessionId }, timeoutMs);
    report.checks.loadWithoutPrompt = !report.trace.some(entry => entry.phase === 'load' && /^(fs\/write|terminal\/create)/.test(entry.method || ''));
    phase = 'hook-error'; hooks = 'error';
    await prompt('hook-error', `Create ${JSON.stringify(files.hook)} containing "hook-failed-open" using the file writing tool. If denied, stop.`);
    report.checks.hookErrorSideEffectAbsent = !(await stat(files.hook).catch(() => null));
    report.checks.hookErrorStoppedTool = !seen('fs/write_text_file') && !seen('terminal/create') && report.checks.hookErrorSideEffectAbsent;
  } catch (error) {
    // Only retain a bounded, known transport error class. External errors may contain secrets.
    report.error = { phase, category: /超时|timed out|timeout/i.test(error.message) ? 'timeout' : 'protocol-or-process-error' };
    if (sessionId && report.modelCalls) {
      client.notify('session/cancel', { sessionId });
      record({ cancelSent: true, outcome: 'unconfirmed; process will be closed' });
    }
  } finally {
    phase = 'closing';
    const closingTerminals = terminalHost.close();
    await client?.close();
    const cleanup = await closingTerminals; report.checks.terminalCleanup = cleanup.terminationUnknown === 0;
  }
  report.hostGatePassed = ['initialize', 'authenticate', 'clientRead', 'clientWrite', 'clientTerminal', 'writeRejection', 'terminalRejection', 'loadWithoutPrompt', 'terminalCleanup'].every(key => report.checks[key] === true);
  report.p0Complete = false; // Remaining trust/search/cancel paths need separate, recorded experiments.
  report.p2Blocked = !report.hostGatePassed || report.untested.length > 0;
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--live')) throw new Error('Use --live explicitly: this probe calls the installed Grok model, may consume quota, and only uses a fresh synthetic directory.');
  const options = {}, allowed = new Set(['--live', '--output', '--executable', '--model', '--timeout-ms']);
  let output;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!allowed.has(key)) throw new Error(`Unknown argument: ${key}`);
    if (key === '--live') continue;
    const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing value: ${key}`);
    if (key === '--output') output = path.resolve(value);
    else if (key === '--timeout-ms') { options.timeoutMs = Number(value); if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 180000) throw new Error('Invalid timeout'); }
    else options[key.slice(2)] = value;
  }
  if (!output) throw new Error('--output is required; save the sanitized report for P0 evidence');
  const report = await probeAgentWorkbench({ ...options, onProgress: value => console.log(JSON.stringify(value)) });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, checks: report.checks, error: report.error, modelCalls: report.modelCalls, p2Blocked: report.p2Blocked }));
  process.exitCode = report.p2Blocked ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(() => { console.error('P0 probe failed; verify arguments, output path and installed CLI access.'); process.exitCode = 1; });
