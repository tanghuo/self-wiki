import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchComfyuiImageSize } from '../../src/shared/domain/comfyuiParameters.js';
import { workflowReferenceImages } from '../../src/renderer/src/features/workflow/workflowReferenceImages.js';
import { workflowNode as n } from '../../src/shared/domain/workflow/examples.js';

const groups = { '16:9': ['1280×720', '1920×1080'], '9:16': ['720×1280', '1080×1920'], '3:4': ['768×1024', '1152×1536'], '1:1': ['1024×1024', '1536×1536'] };
const fields = [{ nodeId: 'size', input: '分辨率档位', optionsByInput: { input: '画幅比例', values: groups } }];
const graph = { size: { class_type: 'CharacterVideoImageSize', inputs: { '画幅比例': '16:9', '分辨率档位': '1920×1080', '自定义宽': 1280, '自定义高': 720 } } };

test('reference matching chooses the closest supported ratio and preserves the pixel budget', () => {
  const before = structuredClone(graph);
  const portrait = matchComfyuiImageSize(graph, fields, 400, 700);
  assert.deepEqual(portrait.matches, [{ nodeId: 'size', ratio: '9:16', resolution: '1080×1920' }]);
  assert.equal(portrait.workflow.size.inputs['画幅比例'], '9:16');
  assert.equal(matchComfyuiImageSize(graph, fields, 700, 1000).matches[0].ratio, '3:4');
  assert.equal(matchComfyuiImageSize(graph, fields, 1024, 1000).matches[0].ratio, '1:1');
  assert.equal(matchComfyuiImageSize(graph, fields, 700, 400).matches[0].ratio, '16:9');
  assert.deepEqual(graph, before, 'matching does not mutate the saved graph');
  const custom = structuredClone(graph); custom.size.inputs['分辨率档位'] = '自定义';
  assert.equal(matchComfyuiImageSize(custom, fields, 400, 700).matches[0].resolution, '720×1280');
  assert.throws(() => matchComfyuiImageSize(graph, fields, 0, 700), /尺寸/);
  assert.throws(() => matchComfyuiImageSize(graph, [], 400, 700), /没有可匹配/);
});

test('reference choices use current fixed and runtime images and keep artifact access bound to the run', () => {
  const definition = { nodes: [
    n('fixed', 'element', { source: 'fixed', parameter: 'fixed', valueType: 'list<image>', default: [{ elementId: 1 }] }),
    n('runtime', 'element', { source: 'runtime', parameter: 'runtime', valueType: 'image' }),
  ] };
  const run = { id: 9, definition: structuredClone(definition) };
  const inputs = { fixed: [{ artifactId: 'frozen' }], runtime: { attachmentId: 'uploaded' } };
  assert.deepEqual(workflowReferenceImages(definition, inputs).map(image => image.src), ['/api/elements/1/image', '/api/workflow-input-images/uploaded/media']);
  assert.equal(workflowReferenceImages(definition, inputs, run)[0].src, '/api/workflow-artifacts/frozen/media?runId=9');
  definition.nodes[0].config.default = [{ elementId: 2 }];
  assert.equal(workflowReferenceImages(definition, inputs, run)[0].src, '/api/elements/2/image');
});
