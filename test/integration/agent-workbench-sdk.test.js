import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGrokSdkTools } from '../../src/agent/engines/grokSdkTools.js';
import { verifyWorkbenchMcpCatalog } from '../../src/agent/engines/grokMcpPolicy.js';

test('stdio SDK tools have no bearer and bind execution to the active turn and declared catalog', async () => {
  let calls = 0;
  const sdk = createGrokSdkTools([{ name: 'wiki_search', description: 'fixture', inputSchema: { type: 'object' } }], async call => { calls++; return { owner: call.owner, query: call.input.query }; });
  assert.deepEqual(Object.keys(sdk.definition).sort(), ['name', 'serverId']);
  const message = (method, params) => ({ serverId: sdk.definition.serverId, message: { jsonrpc: '2.0', id: 1, method, params } });
  await sdk.request(message('initialize', {})); assert.equal(sdk.initialized, true);
  assert.equal((await sdk.request(message('tools/list', {}))).result.tools[0].name, 'wiki_search');
  const input = message('tools/call', { name: 'wiki_search', arguments: { query: 'hello' } });
  await assert.rejects(sdk.request(input), /活动轮次/);
  sdk.begin({ owner: 7 }); const value = await sdk.request(input); assert.match(value.result.content[0].text, /"owner":7/); assert.equal(calls, 1);
  await assert.rejects(sdk.request({ ...input, serverId: 'other-server' }), /不匹配/);
  await assert.rejects(sdk.request(message('tools/call', { name: 'management_api', arguments: {} })), /声明范围/);
  sdk.end(); await assert.rejects(sdk.request(input), /活动轮次/); assert.equal(calls, 1);
});
test('MCP catalog must resolve fully and excludes all external servers, including a same-name impersonator', () => {
  const definition = { name: 'self_wiki', serverId: 'fixture' };
  assert.equal(verifyWorkbenchMcpCatalog({ sessionMcpResolved: true, servers: [] }).transport, 'none');
  assert.throws(() => verifyWorkbenchMcpCatalog({ sessionMcpResolved: true, servers: [{ name: 'foreign', session: { enabled: true } }] }), /其他 MCP/);
  assert.throws(() => verifyWorkbenchMcpCatalog({ servers: [] }, definition), /尚未就绪/);
  assert.equal(verifyWorkbenchMcpCatalog({ servers: [{ name: 'self_wiki', type: 'stdio', command: '', args: [], env: [], session: { enabled: true, status: 'ready' } }], sessionMcpResolved: true }, definition).transport, 'acp');
  for (const name of ['other', 'self_wiki']) assert.throws(() => verifyWorkbenchMcpCatalog({ sessionMcpResolved: true, servers: [{ name, type: 'http', session: { enabled: true } }] }, definition), /其他 MCP/);
});
