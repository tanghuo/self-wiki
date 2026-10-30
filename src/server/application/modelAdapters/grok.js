import { callRestrictedGrok, grokBuildImageExecutor } from '../executorsPort.js';
import { grokBuildConfig, grokAspectRatios } from '../../../shared/domain/imageGeneration.js';
import { workflowError } from '../../../shared/domain/workflow/contracts.js';
import { workflowAgentTools } from '../../../shared/domain/agentWorkbench/workflow.js';
export const callWorkflowModel = callRestrictedGrok;

const base = { version: 1, maxImages: 8, formats: ['image/png', 'image/jpeg', 'image/webp'], cancel: true,
  inputs: () => ({ prompt: 'text', images: 'list<image>' }), resource: () => 'grok',
  confirmedFailure: (error) => /Grok 图片工具执行失败|受限模型节点拒绝工具|无法启动 Grok/.test(error.message),
  validateInput(_snapshot, values) { if (!values.prompt?.trim() || values.prompt.length > 12000) throw workflowError('提示词须为 1–12000 字符'); },
};
function settings(config, saved, allowed) {
  const parameters = config.parameters || {};
  // Legacy definitions may contain an override. New editors expose task parameters only.
  if (Object.keys(parameters).some((key) => !allowed.includes(key)) || Object.values(parameters).some((v) => typeof v !== 'string' || v.length > 240)) throw workflowError('不支持的适配器参数');
  const result = { executable: saved?.executable || 'grok', model: parameters.model || saved?.model || '', aspectRatio: parameters.aspectRatio || saved?.aspectRatio || 'auto', ...(parameters.effort && { effort: parameters.effort }) };
  if (!result.model) throw workflowError('请先在适配器设置中配置模型');
  const { effort, ...imageSettings } = result;
  grokBuildConfig(imageSettings);
  if (allowed.includes('effort')) {
    result.effort = effort || 'low';
    if (!['low', 'medium', 'high', 'xhigh'].includes(result.effort)) throw workflowError('不支持的 Grok 推理强度');
  }
  return result;
}
const effortFields = [{ name: 'effort', label: '推理强度（默认 low）', type: 'select', options: ['low', 'medium', 'high', 'xhigh'], optional: true }];
export const grokTextAdapter = { ...base, id: 'grok-text', label: 'Grok 文字', nodeType: 'model', outputTypes: ['text', 'json'], parameterFields: effortFields,
  snapshot: (config, server) => ({ settings: settings(config, server.chat?.grokBuild, ['model', 'effort']) }),
  model: callWorkflowModel,
};
export const grokAgentAdapter = { ...base, id: 'grok-agent', label: 'Grok 受限 Agent', nodeType: 'agent', outputTypes: ['text', 'json'], parameterFields: effortFields, defaults: { adapterConfig: { tools: ['wiki_search', 'wiki_read'] } },
  snapshot(config, server) {
    const tools = config.adapterConfig?.tools;
    if (!Array.isArray(tools) || tools.length > workflowAgentTools.length || tools.some(name => !workflowAgentTools.includes(name))) throw workflowError('请选择受限 Agent 的应用工具');
    return { settings: settings(config, server.chat?.grokBuild, ['model', 'effort']), allowedTools: [...new Set(tools)] };
  },
};
export const grokImageAdapter = { ...base, id: 'grok-build', label: 'Grok 生图', nodeType: 'image.generate', outputTypes: ['list<image>'],
  parameterFields: [{ name: 'aspectRatio', label: '图片比例', type: 'select', options: grokAspectRatios, optional: true }],
  snapshot: (config, server) => ({ settings: settings(config, server.imageGeneration?.grokBuild, ['aspectRatio']) }),
  generate: (snapshot, value, options) => grokBuildImageExecutor.generate({ prompt: value.prompt, referencePaths: value.images, aspectRatio: snapshot.settings.aspectRatio }, { ...options, config: snapshot.settings }),
};
