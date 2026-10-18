import { comfyuiJson } from "./comfyuiApi.js";
import { comfyuiConfig, comfyuiWorkflow, maxComfyWorkflowBytes } from "../../shared/domain/comfyui.js";
import { elementError } from "../../shared/domain/elements.js";

function workflowPath(value) {
  if (typeof value !== "string" || value.length > 500 || /[\\\x00-\x1f]/.test(value)
      || value.split("/").some((part) => !part || part === "." || part === "..") || !value.endsWith(".json")) throw elementError("无效的远端工作流路径");
  return value;
}

export async function listComfyuiWorkflows(settings) {
  const config = comfyuiConfig(settings);
  let files;
  try { files = await comfyuiJson(config, "/userdata?dir=workflows&recurse=true&full_info=true"); }
  catch (error) { if (error.httpStatus === 404) return { baseUrl: config.baseUrl, workflows: [] }; throw error; }
  if (!Array.isArray(files)) throw new Error("ComfyUI 未返回已保存的工作流列表，请检查服务版本");
  const workflows = files.flatMap((entry) => {
    const name = typeof entry === "string" ? entry : entry?.path;
    try { workflowPath(name); } catch { return []; }
    if (name.split("/").at(-1).startsWith(".")) return [];
    return [{ path: name, name: name.replace(/\.json$/, ""), modified: entry.modified ?? null }];
  }).sort((a, b) => a.path.localeCompare(b.path));
  return { baseUrl: config.baseUrl, workflows };
}

function schemaInputs(info) {
  return ["required", "optional"].flatMap((group) => {
    const inputs = info.input?.[group] || {}, order = info.input_order?.[group] || Object.keys(inputs);
    if (order.length !== Object.keys(inputs).length || new Set(order).size !== order.length || order.some((key) => !Object.hasOwn(inputs, key))) throw new Error("节点输入顺序无效");
    return order.map((name) => [name, inputs[name]]);
  });
}

function fieldType(spec) {
  if (!Array.isArray(spec)) return null;
  if (Array.isArray(spec[0]) || spec[0] === "COMBO" && Array.isArray(spec[1]?.options)) return "COMBO";
  return ["STRING", "INT", "FLOAT", "BOOLEAN"].includes(spec[0]) ? spec[0] : null;
}

function slotTypesMatch(left, right) {
  const a = String(left).toLowerCase().split(","), b = String(right).toLowerCase().split(",");
  return a.some((type) => b.some((other) => type === other || ["", "*", "0"].includes(type) || ["", "*", "0"].includes(other)));
}

function bypassInputSlot(node, outputSlot, targetType, info) {
  const outputType = node.outputs?.[outputSlot]?.type ?? info?.output?.[outputSlot];
  const types = (node.inputs || []).map((input) => input.type
    ?? fieldType(info?.input?.required?.[input.name] ?? info?.input?.optional?.[input.name])
    ?? (info?.input?.required?.[input.name] ?? info?.input?.optional?.[input.name])?.[0]);
  if (outputType == null || targetType == null || types.some((type) => type == null)) {
    throw elementError(`旁路节点 ${node.id} 缺少插槽类型，请导出 API 格式工作流`);
  }
  // Follow ComfyUI's slot preference, including an unconnected matching input.
  if (targetType === "*" || targetType === "") return types.length > outputSlot ? outputSlot : 0;
  const matches = (type) => slotTypesMatch(type, outputType) && slotTypesMatch(type, targetType);
  if (types[outputSlot] != null && matches(types[outputSlot])) return outputSlot;
  const exact = types.indexOf(targetType);
  return exact >= 0 ? exact : types.findIndex(matches);
}

