export const constant = (value) => ({ kind: 'constant', value });
export const output = (nodeId) => ({ kind: 'output', nodeId, port: 'value', path: [] });
export const workflowNode = (id, type, config = {}, inputs = {}, position = { x: 0, y: 0 }) => ({ id, type, version: 1, name: id, config, inputs, position });
export function blankWorkflow() { return { schemaVersion: 1, nodes: [], outputs: {} }; }
export function describeImagesExample({ textAdapter = 'grok-text', imageAdapter = 'grok-build' } = {}) {
  const definition = { schemaVersion: 1, nodes: [
    workflowNode('images', 'element', { source: 'runtime', parameter: 'images', valueType: 'list<image>', required: true, allowEmpty: false }, {}, { x: 0, y: 0 }),
    workflowNode('instruction', 'element', { source: 'runtime', parameter: 'instruction', valueType: 'text', required: true, default: '请详细描述这张图片，输出可用于生图的提示词。' }, {}, { x: 0, y: 180 }),
    workflowNode('batch', 'foreach', { itemsType: 'list<image>', maxItems: 1000, captureTypes: { instruction: 'text' }, body: { nodes: [
      workflowNode('describe', 'model', { adapterId: textAdapter, outputType: 'text' }, { prompt: { kind: 'capture', name: 'instruction' }, images: { kind: 'item' } }, { x: 0, y: 0 }),
      workflowNode('check', 'review', { valueType: 'text' }, { value: output('describe') }, { x: 260, y: 0 }),
      workflowNode('generate', 'image.generate', { adapterId: imageAdapter, parameters: {} }, { prompt: output('check'), images: { kind: 'item' } }, { x: 520, y: 0 }),
    ], outputs: { description: output('check'), images: output('generate') } } }, { items: output('images'), instruction: output('instruction') }, { x: 300, y: 40 }),
  ], outputs: {} };
  const names = { images: '待处理图片', instruction: '描述要求', batch: '逐张反推并生图', describe: '理解图片', check: '确认提示词', generate: '生成图片' };
  for (const node of [...definition.nodes, ...definition.nodes[2].config.body.nodes]) node.name = names[node.id];
  return definition;
}
