export const constant = (value) => ({ kind: 'constant', value });
export const output = (nodeId) => ({ kind: 'output', nodeId, port: 'value', path: [] });
export const workflowNode = (id, type, config = {}, inputs = {}, position = { x: 0, y: 0 }) => ({ id, type, version: 1, name: id, config, inputs, position });
export function blankWorkflow() { return { schemaVersion: 1, nodes: [], outputs: {} }; }

function nameAll(definition, names) {
  const visit = (nodes) => { for (const node of nodes || []) { if (names[node.id]) node.name = names[node.id]; if (node.type === 'foreach') visit(node.config.body?.nodes); } };
  visit(definition.nodes);
  return definition;
}

export function describeImagesExample({ textAdapter = 'grok-text', imageAdapter = 'grok-build' } = {}) {
  const definition = { schemaVersion: 1, nodes: [
    workflowNode('images', 'element', { source: 'runtime', parameter: 'images', valueType: 'list<image>', required: true, allowEmpty: false }, {}, { x: 0, y: 0 }),
    workflowNode('instruction', 'element', { source: 'runtime', parameter: 'instruction', valueType: 'text', required: true, default: '请详细描述这张图片，输出可用于生图的提示词。' }, {}, { x: 0, y: 180 }),
    workflowNode('batch', 'foreach', { itemsType: 'list<image>', maxItems: 1000, captureTypes: { instruction: 'text' }, body: { nodes: [
      workflowNode('describe', 'model', { adapterId: textAdapter, outputType: 'text' }, { prompt: { kind: 'capture', name: 'instruction' }, images: { kind: 'item' } }, { x: 0, y: 0 }),
      workflowNode('check', 'review', { valueType: 'text' }, { value: output('describe') }, { x: 260, y: 0 }),
      workflowNode('generate', 'image.generate', { adapterId: imageAdapter, parameters: {} }, { prompt: output('check'), images: { kind: 'item' } }, { x: 520, y: 0 }),
    ], outputs: { description: output('check'), images: output('generate') } } }, { items: output('images'), instruction: output('instruction') }, { x: 300, y: 40 }),
  ], outputs: {}, resultSteps: ['check', 'generate'] };
  return nameAll(definition, { images: '待处理图片', instruction: '描述要求', batch: '逐张反推并生图', describe: '理解图片', check: '确认提示词', generate: '生成图片' });
}

export function captionAndSaveExample({ textAdapter = 'grok-text' } = {}) {
  const definition = { schemaVersion: 1, nodes: [
    workflowNode('images', 'element', { source: 'runtime', parameter: 'images', valueType: 'list<image>', required: true, allowEmpty: false }, {}, { x: 0, y: 0 }),
    workflowNode('batch', 'foreach', { itemsType: 'list<image>', maxItems: 1000, captureTypes: {}, body: { nodes: [
      workflowNode('describe', 'model', { adapterId: textAdapter, outputType: 'text' }, { prompt: constant('请用一两句话描述这张图片的主要内容。'), images: { kind: 'item' } }, { x: 0, y: 0 }),
      workflowNode('save', 'library.save', { valueType: 'text', tags: ['工作流'], source: '工作流产物' }, { value: output('describe') }, { x: 280, y: 0 }),
    ], outputs: { caption: output('describe') } } }, { items: output('images') }, { x: 300, y: 0 }),
  ], outputs: {}, resultSteps: ['describe', 'save'] };
  return nameAll(definition, { images: '一批图片', batch: '逐张写描述', describe: 'AI 看图写字', save: '存进资料库' });
}

export function oneShotGenerateExample({ imageAdapter = 'grok-build' } = {}) {
  const definition = { schemaVersion: 1, nodes: [
    workflowNode('prompt', 'element', { source: 'runtime', parameter: 'prompt', valueType: 'text', required: true, default: '' }, {}, { x: 0, y: 0 }),
    workflowNode('generate', 'image.generate', { adapterId: imageAdapter, parameters: {} }, { prompt: output('prompt'), images: constant([]) }, { x: 280, y: 0 }),
    workflowNode('pick', 'review', { valueType: 'list<image>' }, { value: output('generate') }, { x: 560, y: 0 }),
    workflowNode('save', 'library.save', { valueType: 'list<image>', tags: ['工作流'], source: '工作流产物' }, { value: output('pick') }, { x: 840, y: 0 }),
  ], outputs: {}, resultSteps: ['generate', 'pick', 'save'] };
  return nameAll(definition, { prompt: '一句话描述', generate: 'AI 生成图片', pick: '挑选满意的图', save: '存进资料库' });
}

