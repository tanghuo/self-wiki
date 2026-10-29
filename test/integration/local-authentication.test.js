import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../../src/server/server.js';
import { createLocalAuthentication } from '../../src/server/application/localAuthentication.js';
import { childEnvironment } from '../../src/shared/runtime/childEnvironment.js';
import { connect } from '../../src/cli/client.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-local-auth-'));
  const app = await createServer({ port: 0, dataDir: root });
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('wiki-local-auth-'));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { app, root, request: (route, options) => fetch(new URL(route, app.url), options) };
}

test('private local APIs require credentials; static pages and health never mint a cookie', async t => {
  const f = await fixture(t);
  for (const route of ['/api/instance', '/api/elements', '/api/organization/status', '/api/chat/sessions/1/events', '/api/workflow-artifacts/1/content', '/api/agent/sessions/1/events', '/image']) {
    const response = await f.request(route);
    assert.equal(response.status, 401, route);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  const health = await f.request('/api/health');
  assert.deepEqual(await health.json(), { ok: true, application: 'self-wiki' });
  assert.equal(health.headers.get('set-cookie'), null);
  assert.equal((await f.request('/')).headers.get('set-cookie'), null);
  assert.equal((await f.request('/api/instance', { headers: f.app.managementHeaders() })).status, 200);
  assert.equal((await f.request('/api/organization/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
});

test('bootstrap is single-use, no-store, HttpOnly and independent of CLI/tool bearers', async t => {
  const f = await fixture(t), code = f.app.createBootstrapCode();
  const redeem = value => f.request('/api/auth/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: value }) });
  assert.equal((await redeem('invalid')).status, 401);
  const response = await redeem(code);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.equal((await redeem(code)).status, 401);
  assert.equal((await f.request('/api/instance', { headers: { cookie } })).status, 200);
  assert.equal((await f.request('/api/instance', { headers: { authorization: `Bearer ${code}` } })).status, 401);
  assert.equal((await f.request('/api/instance', { headers: { authorization: 'Bearer application-tool-token', 'x-self-wiki-chat-token': 'invalid', 'x-self-wiki-chat-call': 'invalid' } })).status, 401);
  assert.equal((await f.request('/api/auth/code')).status, 401);
  assert.equal((await f.request('/api/instance', { headers: { ...f.app.managementHeaders(), origin: 'https://example.com' } })).status, 403);
});

test('credentials live outside the project API, are removed on close and rotate on restart', async t => {
  const f = await fixture(t), headers = f.app.managementHeaders(), oldCode = f.app.createBootstrapCode();
  const credentials = JSON.parse(await readFile(f.app.credentialFile, 'utf8'));
  assert.equal(headers.authorization, `Bearer ${credentials.token}`);
  if (process.platform !== 'win32') assert.equal((await stat(f.app.credentialFile)).mode & 0o777, 0o600);
  const runtime = path.join(f.root, '.runtime');
  const instanceFile = (await readdir(runtime)).find(name => name.startsWith('server-'));
  assert.ok(!(await readFile(path.join(runtime, instanceFile), 'utf8')).includes(credentials.token));
  await f.app.close();
  assert.deepEqual(await readdir(runtime), []);
  const replacement = await createServer({ port: 0, dataDir: f.root });
  try {
    assert.equal((await fetch(new URL('/api/instance', replacement.url), { headers })).status, 401);
    assert.equal((await fetch(new URL('/api/auth/bootstrap', replacement.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: oldCode }) })).status, 401);
  } finally { await replacement.close(); }
});

test('bootstrap expiration and worker credentials fail closed without management authority', () => {
  let time = 1000;
  const auth = createLocalAuthentication({ now: () => time }), code = auth.createBootstrapCode();
  time += 60001;
  assert.throws(() => auth.redeem(code), { statusCode: 401 });
  const token = auth.createWorkerCredential(), req = { method: 'POST', headers: { authorization: `Bearer ${token}` } };
  assert.equal(auth.isManagement(req), false);
  assert.equal(auth.isWorker(req, new URL('http://localhost/api/organization/claim')), true);
  assert.equal(auth.isWorker(req, new URL('http://localhost/api/organization/config')), false);
  assert.equal(auth.isWorker(req, new URL('http://localhost/api/auth/code')), false);
  assert.equal(auth.isWorker(req, new URL('http://localhost/api/organization/results/1/accept')), false);
  auth.revokeWorkerCredential(token);
  assert.equal(auth.isWorker(req, new URL('http://localhost/api/organization/claim')), false);
});

test('CLI discovery authenticates, explicit URLs need a token source and pairing never returns the bearer', async t => {
  const f = await fixture(t);
  const client = await connect({ 'data-dir': f.root });
  assert.equal(client.instance.url, f.app.url);
  const pair = await client.request('/api/auth/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.match(pair.code, /^[\w-]{43}$/);
  assert.ok(!JSON.stringify(pair).includes(f.app.managementHeaders().authorization.slice(7)));
  const explicit = await connect({ url: f.app.url, 'token-file': f.app.credentialFile });
  assert.equal((await explicit.request('/api/instance')).instanceId, client.instance.instanceId);
  await assert.rejects(connect({ url: f.app.url, 'token-file': path.join(f.root, 'missing-credentials.json') }), { code: 'AUTH_REQUIRED' });
});

test('engine environments omit application, unrelated provider and proxy credentials', () => {
  assert.deepEqual(childEnvironment({ Path: 'system-path', USERPROFILE: 'user', GROK_HOME: 'grok-home', CODEX_HOME: 'codex-home', SELF_WIKI_CHAT_TOKEN: 'secret', SELF_WIKI_TOKEN_FILE: 'secret-path', XAI_API_KEY: 'secret', OPENAI_API_KEY: 'secret', HTTPS_PROXY: 'secret' }),
    { Path: 'system-path', USERPROFILE: 'user', GROK_HOME: 'grok-home', CODEX_HOME: 'codex-home' });
});
