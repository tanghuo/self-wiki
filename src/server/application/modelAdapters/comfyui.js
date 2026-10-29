import { comfyuiImageExecutor, recoverComfyuiImage, listComfyuiWorkflows, loadComfyuiWorkflow } from '../executorsPort.js';
import { comfyuiConfig, configuredComfyuiWorkflow } from '../../../shared/domain/comfyui.js';
import { workflowError } from '../../../shared/domain/workflow/contracts.js';

const mappingFor = (config) => config.adapterConfig || config.comfyui || {};
export const comfyuiAdapter = {
  id: 'comfyui', label: 'ComfyUI', version: 1, nodeType: 'image.generate', maxImages: 8, formats: ['image/png', 'image/jpeg', 'image/webp'], outputTypes: ['list<image>'], parameterFields: [], cancel: true,
  configurationEditor: 'comfyui', legacyConfigKeys: ['comfyui'],
  legacyConfigurationRoutes: { '/api/workflows/comfyui/workflows': 'workflows', '/api/workflows/comfyui/workflows/load': 'load' },
  defaults: { adapterConfig: { workflow: null, prompt: null, outputNodeId: '', promptMode: 'input', imageInputs: [] } },
  normalize(config) { const { comfyui, ...rest } = config; return { ...rest, ...(comfyui && !rest.adapterConfig && { adapterConfig: comfyui }) }; },
  inputs: (config) => mappingFor(config).promptMode === 'workflow' ? { images: 'list<image>' } : { prompt: 'text', images: 'list<image>' },
  snapshot(config, server, node) {
    if (Object.keys(config.parameters || {}).length) throw workflowError('此适配器不接受额外参数');
    const saved = server.imageGeneration?.comfyui || {}, { promptMode, ...mapping } = mappingFor(config);
    if (promptMode !== undefined && !['input', 'workflow'].includes(promptMode)) throw workflowError('请选择提示词来源');
    if (Object.keys(mapping).some((key) => !['workflow', 'workflowName', 'prompt', 'outputNodeId', 'imageInputs'].includes(key))) throw workflowError('适配器连接地址来自本机设置，节点仅保存任务配置');
    const settings = comfyuiConfig({ ...saved, ...mapping, baseUrl: saved.baseUrl });
    const graph = configuredComfyuiWorkflow(settings, { requirePrompt: promptMode !== 'workflow' });
    if (node.inputs?.images && !(node.inputs.images.kind === 'constant' && Array.isArray(node.inputs.images.value) && !node.inputs.images.value.length) && (settings.imageInputs !== undefined ? settings.imageInputs.length === 0 : Object.values(graph).filter((n) => n.class_type === 'LoadImage').length !== 1)) throw workflowError('请为参考图选择明确的 LoadImage 映射');
    return { settings, promptMode: promptMode || 'input' };
  },
  resource: (snapshot) => 'comfyui:' + new URL(snapshot.settings.baseUrl).origin,
  validateInput(snapshot, values) { if ((snapshot.promptMode !== 'workflow' && !values.prompt?.trim()) || (values.prompt || '').length > 12000) throw workflowError('提示词须为 1–12000 字符'); },
  confirmedFailure: (error) => /ComfyUI 执行失败/.test(error.message),
  generate: (snapshot, value, options) => comfyuiImageExecutor.generate({ prompt: snapshot.promptMode === 'workflow' ? '' : value.prompt, referencePaths: value.images }, { ...options, multiple: true, config: snapshot.settings }),
  recoveryTicket(attempt) {
    const data = attempt?.data?.comfyui;
    if (data?.sequence) return { count: data.sequence.count, promptIds: data.sequence.requests.map((request) => request.promptId || request.requestedPromptId) };
    return data?.promptId || null;
  },
  recover: (snapshot, ticket, options) => recoverComfyuiImage(snapshot.settings, ticket, { ...options, multiple: true }),
  configuration: {
    workflows: { method: 'GET', execute: (server) => listComfyuiWorkflows(server.imageGeneration?.comfyui || {}) },
    load: { method: 'POST', execute: (server, payload) => loadComfyuiWorkflow(server.imageGeneration?.comfyui || {}, payload) },
  },
};