// ComfyUI's browser can add arbitrary serialization through extensions. Only
// convert graphs whose stored widgets have an unambiguous server-side schema.
export function convertComfyuiWorkflow(value, infos) {
  if (!Array.isArray(value?.nodes)) return comfyuiWorkflow(value);
  if (value.nodes.length > 1000 || !Array.isArray(value.links)) throw elementError("ComfyUI 画布的节点或连线无效");
  const nodes = new Map(), links = new Map(), result = {};
  for (const node of value.nodes) {
    const id = String(node.id);
    if (!/^[\w.:-]{1,128}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) throw elementError("ComfyUI 节点 ID 无效");
    if (nodes.has(id)) throw elementError(`重复的 ComfyUI 节点：${id}`);
    nodes.set(id, node);
  }
  for (const link of value.links) {
    const [id, origin, slot, target, targetSlot] = Array.isArray(link) ? link : [link.id, link.origin_id, link.origin_slot, link.target_id, link.target_slot];
    if (links.has(String(id)) || !Number.isInteger(slot) || slot < 0 || !Number.isInteger(targetSlot) || targetSlot < 0) throw elementError("ComfyUI 连线无效");
    links.set(String(id), { origin: String(origin), slot, target: String(target), targetSlot });
  }
  function connection(id, target, targetSlot, type, seen = new Set()) {
    if (seen.has(String(id))) throw elementError("ComfyUI 工作流存在循环转接线");
    seen.add(String(id));
    const link = links.get(String(id)), source = link && nodes.get(link.origin);
    if (!source || link.target !== target || link.targetSlot !== targetSlot) throw elementError(`节点 ${target} 的连线不完整`);
    if (source.mode === 2) return null;
    if (source.mode === 4) {
      const slot = bypassInputSlot(source, link.slot, type, infos[source.type]);
      const input = source.inputs?.[slot];
      if (input?.link == null) return null;
      return connection(input.link, link.origin, slot, input.type ?? type, seen);
    }
    if (source.type === "Reroute") {
      if (source.inputs?.[0]?.link == null) throw elementError(`转接节点 ${link.origin} 缺少输入`);
      return connection(source.inputs[0].link, link.origin, 0, type, seen);
    }
    if (source.type === "PrimitiveNode") throw elementError(`节点 ${link.origin} 使用前端 PrimitiveNode，请改用普通节点输入或导出 API 格式`);
    if (!infos[source.type] || !Array.isArray(infos[source.type].output) || link.slot >= infos[source.type].output.length) throw elementError(`节点 ${link.origin} 的输出插槽无效`);
    return [link.origin, link.slot];
  }
  for (const [id, node] of nodes) {
    if (["Note", "MarkdownNote", "Reroute", "PrimitiveNode"].includes(node.type) || node.mode === 2 || node.mode === 4) continue;
    const fail = (message) => { throw elementError(`ComfyUI 节点 ${id}（${node.type}）：${message}；可在会话中导入 API 格式作为备用`); };
    const info = infos[node.type];
    if (!info) fail("服务缺少此节点，或节点使用了子图/前端扩展");
    const widgets = node.widgets_values || [], named = node.widgets_values_named;
    if (!Array.isArray(widgets)) fail("无法识别控件存储格式");
    const inputs = {}, connections = node.inputs || [];
    let index = 0;
    for (const [name, spec] of schemaInputs(info)) {
      const slot = connections.findIndex((input) => input.name === name), socket = connections[slot];
      const hasWidget = fieldType(spec) && (!spec[1]?.forceInput || socket?.widget);
      if (hasWidget) {
        if (named) {
          if (!Object.hasOwn(named, name)) fail(`命名控件缺少 ${name}`);
          inputs[name] = named[name];
        }
        else {
          if (index >= widgets.length) fail(`缺少参数 ${name} 的控件值`);
          inputs[name] = widgets[index++];
          const control = spec[1]?.control_after_generate || ["seed", "noise_seed"].includes(name);
          if (control && ["fixed", "increment", "decrement", "randomize"].includes(widgets[index])) index++;
        }
      }
      const connected = socket?.link == null ? null : connection(socket.link, id, slot, socket.type ?? fieldType(spec) ?? spec[0]);
      if (connected) inputs[name] = connected;
      else if (!hasWidget && Object.hasOwn(info.input?.required || {}, name)) {
        fail(`必填输入 ${name} 未连接${socket?.link != null ? "（上游静音或旁路后无有效输入）" : ""}`);
      }
    }
    if (!named && index !== widgets.length) fail("控件数量与节点定义不符，可能使用了自定义序列化");
    result[id] = { class_type: node.type, inputs, _meta: { title: node.title || info.display_name || node.type } };
  }
  return comfyuiWorkflow(result);
}

