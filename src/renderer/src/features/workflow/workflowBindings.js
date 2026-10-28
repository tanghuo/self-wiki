import { outputBindingType, valueTypes, listItemType, matchesType } from '../../../../shared/domain/workflow/contracts.js';

export function canAppendTextReference(node) {
  return node?.type === 'element' && node.config.source === 'fixed' && node.config.valueType === 'text'
    && (Array.isArray(node.config.parts) || node.config.default == null || typeof node.config.default === 'string');
}

export function setNodeBinding(node, handle, binding) {
  if (handle === 'template:new') {
    if (!canAppendTextReference(node) || !binding) return node;
    const config = { ...node.config, parts: [...(node.config.parts || [{ kind: 'text', text: node.config.default || '' }]), { kind: 'ref', ref: binding }] };
    delete config.default;
    return { ...node, config };
  }
  if (node.type === 'foreach' && handle === 'capture:new' && binding?.kind === 'output') {
    let index = 1;
    while (Object.hasOwn(node.config.captureTypes || {}, `content_${index}`)) index++;
    const key = `content_${index}`;
    return { ...node, config: { ...node.config, captureTypes: { ...node.config.captureTypes, [key]: 'text' } }, inputs: { ...node.inputs, [key]: binding } };
  }
  const replacement = binding || { kind: 'text', text: '' };
  if (handle?.startsWith('text:')) {
    const [, port, index] = handle.split(':');
    const expression = node.inputs?.[port];
    if (!expression?.parts?.[Number(index)]) return node;
    const parts = expression.parts.map((part, i) => i === Number(index) ? binding ? { kind: 'ref', ref: binding } : replacement : part);
    return { ...node, inputs: { ...node.inputs, [port]: { ...expression, parts } } };
  }
  if (handle?.startsWith('template:')) {
    const index = Number(handle.slice(9));
    if (!node.config.parts?.[index]) return node;
    return { ...node, config: { ...node.config, parts: node.config.parts.map((part, i) => i === index ? binding ? { kind: 'ref', ref: binding } : replacement : part) } };
  }
  return { ...node, inputs: { ...node.inputs, [handle]: binding || { kind: 'output', nodeId: '', port: 'value', path: [] } } };
}

export function bindingType(binding, graph, parent, fallback) {
  if (!binding) return undefined;
  if (binding.kind === 'text') return 'text';
  if (binding.kind === 'output') return outputBindingType(graph.nodes.find((n) => n.id === binding.nodeId), binding);
  if (binding.kind === 'item') return listItemType(parent?.config.itemsType);
  if (binding.kind === 'index') return 'number';
  if (binding.kind === 'itemId') return 'text';
  if (binding.kind === 'capture') return parent?.config.captureTypes?.[binding.name];
  if (binding.kind === 'constant') {
    if ((fallback !== 'json' && fallback !== 'list<json>' && matchesType(binding.value, fallback)) || (Array.isArray(binding.value) && !binding.value.length && listItemType(fallback))) return fallback;
    return valueTypes.filter((t) => t !== 'json' && t !== 'list<json>').find((t) => matchesType(binding.value, t)) || 'json';
  }
}

export function acceptedTypes(node, port, expected) {
  if (node?.type === 'review') return ['text', 'image', 'list<image>'];
  if (node?.type === 'library.save') return ['text', 'image', 'list<image>'];
  if (node?.type === 'preview' || node?.type === 'foreach' && port !== 'items') return valueTypes;
  if (node?.type === 'foreach') return valueTypes.filter(listItemType);
  if (node?.type === 'transform') {
    if (node.config.operation === 'field') return valueTypes;
    if (['nth', 'zip'].includes(node.config.operation)) return valueTypes.filter(listItemType);
    if (node.config.operation === 'list') return valueTypes;
  }
  return expected === 'list<image>' ? ['image', 'list<image>'] : [expected];
}

// Inference changes persisted declarations, not the validator's authority.
// Keep unchanged node objects intact so canvas measurements remain stable.
export function inferGraphTypes(graph, parent) {
  let result = graph;
  for (let pass = 0; pass < graph.nodes.length; pass++) {
    let changed = false;
    const nodes = result.nodes.map((node) => {
      let config = node.config;
      const set = (key, value) => { if (value && config[key] !== value) { config = { ...config, [key]: value }; } };
      if (node.type === 'transform') {
        const type = (key, fallback) => bindingType(node.inputs?.[key], result, parent, fallback);
        if (config.operation === 'nth') set('valueType', listItemType(type('value', `list<${config.valueType}>`)));
        if (config.operation === 'zip') { set('listType', type('a', config.listType)); set('otherListType', type('b', config.otherListType)); set('valueType', 'list<json>'); }
        if (config.operation === 'list') {
          const types = (config.keys || ['a', 'b']).map((key) => type(key, listItemType(config.valueType))).filter(Boolean);
          const item = types.length && types.every((t) => ['image', 'list<image>'].includes(t)) ? 'image' : types.length && types.every((t) => t === types[0]) && !listItemType(types[0]) ? types[0] : 'json';
          set('valueType', `list<${item}>`);
        }
      }
      if (['preview', 'review', 'library.save'].includes(node.type)) {
        let type = bindingType(node.inputs?.value, result, parent, config.valueType);
        if (node.type === 'review' && type === 'image') type = 'list<image>';
        if (acceptedTypes(node, 'value', config.valueType).includes(type)) set('valueType', type);
      }
      if (node.type === 'foreach') {
        const type = bindingType(node.inputs?.items, result, parent, config.itemsType);
        if (listItemType(type)) set('itemsType', type);
        for (const [key, previous] of Object.entries(config.captureTypes || {})) {
          const captured = bindingType(node.inputs?.[key], result, parent, previous);
          if (captured && captured !== config.captureTypes[key]) config = { ...config, captureTypes: { ...config.captureTypes, [key]: captured } };
        }
        const body = config.body?.nodes ? inferGraphTypes(config.body, { ...node, config }) : config.body;
        if (body !== config.body) config = { ...config, body };
      }
      if (config === node.config) return node;
      changed = true; return { ...node, config };
    });
    if (!changed) return result;
    result = { ...result, nodes };
  }
  return result;
}
