import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openGrokWorkbench } from '../../src/agent/engines/grokWorkbench.js';

// Grok Build's ACP advertises promptCapabilities without `image`, as the
// upstream acp_agent.rs does, while session/prompt still consumes image blocks.
const fakeGrok = (home, log) => `
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
if (process.argv.includes('--version')) { console.log('grok 9.9.9 (fixture)'); process.exit(0); }
const home = ${JSON.stringify(home)}, log = ${JSON.stringify(log)};
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
let buffer = '', model = '', effort = '';
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', chunk => {
  buffer += chunk; let end;
  while ((end = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
    const { id, method, params } = JSON.parse(line); if (id === undefined) continue;
    if (method === 'initialize') send({ id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { embeddedContext: true } }, authMethods: [{ id: 'cached_token' }], _meta: {} } });
    else if (method === 'authenticate') send({ id, result: {} });
    else if (method === 'session/new') {
      const sessionId = randomUUID(), folder = path.join(home, 'sessions', encodeURIComponent(params.cwd), sessionId);
      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, 'summary.json'), JSON.stringify({ agent_name: process.env.GROK_AGENT }));
      send({ id, result: { sessionId } });
    } else if (method === '_x.ai/mcp/list') send({ id, result: { sessionMcpResolved: true, servers: [] } });
    else if (method === 'session/set_config_option') {
      if (params.configId === 'model') model = params.value; else effort = params.value;
      send({ id, result: { configOptions: [{ id: 'model', currentValue: model }, { id: 'reasoning_effort', currentValue: effort }] } });
    } else if (method === 'session/prompt') {
      const images = params.prompt.filter(block => block.type === 'image');
      appendFileSync(log, JSON.stringify(images.map(block => block.mimeType)) + '\\n');
      send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'images:' + images.length } } } });
      send({ id, result: { stopReason: 'end_turn' } });
    } else send({ id, error: { code: -32601, message: 'unsupported ' + method } });
  }
});
`;

test('Grok workbench sends pasted images although ACP initialize omits promptCapabilities.image', { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-grok-images-'));
  const home = path.join(root, 'grok-home'), cwd = path.join(root, 'project'), neutral = path.join(root, 'neutral'), log = path.join(root, 'prompts.log');
  await mkdir(path.join(home, 'sessions'), { recursive: true }); await mkdir(cwd); await mkdir(neutral);
  const executable = path.join(root, 'grok.mjs'); await writeFile(executable, fakeGrok(home, log));
  const previous = process.env.GROK_HOME; process.env.GROK_HOME = home;
  // Node 24 runs after hooks in registration order. Close the fixture process
  // before removing its working directory, or Windows reports EBUSY and the
  // test runner waits on the still-open child.
  let engine;
  t.after(async () => {
    await engine?.close();
    if (previous === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = previous;
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('wiki-grok-images-'));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const events = [], deliveries = [];
  engine = await openGrokWorkbench({ executable, model: 'grok-fixture', effort: 'medium' }, { cwd, neutralCwd: neutral, onEvent: async (type, data) => { events.push({ type, data }); }, onRequest: async () => { throw new Error('unexpected'); }, onExit() {} });
  assert.equal(engine.capabilities.images, true);
  const image = { type: 'image', mimeType: 'image/jpeg', data: Buffer.from('fixture').toString('base64') };
  const result = await engine.prompt('这个什么问题?', value => deliveries.push(value), [image]);
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(deliveries, ['attempted']);
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), [['image/jpeg']]);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(events.some(event => event.type === 'message.delta' && event.data.text === 'images:1'));
});
