import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preferredModel, rememberModel, rememberedModel } from '../../src/renderer/src/features/agentWorkbench/workbenchModelMemory.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: key => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, String(value)) };
}

test('a new task prefers the last model chosen for that engine', () => {
  const storage = memoryStorage();
  rememberModel('grok-build', 'grok-4.5', storage);
  rememberModel('codex-cli', 'gpt-5', storage);
  assert.equal(rememberedModel('grok-build', storage), 'grok-4.5');
  assert.equal(preferredModel('grok-build', { models: [{ id: 'grok-4.7' }], defaultModel: 'grok-4.7' }, storage), 'grok-4.5');
  assert.equal(preferredModel('codex-cli', { defaultModel: 'codex-default' }, storage), 'gpt-5');
  assert.equal(preferredModel('antigravity-acp', { models: [{ id: 'gemini' }], sessionModel: 'session-gemini', defaultModel: 'gemini' }, storage), 'session-gemini');
  assert.equal(preferredModel('grok-build', { current: 'grok-4.7', sessionModel: 'grok-4.5', defaultModel: 'grok-4.6' }, storage), 'grok-4.7');
});

test('invalid stored model choices are ignored', () => {
  const storage = memoryStorage({ workbenchLastModel: JSON.stringify({ 'grok-build': '  ', bad: 1, ok: 'kept-model' }) });
  assert.equal(rememberedModel('grok-build', storage), '');
  assert.equal(rememberedModel('ok', storage), 'kept-model');
  assert.equal(preferredModel('missing', { models: [] }, storage), '');
  rememberModel('', 'grok-4.5', storage);
  rememberModel('grok-build', '   ', storage);
  assert.equal(rememberedModel('grok-build', storage), '');
});
