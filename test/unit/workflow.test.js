import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDefinition, safePath, matchesType, downstreamClosure, summarizeRun } from '../../src/shared/domain/workflow/contracts.js';
import { workflowNode as n, constant as c, output as o, describeImagesExample } from '../../src/shared/domain/workflow/examples.js';
import { checkJsonSchema } from '../../src/shared/domain/workflow/jsonSchema.js';
import { executionNode, editableDefinition, isRuntimeElement } from '../../src/shared/domain/workflow/contracts.js';
import { inferGraphTypes, setNodeBinding } from '../../src/renderer/src/features/workflow/workflowBindings.js';
import { editableTextParts } from '../../src/renderer/src/features/workflow/workflowText.js';
import { bindings, bindingHandle, preparedElements, outputVariables, outputBindingType } from '../../src/shared/domain/workflow/contracts.js';

test('workflow attachments are image input references, never managed artifacts or text references', () => {
  const attachment = { attachmentId: '00000000-0000-4000-8000-000000000000' };
  const graph = (type, value) => ({ schemaVersion: 1, nodes: [n('source', 'element', { source: 'fixed', parameter: 'source', valueType: type, default: value })], outputs: {} });
  assert.equal(validateDefinition(graph('image', attachment)).valid, true);
  assert.equal(validateDefinition(graph('list<image>', [attachment, { elementId: 1 }])).valid, true);
  assert.equal(validateDefinition(graph('text', attachment)).valid, false);
  assert.equal(validateDefinition(graph('image', { attachmentId: '../file.png' })).valid, false);
  assert.equal(validateDefinition(graph('image', { ...attachment, elementId: 1 })).valid, false);
  assert.equal(matchesType(attachment, 'image'), false, 'attachments must be prepared into run-bound artifacts before execution');
});

test('model output variables retain raw text and infer nested schema fields without extraction nodes', () => {
  const model = n('model', 'model', { outputType: 'json', jsonSchema: { type: 'object', properties: { title: { type: 'string' }, score: { type: 'number' }, details: { type: 'object', properties: { labels: { type: 'array', items: { type: 'string' } } } } } } }, { prompt: c('JSON') });
  const ref = (path = [], port = 'value') => ({ ...o('model'), port, path });
  assert.deepEqual(outputVariables(model).map((v) => [v.name, v.type]), [['text', 'text'], ['structured_output', 'json'], ['structured_output.title', 'text'], ['structured_output.score', 'number'], ['structured_output.details', 'json'], ['structured_output.details.labels', 'list<text>']]);
  assert.equal(outputBindingType(model, ref([], 'raw')), 'text');
  assert.equal(outputBindingType(model, ref(['title'])), 'text');
  assert.equal(outputBindingType(model, ref(['missing'])), undefined);
  const graph = { schemaVersion: 1, nodes: [model, n('answer', 'preview', { valueType: 'text' }, { value: ref(['title']) }), n('raw', 'preview', { valueType: 'text' }, { value: ref([], 'raw') })] };
  assert.deepEqual(validateDefinition(graph).errors, []);
  graph.nodes[1].inputs.value = ref(['score']);
  assert.ok(validateDefinition(graph).errors.some((e) => e.message.includes('需要 text，实际 number')));
  assert.equal(inferGraphTypes(graph).nodes[1].config.valueType, 'number');
  graph.nodes[1].inputs.value = ref(['__proto__']);
  assert.equal(validateDefinition(graph).valid, false);
  const legacy = n('legacy', 'model', { outputType: 'text' });
  assert.equal(outputBindingType(legacy, o('legacy')), 'text');
  assert.deepEqual(outputVariables(legacy), [{ name: 'text', type: 'text', port: 'text', path: [] }]);
  assert.equal(outputBindingType(legacy, { ...o('legacy'), port: 'text' }), 'text');
  assert.equal(outputBindingType(model, { ...o('model'), port: 'text' }), 'text', 'the text variable retains its meaning when structured output is enabled');
});

