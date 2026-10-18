import { elementError } from "./elements.js";

export const maxComfyWorkflowBytes = 512 * 1024;

export function defaultComfyuiConfig() {
  return { baseUrl: "http://127.0.0.1:8188", workflowName: "", workflow: null, prompt: null, outputNodeId: "" };
}

export function comfyuiWorkflow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length || Array.isArray(value.nodes)) {
    throw elementError("请导入 ComfyUI 的 API 格式工作流（Export Workflow (API)），普通画布 JSON 不能执行");
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > maxComfyWorkflowBytes || Object.keys(value).length > 1000) {
    throw elementError("ComfyUI 工作流最多 512 KiB、1000 个节点");
  }
  for (const [id, node] of Object.entries(value)) {
    if (!/^[\w.:-]{1,128}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)
        || !node || typeof node !== "object" || Array.isArray(node)
        || typeof node.class_type !== "string" || !node.class_type.trim() || node.class_type.length > 200
        || !node.inputs || typeof node.inputs !== "object" || Array.isArray(node.inputs)) {
      throw elementError(`ComfyUI 节点 ${id.slice(0, 128)} 不是有效的 API 节点`);
    }
  }
  return structuredClone(value);
}

export function comfyuiConfig(value = defaultComfyuiConfig()) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => !["baseUrl", "workflowName", "workflow", "prompt", "outputNodeId"].includes(key))) {
    throw elementError("无效的 ComfyUI 配置");
  }
  value = { ...defaultComfyuiConfig(), ...value };
  let url;
  try { url = new URL(value.baseUrl); } catch { throw elementError("请填写完整的 ComfyUI HTTP(S) 服务地址"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw elementError("ComfyUI 地址须为 HTTP(S)，不包含账号、密码、查询参数或片段");
  }
  if (typeof value.workflowName !== "string" || value.workflowName.length > 240 || /[\r\n\0]/.test(value.workflowName)
      || typeof value.outputNodeId !== "string" || value.outputNodeId.length > 128) throw elementError("无效的 ComfyUI 工作流名称或输出节点");
  const workflow = value.workflow === null ? null : comfyuiWorkflow(value.workflow);
  const prompt = value.prompt;
  if (prompt !== null && (!prompt || typeof prompt !== "object" || Array.isArray(prompt)
      || Object.keys(prompt).some((key) => !["nodeId", "input"].includes(key))
      || typeof prompt.nodeId !== "string" || typeof prompt.input !== "string"
      || !Object.hasOwn(workflow || {}, prompt.nodeId) || !Object.hasOwn(workflow[prompt.nodeId].inputs, prompt.input)
      || typeof workflow[prompt.nodeId].inputs[prompt.input] !== "string")) {
    throw elementError("请选择工作流中的提示词文本字段，不能覆盖节点连线");
  }
  if (value.outputNodeId && !Object.hasOwn(workflow || {}, value.outputNodeId)) throw elementError("所选 ComfyUI 输出节点不存在");
  return { baseUrl: url.href.replace(/\/+$/, ""), workflowName: value.workflowName.trim(), workflow,
    prompt: prompt && { nodeId: prompt.nodeId, input: prompt.input }, outputNodeId: value.outputNodeId };
}

// Only the selected output and its dependencies run. The template stays intact.
export function configuredComfyuiWorkflow(config) {
  const { workflow, prompt, outputNodeId } = config;
  if (!workflow || !prompt || !outputNodeId) throw elementError("请在会话中选择 ComfyUI 工作流、提示词字段和图片输出节点");
  const reachable = new Set(), visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) throw elementError("ComfyUI 工作流存在循环连线");
    if (reachable.has(id)) return;
    if (!Object.hasOwn(workflow, id)) throw elementError(`ComfyUI 工作流引用了不存在的节点：${id}`);
    visiting.add(id);
    for (const input of Object.values(workflow[id].inputs)) {
      if (Array.isArray(input) && input.length === 2 && Number.isInteger(input[1]) && ["string", "number"].includes(typeof input[0])) visit(String(input[0]));
    }
    visiting.delete(id); reachable.add(id);
  }
  visit(outputNodeId);
  if (!reachable.has(prompt.nodeId)) throw elementError("提示词节点没有连接到所选图片输出，请检查映射");
  return Object.fromEntries([...reachable].map((id) => [id, structuredClone(workflow[id])]));
}
