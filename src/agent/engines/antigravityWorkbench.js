import { createAcpWorkbenchEvents } from './acpWorkbenchEvents.js';
import { randomUUID } from 'node:crypto';
import { startAntigravityAcp, antigravityVersion } from '../executors/antigravityProcess.js';
import { acquireExternalResource } from '../executors/resourceGate.js';

function options(config) {
  return (config?.options || []).flatMap(option => Array.isArray(option.options) ? option.options : [option]);
}
export function antigravityModels(session) {
  const selector = session.configOptions?.find(option => option.id === 'model');
  const entries = selector ? options(selector).map(option => ({ id: option.value, label: option.name || option.value }))
    : (session.models?.availableModels || []).map(option => ({ id: option.modelId, label: option.name || option.modelId }));
  const seen = new Set();
  const models = entries.filter(option => typeof option.id === 'string' && option.id && option.id.length <= 120 && !seen.has(option.id) && seen.add(option.id)).slice(0, 100);
  if (!models.length) throw new Error('Antigravity 未返回可用模型，请检查账号权限');
  const current = selector?.currentValue || session.models?.currentModelId;
  return { models, defaultModel: models.some(model => model.id === current) ? current : models[0].id };
}
async function initialize(client) {
  const init = await client.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'self-wiki-workbench', version: '1' } });
  if (init.protocolVersion !== 1 || init.agentInfo?.name !== 'antigravity-acp' || init.agentInfo.version !== antigravityVersion) throw new Error(`Antigravity ACP 版本未验证，请使用 ${antigravityVersion}`);
  return init;
}
export async function describeAntigravityWorkbench(settings = {}, { cwd, signal, authenticate = false } = {}) {
  const release = await acquireExternalResource('antigravity', signal);
  let client;
  try {
    client = await startAntigravityAcp(settings, { cwd, signal });
    const init = await initialize(client);
    if (authenticate) {
      if (!init.authMethods?.some(method => method.id === 'oauth-personal')) throw new Error('此 Antigravity 不支持个人 Google 账号认证');
      await client.request('authenticate', { methodId: 'oauth-personal' }, 180000);
    }
    return antigravityModels(await client.request('session/new', { cwd, mcpServers: [] }, 60000));
  } finally { await client?.close(); release(); }
}