test('wiring into text appends references while preserving text and existing connections', () => {
  const original = n('combined', 'element', { source: 'fixed', valueType: 'text', parameter: 'combined', default: '前缀：' });
  const connected = setNodeBinding(original, 'template:new', { ...o('model'), port: 'text' });
  assert.equal(original.config.default, '前缀：');
  assert.equal(Object.hasOwn(connected.config, 'default'), false);
  assert.deepEqual(connected.config.parts, [{ kind: 'text', text: '前缀：' }, { kind: 'ref', ref: { ...o('model'), port: 'text' } }]);
  const appended = setNodeBinding({ ...connected, config: { ...connected.config, parts: [...connected.config.parts, { kind: 'text', text: '后缀' }] } }, 'template:new', o('other'));
  assert.equal(appended.config.parts.length, 4);
  assert.equal(bindingHandle(bindings(appended)[1].field), 'template:3');
  const disconnected = setNodeBinding(appended, 'template:1', null);
  assert.equal(disconnected.config.parts[0].text, '前缀：');
  assert.equal(disconnected.config.parts[2].text, '后缀');
  assert.deepEqual(disconnected.config.parts[3], { kind: 'ref', ref: o('other') });
  const reconnected = setNodeBinding(disconnected, 'template:1', o('replacement'));
  assert.deepEqual(reconnected.config.parts[1], { kind: 'ref', ref: o('replacement') });
  for (const config of [
    { source: 'runtime', valueType: 'text', default: '运行时填写' },
    { source: 'fixed', valueType: 'text', default: { elementId: 1 } },
    { source: 'fixed', valueType: 'list<image>', default: [] },
  ]) {
    const node = n('excluded', 'element', config);
    assert.equal(setNodeBinding(node, 'template:new', o('model')), node);
  }
});

test('inline text references have real edges, exact handles, type checking and cycle detection', () => {
  const d = { schemaVersion: 1, nodes: [n('a', 'element', { source: 'fixed', valueType: 'text', parts: [{ kind: 'text', text: '请翻译 ' }, { kind: 'ref', ref: o('b') }] }), n('b', 'element', { source: 'runtime', valueType: 'text', parameter: 'b' })] };
  assert.deepEqual(validateDefinition(d).errors, []);
  assert.deepEqual(preparedElements(d).map((node) => node.id), ['b']);
  assert.equal(bindingHandle(bindings(d.nodes[0])[0].field), 'template:1');
  assert.equal(bindingHandle('inputs.prompt.parts.3'), 'text:prompt:3');
  d.nodes[1] = n('b', 'element', { source: 'fixed', valueType: 'text', parts: [{ kind: 'ref', ref: o('a') }] });
  assert.ok(validateDefinition(d).errors.some((e) => e.message.includes('循环依赖')));
  d.nodes[1] = n('b', 'element', { source: 'runtime', valueType: 'image', parameter: 'b' });
  assert.ok(validateDefinition(d).errors.some((e) => e.message.includes('需要 text')));
});

test('text composition preserves literal braces, reference identities and order', () => {
  const a = { kind: 'ref', ref: o('a') }, b = { kind: 'ref', ref: o('b') };
  assert.deepEqual(editableTextParts([a, b]), [{ kind: 'text', text: '' }, a, { kind: 'text', text: '' }, b, { kind: 'text', text: '' }]);
  const parts = [{ kind: 'text', text: '{{同名}} 与 ' }, a, { kind: 'text', text: ' / ' }, b];
  assert.deepEqual(editableTextParts(parts), [...parts, { kind: 'text', text: '' }]);
  assert.deepEqual(editableTextParts([{ kind: 'text', text: '{{未插入的变量}}' }]), [{ kind: 'text', text: '{{未插入的变量}}' }]);
  assert.equal(parts.length, 4, 'opening the editor does not mutate the saved parts');
});

