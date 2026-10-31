import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerGoogleAgent } from '../../tools/aionui-google-agent.mjs';

test('missing Google ACP is optional; installed agents are reused or registered', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-aionui-google-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('wiki-aionui-google-')); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const executable = path.join(root, 'google.exe'), calls = [];
  const api = async (route, options) => { calls.push({ route, options }); return { id: 'new', ...JSON.parse(options.body) }; };
  assert.equal(await registerGoogleAgent({ api, agents: [], executable }), null);
  assert.equal(calls.length, 0);
  await writeFile(executable, 'fixture');
  const existing = { id: 'old', name: 'Google 官方 ACP · self-wiki', agent_source: 'custom', command: executable, args: [] };
  assert.equal(await registerGoogleAgent({ api, agents: [existing], executable }), existing);
  assert.equal(calls.length, 0);
  const created = await registerGoogleAgent({ api, agents: [], executable });
  assert.equal(created.command, executable);
  assert.equal(calls[0].options.method, 'POST');
  await registerGoogleAgent({ api, agents: [{ ...existing, command: 'obsolete' }], executable });
  assert.equal(calls[1].route, '/api/agents/custom/old');
  assert.equal(calls[1].options.method, 'PUT');
});