export function polishTextExample({ textAdapter = 'grok-text' } = {}) {
  const definition = { schemaVersion: 1, nodes: [
    workflowNode('texts', 'element', { source: 'runtime', parameter: 'texts', valueType: 'list<text>', required: true, allowEmpty: false }, {}, { x: 0, y: 0 }),
    workflowNode('batch', 'foreach', { itemsType: 'list<text>', maxItems: 1000, captureTypes: {}, body: { nodes: [
      workflowNode('rewrite', 'model', { adapterId: textAdapter, outputType: 'text' }, { prompt: { kind: 'text', parts: [{ kind: 'text', text: '请润色下面这段文字，保持原意，使表达更清晰自然：\n\n' }, { kind: 'ref', ref: { kind: 'item' } }] }, images: constant([]) }, { x: 0, y: 0 }),
      workflowNode('save', 'library.save', { valueType: 'text', tags: ['工作流'], source: '工作流产物' }, { value: output('rewrite') }, { x: 280, y: 0 }),
    ], outputs: { polished: output('rewrite') } } }, { items: output('texts') }, { x: 300, y: 0 }),
  ], outputs: {}, resultSteps: ['rewrite', 'save'] };
  return nameAll(definition, { texts: '多段文字', batch: '逐段润色', rewrite: 'AI 改写', save: '存进资料库' });
}

export function translateTextExample({ textAdapter = 'grok-text' } = {}) {
  const definition = { schemaVersion: 1, nodes: [
    workflowNode('source', 'element', { source: 'runtime', parameter: 'source', valueType: 'text', required: true, default: '' }, {}, { x: 0, y: 0 }),
    workflowNode('lang', 'element', { source: 'fixed', parameter: 'lang', valueType: 'text', default: '英文' }, {}, { x: 0, y: 160 }),
    workflowNode('translate', 'model', { adapterId: textAdapter, outputType: 'text' }, { prompt: { kind: 'text', parts: [{ kind: 'text', text: '请把下面的文字翻译成' }, { kind: 'ref', ref: output('lang') }, { kind: 'text', text: '：\n\n' }, { kind: 'ref', ref: output('source') }] }, images: constant([]) }, { x: 300, y: 40 }),
    workflowNode('check', 'review', { valueType: 'text' }, { value: output('translate') }, { x: 580, y: 40 }),
    workflowNode('save', 'library.save', { valueType: 'text', tags: ['翻译'], source: '工作流产物' }, { value: output('check') }, { x: 860, y: 40 }),
  ], outputs: {}, resultSteps: ['translate', 'check', 'save'] };
  return nameAll(definition, { source: '原文', lang: '目标语言', translate: 'AI 翻译', check: '我来确认', save: '存进资料库' });
}

/** Client-side starter templates (same definition shape as the server examples). */
export function workflowTemplates({ textAdapter = 'grok-text', imageAdapter = 'grok-build' } = {}) {
  return [
    { id: 'caption-save', name: '批量看图写描述', blurb: '一批图片 → AI 写描述 → 存进资料库', flow: ['一批图片', 'AI 写描述', '存进资料库'], definition: captionAndSaveExample({ textAdapter }) },
    { id: 'describe-images', name: '批量反推并生图', blurb: '一批图片 → AI 写提示词 → 我确认 → AI 生图', flow: ['一批图片', 'AI 写提示词', '我确认', 'AI 生图'], definition: describeImagesExample({ textAdapter, imageAdapter }) },
    { id: 'one-shot', name: '一句话生图并挑选', blurb: '一句话 → AI 生图 → 我挑选 → 存进资料库', flow: ['一句话', 'AI 生图', '我挑选', '存进资料库'], definition: oneShotGenerateExample({ imageAdapter }) },
    { id: 'polish', name: '文字润色', blurb: '多段文字 → AI 改写 → 存进资料库', flow: ['多段文字', 'AI 改写', '存进资料库'], definition: polishTextExample({ textAdapter }) },
    { id: 'translate', name: '翻译并确认', blurb: '原文 → AI 翻译 → 我确认 → 存进资料库', flow: ['原文', 'AI 翻译', '我确认', '存进资料库'], definition: translateTextExample({ textAdapter }) },
  ];
}
