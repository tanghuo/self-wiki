import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { recoverComfyuiImage } from '../../src/agent/executors/comfyui.js';
import { acquireExternalResource } from '../../src/agent/executors/resourceGate.js';
import { externalResourceLimits } from '../../src/shared/domain/externalResources.js';
import { modelAdapters } from '../../src/server/application/modelAdapters/index.js';
import { createWorkflowNodes } from '../../src/server/application/workflow/nodes.js';
import sharp from 'sharp';
import { startGrokAcp } from '../../src/agent/executors/grokProcess.js';

test('adapter-owned compatibility reads legacy configuration and frozen snapshots without rewriting them', async () => {
  const legacy = { id: 'image', type: 'image.generate', version: 1, config: { executor: 'comfyui', comfyui: {
    workflow: { '1': { class_type: 'LoadImage', inputs: { image: 'keep.png' } }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } } },
    outputNodeId: '2', prompt: null, promptMode: 'workflow', imageInputs: [],
  } }, inputs: {} };
  const before = structuredClone(legacy), normalized = modelAdapters.normalizeNode(legacy);
  assert.equal(normalized.config.comfyui, undefined);
  assert.deepEqual(normalized.config.adapterInputs, { images: 'list<image>' });
  assert.deepEqual(createWorkflowNodes({ repo: {}, store: {}, imageStore: {} }).inputs(legacy, [], {}), { images: [] }, 'old frozen nodes use the adapter contract at execution');
  const server = { imageGeneration: { comfyui: { baseUrl: 'http://127.0.0.1:8188' } } };
  const snapshot = modelAdapters.snapshotDefinition({ nodes: [legacy] }, server)['root/image'];
  assert.equal(snapshot.promptMode, 'workflow');
  assert.equal(modelAdapters.resource(snapshot), 'comfyui:http://127.0.0.1:8188');
  assert.equal(modelAdapters.recoveryTicket(snapshot, { data: { comfyui: { promptId: 'known-job' } } }), 'known-job');
  assert.deepEqual(modelAdapters.recoveryTicket(snapshot, { data: { comfyui: { promptId: 'second-job', sequence: { count: 2, requests: [
    { promptId: 'first-job', requestedPromptId: 'first-request' }, { requestedPromptId: 'second-request' },
  ] } } } }), { count: 2, promptIds: ['first-job', 'second-request'] }, 'sequential recovery includes the entire ordered task set, including an uncertain final submission');
  assert.deepEqual(legacy, before, 'compatibility never mutates historical definitions');
  assert.deepEqual(modelAdapters.configurationRoute('/api/workflows/comfyui/workflows/load'), { adapter: 'comfyui', operation: 'load' });
  await assert.rejects(modelAdapters.configure('comfyui', 'load', server, {}, 'GET'), /HTTP 方法/);
  const unavailable = { ...legacy, config: { executor: 'removed-adapter' } };
  assert.equal(modelAdapters.normalizeNode(unavailable), unavailable, 'unavailable adapters leave drafts editable');
  assert.throws(() => modelAdapters.snapshotDefinition({ nodes: [unavailable] }, server), /未注册/);
  assert.equal(modelAdapters.recoveryTicket({ id: 'removed-adapter' }, {}), null);
  const modern = { id: 'text', type: 'model', version: 1, config: { adapterId: 'grok-text', outputType: 'text', parameters: {} }, inputs: {} };
  const settings = { chat: { grokBuild: { executable: 'configured-cli', model: 'configured-model' } } };
  assert.equal(modelAdapters.snapshotDefinition({ nodes: [modern] }, settings)['root/text'].settings.model, 'configured-model');
  assert.equal(modelAdapters.snapshotDefinition({ nodes: [modern] }, settings)['root/text'].settings.effort, 'low');
  const withEffort = effort => ({ ...modern, config: { ...modern.config, parameters: { effort } } });
  assert.equal(modelAdapters.snapshotDefinition({ nodes: [withEffort('medium')] }, settings)['root/text'].settings.effort, 'medium');
  assert.throws(() => modelAdapters.snapshotDefinition({ nodes: [withEffort('invalid')] }, settings), /推理强度/);
  assert.throws(() => modelAdapters.normalizeNode({ ...modern, config: { ...modern.config, parameters: { model: 'workflow-model' } } }), /未声明此任务参数/);
  assert.equal(modelAdapters.catalog().find((entry) => entry.id === 'grok-text').parameterFields.some((field) => field.name === 'model'), false);
});

