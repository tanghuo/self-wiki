import { elementError } from "./elements.js";
import { imageExecutorDefinition, grokAspectRatios } from "./imageGeneration.js";

export function chatImageOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.executor !== "string" || new TextEncoder().encode(JSON.stringify(value)).length > 32000
      || Object.keys(value).some((key) => !["executor", "direct", "workflowId", "prompt", "outputNodeId", "parameters", "aspectRatio"].includes(key))) throw elementError("无效的会话生图选项");
  const definition = imageExecutorDefinition(value.executor);
  if (typeof value.direct !== "boolean" || value.direct && !definition.directInput) throw elementError("此生图方式不支持原文直发");
  if (definition.id === "grok-build") {
    const aspectRatio = value.aspectRatio ?? "auto";
    if (!grokAspectRatios.includes(aspectRatio)) throw elementError("无效的 Grok 图片比例");
    return { executor: definition.id, direct: value.direct, aspectRatio };
  }
  if (definition.id !== "comfyui") return { executor: definition.id, direct: value.direct };
  const { workflowId = null, prompt = null, outputNodeId = "", parameters = [] } = value;
  if (workflowId !== null && (!Number.isSafeInteger(workflowId) || workflowId < 1)) throw elementError("无效的 ComfyUI 工作流");
  const name = (entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 200 && !/[\x00-\x1f]/.test(entry);
  if (prompt !== null && (!name(prompt?.nodeId) || !name(prompt?.input) || Object.keys(prompt).some((key) => !["nodeId", "input"].includes(key)))) throw elementError("无效的提示词字段");
  if (typeof outputNodeId !== "string" || outputNodeId.length > 128) throw elementError("无效的输出节点");
  if (!Array.isArray(parameters) || parameters.length > 128) throw elementError("最多调整 128 个工作流参数");
  const keys = new Set();
  const normalized = parameters.map((entry) => {
    if (!name(entry?.nodeId) || !name(entry?.input) || Object.keys(entry).some((key) => !["nodeId", "input", "value"].includes(key))
        || !["string", "number", "boolean"].includes(typeof entry.value) || typeof entry.value === "string" && entry.value.length > 12000
        || typeof entry.value === "number" && !Number.isFinite(entry.value)) throw elementError("无效的工作流参数");
    const key = JSON.stringify([entry.nodeId, entry.input]);
    if (keys.has(key)) throw elementError("工作流参数重复");
    keys.add(key);
    return { nodeId: entry.nodeId, input: entry.input, value: entry.value };
  }).sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.input.localeCompare(b.input));
  return { executor: definition.id, direct: value.direct, workflowId, prompt: prompt && { nodeId: prompt.nodeId, input: prompt.input }, outputNodeId, parameters: normalized };
}
