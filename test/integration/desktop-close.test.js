import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';

test('Electron handles real beforeunload vetoes for window Close and application Quit', { timeout: 20000, skip: process.platform !== 'win32' && 'Windows desktop smoke test' }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wiki-desktop-close-'));
  t.after(async () => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('wiki-desktop-close-')); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); });
  const env = { ...process.env, WIKI_CLOSE_TEST_DIR: dir }; delete env.ELECTRON_RUN_AS_NODE;
  const result = await promisify(execFile)(electron, [path.resolve(import.meta.dirname, '../fixtures/desktop-close.cjs')], { windowsHide: true, env, timeout: 15000 });
  assert.match(result.stdout, /desktop close guard smoke ok/);
});
