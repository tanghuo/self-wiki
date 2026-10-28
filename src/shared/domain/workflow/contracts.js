// JSON-only contracts. Bindings are the sole source of graph dependencies.
export const workflowLimits = { scopeNodes: 100, nodes: 300, items: 1000, instances: 20000 };
export const workflowError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
export const terminalNodeStates = new Set(['succeeded', 'failed', 'blocked', 'cancelled']);
export const externalNodeTypes = new Set(['model', 'image.generate']);
export const nodeTypes = [
  { type: 'element', label: '元素', version: 1 },
  { type: 'input', label: '输入', version: 1 },
  { type: 'template', label: '文字组合', version: 1 },
  { type: 'model', label: '模型调用', version: 1 },
  { type: 'image.generate', label: '图片生成', version: 1 },
  { type: 'transform', label: '数据处理', version: 1 },
  { type: 'foreach', label: '批量循环', version: 1 },
  { type: 'review', label: '人工检查', version: 1 },
  { type: 'preview', label: '预览', version: 1 },
  { type: 'library.save', label: '保存到内容库', version: 1 },
];
export const valueTypes = ['text', 'number', 'boolean', 'json', 'image', 'list<text>', 'list<number>', 'list<boolean>', 'list<json>', 'list<image>'];
export const listItemType = (type) => /^list<(.+)>$/.exec(type || '')?.[1];
export const isRuntimeElement = (node) => node.type === 'input' || node.type === 'element' && node.config.source === 'runtime';
export const preparedElements = (definition) => definition.nodes.filter((n) => n.type === 'input' || n.type === 'element' && n.config.source !== 'upstream' && !Array.isArray(n.config.parts));
export const loopItems = (node, items) => node.config.sampleSize === 1 ? items.slice(0, 1) : items;
export function sampleDefinition(definition) {
  return { ...definition, nodes: definition.nodes.map((node) => node.type === 'foreach' ? { ...node, config: { ...node.config, sampleSize: 1 } } : node) };
}
export function editableDefinition(definition) {
  const next = structuredClone(definition);
  function edit(graph) {
    for (const n of graph.nodes) {
      if (n.type === 'input') {
        n.type = 'element'; n.config.source = 'runtime';
        if (n.name === '输入') n.name = n.config.valueType?.includes('image') ? '图片' : '文字';
      }
      if (n.type === 'element' && n.config.valueType === 'image' && n.config.source !== 'upstream') {
        n.config.valueType = 'list<image>';
        if (n.config.default !== undefined) n.config.default = [n.config.default];
      }
      if (n.type === 'foreach') delete n.config.sampleSize;
      if (n.type === 'transform' && n.config.operation === 'concat' && (n.config.keys || ['a', 'b']).every((key) => n.inputs?.[key])) {
        const parts = [];
        for (const [index, key] of (n.config.keys || ['a', 'b']).entries()) {
          if (index && n.config.separator) parts.push({ kind: 'text', text: n.config.separator });
          const binding = n.inputs[key];
          parts.push(binding.kind === 'constant' ? { kind: 'text', text: binding.value } : { kind: 'ref', ref: binding });
        }
        n.type = 'template'; n.config = { parts }; n.inputs = {};
      }
      if (n.type === 'template') { n.type = 'element'; n.config = { source: 'fixed', valueType: 'text', parts: n.config.parts || [] }; n.inputs = {}; if (['文字组合', '提示词模板'].includes(n.name)) n.name = '元素'; }
      if (n.type === 'foreach' && n.config.body?.nodes) edit(n.config.body);
    }
  }
  edit(next);
  // Only loop return mappings are consumed; historical run snapshots stay untouched.
  next.outputs = {};
  return next;
}
const validName = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
export function matchesType(value, type) {
  const item = listItemType(type);
  if (item) return Array.isArray(value) && value.every((v) => matchesType(v, item));
  if (type === 'text') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'image') return !!value && typeof value === 'object' && !Array.isArray(value) && typeof value.artifactId === 'string' && Object.keys(value).every((k) => ['artifactId'].includes(k));
  return type === 'json' && value !== undefined;
}
export function outputType(node) {
  if (node.type === 'template') return 'text';
  if (node.type === 'image.generate') return 'list<image>';
  if (node.type === 'foreach') return 'list<json>';
  if (node.type === 'library.save') return 'list<number>';
  if (node.type === 'model') return node.config?.outputType || 'text';
  return node.config?.valueType || 'text';
}
// Public variable names are independent of the historical artifact storage ports.
export function outputVariables(node) {
  const primary = outputType(node);
  const roots = node.type === 'model'
    ? [{ name: 'text', type: 'text', port: 'text', path: [] }, ...(primary === 'json' ? [{ name: 'structured_output', type: 'json', port: 'structured_output', path: [] }] : [])]
    : [{ name: node.type === 'image.generate' ? 'images' : 'value', type: primary, port: node.type === 'image.generate' ? 'images' : 'value', path: [] }];
  const fields = [];
  function visit(schema, path, depth = 0) {
    if (!schema || depth > 24) return;
    for (const [key, field] of Object.entries(schema.properties || {})) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
      const next = [...path, key], type = schemaValueType(field);
      fields.push({ name: `structured_output.${next.join('.')}`, type, port: 'structured_output', path: next });
      visit(field, next, depth + 1);
    }
  }
  if (node.type === 'model' && primary === 'json') visit(node.config.jsonSchema, []);
  return [...roots, ...fields];
}
function schemaValueType(schema) {
  const type = ({ string: 'text', number: 'number', integer: 'number', boolean: 'boolean' })[schema?.type];
  if (type) return type;
  if (schema?.type === 'array') return `list<${schemaValueType(schema.items).replace(/^list<.*>$/, 'json')}>`;
  return 'json';
}
export function outputBindingType(node, binding) {
  if (!node) return undefined;
  const type = binding.port === 'value' ? outputType(node) : node.type === 'model' && ['text', 'raw'].includes(binding.port) ? 'text'
    : node.type === 'model' && binding.port === 'structured_output' && outputType(node) === 'json' ? 'json'
    : node.type === 'image.generate' && binding.port === 'images' ? 'list<image>' : undefined;
  if (!binding.path?.length) return type;
  if (type !== 'json') return undefined;
  if (node.type === 'model' && node.config.jsonSchema) {
    let schema = node.config.jsonSchema;
    for (const key of binding.path) {
      if (schema?.type === 'array' && /^(0|[1-9]\d*)$/.test(String(key))) schema = schema.items;
      else if (Object.hasOwn(schema?.properties || {}, key)) schema = schema.properties[key];
      else return undefined;
    }
    return schemaValueType(schema);
  }
  return 'json';
}
export function outputVariableName(node, binding) {
  return [outputPortName(node, binding.port), ...(binding.path || [])].join('.');
}
export function outputPortName(node, port) {
  if (node?.type === 'model') return port === 'raw' ? 'text' : port === 'value' ? outputType(node) === 'json' ? 'structured_output' : 'text' : port;
  return node?.type === 'image.generate' && port === 'value' ? 'images' : port;
}
export function inputPorts(node) {
  const c = node.config || {};
  switch (node.type) {
    case 'element': return c.source === 'upstream' ? { value: c.valueType || 'text' } : {};
    case 'input': case 'template': return {};
    case 'model': case 'image.generate': return c.adapterInputs || { prompt: 'text', images: 'list<image>' };
    case 'foreach': return { items: c.itemsType || 'list<image>', ...c.captureTypes };
    case 'transform': return c.operation === 'list' || c.operation === 'concat' ? Object.fromEntries((c.keys || ['a', 'b']).map((k) => [k, c.operation === 'concat' ? 'text' : c.valueType === 'list<image>' ? 'list<image>' : listItemType(c.valueType)]))
      : c.operation === 'zip' ? { a: c.listType || 'list<image>', b: c.otherListType || c.listType || 'list<image>' }
      : { value: c.operation === 'field' ? 'json' : c.operation === 'successes' ? 'list<json>' : `list<${c.valueType || 'text'}>` };
    default: return { value: c.valueType || 'text' };
  }
}
export function validTextParts(parts) {
  return Array.isArray(parts) && parts.length <= 1000 && parts.every((p) => p && (p.kind === 'text' && typeof p.text === 'string' || p.kind === 'ref' && p.ref && ['constant', 'output', 'item', 'index', 'itemId', 'capture'].includes(p.ref.kind)));
}
export function bindings(node) {
  const entries = Object.entries(node.inputs || {}).flatMap(([port, binding]) => [
    { field: `inputs.${port}`, binding },
    ...(binding?.kind === 'text' && Array.isArray(binding.parts) ? binding.parts.flatMap((part, i) => part?.kind === 'ref' ? [{ field: `inputs.${port}.parts.${i}`, binding: part.ref }] : []) : []),
  ]);
  if ((node.type === 'template' || node.type === 'element' && node.config?.source === 'fixed') && Array.isArray(node.config?.parts)) {
    entries.push(...node.config.parts.flatMap((part, i) => part?.kind === 'ref' ? [{ field: `config.parts.${i}`, binding: part.ref }] : []));
  }
  return entries;
}
export function bindingHandle(field) {
  if (field.startsWith('config.parts.')) return `template:${field.split('.').at(-1)}`;
  const [port, , index] = field.slice(7).split('.');
  return index === undefined ? port : `text:${port}:${index}`;
}
export const dependencies = (node) => [...new Set(bindings(node).filter(({ binding }) => binding?.kind === 'output').map(({ binding }) => binding.nodeId))];
export function safePath(value, path = []) {
  if (!Array.isArray(path) || path.length > 32) throw workflowError('字段路径无效');
  for (const key of path) {
    if (!(typeof key === 'string' || Number.isSafeInteger(key)) || ['__proto__', 'prototype', 'constructor'].includes(String(key)) || value == null || !Object.hasOwn(Object(value), key)) throw workflowError(`字段不存在：${String(key)}`);
    value = value[key];
  }
  return value;
}
export function validateDefinition(definition, { limits = workflowLimits } = {}) {
  const errors = [], orders = {}, add = (nodeId, field, message) => errors.push({ nodeId, field, message });
  if (!definition || definition.schemaVersion !== 1 || !Array.isArray(definition.nodes)) return { valid: false, errors: [{ field: 'schemaVersion', message: '需要 schemaVersion: 1 和 nodes 数组' }], orders, maxCalls: 0 };
  // P3: optional list of node ids to highlight as the run's "final results".
  if (definition.resultSteps !== undefined) {
    if (!Array.isArray(definition.resultSteps) || definition.resultSteps.length > 64 || definition.resultSteps.some((id) => typeof id !== 'string' || id.length > 80)) {
      return { valid: false, errors: [{ field: 'resultSteps', message: 'resultSteps 须为节点 ID 字符串数组' }], orders, maxCalls: 0 };
    }
  }
  let total = 0, maxCalls = 0, maxInstances = 0;
  function scope(graph, name, parent = null, multiplier = 1) {
    if (!graph || !Array.isArray(graph.nodes)) { add(parent?.id, 'body', '缺少循环子图'); return; }
    const nodes = graph.nodes;
    total += nodes.length; maxInstances += nodes.length * multiplier;
    if (nodes.length > limits.scopeNodes) add(parent?.id, 'nodes', '每个作用域最多 100 个节点');
    const ids = new Map();
    for (const node of nodes) {
      if (!node || typeof node !== 'object') { add('', 'nodes', '节点必须是对象'); continue; }
      if (!validName(node.id) || ids.has(node.id)) add(node.id, 'id', '节点 ID 无效或重复');
      ids.set(node.id, node);
      if (!nodeTypes.some((t) => t.type === node.type && t.version === node.version)) add(node.id, 'type', '不支持的节点类型或契约版本');
      if (!node.config || typeof node.config !== 'object' || Array.isArray(node.config)) add(node.id, 'config', '配置必须是对象');
      if (!valueTypes.includes(outputType(node))) add(node.id, 'config.valueType', '不支持的输出类型');
      if (externalNodeTypes.has(node.type)) maxCalls += multiplier;
    }
    const parameters = new Set();
    for (const node of nodes.filter((n) => n && typeof n === 'object')) {
      const c = node.config || {}, ports = inputPorts(node);
      if (node.type === 'element' && !['fixed', 'runtime', 'upstream'].includes(c.source)) add(node.id, 'config.source', '请选择内容来源');
      if (node.type === 'input' || node.type === 'element' && c.source !== 'upstream' && !Array.isArray(c.parts)) {
        if (parent) add(node.id, 'type', '循环内请使用 item 或显式捕获');
        if (!validName(c.parameter) || parameters.has(c.parameter)) add(node.id, 'config.parameter', '参数名无效或重复');
        parameters.add(c.parameter);
        const ref = (v) => !!v && typeof v === 'object' && Object.keys(v).length === 1 && (Number.isSafeInteger(v.elementId) && v.elementId > 0 || outputType(node).includes('image') && typeof v.attachmentId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v.attachmentId));
        const libraryValue = node.type === 'element' && (['text', 'image'].includes(outputType(node)) ? ref(c.default) : outputType(node) === 'list<image>' && Array.isArray(c.default) && c.default.every(ref));
        if (Object.hasOwn(c, 'default') && !matchesType(c.default, outputType(node)) && !libraryValue) add(node.id, 'config.default', '内容类型错误');
      }
      if (node.type === 'element' && c.parts !== undefined && (c.source !== 'fixed' || outputType(node) !== 'text' || !validTextParts(c.parts))) add(node.id, 'config.parts', '文字引用只能用于固定文字元素');
      if (node.type === 'model' && !['text', 'json'].includes(outputType(node))) add(node.id, 'config.outputType', '模型只输出 text 或 json');
      if (node.type === 'review' && !['text', 'list<image>'].includes(outputType(node))) add(node.id, 'config.valueType', '检查仅支持文字或图片列表');
      if (node.type === 'library.save' && !['text', 'image', 'list<image>'].includes(c.valueType)) add(node.id, 'config.valueType', '保存仅支持文字或图片');
      if (node.type === 'transform' && !['field', 'concat', 'list', 'nth', 'zip', 'successes'].includes(c.operation)) add(node.id, 'config.operation', '未知数据操作');
      if (node.type === 'transform' && ['zip', 'successes'].includes(c.operation) && outputType(node) !== 'list<json>') add(node.id, 'config.valueType', '配对及成功项筛选输出 list<json>');
      if (node.type === 'template' && (!Array.isArray(c.parts) || c.parts.some((p) => !p || !['text', 'ref'].includes(p.kind) || p.kind === 'text' && typeof p.text !== 'string'))) add(node.id, 'config.parts', '模板需要 text 或 ref 片段数组');
      for (const [port, type] of Object.entries(ports)) {
        if (!validName(port)) add(node.id, `inputs.${port}`, '端口名称无效');
        if (!valueTypes.includes(type)) add(node.id, `inputs.${port}`, '端口类型无效');
        if (!node.inputs?.[port] && !(['model', 'image.generate'].includes(node.type) && port === 'images')) add(node.id, `inputs.${port}`, '必填输入未绑定');
      }
      for (const key of Object.keys(node.inputs || {})) if (!Object.hasOwn(ports, key)) add(node.id, `inputs.${key}`, '未知输入端口');
      for (const { field, binding: b } of bindings(node)) {
        let type;
        if (!b || typeof b !== 'object') { add(node.id, field, '无效绑定'); continue; }
        if (b.kind === 'text') {
          type = 'text'; if (!validTextParts(b.parts)) add(node.id, field, '文字内容无效');
        } else if (b.kind === 'constant') {
          type = field.startsWith('config.') ? 'text' : (field.includes('.parts.') ? 'text' : ports[field.slice(7)]);
          if (!matchesType(b.value, type) && !(type === 'list<image>' && matchesType(b.value, 'image'))) add(node.id, field, '常量类型不匹配');
        } else if (b.kind === 'output') {
          const source = ids.get(b.nodeId);
          if (!b.nodeId) add(node.id, field, '等待手动连线');
          else if (!(type = outputBindingType(source, b))) add(node.id, field, '引用节点、输出变量或字段不存在（仅允许同作用域）');
        } else if (parent && ['item', 'index', 'itemId', 'capture'].includes(b.kind)) {
          type = b.kind === 'item' ? listItemType(parent.config?.itemsType || 'list<image>') : b.kind === 'index' ? 'number' : b.kind === 'itemId' ? 'text' : parent.config?.captureTypes?.[b.name];
          if (!type) add(node.id, field, '捕获输入不存在');
        } else add(node.id, field, '不支持的绑定或非法跨作用域引用');
        if (b.path !== undefined && (!Array.isArray(b.path) || b.path.length > 32 || b.path.some((k) => !['string', 'number'].includes(typeof k) || ['__proto__', 'prototype', 'constructor'].includes(String(k))))) add(node.id, field, '字段路径无效');
        const expected = field.startsWith('config.') || field.includes('.parts.') ? 'text' : ports[field.slice(7)];
        if (type && expected && type !== expected && !(type === 'image' && expected === 'list<image>') && !(node.type === 'transform' && ['field', 'list'].includes(c.operation) && expected === 'json')) add(node.id, field, `需要 ${expected}，实际 ${type}`);
      }
      if (node.type === 'foreach') {
        if (parent) { add(node.id, 'body', '首版不支持嵌套循环'); continue; }
        if (!listItemType(c.itemsType || 'list<image>')) add(node.id, 'config.itemsType', '循环需要列表类型');
        const size = c.maxItems ?? limits.items;
        if (!Number.isInteger(size) || size < 1 || size > limits.items) add(node.id, 'config.maxItems', '循环上限须为 1–1000');
        if (c.sampleSize !== undefined && c.sampleSize !== 1) add(node.id, 'config.sampleSize', '试跑仅支持取循环首项');
        scope(c.body, `${name}/${node.id}`, node, Number.isInteger(size) && size > 0 ? size : limits.items);
      }
    }
    const seen = new Set(), visiting = new Set(), ordered = [];
    function visit(id) {
      if (visiting.has(id)) { add(id, 'inputs', '图中存在循环依赖'); return; }
      if (seen.has(id) || !ids.has(id)) return;
      visiting.add(id);
      for (const dep of dependencies(ids.get(id))) visit(dep);
      visiting.delete(id); seen.add(id); ordered.push(id);
    }
    for (const id of ids.keys()) visit(id);
    orders[name] = ordered;
    for (const b of Object.values(graph.outputs || {})) if (b?.kind !== 'output' || !outputBindingType(ids.get(b.nodeId), b) || b.path !== undefined && (!Array.isArray(b.path) || b.path.length > 32 || b.path.some((key) => ['__proto__', 'prototype', 'constructor'].includes(String(key))))) add(parent?.id, 'outputs', '作用域输出必须引用本作用域节点的有效变量');
  }
  scope(definition, 'root');
  if (total > limits.nodes) add('', 'nodes', '整个定义最多 300 个节点');
  if (maxInstances > limits.instances) add('', 'nodes', '预计实例超过 20000，请降低循环 maxItems');
  if (Array.isArray(definition.resultSteps)) {
    const allIds = new Set();
    (function walk(nodes) { for (const n of nodes || []) { allIds.add(n.id); if (n.type === 'foreach') walk(n.config.body?.nodes); } })(definition.nodes);
    for (const id of definition.resultSteps) if (!allIds.has(id)) add(id, 'resultSteps', '结果步骤必须是流程里已有的节点');
  }
  return { valid: errors.length === 0, errors, orders, maxCalls, maxInstances };
}
export function downstreamClosure(nodes, changed) {
  const result = new Set(changed);
  let grew = true;
  while (grew) { grew = false; for (const n of nodes) if (!result.has(n.id) && dependencies(n).some((id) => result.has(id))) { result.add(n.id); grew = true; } }
  return result;
}
export function executionNode(node) {
  const config = { ...node.config };
  if (config.body) config.body = { nodes: config.body.nodes.map((n) => ({ id: n.id, ...executionNode(n) })).sort((a, b) => a.id.localeCompare(b.id)), outputs: config.body.outputs || {} };
  return { type: node.type, version: node.version, config, inputs: node.inputs };
}
export function summarizeRun(instances, { cancelled, paused } = {}) {
  if (cancelled) return 'cancelled';
  if (instances.some((n) => n.state === 'unknown' || n.serviceFault)) return 'needs_attention';
  if (paused) return 'paused';
  if (instances.some((n) => ['pending', 'running'].includes(n.state))) return 'running';
  if (instances.some((n) => n.state === 'waiting_review')) return 'waiting_review';
  const failures = instances.filter((n) => ['failed', 'blocked', 'cancelled'].includes(n.state)).length;
  return failures ? instances.some((n) => n.state === 'succeeded') ? 'partial_failed' : 'failed' : 'succeeded';
}