test('workflow Grok text adapter verifies an empty tool profile, isolates sessions and rejects shell, image and Wiki attempts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-workflow-adapter-'));
  const previous = process.env.GROK_HOME; process.env.GROK_HOME = root;
  const executable = path.join(root, 'grok.mjs');
  await writeFile(executable, await readFile(new URL('../fixtures/grok-acp.txt', import.meta.url)));
  t.after(async () => { if (previous === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = previous; assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('wiki-workflow-adapter-')); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const snapshot = { id: 'grok-text', version: 1, settings: { executable, model: 'grok-4.6' } };
  const progress = [];
  const call = (prompt) => modelAdapters.model(snapshot, { prompt, images: [], workspace: root, signal: AbortSignal.timeout(5000), onRequest() {}, onProgress: event => progress.push(event.metadata) });
  assert.equal((await call('hello')).text, 'fixture Grok reply');
  assert.ok(progress.some(entry => entry.model === 'grok-4.6' && entry.effort === 'low'));
  assert.deepEqual(progress.filter(entry => entry.progress).map(entry => entry.progress.phase), ['preparing', 'queued', 'waiting', 'generating', 'completed']);
  assert.equal(progress.at(-1).progress.text, 'fixture Grok reply', 'the last chunk is flushed even inside the throttle interval');
  const configured = (await readFile(path.join(root, 'acp-config.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(configured.map(({ configId, value }) => [configId, value]), [['model', 'grok-4.6'], ['reasoning_effort', 'low']]);
  await assert.rejects(call('DENY_SHELL'), /受限模型节点拒绝工具/);
  await assert.rejects(call('GENERATE_CAT'), /受限模型节点拒绝工具/);
  await assert.rejects(call('WIKI'), /受限模型节点拒绝工具/);
  const client = await startGrokAcp(snapshot.settings, { cwd: root, signal: AbortSignal.timeout(5000) });
  try {
    await assert.rejects(client.request('session/new', { cwd: root, mcpServers: [], _meta: { agentProfile: { injectDefaultTools: false, toolConfig: { tools: [] } } } }), /session\/new: Internal error.*invalid configuration: curated tool list is empty/);
  } finally { await client.close(); }
  const requests = (await readFile(path.join(root, 'acp-requests.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(requests.length, 4);
  assert.equal(new Set(requests.map((r) => r.thread)).size, 4);
  assert.ok(requests.every((r) => r.method === 'session/new'));
  assert.ok(requests.every(r => r.profile.injectDefaultTools === false && r.profile.toolConfig.tools.length === 1 && r.profile.disallowedTools.includes('read_file') && !r.mcpUrl));
  await assert.rejects(call('INJECT_TOOLS'), /出现可调用工具/);
  for (const format of ['jpeg', 'webp']) {
    const file = path.join(root, `reference.${format}`);
    await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).toFormat(format).toFile(file);
    await modelAdapters.model(snapshot, { prompt: 'describe', images: [file], workspace: root, signal: AbortSignal.timeout(5000), onRequest() {} });
  }
  const inputs = (await readFile(path.join(root, 'acp-inputs.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  for (const [index, format] of ['jpeg', 'webp'].entries()) {
    const image = inputs.at(index - 2).prompt.find((entry) => entry.type === 'image');
    assert.equal(image.mimeType, `image/${format}`);
    assert.equal((await sharp(Buffer.from(image.data, 'base64')).metadata()).format, format);
  }
  let dispatched = false;
  await assert.rejects(modelAdapters.model({ ...snapshot, settings: { ...snapshot.settings, model: 'ignored-model' } }, {
    prompt: 'must not be sent', images: [], workspace: root, signal: AbortSignal.timeout(5000), onRequest() { dispatched = true; },
  }), /未按配置生效/);
  assert.equal(dispatched, false, 'a silently substituted model never receives the prompt');
});

test('external resource gate keeps one slot per non-Grok key; queued cancellation never acquires a slot', async () => {
  const releaseA = await acquireExternalResource('gate-a'), releaseB = await acquireExternalResource('gate-b');
  let acquired = false;
  const wait = acquireExternalResource('gate-a').then((release) => { acquired = true; return release; });
  const controller = new AbortController();
  let cancelledAcquired = false;
  const cancelled = acquireExternalResource('gate-a', controller.signal).then((release) => { cancelledAcquired = true; return release; });
  controller.abort(); await assert.rejects(cancelled);
  releaseB(); await new Promise((r) => setTimeout(r, 10));
  assert.equal(acquired, false); assert.equal(cancelledAcquired, false);
  releaseA(); const release = await wait; assert.equal(acquired, true); assert.equal(cancelledAcquired, false); release();
});

test('Grok can hold ten slots and the next request waits until one is released', async () => {
  const releases = [];
  try {
    for (let i = 0; i < externalResourceLimits.keys.grok; i++) releases.push(await acquireExternalResource('grok'));
    let acquired = false;
    const wait = acquireExternalResource('grok').then((release) => { acquired = true; releases.push(release); return release; });
    let other = false;
    const blocked = acquireExternalResource('comfyui:http://127.0.0.1:8188').then((release) => { other = true; releases.push(release); return release; });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(acquired, false); assert.equal(other, false);
    releases.shift()();
    await wait; assert.equal(acquired, true); assert.equal(other, false);
    releases.at(-1)(); const otherRelease = await blocked; assert.equal(other, true); otherRelease();
  } finally {
    releases.forEach((releaseSlot) => releaseSlot());
  }
});

test('ComfyUI recovery only queries a recorded task and never submits a prompt', async (t) => {
  const requests = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url.startsWith('/history/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ 'known-task': { outputs: { '2': { images: [{ filename: 'result.png', type: 'output' }] } } } })); }
    else if (req.url.startsWith('/view?')) res.end(png);
    else { res.writeHead(500); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const settings = { baseUrl: `http://127.0.0.1:${server.address().port}`, workflowName: '', workflow: { '2': { class_type: 'SaveImage', inputs: {} } }, prompt: null, outputNodeId: '2' };
  assert.deepEqual((await recoverComfyuiImage(settings, 'known-task', { signal: AbortSignal.timeout(3000) })).bytes, png);
  await assert.rejects(recoverComfyuiImage(settings, 'missing-task'), /保留未知/);
  assert.ok(requests.every((r) => r.startsWith('GET ')));
  assert.equal(requests.filter((r) => r.includes('/prompt')).length, 0);
});
