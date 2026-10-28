import { openGrokSession, grokBuildImageExecutor } from '../executorsPort.js';
import { grokBuildConfig, grokAspectRatios } from '../../../shared/domain/imageGeneration.js';
import { workflowError } from '../../../shared/domain/workflow/contracts.js';
export async function callWorkflowModel(snapshot, { prompt, images, workspace, signal, onRequest, onProgress }) {
  let client, text = '', resolve, reject;
  const done = new Promise((a, b) => { resolve = a; reject = b; });
  // A connection may exit during setup, before awaiting the completion promise.
  done.catch(() => {});
  const abort = () => reject(Object.assign(new Error('模型请求被中断，结果可能未知'), { unknown: true }));
  signal.addEventListener('abort', abort, { once: true });
  try {
    client = await openGrokSession({ chat: { grokBuild: snapshot.settings }, imageGeneration: { executor: 'disabled' } }, {
      cwd: workspace, signal, restrictedText: true,
      onEvent(event) {
        if (event.type === 'text-delta') { text += event.text; if (text.length > 2 * 1024 * 1024) reject(new Error('模型输出超过 2 MiB')); }
        if (event.type === 'turn-completed') {
          if (event.state === 'completed') resolve({ text });
          else reject(Object.assign(new Error(event.error || '模型执行失败'), { unknown: /未知/.test(event.error || '') }));
        }
      },
      onToolCall() { throw new Error('工作流模型节点禁止所有工具'); },
      onExit(error) { reject(Object.assign(new Error(error?.message || 'Grok 已退出'), { unknown: true })); },
    });
    const thread = await client.openThread({ model: snapshot.settings.model, instructions: '只根据输入返回文字。所有工具均已禁用。', tools: [], onRequest() {} });
    signal.throwIfAborted();
    await client.startTurn({ threadId: thread.id, model: snapshot.settings.model, effort: snapshot.settings.effort || '', text: prompt,
      attachments: images.map((p) => ({ type: 'localImage', path: p })), onRequest(request) {
        if (typeof request?.params?.threadId === 'string') onProgress?.({ type: 'metadata', metadata: { remoteThreadId: request.params.threadId } });
        onRequest(request);
      } });
    return await done;
  } finally { signal.removeEventListener('abort', abort); await client?.close(); }
}

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
  grokBuildConfig(result); return result;
}
export const grokTextAdapter = { ...base, id: 'grok-text', label: 'Grok 文字', nodeType: 'model', outputTypes: ['text', 'json'], parameterFields: [],
  snapshot: (config, server) => ({ settings: settings(config, server.chat?.grokBuild, ['model', 'effort']) }),
  model: callWorkflowModel,
};
export const grokImageAdapter = { ...base, id: 'grok-build', label: 'Grok 生图', nodeType: 'image.generate', outputTypes: ['list<image>'],
  parameterFields: [{ name: 'aspectRatio', label: '图片比例', type: 'select', options: grokAspectRatios, optional: true }],
  snapshot: (config, server) => ({ settings: settings(config, server.imageGeneration?.grokBuild, ['aspectRatio']) }),
  generate: (snapshot, value, options) => grokBuildImageExecutor.generate({ prompt: value.prompt, referencePaths: value.images, aspectRatio: snapshot.settings.aspectRatio }, { ...options, config: snapshot.settings }),
};
