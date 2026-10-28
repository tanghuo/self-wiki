import { listComfyuiWorkflows, loadComfyuiWorkflow } from "../executorsPort.js";
import { chatImageOptions } from "../../../shared/domain/chatImageOptions.js";
import { comfyuiConfig, configuredComfyuiWorkflow } from "../../../shared/domain/comfyui.js";
import { elementError } from "../../../shared/domain/elements.js";

const publicWorkflow = ({ workflow, ...record }) => record;

export function createChatImageSettings(repo, organization) {
  function preference() {
    return repo.imagePreference() || chatImageOptions({ executor: organization.executionConfig().imageGeneration.executor, direct: false });
  }
  function validate(value, ready = false) {
    const options = chatImageOptions(value);
    if (options.executor !== "comfyui") return options;
    if (!options.workflowId) {
      if (ready || options.prompt || options.outputNodeId || options.parameters.length) throw elementError("请先在会话中选择 ComfyUI 工作流");
      return options;
    }
    const record = repo.imageWorkflow(options.workflowId);
    if (options.prompt && !record.fields.some((field) => field.nodeId === options.prompt.nodeId && field.input === options.prompt.input && field.type === "STRING")) throw elementError("请选择工作流中的提示词文本字段");
    if (options.outputNodeId && !record.outputs.some((output) => output.nodeId === options.outputNodeId)) throw elementError("请选择工作流的图片输出节点");
    for (const parameter of options.parameters) {
      const field = record.fields.find((entry) => entry.nodeId === parameter.nodeId && entry.input === parameter.input), value = parameter.value;
      if (!field || options.prompt?.nodeId === parameter.nodeId && options.prompt.input === parameter.input) throw elementError("不能覆盖连线、提示词映射或不存在的参数");
      if (field.type === "COMBO" ? !field.options.includes(value)
        : field.type === "STRING" ? typeof value !== "string"
        : field.type === "BOOLEAN" ? typeof value !== "boolean"
        : typeof value !== "number" || !Number.isFinite(value) || field.type === "INT" && !Number.isSafeInteger(value)
          || typeof field.min === "number" && value < field.min || typeof field.max === "number" && value > field.max) throw elementError(`工作流参数 ${field.label} 的值无效`);
    }
    if (ready || options.prompt && options.outputNodeId) configuredComfyuiWorkflow({ workflow: record.workflow, prompt: options.prompt, outputNodeId: options.outputNodeId });
    return options;
  }
  return {
    preference, validate,
    setPreference: (value) => repo.setImagePreference(validate(value)),
    list: () => listComfyuiWorkflows(organization.executionConfig().imageGeneration.comfyui),
    get: (id) => publicWorkflow(repo.imageWorkflow(id)),
    async load(value) {
      // Remote I/O completes before inserting the immutable revision.
      const record = await loadComfyuiWorkflow(organization.executionConfig().imageGeneration.comfyui, value);
      return publicWorkflow(repo.cacheImageWorkflow(record));
    },
    configuration(config, value) {
      if (!value) return config; // Existing API clients retain their legacy routing.
      const options = validate(value, true), result = { ...config, executor: options.executor };
      if (options.executor === "grok-build") result.grokBuild = { ...config.grokBuild, aspectRatio: options.aspectRatio };
      if (options.executor !== "comfyui") return result;
      const record = repo.imageWorkflow(options.workflowId), workflow = structuredClone(record.workflow);
      for (const parameter of options.parameters) {
        const node = workflow[parameter.nodeId];
        node.inputs[parameter.input] = parameter.value;
        if (['seed', 'noise_seed'].includes(parameter.input)) node._meta = { ...node._meta, seedControls: { ...node._meta?.seedControls, [parameter.input]: { ...node._meta?.seedControls?.[parameter.input], mode: 'fixed' } } };
      }
      result.comfyui = comfyuiConfig({ baseUrl: record.baseUrl, workflowName: record.name.replace(/[\r\n\0]/g, " ").slice(0, 240), workflow, prompt: options.prompt, outputNodeId: options.outputNodeId });
      return result;
    },
  };
}
