import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandComfyuiSubgraphs } from '../../src/agent/executors/comfyuiSubgraphs.js';
import { convertComfyuiWorkflow, describeComfyuiWorkflow } from '../../src/agent/executors/comfyuiWorkflows.js';
import { configuredComfyuiWorkflow } from '../../src/shared/domain/comfyui.js';

const infos = {
  Encode: { input: { required: { prompt: ['STRING'], seed: ['INT', { control_after_generate: true }], images: ['COMFY_AUTOGROW_V3', { template: { input: { required: { image: ['IMAGE'] } }, names: ['image_1', 'image_2'], min: 0 } }] } }, output: ['IMAGE'] },
  LoadImage: { input: { required: { image: [['reference.png'], { image_upload: true }] } }, output: ['IMAGE', 'MASK'] },
  Save: { input: { required: { images: ['IMAGE'] } }, output: [], output_node: true },
};

function workflow() {
  return {
    nodes: [
      { id: 1, type: 'LoadImage', widgets_values: ['reference.png', 'image'] },
      { id: 2, type: 'subgraph', inputs: [{ name: 'prompt', type: 'STRING', widget: { name: 'prompt' }, link: null }, { name: 'seed', type: 'INT', widget: { name: 'seed' }, link: null }, { name: 'image', type: 'IMAGE', link: 1 }], widgets_values: ['host prompt', 123] },
      { id: 3, type: 'Save', inputs: [{ name: 'images', type: 'IMAGE', link: 2 }] },
    ],
    links: [[1, 1, 0, 2, 2, 'IMAGE'], [2, 2, 0, 3, 0, 'IMAGE']],
    definitions: { subgraphs: [{ id: 'subgraph', inputNode: { id: -10 }, outputNode: { id: -20 },
      inputs: [{ name: 'prompt' }, { name: 'seed' }, { name: 'image' }], outputs: [{ name: 'images' }],
      nodes: [{ id: 1, type: 'Encode', inputs: [{ name: 'prompt', type: 'STRING', widget: { name: 'prompt' }, link: 1 }, { name: 'seed', type: 'INT', widget: { name: 'seed' }, link: 2 }, { name: 'images.image_1', type: 'IMAGE', link: 3 }, { name: 'images.image_2', type: 'IMAGE', link: null }], widgets_values: ['definition prompt', 42, 'randomize'] }],
      links: [{ id: 1, origin_id: -10, origin_slot: 0, target_id: 1, target_slot: 0, type: 'STRING' }, { id: 2, origin_id: -10, origin_slot: 1, target_id: 1, target_slot: 1, type: 'INT' }, { id: 3, origin_id: -10, origin_slot: 2, target_id: 1, target_slot: 2, type: 'IMAGE' }, { id: 4, origin_id: 1, origin_slot: 0, target_id: -20, target_slot: 0, type: 'IMAGE' }],
    }] },
  };
}

test('subgraph expansion preserves host widgets, seed controls, image links and output mappings without mutating the source', () => {
  const graph = workflow(), before = structuredClone(graph), result = convertComfyuiWorkflow(graph, infos);
  assert.deepEqual(graph, before);
  assert.deepEqual(result['2:1'].inputs, { prompt: 'host prompt', seed: 123, 'images.image_1': ['1', 0] });
  assert.deepEqual(result['3'].inputs.images, ['2:1', 0]);
  assert.deepEqual(result['1'].inputs, { image: 'reference.png' });
  const description = describeComfyuiWorkflow(result, infos);
  assert.deepEqual(description.prompt, { nodeId: '2:1', input: 'prompt' });
  assert.equal(description.outputNodeId, '3');
  assert.deepEqual(Object.keys(configuredComfyuiWorkflow({ workflow: result, prompt: description.prompt, outputNodeId: '3', imageInputs: [{ nodeId: '1', input: 'image' }] })).sort(), ['1', '2:1', '3']);
});

test('reused subgraph definitions have independent IDs, named values and external links', () => {
  const graph = workflow(), second = structuredClone(graph.nodes[1]);
  second.id = 4; second.widgets_values_named = { prompt: 'second prompt', seed: 456 }; second.inputs[2].link = null;
  graph.nodes.push(second);
  const result = convertComfyuiWorkflow(graph, infos);
  assert.equal(result['2:1'].inputs.prompt, 'host prompt');
  assert.deepEqual(result['4:1'].inputs, { prompt: 'second prompt', seed: 456 });
});

test('external links override promoted widgets and nested boundaries resolve through each instance', () => {
  const graph = workflow(), inner = graph.definitions.subgraphs[0];
  const wrapper = { id: 'wrapper', inputNode: { id: -10 }, outputNode: { id: -20 }, inputs: structuredClone(inner.inputs), outputs: structuredClone(inner.outputs),
    nodes: [{ ...structuredClone(graph.nodes[1]), id: 7, inputs: graph.nodes[1].inputs.map((input, slot) => ({ ...input, link: slot + 1 })), widgets_values: ['ignored nested value', 999] }],
    links: [
      [1, -10, 0, 7, 0, 'STRING'], [2, -10, 1, 7, 1, 'INT'], [3, -10, 2, 7, 2, 'IMAGE'], [4, 7, 0, -20, 0, 'IMAGE'],
    ],
  };
  graph.definitions.subgraphs.push(wrapper); graph.nodes[1].type = 'wrapper';
  const result = convertComfyuiWorkflow(graph, infos);
  assert.deepEqual(result['2:7:1'].inputs, { prompt: 'host prompt', seed: 123, 'images.image_1': ['1', 0] });
  assert.deepEqual(result['3'].inputs.images, ['2:7:1', 0]);
});

