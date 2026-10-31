import { randomUUID } from 'node:crypto';
import { startCodexAppServer } from '../executors/codexAppServer.js';
import { acquireExternalResource } from '../executors/resourceGate.js';

const disabled = ['computer_use', 'browser_use_external', 'code_mode', 'code_mode_only', 'multi_agent_v2', 'goals', 'in_app_local_automation', 'sleep_tool', 'request_permissions_tool', 'unbounded_connection_retries'];
const overrides = () => disabled.map(name => `features.${name}=false`);
const bounded = value => {
  let bytes = Buffer.from(value || '').subarray(-1024 * 1024);
  while (bytes.length && (bytes[0] & 0xc0) === 0x80) bytes = bytes.subarray(1);
  return bytes.toString('utf8');
};
function checkVersion(client) { if (!/\/0\.159\.0\b/.test(client.version)) throw new Error('此 Codex 版本未通过工作台验证，需要 0.159.0'); }
function authMessage(error) { if (error?.code === 'AUTH_REQUIRED') error.message = 'Codex 登录已失效，请先恢复本机登录，再明确继续；本轮不会自动重发。'; return error; }
export function verifyCodexWorkbenchPolicy(result, cwd) {
  if (result.approvalPolicy !== 'untrusted' || result.approvalsReviewer !== 'user' || result.sandbox?.type !== 'readOnly' || result.sandbox.networkAccess !== false || result.cwd?.toLowerCase() !== cwd.toLowerCase()) throw new Error('Codex 未采用所要求的原生只读权限和用户审批，禁止发送任务');
}
async function verifyMcp(client, cwd, threadId) {
  const resolved = await client.request('config/read', { includeLayers: false, cwd });
  for (const feature of ['apps', 'plugins', 'hooks', 'multi_agent', 'image_generation', 'browser_use', 'in_app_browser', ...disabled]) {
    if (resolved.config?.features?.[feature] !== false) throw new Error(`Codex 未确认关闭 ${feature}，禁止发送任务`);
  }
  if (Object.values(resolved.config?.mcp_servers || {}).some(server => server.enabled !== false)) throw new Error('Codex 存在其他已启用 MCP，禁止发送工作台任务');
  let cursor; const seen = new Set();
  do {
    const catalog = await client.request('mcpServerStatus/list', { threadId, limit: 100, ...(cursor && { cursor }) });
    if (!Array.isArray(catalog.data) || catalog.data.some(server => server.runtimeStatus !== 'disabled' || Object.keys(server.tools || {}).length)) throw new Error('Codex MCP 目录未确认全部禁用，禁止发送任务');
    cursor = catalog.nextCursor;
    if (cursor && (seen.has(cursor) || seen.size >= 10)) throw new Error('Codex MCP 目录分页异常');
    if (cursor) seen.add(cursor);
  } while (cursor);
}
export async function describeCodexWorkbench(config, { cwd, signal }) {
  const client = await startCodexAppServer(config, { cwd, signal, workbench: true, configurationOnly: true, configOverrides: overrides(), onNotification() {}, onExit() {}, onToolCall() { throw new Error('No active turn'); } });
  try { checkVersion(client); if (!client.account.account && client.account.requiresOpenaiAuth !== false) throw new Error('请先在本机登录 Codex'); return { models: await client.models(), defaultModel: client.defaultModel, defaultEffort: client.defaultEffort, version: client.version }; }
  finally { await client.close(); }
}
export async function openCodexWorkbench(config, { cwd, neutralCwd, sessionId, signal, onRequest, onEvent, onExit, tools = [], onToolCall }) {
  let client, thread, turn, prompting = false, closed = false, completion, timer;
  let remaining, timerStarted, approvalWaits = 0;
  function armTimer() {
    timerStarted = performance.now();
    timer = setTimeout(() => completion.reject(new Error('Codex 轮次超时，结果可能未知')), remaining);
  }
  const items = new Map(), commands = new Map();
  const live = params => !closed && prompting && params.threadId === thread && typeof turn === 'string' && params.turnId === turn;
  try {
    client = await startCodexAppServer(config, { cwd: neutralCwd, signal, workbench: true, configOverrides: overrides(), onExit(error) { const failure = authMessage(error || new Error('Codex 连接断开')); completion?.reject(failure); onExit(failure); },
      async onToolCall(params) {
        if (!live(params) || params.namespace && params.namespace !== 'self_wiki' || !tools.some(tool => tool.name === params.tool)) throw new Error('工作台工具不属于活动轮次或未声明');
        const value = await onToolCall({ name: params.tool, input: params.arguments, callId: params.callId });
        if (!live(params)) throw new Error('工具结果所属轮次已结束');
        return { success: true, contentItems: value?.content ? [{ type: 'inputText', text: JSON.stringify({ ...value, content: undefined }) }, ...value.content.map(item => item.type === 'image' ? { type: 'inputImage', imageUrl: `data:${item.mimeType};base64,${item.data}` } : { type: 'inputText', text: item.text || '' })] : [{ type: 'inputText', text: JSON.stringify(value) }] };
      },
      async onRequest(method, params) {
        if (!live(params)) throw new Error('Codex 审批不属于活动轮次');
        if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) throw new Error('此工作台不支持额外权限、网络或输入扩权请求');
        const item = items.get(params.itemId);
        if (!item || method.includes('fileChange') && (!Array.isArray(item.changes) || !item.changes.length)) return { decision: 'decline' };
        if (params.networkApprovalContext || params.additionalPermissions || params.grantRoot) return { decision: 'decline' };
        const file = method.includes('fileChange');
        const operation = file ? { kind: 'native.file', itemId: params.itemId, changes: item.changes, reason: params.reason || '' } : { kind: 'native.command', itemId: params.itemId, command: params.command || item.command, cwd: params.cwd || item.cwd, reason: params.reason || '', nativePolicy: 'untrusted / read-only' };
        if (!file && (typeof operation.command !== 'string' || !operation.command.trim() || typeof operation.cwd !== 'string')) return { decision: 'decline' };
        const currentCompletion = completion;
        if (approvalWaits++ === 0) {
          clearTimeout(timer);
          remaining = Math.max(0, remaining - (performance.now() - timerStarted));
        }
        let allowed;
        try { allowed = await onRequest('engine/native_approval', operation); }
        finally {
          if (--approvalWaits === 0 && prompting && !closed && completion === currentCompletion) armTimer();
        }
        const canAccept = !params.availableDecisions || params.availableDecisions.includes('accept');
        return { decision: allowed === true && live(params) && canAccept ? 'accept' : 'decline' };
      },
      async onNotification(method, params) {
        if (!prompting || params.threadId !== thread || closed) return;
        if (method === 'turn/started' && !turn) turn = params.turn.id;
        if (params.turnId && turn && params.turnId !== turn) return;
        if (method === 'item/agentMessage/delta') return onEvent('message.delta', { text: params.delta, messageId: params.itemId, phase: items.get(params.itemId)?.phase });
        if (method === 'turn/plan/updated') return onEvent('plan.updated', { entries: (params.plan || []).map(entry => ({ content: entry.step, status: entry.status })) });
        if (method === 'thread/tokenUsage/updated') return onEvent('engine.usage', { namespace: 'codex', usage: params.tokenUsage });
        if (method === 'turn/diff/updated') return onEvent('engine.diff', { namespace: 'codex', diff: String(params.diff || '').slice(0, 2 * 1024 * 1024), truncated: String(params.diff || '').length > 2 * 1024 * 1024 });
        if (['item/started', 'item/completed'].includes(method) && params.item) {
          const item = params.item; items.set(item.id, item);
          const completed = method === 'item/completed';
          if (item.type === 'commandExecution') {
            if (!commands.has(item.id)) commands.set(item.id, randomUUID());
            if (completed) await onEvent('command.completed', { toolCallId: item.id, commandId: commands.get(item.id), output: bounded(item.aggregatedOutput), exitCode: item.exitCode ?? null, truncated: Buffer.byteLength(item.aggregatedOutput || '') > 1024 * 1024, namespace: 'codex' });
          }
          if (item.type === 'fileChange' && completed) await onEvent('file.native_diff', { changes: item.changes, status: item.status, namespace: 'codex' });
          if (['commandExecution', 'fileChange', 'dynamicToolCall', 'mcpToolCall', 'imageGeneration', 'collabToolCall'].includes(item.type)) await onEvent('tool.updated', { id: item.id, kind: item.type, title: item.type === 'commandExecution' ? item.command : item.type, status: completed ? ['failed', 'declined', 'cancelled'].includes(item.status) ? item.status === 'declined' ? 'failed' : item.status : 'completed' : 'running' });
        }
        if (method === 'error' && !params.willRetry) completion?.reject(new Error(params.error?.message || 'Codex 执行失败'));
        if (method === 'turn/completed' && params.turn.id === turn) {
          if (params.turn.status === 'completed' || params.turn.status === 'interrupted') completion?.resolve({ stopReason: params.turn.status === 'completed' ? 'end_turn' : 'cancelled' });
          else completion?.reject(new Error(params.turn.error?.message || 'Codex 执行失败'));
        }
      },
    });
    checkVersion(client);
    if (!client.account.account && client.account.requiresOpenaiAuth !== false) throw new Error('请先在本机登录 Codex');
    const options = { cwd, sandbox: 'read-only', approvalPolicy: 'untrusted', approvalsReviewer: 'user', runtimeWorkspaceRoots: [cwd], model: config.codexCli.model, config: { 'sandbox_workspace_write.network_access': false }, ...(!sessionId && { allowProviderModelFallback: false }) };
    const result = await client.request(sessionId ? 'thread/resume' : 'thread/start', { ...options, ...(sessionId ? { threadId: sessionId, excludeTurns: true } : { ephemeral: false, dynamicTools: tools.map(tool => ({ type: 'function', ...tool })) }) }, 60000);
    thread = result.thread.id; verifyCodexWorkbenchPolicy(result, cwd);
    if (result.model && result.model !== config.codexCli.model) throw new Error('Codex 返回模型与会话固定模型不一致，禁止静默替换');
    await verifyMcp(client, cwd, thread);
    return {
      sessionId: thread, version: client.version, capabilities: { verified: true, resume: true, clientFiles: false, clientTerminal: false, approval: 'native', fileReads: 'native_full_disk', nativePolicy: result.sandbox, applicationTools: tools.length > 0, images: true },
      async prompt(text, onDelivery = () => {}, images = []) {
        if (prompting || closed) throw new Error('Codex 会话不可发送');
        const release = await acquireExternalResource('codex', signal);
        try {
          signal?.throwIfAborted(); await verifyMcp(client, cwd, thread);
          prompting = true; turn = null; items.clear(); commands.clear(); completion = Promise.withResolvers(); completion.promise.catch(() => {});
          remaining = 30 * 60 * 1000; armTimer();
          onDelivery('attempted');
          const response = await client.request('turn/start', { threadId: thread, model: config.codexCli.model, ...(config.effort && { effort: config.effort }), approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false }, input: [{ type: 'text', text }, ...images.map(image => ({ type: 'image', url: `data:${image.mimeType};base64,${image.data}` }))] }, 60000);
          turn ||= response.turn.id; return await completion.promise;
        } finally { clearTimeout(timer); prompting = false; completion = null; release(); }
      },
      async cancel() { if (prompting && turn) await client.request('turn/interrupt', { threadId: thread, turnId: turn }, 3000).catch(() => {}); },
      async close() { closed = true; completion?.reject(new Error('Codex 会话已关闭，结果可能未知')); await client.close(); },
    };
  } catch (error) { await client?.close(); throw authMessage(error); }
}