test('consumer and loop types follow connected content, including downstream edits', () => {
  const graph = { schemaVersion: 1, nodes: [
    n('source', 'element', { source: 'runtime', parameter: 'images', valueType: 'list<image>' }),
    n('check', 'review', { valueType: 'text' }, { value: o('source') }),
    n('save', 'library.save', { valueType: 'text' }, { value: o('check') }),
    n('loop', 'foreach', { itemsType: 'list<text>', maxItems: 1, captureTypes: { extra: 'text' }, body: { nodes: [], outputs: {} } }, { items: o('source'), extra: o('check') }),
  ] };
  const inferred = inferGraphTypes(graph);
  assert.deepEqual(inferred.nodes.slice(1, 3).map((node) => node.config.valueType), ['list<image>', 'list<image>']);
  assert.equal(inferred.nodes[3].config.itemsType, 'list<image>');
  assert.equal(inferred.nodes[3].config.captureTypes.extra, 'list<image>');
  assert.equal(graph.nodes[1].config.valueType, 'text', 'do not mutate history');
  assert.equal(inferGraphTypes(inferred), inferred, 'stable graphs retain identity for canvas rendering');
  const changed = { ...inferred, nodes: inferred.nodes.map((node) => node.id === 'source' ? { ...node, config: { ...node.config, valueType: 'list<text>' } } : node) };
  assert.equal(inferGraphTypes(changed).nodes[3].config.itemsType, 'list<text>');
});

test('list collection, selection and pairing infer types and direct loop connections create capture ports', () => {
  const source = n('source', 'element', { source: 'runtime', parameter: 'photos', valueType: 'list<image>' });
  const graph = { schemaVersion: 1, nodes: [source,
    n('pick', 'transform', { operation: 'nth', index: 0, valueType: 'text' }, { value: o('source') }),
    n('list', 'transform', { operation: 'list', keys: ['a', 'b'], valueType: 'list<text>' }, { a: o('pick'), b: o('pick') }),
    n('pair', 'transform', { operation: 'zip', valueType: 'list<json>' }, { a: o('source'), b: c(['a', 'b']) }),
    setNodeBinding(n('loop', 'foreach', { itemsType: 'list<image>', maxItems: 2, captureTypes: {}, body: { nodes: [], outputs: {} } }, { items: o('source') }), 'capture:new', o('pick')),
  ] };
  const inferred = inferGraphTypes(graph);
  assert.equal(inferred.nodes[1].config.valueType, 'image');
  assert.equal(inferred.nodes[2].config.valueType, 'list<image>');
  assert.equal(inferred.nodes[3].config.listType, 'list<image>');
  assert.equal(inferred.nodes[3].config.otherListType, 'list<text>');
  assert.equal(inferred.nodes[4].config.captureTypes.content_1, 'image');
  assert.deepEqual(validateDefinition(inferred).errors, []);
  assert.equal(inferGraphTypes(inferred), inferred);
  const legacy = editableDefinition({ schemaVersion: 1, nodes: [n('photo', 'element', { source: 'fixed', parameter: 'photo', valueType: 'image', default: { elementId: 1 } })] });
  assert.equal(legacy.nodes[0].config.valueType, 'list<image>');
  assert.deepEqual(legacy.nodes[0].config.default, [{ elementId: 1 }]);
});

test('legacy text concatenation opens as one text-composition contract and preserves separators and dependencies', () => {
  const graph = { schemaVersion: 1, nodes: [n('source', 'input', { parameter: 'text', valueType: 'text' }), n('join', 'transform', { operation: 'concat', valueType: 'text', keys: ['a', 'b'], separator: '\n' }, { a: c('固定文字'), b: o('source') })] };
  const edited = editableDefinition(graph);
  assert.equal(edited.nodes[1].type, 'element');
  assert.equal(edited.nodes[1].config.valueType, 'text');
  assert.deepEqual(edited.nodes[1].config.parts, [{ kind: 'text', text: '固定文字' }, { kind: 'text', text: '\n' }, { kind: 'ref', ref: o('source') }]);
  assert.deepEqual(validateDefinition(edited).errors, []);
  assert.equal(graph.nodes[1].type, 'transform');
  assert.deepEqual([...downstreamClosure(edited.nodes, ['source'])], ['source', 'join']);
});

test('editable legacy inputs become elements without changing historical snapshots or parameter keys', () => {
  const historical = { schemaVersion: 1, nodes: [n('old', 'input', { parameter: 'photos', valueType: 'list<image>', required: true })] };
  historical.nodes[0].name = '输入';
  const edited = editableDefinition(historical);
  assert.equal(edited.nodes[0].type, 'element');
  assert.equal(edited.nodes[0].config.parameter, 'photos');
  assert.equal(edited.nodes[0].name, '图片');
  assert.ok(isRuntimeElement(edited.nodes[0]));
  assert.equal(historical.nodes[0].type, 'input');
  assert.deepEqual(validateDefinition(edited).errors, []);
  edited.nodes[0].config.source = 'broken';
  assert.ok(validateDefinition(edited).errors.some((e) => e.field === 'config.source'));
});

