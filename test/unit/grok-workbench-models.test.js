import test from 'node:test';
import assert from 'node:assert/strict';
import { grokWorkbenchModels } from '../../src/agent/engines/grokWorkbench.js';

const state = {
  currentModelId: 'grok-4.7',
  availableModels: [
    { modelId: 'grok-4.7', name: 'Grok 4.7' },
    { modelId: ' grok-4.7 ', name: '重复' },
    { modelId: 'grok-4.7-build-fast', name: 'Grok 4.7 Fast' },
    { modelId: 'grok-4.6', name: 'Grok 4.6' },
    { modelId: '', name: '空' },
    { name: '缺 ID' },
  ],
};

test('workbench model catalog keeps Grok labels and prefers the configured id', () => {
  const result = grokWorkbenchModels(state, 'grok-4.6');
  assert.deepEqual(result.models, [
    { id: 'grok-4.7', label: 'Grok 4.7' },
    { id: 'grok-4.7-build-fast', label: 'Grok 4.7 Fast' },
    { id: 'grok-4.6', label: 'Grok 4.6' },
  ]);
  assert.equal(result.defaultModel, 'grok-4.6');
});

test('workbench model catalog falls back to the CLI current model', () => {
  assert.equal(grokWorkbenchModels(state, 'missing').defaultModel, 'grok-4.7');
  assert.throws(() => grokWorkbenchModels({ availableModels: [] }, 'grok-4.6'), /未返回可用模型/);
});
