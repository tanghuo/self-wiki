import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rerunChanges } from '../../src/renderer/src/features/workflow/workflowRerun.js';
import { workflowNode as n, constant as c, output as o } from '../../src/shared/domain/workflow/examples.js';

test('multiple edited branches invalidate their union without invalidating independent results', () => {
  const definition = { nodes: [
    n('a', 'element', { source: 'runtime', parameter: 'a', valueType: 'text' }),
    n('b', 'element', { source: 'fixed', parameter: 'b', valueType: 'text', default: 'before' }),
    n('stable', 'preview', { valueType: 'text' }, { value: c('independent') }),
    n('join', 'template', { parts: [{ kind: 'ref', ref: o('a') }, { kind: 'ref', ref: o('b') }] }),
    n('review', 'review', { valueType: 'text' }, { value: o('join') }),
  ] };
  const run = { definition, inputs: { a: 'before', b: 'before' } };
  assert.equal(rerunChanges(run, definition, { a: 'before' }).affected.size, 0);
  const next = structuredClone(definition); next.nodes[1].config.default = 'after';
  const changes = rerunChanges(run, next, { a: 'after' });
  assert.deepEqual(changes.changed, ['a', 'b']);
  assert.deepEqual([...changes.affected].sort(), ['a', 'b', 'join', 'review']);
  assert.equal(run.definition.nodes[1].config.default, 'before');
});

test('changing an inner prompt reruns its containing loop and dependent saves', () => {
  const definition = { nodes: [
    n('loop', 'foreach', { itemsType: 'list<text>', body: { nodes: [n('model', 'model', {}, { prompt: c('before') })], outputs: {} } }, { items: c(['one']) }),
    n('downstream', 'preview', { valueType: 'json' }, { value: o('loop') }),
    n('stable', 'preview', { valueType: 'text' }, { value: c('independent') }),
  ] };
  const run = { definition, inputs: {} }, next = structuredClone(definition);
  next.nodes[0].config.body.nodes[0].inputs.prompt = c('after');
  assert.deepEqual([...rerunChanges(run, next, {}).affected].sort(), ['downstream', 'loop']);
});