test('null promoted values retain interior defaults; named values and seed controls remain aligned', () => {
  const graph = workflow(); graph.nodes[1].widgets_values = [null, 876, 'fixed'];
  const result = convertComfyuiWorkflow(graph, infos);
  assert.equal(result['2:1'].inputs.prompt, 'definition prompt');
  assert.equal(result['2:1'].inputs.seed, 876);
  assert.equal(result['2:1']._meta.seedControls.seed.mode, 'fixed');
  graph.nodes[1].widgets_values_named = { prompt: 'named', seed: 5, control_after_generate: 'fixed' };
  assert.equal(convertComfyuiWorkflow(graph, infos)['2:1']._meta.seedControls.seed.mode, 'fixed');
});

test('invalid recursive subgraphs, broken boundaries and expanded ID collisions fail explicitly', () => {
  const recursive = workflow(); recursive.definitions.subgraphs[0].nodes[0].type = 'subgraph';
  assert.throws(() => expandComfyuiSubgraphs(recursive), /递归/);
  const broken = workflow(); broken.definitions.subgraphs[0].links.pop();
  assert.throws(() => expandComfyuiSubgraphs(broken), /输出缺少唯一/);
  const collision = workflow(); collision.nodes.push({ id: '2:1', type: 'LoadImage', widgets_values: ['reference.png'] });
  assert.throws(() => convertComfyuiWorkflow(collision, infos), /重复/);
});

test('muted and bypassed subgraph hosts do not expand or require their internal node schemas', () => {
  for (const mode of [2, 4]) {
    const graph = workflow(); graph.nodes[1].mode = mode; graph.nodes[1].outputs = [{ type: 'IMAGE' }];
    const result = expandComfyuiSubgraphs(graph).value;
    assert.equal(result.nodes.length, 3);
    assert.ok(!result.nodes.some((node) => String(node.id).includes(':')));
  }
});

test('modern dynamic selectors serialize only the active branch, including nested widgets', () => {
  const info = { input: { required: { format: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'png', inputs: { required: { depth: [['8', '16']] } } }, { key: 'jpg', inputs: { required: {} } }] }] } }, output: ['IMAGE'] };
  const graph = { nodes: [{ id: 1, type: 'Dynamic', inputs: [], widgets_values: ['png', '16'] }], links: [] };
  const result = convertComfyuiWorkflow(graph, { Dynamic: info });
  assert.deepEqual(result['1'].inputs, { format: 'png', 'format.depth': '16' });
  assert.deepEqual(describeComfyuiWorkflow(result, { Dynamic: info }).fields.map((field) => field.input), ['format.depth']);
  graph.nodes[0].widgets_values = ['invalid'];
  assert.throws(() => convertComfyuiWorkflow(graph, { Dynamic: info }), /动态选项/);
});

test('legacy proxy widgets override their own interior node and retain defaults when unsaved', () => {
  const graph = workflow();
  graph.nodes[1].properties = { proxyWidgets: [['1', 'prompt'], ['1', 'seed'], ['1', 'control_after_generate']] };
  graph.nodes[1].widgets_values = ['proxy prompt', 888, 'randomize'];
  // Legacy promotions do not use boundary links for the promoted widgets.
  graph.definitions.subgraphs[0].nodes[0].inputs[0].link = null;
  graph.definitions.subgraphs[0].nodes[0].inputs[1].link = null;
  assert.equal(convertComfyuiWorkflow(graph, infos)['2:1'].inputs.prompt, 'proxy prompt');
  assert.equal(convertComfyuiWorkflow(graph, infos)['2:1'].inputs.seed, 888);
  assert.equal(convertComfyuiWorkflow(graph, infos)['2:1']._meta.seedControls.seed.mode, 'randomize');
  graph.nodes[1].widgets_values = [];
  assert.equal(convertComfyuiWorkflow(graph, infos)['2:1'].inputs.seed, 42);
});

test('new server widget defaults are used only when the saved workflow has no value', () => {
  const info = { input: { required: { count: ['INT', { default: 5 }], format: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'png', inputs: { required: {} } }] }] } }, output: [] };
  for (const node of [{ id: 1, type: 'New', widgets_values: [0] }, { id: 1, type: 'New', widgets_values: [0], widgets_values_named: { count: 0 } }]) {
    assert.deepEqual(convertComfyuiWorkflow({ nodes: [node], links: [] }, { New: info })['1'].inputs, { count: 0, format: 'png' });
  }
});

test('scalar boundary inputs pass through reroutes and direct subgraph outputs', () => {
  const graph = workflow(), definition = graph.definitions.subgraphs[0];
  definition.nodes.push({ id: 8, type: 'Reroute', inputs: [{ name: '', type: 'STRING', link: 1 }] });
  definition.links[0].target_id = 8; definition.links[0].target_slot = 0;
  definition.links.push([5, 8, 0, 1, 0, 'STRING']);
  definition.nodes[0].inputs[0].link = 5;
  assert.equal(convertComfyuiWorkflow(graph, infos)['2:1'].inputs.prompt, 'host prompt');
});

test('a unique image saver is selected ahead of comparison outputs while multiple savers remain explicit', () => {
  const graph = { '1': { class_type: 'SaveImageAdvanced', inputs: {} }, '2': { class_type: 'ImageCompare', inputs: {} } };
  const schemas = { SaveImageAdvanced: { input: {}, output_node: true }, ImageCompare: { input: {}, output_node: true } };
  assert.equal(describeComfyuiWorkflow(graph, schemas).outputNodeId, '1');
  graph['3'] = { class_type: 'SaveImageAdvanced', inputs: {} };
  assert.equal(describeComfyuiWorkflow(graph, schemas).outputNodeId, '');
});