test('workflow example serializes with binding-only dependencies and conservative call bounds', () => {
  const d = JSON.parse(JSON.stringify(describeImagesExample()));
  const report = validateDefinition(d);
  assert.deepEqual(report.errors, []);
  assert.equal(report.maxCalls, 2000);
  assert.equal(report.maxInstances, 3003);
  assert.equal(d.edges, undefined);
});
test('workflow types, missing bindings, cycles and scope escapes fail authoritatively', () => {
  const nodes = [n('a', 'preview', { valueType: 'text' }, { value: o('b') }), n('b', 'preview', { valueType: 'number' }, { value: o('a') })];
  const errors = validateDefinition({ schemaVersion: 1, nodes }).errors;
  assert.ok(errors.some((e) => e.message.includes('循环')));
  assert.ok(errors.some((e) => e.message.includes('需要 text')));
  const d = describeImagesExample();
  d.nodes[2].config.body.nodes[0].inputs.prompt = o('instruction');
  assert.ok(validateDefinition(d).errors.some((e) => e.message.includes('同作用域')));
  assert.equal(validateDefinition({ schemaVersion: 1, nodes: [n('p', 'preview', { valueType: 'text' })] }).valid, false);
});
test('workflow JSON paths never traverse prototypes; JSON/text and singleton/list images stay distinct', () => {
  assert.throws(() => safePath({}, ['constructor']), /字段不存在/);
  assert.throws(() => safePath({}, ['missing']), /字段不存在/);
  assert.equal(safePath({ a: [{ b: 'yes' }] }, ['a', 0, 'b']), 'yes');
  assert.equal(matchesType({ a: 1 }, 'text'), false);
  assert.equal(matchesType({ artifactId: 'x' }, 'list<image>'), false);
  assert.equal(matchesType({ artifactId: 'x', path: 'secret' }, 'image'), false);
});
test('workflow template references participate in invalidation and scheduling', () => {
  const graph = [n('a', 'input', { parameter: 'a', valueType: 'text' }), n('b', 'template', { parts: [{ kind: 'ref', ref: o('a') }] }), n('c', 'preview', { valueType: 'text' }, { value: o('b') }), n('d', 'preview', { valueType: 'text' }, { value: c('same') })];
  assert.deepEqual([...downstreamClosure(graph, ['a'])], ['a', 'b', 'c']);
});
test('workflow status prioritizes cancellation, unknown, pause and review', () => {
  assert.equal(summarizeRun([{ state: 'unknown' }], { cancelled: true }), 'cancelled');
  assert.equal(summarizeRun([{ state: 'unknown' }], { paused: true }), 'needs_attention');
  assert.equal(summarizeRun([{ state: 'waiting_review' }]), 'waiting_review');
  assert.equal(summarizeRun([{ state: 'failed' }]), 'failed');
});
test('model JSON validation rejects unsupported schema keywords and invalid field shapes', () => {
  const schema = { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } }, additionalProperties: false };
  assert.doesNotThrow(() => checkJsonSchema(schema, { prompt: 'good' }));
  assert.throws(() => checkJsonSchema(schema, { prompt: 42 }), /应为 string/);
  assert.throws(() => checkJsonSchema(schema, { prompt: 'ok', shell: 'no' }), /未声明字段/);
  assert.throws(() => checkJsonSchema({ ...schema, patternProperties: {} }, undefined, { validateOnly: true }), /不支持/);
});
test('display-only edits do not change a loop execution signature', () => {
  const d = describeImagesExample(), before = executionNode(d.nodes[2]);
  d.nodes[2].name = 'new label'; d.nodes[2].position = { x: 50, y: 75 };
  d.nodes[2].config.body.nodes[0].name = 'new child label';
  d.nodes[2].config.body.nodes[0].position = { x: 200, y: 300 };
  assert.deepEqual(executionNode(d.nodes[2]), before);
});
