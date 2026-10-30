import test from 'node:test';
import assert from 'node:assert/strict';
import { grokEnvironment } from '../../src/agent/executors/grokEnvironment.js';
import { childEnvironment } from '../../src/shared/runtime/childEnvironment.js';

test('Grok explicitly uses local Clash without inheriting proxy credentials or bypass rules', () => {
  const parent = { Path: 'system', GROK_HOME: 'login', HTTPS_PROXY: 'http://user:secret@remote:80',
    https_proxy: 'http://other:80', NO_PROXY: '*', no_proxy: '*', XAI_API_KEY: 'secret', SELF_WIKI_CHAT_TOKEN: 'secret' };
  const result = grokEnvironment(parent);
  assert.deepEqual(result, { Path: 'system', GROK_HOME: 'login',
    HTTP_PROXY: 'http://127.0.0.1:7890', HTTPS_PROXY: 'http://127.0.0.1:7890', ALL_PROXY: 'http://127.0.0.1:7890',
    http_proxy: 'http://127.0.0.1:7890', https_proxy: 'http://127.0.0.1:7890', all_proxy: 'http://127.0.0.1:7890' });
  assert.equal(parent.NO_PROXY, '*');
  assert.deepEqual(childEnvironment(parent), { Path: 'system', GROK_HOME: 'login' });
});
