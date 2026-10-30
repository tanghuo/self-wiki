import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startGrokAcp } from '../../src/agent/executors/grokProcess.js';

test('Grok prompt timeout pauses for host decisions and resumes for model execution', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-grok-timeout-'));
  const executable = path.join(root, 'fixture.mjs');
  await writeFile(executable, `
    import readline from 'node:readline';
    const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
    let prompt;
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const value = JSON.parse(line);
      if (value.method === 'initialize') send({ id: value.id, result: {} });
      else if (value.method === 'session/prompt') {
        prompt = value;
        send({ id: 'host', method: 'session/request_permission', params: {} });
      } else if (value.id === 'host' && prompt.params.finish) send({ id: prompt.id, result: { stopReason: 'end_turn' } });
    });
  `);
  let release, requested;
  const arrived = () => new Promise(resolve => { requested = resolve; });
  const client = await startGrokAcp({ executable, model: 'fixture' }, { cwd: root, pausePromptTimeoutOnRequest: true,
    onRequest() { requested(); return new Promise(resolve => { release = resolve; }); },
  });
  t.after(async () => {
    await client.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('wiki-grok-timeout-'));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  await client.request('initialize');
  let host = arrived();
  const completed = client.request('session/prompt', { finish: true }, 150);
  let settled = false;
  completed.then(() => { settled = true; }, () => { settled = true; });
  await host;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(settled, false);
  release({});
  assert.equal((await completed).stopReason, 'end_turn');
  host = arrived();
  const hanging = client.request('session/prompt', { finish: false }, 150);
  const timedOut = assert.rejects(hanging, /Grok 请求超时：session\/prompt/);
  await host;
  release({});
  await timedOut;
});
