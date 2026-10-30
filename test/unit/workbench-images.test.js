import test from 'node:test';
import assert from 'node:assert/strict';
import { workbenchImageError, workbenchImageFiles } from '../../src/renderer/src/features/agentWorkbench/workbenchImages.js';

const file = (name, type, size = 10) => ({ name, type, size });

test('workbench image paste accepts png jpeg webp within the existing limits', () => {
  assert.equal(workbenchImageError([file('a.png', 'image/png'), file('b.jpg', 'image/jpeg')], 6), '');
  assert.equal(workbenchImageError([file('c.webp', '')], 0), '');
  assert.match(workbenchImageError([file('d.gif', 'image/gif')], 0), /PNG、JPEG、WebP/);
  assert.match(workbenchImageError([file('e.png', 'image/png', 26 * 1024 * 1024)], 0), /25 MiB/);
  assert.match(workbenchImageError([file('f.png', 'image/png')], 8), /最多 8 张/);
  assert.equal(workbenchImageError([], 0), '');
});

test('workbench image paste reads clipboard image files', () => {
  const png = file('shot.png', 'image/png');
  assert.deepEqual(workbenchImageFiles({ files: [png], items: [] }), [png]);
  assert.deepEqual(workbenchImageFiles(null), []);
});
