import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startGrokAcp, grokCommand } from '../executors/grokProcess.js';
import { acquireExternalResource } from '../executors/resourceGate.js';
import { childEnvironment } from '../../shared/runtime/childEnvironment.js';
import { grokWorkbenchProfile, verifyGrokWorkbenchProfile } from './grokWorkbenchProfile.js';
import { createGrokSdkTools } from './grokSdkTools.js';
import { verifyWorkbenchMcpCatalog } from './grokMcpPolicy.js';
import { randomUUID } from 'node:crypto';

export async function openGrokWorkbench(settings, { cwd, neutralCwd, sessionId, signal, onRequest, onEvent, onExit, restricted = false, tools = [], onToolCall, onPolicyViolation = () => {} }) {
  const command = await grokCommand(settings.executable);
  const version = (await promisify(execFile)(command.executable, [...command.prefix, '--version'], { windowsHide: true, env: childEnvironment(), timeout: 10000 })).stdout.trim();
  if (!/^grok 1\.0\.70 \(f50904eaee6c\)/.test(version)) throw new Error('此 Grok 版本尚未通过工作台能力验证，请使用已验证的 1.0.70 (f50904eaee6c)');
  const applicationTools = tools.length > 0;
  const profile = grokWorkbenchProfile({ restricted, applicationTools });
  const sdk = applicationTools ? createGrokSdkTools(tools, onToolCall) : null;
  let client, thread, prompting = false, closed = false;
  try {
    client = await startGrokAcp(settings, { cwd: neutralCwd, signal, onExit, onNotification(method, params) {
      if (!prompting || params.sessionId !== thread || method !== 'session/update') return;
      const value = params.update || {};
      if (value.sessionUpdate === 'agent_message_chunk' && value.content?.type === 'text') return onEvent('message.delta', { text: value.content.text });
      if (value.sessionUpdate === 'plan') return onEvent('plan.updated', { entries: value.entries });
      if (['tool_call', 'tool_call_update'].includes(value.sessionUpdate)) return onEvent('tool.updated', { id: value.toolCallId, title: value.title, status: value.status, kind: value.kind, content: value.content });
      return onEvent('engine.extension', { namespace: 'grok', type: String(value.sessionUpdate || '').slice(0, 100) });
    }, async onRequest(method, params) {
      if (sdk && method.replace(/^_/, '') === 'x.ai/mcp/sdk_call') return sdk.request(params);
      if (!thread || params.sessionId !== thread || closed) throw new Error('工作台会话已失效');
      if (sdk && method === 'session/request_permission') {
        const call = params.toolCall || {}, name = call._meta?.['x.ai/tool']?.name || call.toolName;
        const target = call.rawInput?.tool_name;
        const own = tools.some(tool => target === `${sdk.definition.name}__${tool.name}` || name === `${sdk.definition.name}__${tool.name}`);
        if (name === 'use_tool' || typeof name === 'string' && name.includes('__')) {
          const option = params.options?.find(option => option.kind === (own ? 'allow_once' : 'reject_once'));
          return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } };
        }
      }
      if (method.replace(/^_/, '') === 'x.ai/hooks/run') {
        // Independent fs/terminal authorization remains required even when a
        // hook fails open. Native paid tools, search, discovery and agents are
        // absent from the verified explicit profile, rather than hook-only denied.
        const name = params.toolName || params.tool_name;
        const target = (params.toolInput || params.tool_input || {}).tool_name;
        const appTool = sdk && (name === 'search_tool' || name === 'use_tool' && typeof target === 'string' && tools.some(tool => target === `${sdk.definition.name}__${tool.name}`) || tools.some(tool => name === `${sdk.definition.name}__${tool.name}`));
        if (restricted && !appTool) onPolicyViolation(name);
        return { decision: !restricted && ['read_file', 'search_replace', 'write', 'run_terminal_cmd'].includes(name) || appTool ? 'continue' : 'deny', reason: '只允许已验证的客户端宿主与本应用工具' };
      }
      return onRequest(method, params);
    } });
    const init = await client.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: !restricted, writeTextFile: !restricted }, terminal: !restricted }, clientInfo: { name: 'self-wiki-workbench', version: '1' } });
    if (sdk && init._meta?.['x.ai/mcp/sdk'] !== true) throw new Error('此 Grok 不支持无令牌的本机应用工具通道');
    if (!init.authMethods?.some(method => method.id === 'cached_token')) throw new Error('请先在本机登录 Grok');
    await client.request('authenticate', { methodId: 'cached_token', _meta: { headless: true } });
    const meta = { agentProfile: profile, yoloMode: false, autoMode: false, ...(sdk && { 'x.ai/mcp/servers': [sdk.definition] }), 'x.ai/hooks': { pre_tool_use: [{ hookCallbackIds: ['workbench-policy-v1'], timeout: 30 }] } };
    const response = await client.request(sessionId ? 'session/load' : 'session/new', { ...(sessionId && { sessionId }), cwd, mcpServers: [], _meta: meta }, 60000);
    thread = sessionId || response.sessionId;
    const verification = await verifyGrokWorkbenchProfile({ cwd, sessionId: thread, profile });
    async function verifyTools() {
      const response = await client.request('_x.ai/mcp/list', { sessionId: thread }, 10000);
      const catalog = response.result || response;
      const verified = verifyWorkbenchMcpCatalog(catalog, sdk?.definition);
      if (sdk && !sdk.initialized) throw new Error('工作台应用工具握手尚未完成');
      return verified;
    }
    {
      let lastError;
      for (let i = 0; i < 20; i++) {
        try { await verifyTools(); lastError = undefined; break; }
        catch (error) { lastError = error; if (/其他 MCP/.test(error.message)) throw error; await new Promise(resolve => setTimeout(resolve, 200)); }
      }
      if (lastError) throw lastError;
    }
    if (settings.effort) await client.request('session/set_config_option', { sessionId: thread, configId: 'reasoning_effort', value: settings.effort });
    return {
      sessionId: thread, version, capabilities: { clientFiles: !restricted, clientTerminal: !restricted, images: init.agentCapabilities?.promptCapabilities?.image === true, approval: 'host', osSandbox: false, restricted, applicationTools, ...verification },
      async prompt(text, onDelivery = () => {}, images = []) {
        if (images.length && init.agentCapabilities?.promptCapabilities?.image !== true) throw new Error('此引擎未声明支持图片输入');
        const release = await acquireExternalResource('grok', signal);
        try {
          signal?.throwIfAborted(); await verifyTools(); prompting = true; sdk?.begin({ sessionId: thread, turnId: randomUUID() }); onDelivery('attempted');
          const result = await client.request('session/prompt', { sessionId: thread, prompt: [{ type: 'text', text }, ...images] }, 30 * 60 * 1000);
          if (restricted && !applicationTools) await verifyGrokWorkbenchProfile({ cwd, sessionId: thread, profile, requireEmptyTools: true });
          return result;
        } finally { prompting = false; sdk?.end(); release(); }
      },
      cancel() { client.notify('session/cancel', { sessionId: thread }); },
      async close() { closed = true; sdk?.end(); await client.close(); },
    };
  } catch (error) { await client?.close(); throw error; }
}
