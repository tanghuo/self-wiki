import { comfyuiJson } from "./comfyuiApi.js";
import { comfyuiConfig, comfyuiWorkflow, configuredComfyuiWorkflow, maxComfyWorkflowBytes } from "../../shared/domain/comfyui.js";
import { elementError } from "../../shared/domain/elements.js";
import { expandComfyuiSubgraphs } from './comfyuiSubgraphs.js';

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

function* schemaInputs(info, node, currentValue = () => undefined, prefix = '', depth = 0) {
  if (depth > 16) throw elementError('ComfyUI 动态输入嵌套过深');
  for (const group of ["required", "optional"]) {
    const inputs = info.input?.[group] || {}, order = info.input_order?.[group] || Object.keys(inputs);
    if (order.length !== Object.keys(inputs).length || new Set(order).size !== order.length || order.some((key) => !Object.hasOwn(inputs, key))) throw new Error("节点输入顺序无效");
    for (const key of order) {
      const name = prefix + key, spec = inputs[key];
      if (spec[0] === 'COMFY_DYNAMICCOMBO_V3') {
        const options = spec[1]?.options;
        if (!Array.isArray(options)) throw elementError('ComfyUI 动态选项定义无效');
        yield [name, ['COMBO', { ...spec[1], default: spec[1]?.default ?? options[0]?.key, options: options.map((option) => option.key), dynamic: true }]];
        const selected = options.find((option) => option.key === currentValue(name));
        if (!selected) throw elementError(`ComfyUI 动态选项 ${name} 的值无效`);
        yield* schemaInputs({ input: selected.inputs }, node, currentValue, name + '.', depth + 1);
      } else if (spec[0] === 'COMFY_AUTOGROW_V3') {
        const template = spec[1]?.template, fields = Object.values(template?.input?.required || {});
        if (!Array.isArray(template?.names) || fields.length !== 1 || fieldType(fields[0])) throw elementError(`ComfyUI 动态输入 ${name} 的模板尚不支持`);
        const names = new Set(template.names.map((entry) => `${name}.${entry}`));
        const sockets = Array.isArray(node.inputs) ? node.inputs : Object.keys(node.inputs || {}).map((entry) => ({ name: entry }));
        for (const socket of sockets) if (names.has(socket.name)) yield [socket.name, fields[0]];
      } else yield [name, spec];
    }
  }
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
    throw elementError(`当前无法读取 ComfyUI 工作流：旁路节点 ${node.id} 缺少插槽类型`);
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
  const expanded = expandComfyuiSubgraphs(value);
  value = expanded.value;
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
    if (source.type === "PrimitiveNode") throw elementError(`当前无法读取 ComfyUI 工作流：节点 ${link.origin} 使用了尚不支持的前端 PrimitiveNode`);
    if (!infos[source.type] || !Array.isArray(infos[source.type].output) || link.slot >= infos[source.type].output.length) throw elementError(`节点 ${link.origin} 的输出插槽无效`);
    return [link.origin, link.slot];
  }
  for (const [id, node] of nodes) {
    if (["Note", "MarkdownNote", "Reroute", "PrimitiveNode"].includes(node.type) || node.mode === 2 || node.mode === 4) continue;
    const fail = (message) => { throw elementError(`当前无法读取 ComfyUI 节点 ${id}（${node.type}）：${message}`); };
    const info = infos[node.type];
    if (!info) fail("服务缺少此节点，或节点使用了子图/前端扩展");
    const widgets = node.widgets_values || [], named = node.widgets_values_named;
    if (!Array.isArray(widgets)) fail("无法识别控件存储格式");
    const inputs = {}, connections = node.inputs || [], seedControls = {};
    let index = 0;
    for (const [name, spec] of schemaInputs(info, node, (name) => inputs[name])) {
      const slot = connections.findIndex((input) => input.name === name), socket = connections[slot];
      const hasWidget = fieldType(spec) && (!spec[1]?.forceInput || socket?.widget);
      if (hasWidget) {
        if (named) {
          if (!Object.hasOwn(named, name) && spec[1]?.default === undefined) fail(`命名控件缺少 ${name}`);
          inputs[name] = Object.hasOwn(named, name) ? named[name] : spec[1].default;
        }
        else {
          if (index >= widgets.length) {
            if (spec[1]?.default === undefined) fail(`缺少参数 ${name} 的控件值`);
            inputs[name] = spec[1].default;
          } else inputs[name] = widgets[index++];
          const control = spec[1]?.control_after_generate || ["seed", "noise_seed"].includes(name);
          if (control && ["fixed", "increment", "decrement", "randomize"].includes(widgets[index])) {
            const mode = widgets[index++];
            if (['seed', 'noise_seed'].includes(name)) seedControls[name] = { mode, min: spec[1]?.min ?? 0, max: Math.min(spec[1]?.max ?? Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) };
          }
        }
      }
      if (expanded.overrides.get(id)?.has(name)) inputs[name] = expanded.overrides.get(id).get(name);
      if (['seed', 'noise_seed'].includes(name) && typeof inputs[name] === 'number') {
        const mode = expanded.overrides.get(id)?.get(`${name}:control_after_generate`) ?? node.widgets_values_named?.control_after_generate;
        seedControls[name] = { mode: mode ?? seedControls[name]?.mode ?? 'fixed', min: spec[1]?.min ?? 0, max: Math.min(spec[1]?.max ?? Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) };
      }
      const connected = socket?.link == null ? null : connection(socket.link, id, slot, socket.type ?? fieldType(spec) ?? spec[0]);
      if (connected) inputs[name] = connected;
      else if (!hasWidget && !Object.hasOwn(inputs, name) && !spec[1]?.socketless && Object.hasOwn(info.input?.required || {}, name)) {
        fail(`必填输入 ${name} 未连接${socket?.link != null ? "（上游静音或旁路后无有效输入）" : ""}`);
      }
    }
    // ComfyUI's LoadImage persists the upload destination as a UI-only widget.
    if (node.type === 'LoadImage' && info.input?.required?.image?.[1]?.image_upload && widgets.length === index + 1 && widgets[index] === 'image') index++;
    if (!named && index !== widgets.length) fail("控件数量与节点定义不符，可能使用了自定义序列化");
    result[id] = { class_type: node.type, inputs, _meta: { title: node.title || info.display_name || node.type, ...(Object.keys(seedControls).length && { seedControls }) } };
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
    for (const [input, spec] of schemaInputs(info, node, (name) => node.inputs[name])) {
      const type = fieldType(spec), value = node.inputs[input], options = Array.isArray(spec[0]) ? spec[0] : spec[1]?.options;
      if (!type || spec[1]?.dynamic || !["string", "number", "boolean"].includes(typeof value)) continue;
      fields.push({ nodeId, input, label: `${label} → ${input}`, type, value,
        ...(type === "COMBO" && { options: options.filter((option) => ["string", "number", "boolean"].includes(typeof option)) }),
        ...Object.fromEntries(["min", "max", "step", "multiline"].filter((key) => spec[1]?.[key] !== undefined).map((key) => [key, spec[1][key]])) });
      if (type === 'COMBO' && spec[1]?.sizes_by_ratio) {
        const values = spec[1].sizes_by_ratio, ratios = Object.keys(values);
        const selectors = [...schemaInputs(info, node, (name) => node.inputs[name])].filter(([name, schema]) => name !== input && Array.isArray(schema[0]) && ratios.every((ratio) => schema[0].includes(ratio)));
        if (selectors.length === 1 && Object.values(values).every((entries) => Array.isArray(entries) && entries.every((entry) => options.includes(entry)))) fields.at(-1).optionsByInput = { input: selectors[0][0], values };
      }
    }
  }
  const saves = outputs.filter((output) => ['SaveImage', 'SaveImageAdvanced'].includes(workflow[output.nodeId].class_type));
  const outputNodeId = saves.length === 1 ? saves[0].nodeId : outputs.length === 1 ? outputs[0].nodeId : '';
  const reachable = outputNodeId ? configuredComfyuiWorkflow({ workflow, outputNodeId }, { requirePrompt: false }) : workflow;
  const candidates = fields.filter((field) => reachable[field.nodeId] && field.type === "STRING" && ["text", "prompt", "positive", "value"].includes(field.input));
  const positive = candidates.filter((field) => /positive|正向|正面/i.test(field.label) && !/negative|负/i.test(field.label));
  const selected = positive.length === 1 ? positive[0] : candidates.length === 1 ? candidates[0] : null;
  return { fields, outputs, prompt: selected && { nodeId: selected.nodeId, input: selected.input }, outputNodeId };
}

