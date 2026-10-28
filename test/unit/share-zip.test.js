import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareZip } from '../../src/server/assets/shareZip.js';

test('ZIP rejects POSIX names that Windows could interpret as traversal or absolute paths', async () => {
  for (const name of ['shared/..\\..\\outside.txt', '../outside', '/absolute', 'C:/outside', 'shared/../outside', 'shared/./file']) {
    await assert.rejects(async () => {
      for await (const _chunk of shareZip([{ name, directory: true }], new AbortController().signal)) { /* consume */ }
    }, /不安全/);
  }
});