export async function openAntigravityWorkbench(settings, { cwd, neutralCwd, sessionId, signal, onRequest, onEvent, onExit, restricted = false, approvalMode = 'ask', tools = [] }) {
  if (restricted || tools.length) throw new Error('Antigravity 暂不支持受限工作流或工作台应用工具');
  if (approvalMode !== 'ask') throw new Error('Antigravity 当前仅支持手动审批');
  let client, thread, prompting = false, closed = false;
  const emitUpdate = createAcpWorkbenchEvents(onEvent);
  const calls = new Map();
  try {
    client = await startAntigravityAcp(settings, { cwd: neutralCwd, signal, onExit,
      async onNotification(method, params) {
        if (!prompting || closed || params.sessionId !== thread || method !== 'session/update') return;
        const value = params.update || {};
        if (['agent_message_chunk', 'plan'].includes(value.sessionUpdate)) return emitUpdate(value);
        if (value.sessionUpdate === 'config_option_update') {
          for (const option of value.configOptions || []) {
            if (option.id === 'mode' && option.currentValue !== 'default' || option.id === 'model' && option.currentValue !== settings.model) throw new Error('Antigravity 在执行中切换了模型或审批模式，请核查结果');
          }
        }
        if (['tool_call', 'tool_call_update'].includes(value.sessionUpdate)) {
          const previous = calls.get(value.toolCallId), diffs = previous?.diffs || new Map();
          for (const item of value.content || []) if (item.type === 'diff' && typeof item.path === 'string' && typeof item.newText === 'string') diffs.set(item.path, item);
          const call = { ...previous, ...value, diffs }; calls.set(value.toolCallId, call);
          await emitUpdate(call);
          if (value.status === 'completed') {
            for (const item of diffs.values()) {
              // Provider-native changes are viewable, with no complete byte history for undo.
              await onEvent('file.native_diff', { namespace: 'antigravity', status: 'completed', changes: [{ path: item.path, before: item.oldText ?? '', after: item.newText }] });
            }
            if (call.kind === 'execute') {
              const output = (call.content || []).filter(item => item.type === 'content' && item.content?.type === 'text').map(item => item.content.text).join('\n');
              if (output) await onEvent('command.completed', { toolCallId: call.toolCallId, commandId: randomUUID(), namespace: 'antigravity', output: output.slice(-1024 * 1024), exitCode: null, truncated: Buffer.byteLength(output) > 1024 * 1024 });
            }
          }
        }
      },
      async onRequest(method, params) {
        if (!prompting || closed || params.sessionId !== thread || method !== 'session/request_permission') throw new Error('Antigravity 请求不属于活动轮次或不受支持');
        const allow = params.options?.find(option => option.kind === 'allow_once');
        const reject = params.options?.find(option => option.kind === 'reject_once');
        if (!allow) return { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } };
        const approved = await onRequest('engine/antigravity_approval', { toolCall: params.toolCall });
        const option = approved && prompting && !closed ? allow : reject;
        return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } };
      },
    });
    const init = await initialize(client);
    if (sessionId && init.agentCapabilities?.loadSession !== true) throw new Error('Antigravity 未声明支持会话恢复');
    const response = await client.request(sessionId ? 'session/load' : 'session/new', { cwd, mcpServers: [], ...(sessionId && { sessionId }) }, 60000);
    thread = sessionId || response.sessionId;
    if (typeof thread !== 'string' || !thread || response.sessionId && response.sessionId !== thread) throw new Error('Antigravity 返回的会话不匹配');
    const catalog = antigravityModels(response);
    if (!catalog.models.some(model => model.id === settings.model)) throw new Error('所选 Antigravity 模型不在当前账号的可用列表中');
    const configuredModel = await client.request('session/set_config_option', { sessionId: thread, configId: 'model', value: settings.model });
    if (configuredModel.configOptions?.find(option => option.id === 'model')?.currentValue !== settings.model) throw new Error('Antigravity 未采用所选模型');
    let effort;
    if (settings.effort) {
      const selector = configuredModel.configOptions?.find(option => option.id === 'thinking_level');
      if (!options(selector).some(option => option.value === settings.effort)) throw new Error('所选 Antigravity 模型不支持此推理强度');
      const configuredEffort = await client.request('session/set_config_option', { sessionId: thread, configId: 'thinking_level', value: settings.effort });
      effort = configuredEffort.configOptions?.find(option => option.id === 'thinking_level')?.currentValue;
      if (effort !== settings.effort) throw new Error('Antigravity 未采用所选推理强度');
    }
    const configuredMode = await client.request('session/set_config_option', { sessionId: thread, configId: 'mode', value: 'default' });
    if (configuredMode.configOptions?.find(option => option.id === 'mode')?.currentValue !== 'default'
      || configuredMode.configOptions?.find(option => option.id === 'model')?.currentValue !== settings.model
      || effort && configuredMode.configOptions?.find(option => option.id === 'thinking_level')?.currentValue !== effort) throw new Error('Antigravity 未确认所选模型、推理强度和手动审批模式');
    return {
      sessionId: thread, version: `antigravity-acp ${init.agentInfo.version}`,
      capabilities: { verified: true, approvalMode: 'ask', approval: 'native', fileReads: 'native', osSandbox: false, applicationTools: false, resume: true, images: init.agentCapabilities?.promptCapabilities?.image === true, model: settings.model, effort: effort || 'model_default' },
      async prompt(text, onDelivery = () => {}, images = []) {
        if (closed || prompting) throw new Error('Antigravity 会话不可发送');
        if (images.length && init.agentCapabilities?.promptCapabilities?.image !== true) throw new Error('此 Antigravity 不支持图片输入');
        await onEvent('resource.queued', {});
        const release = await acquireExternalResource('antigravity', signal);
        try {
          await onEvent('resource.acquired', {}); signal?.throwIfAborted();
          prompting = true; calls.clear(); onDelivery('attempted');
          const result = await client.request('session/prompt', { sessionId: thread, prompt: [{ type: 'text', text }, ...images] }, 30 * 60 * 1000);
          if (!['end_turn', 'cancelled'].includes(result.stopReason)) throw new Error(`Antigravity 轮次未正常结束：${result.stopReason}`);
          return result;
        } finally { prompting = false; release(); }
      },
      cancel() { client.notify('session/cancel', { sessionId: thread }); },
      async close() { closed = true; await client.close(); },
    };
  } catch (error) { await client?.close(); throw error; }
}