export async function loadComfyuiWorkflow(settings, payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some((key) => key !== 'path')) throw elementError('仅支持选择 ComfyUI 中已保存的工作流');
  const remotePath = workflowPath(payload.path);
  const config = comfyuiConfig(settings), signal = AbortSignal.timeout(45000);
  const value = await comfyuiJson(config, `/userdata/${encodeURIComponent(`workflows/${remotePath}`)}`, { signal, maxBytes: maxComfyWorkflowBytes });
  if (Buffer.byteLength(JSON.stringify(value)) > maxComfyWorkflowBytes) throw elementError("工作流最多 512 KiB");
  const expanded = expandComfyuiSubgraphs(value).value;
  const classes = [...new Set(Array.isArray(expanded.nodes) ? expanded.nodes.filter((node) => !["Note", "MarkdownNote", "Reroute", "PrimitiveNode"].includes(node.type) && node.mode !== 2 && node.mode !== 4).map((node) => node.type) : Object.values(expanded).map((node) => node.class_type))];
  if (classes.length > 200 || classes.some((type) => typeof type !== "string" || type.length > 200)) throw elementError("工作流节点类型过多或无效");
  const infos = {};
  for (let index = 0; index < classes.length; index += 4) {
    const batch = await Promise.all(classes.slice(index, index + 4).map(async (type) => {
      const response = await comfyuiJson(config, `/object_info/${encodeURIComponent(type)}`, { signal });
      if (!Object.hasOwn(response, type)) throw elementError(`当前无法读取 ComfyUI 工作流：服务未提供节点类型 ${type} 的定义，可能是子图、前端扩展或未安装的节点`);
      return [type, response[type]];
    }));
    for (const [type, info] of batch) Object.defineProperty(infos, type, { value: info, enumerable: true });
  }
  const converted = convertComfyuiWorkflow(value, infos), description = describeComfyuiWorkflow(converted, infos);
  return { baseUrl: config.baseUrl, path: remotePath, name: remotePath, workflow: converted, ...description };
}
