import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAionuiExperiment } from '../../src/server/application/aionuiExperiment.js';
import { handleAionuiExperimentRoute } from '../../src/server/http/aionuiExperimentRoutes.js';

test('experiment does not start without prepared resources', async () => {
  const service = createAionuiExperiment({ root: path.join(os.tmpdir(), 'self-wiki-missing-aionui'), dataDir: os.tmpdir() });
  assert.equal((await service.status()).prepared, false);
  await assert.rejects(service.launch(), /尚未准备/);
  await service.close();
});

test('concurrent opens share one host, exchange separate login cookies, and stop their process', { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-aionui-'));
  const runtime = path.join(root, '.local/aionui-experiment');
  await mkdir(path.join(runtime, 'backend'), { recursive: true });
  await mkdir(path.join(root, '.local/references/AionUi/out/renderer'), { recursive: true });
  await writeFile(path.join(runtime, 'backend/aioncore.exe'), 'fixture');
  await writeFile(path.join(root, '.local/references/AionUi/out/renderer/index.html'), 'fixture');
  await writeFile(path.join(runtime, 'host.mjs'), `
    import { createServer } from 'node:http';
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url.includes('qr-token')) res.end(JSON.stringify({data:{token:'fixture'}}));
      else { res.setHeader('set-cookie', ['aionui-session=fixture; Path=/; HttpOnly', 'aionui-refresh=fixture; Path=/api/auth/refresh; HttpOnly']); res.end('{}'); }
    });
    server.listen(0,'127.0.0.1', () => console.log('SELF_WIKI_AIONUI_READY ' + JSON.stringify({url:'http://127.0.0.1:'+server.address().port, backendPort:server.address().port, agentName:'fixture'})));
    process.stdin.resume(); process.stdin.on('end', () => server.close());
  `);
  const service = createAionuiExperiment({ root, dataDir: path.join(root, 'data'), timeoutMs: 3000 });
  t.after(async () => {
    await service.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('wiki-aionui-'));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const [first, second] = await Promise.all([service.launch(), service.launch()]);
  assert.equal(first.status.url, second.status.url);
  assert.equal(first.cookies.length, 2);
  assert.equal((await service.status()).state, 'running');
  await service.stop();
  assert.equal((await service.status()).state, 'stopped');
  await assert.rejects(fetch(first.status.url, { signal: AbortSignal.timeout(1000) }));
  await service.close();
  await assert.rejects(service.launch(), /正在关闭/);
});

test('experiment routes reject LAN callers before consulting the service', async () => {
  await assert.rejects(handleAionuiExperimentRoute({}, { method: 'POST' }, {}, new URL('http://localhost/api/aionui/start'), 'lan'), error => error.statusCode === 403);
});
