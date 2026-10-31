import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasRememberedApprovalMode, rememberApprovalMode, rememberedApprovalMode } from '../../src/renderer/src/features/agentWorkbench/workbenchApprovalMemory.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: key => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, String(value)) };
}

test('a new Grok task starts from the last approval mode', () => {
  const storage = memoryStorage();
  assert.equal(rememberedApprovalMode('grok-build', storage), 'ask');
  assert.equal(hasRememberedApprovalMode('grok-build', storage), false);
  rememberApprovalMode('grok-build', 'allow', storage);
  assert.equal(hasRememberedApprovalMode('grok-build', storage), true);
  assert.equal(rememberedApprovalMode('grok-build', storage), 'allow');
  rememberApprovalMode('grok-build', 'auto', storage);
  assert.equal(rememberedApprovalMode('grok-build', storage), 'auto');
  assert.equal(rememberedApprovalMode('codex-cli', storage), 'ask');
  assert.equal(rememberedApprovalMode('antigravity-acp', storage), 'ask');
});

test('approval memory ignores other engines and invalid values', () => {
  const storage = memoryStorage({ workbenchLastApprovalMode: JSON.stringify({ 'grok-build': 'yolo', 'codex-cli': 'allow' }) });
  assert.equal(rememberedApprovalMode('grok-build', storage), 'ask');
  rememberApprovalMode('codex-cli', 'allow', storage);
  rememberApprovalMode('grok-build', 'nope', storage);
  assert.equal(rememberedApprovalMode('grok-build', storage), 'ask');
  rememberApprovalMode('grok-build', 'allow', storage);
  assert.deepEqual(JSON.parse(storage.getItem('workbenchLastApprovalMode')), { 'grok-build': 'allow' });
});
