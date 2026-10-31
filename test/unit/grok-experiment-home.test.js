import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareGrokExperimentHome } from '../../src/agent/executors/grokExperimentHome.js';

test('experiment isolates npm installation, seeds login and preserves only its own old sessions', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-grok-home-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('wiki-grok-home-')); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const source = path.join(root, 'original'), directory = path.join(root, 'experiment');
  await mkdir(path.join(source, 'bin'), { recursive: true });
  await writeFile(path.join(source, 'bin/grok.exe'), 'original-binary');
  await writeFile(path.join(source, 'auth.json'), 'synthetic-login');
  const own = encodeURIComponent(path.join(directory, 'workspaces/project'));
  const other = encodeURIComponent(path.join(root, 'workbench'));
  const sibling = encodeURIComponent(path.join(directory, 'workspaces-other'));
  for (const name of [own, other, sibling]) {
    await mkdir(path.join(source, 'sessions', name), { recursive: true });
    await writeFile(path.join(source, 'sessions', name, 'history'), name);
  }
  const home = await prepareGrokExperimentHome(directory, source);
  assert.notEqual(home, source);
  assert.equal(await readFile(path.join(home, 'auth.json'), 'utf8'), 'synthetic-login');
  assert.equal(await readFile(path.join(home, 'sessions', own, 'history'), 'utf8'), own);
  for (const name of [other, sibling]) await assert.rejects(access(path.join(home, 'sessions', name)), { code: 'ENOENT' });
  await mkdir(path.join(home, 'bin'));
  await writeFile(path.join(home, 'bin/grok.exe'), 'npm-experiment-binary');
  assert.equal(await readFile(path.join(source, 'bin/grok.exe'), 'utf8'), 'original-binary');
  await writeFile(path.join(home, 'auth.json'), 'refreshed-experiment-login');
  await writeFile(path.join(home, 'sessions', own, 'history'), 'newer-history');
  await prepareGrokExperimentHome(directory, source);
  assert.equal(await readFile(path.join(home, 'auth.json'), 'utf8'), 'refreshed-experiment-login');
  assert.equal(await readFile(path.join(home, 'sessions', own, 'history'), 'utf8'), 'newer-history');
  await assert.rejects(prepareGrokExperimentHome(directory, home), /不能与原安装目录相同/);
});