export function describeComfyuiWorkflow(workflow, infos) {
  const fields = [], outputs = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    const info = infos[node.class_type];
    if (!info) throw elementError(`ComfyUI 缺少节点：${node.class_type}`);
    const label = `${node._meta?.title || info.display_name || node.class_type} · #${nodeId}`;
    if (info.output_node) outputs.push({ nodeId, label });
    for (const [input, spec] of schemaInputs(info)) {
      const type = fieldType(spec), value = node.inputs[input], options = Array.isArray(spec[0]) ? spec[0] : spec[1]?.options;
      if (!type || !["string", "number", "boolean"].includes(typeof value)) continue;
      fields.push({ nodeId, input, label: `${label} → ${input}`, type, value,
        ...(type === "COMBO" && { options: options.filter((option) => ["string", "number", "boolean"].includes(typeof option)) }),
        ...Object.fromEntries(["min", "max", "step", "multiline"].filter((key) => spec[1]?.[key] !== undefined).map((key) => [key, spec[1][key]])) });
    }
  }
  const candidates = fields.filter((field) => field.type === "STRING" && ["text", "prompt", "positive"].includes(field.input));
  const positive = candidates.filter((field) => /positive|正向|正面/i.test(field.label) && !/negative|负/i.test(field.label));
  const selected = positive.length === 1 ? positive[0] : candidates.length === 1 ? candidates[0] : null;
  return { fields, outputs, prompt: selected && { nodeId: selected.nodeId, input: selected.input }, outputNodeId: outputs.length === 1 ? outputs[0].nodeId : "" };
}

export async function loadComfyuiWorkflow(settings, { path, workflow, name }) {
  const config = comfyuiConfig(settings), signal = AbortSignal.timeout(45000);
  const remotePath = path === undefined ? "" : workflowPath(path);
  const value = remotePath ? await comfyuiJson(config, `/userdata/${encodeURIComponent(`workflows/${remotePath}`)}`, { signal, maxBytes: maxComfyWorkflowBytes }) : comfyuiWorkflow(workflow);
  if (Buffer.byteLength(JSON.stringify(value)) > maxComfyWorkflowBytes) throw elementError("工作流最多 512 KiB");
  const classes = [...new Set(Array.isArray(value.nodes) ? value.nodes.filter((node) => !["Note", "MarkdownNote", "Reroute", "PrimitiveNode"].includes(node.type) && node.mode !== 2 && node.mode !== 4).map((node) => node.type) : Object.values(value).map((node) => node.class_type))];
  if (classes.length > 200 || classes.some((type) => typeof type !== "string" || type.length > 200)) throw elementError("工作流节点类型过多或无效");
  const infos = {};
  for (let index = 0; index < classes.length; index += 4) {
    const batch = await Promise.all(classes.slice(index, index + 4).map(async (type) => {
      const response = await comfyuiJson(config, `/object_info/${encodeURIComponent(type)}`, { signal });
      if (!Object.hasOwn(response, type)) throw elementError(`ComfyUI 缺少节点：${type}`);
      return [type, response[type]];
    }));
    for (const [type, info] of batch) Object.defineProperty(infos, type, { value: info, enumerable: true });
  }
  const converted = convertComfyuiWorkflow(value, infos), description = describeComfyuiWorkflow(converted, infos);
  return { baseUrl: config.baseUrl, path: remotePath, name: remotePath || (typeof name === "string" ? name.slice(0, 240) : "导入的工作流"), workflow: converted, ...description };
}
