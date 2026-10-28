import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { initDb } from '../../src/server/data/sqlite.js';
import { createWorkflowRepository } from '../../src/server/data/workflowRepository.js';
import { createWorkflowStore } from '../../src/server/assets/workflowStore.js';
import { createImageStore } from '../../src/server/assets/imageStore.js';
import { createWorkflowService } from '../../src/server/application/workflow/service.js';
import { workflowNode as n, constant as c, output as o } from '../../src/shared/domain/workflow/examples.js';
import { lanRestriction } from '../../src/server/http/lanRoutes.js';
import { createServer } from '../../src/server/server.js';

const key = () => randomUUID();
const definition = (nodes) => ({ schemaVersion: 1, nodes, outputs: {} });
const config = () => ({ chat: { grokBuild: { executable: 'grok', model: 'fixture' } }, imageGeneration: { grokBuild: { executable: 'grok', model: 'fixture', aspectRatio: 'auto' } } });
async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wiki-workflow-'));
  const db = initDb(':memory:'), repo = createWorkflowRepository(db), store = createWorkflowStore(dir), imageStore = createImageStore(path.join(dir, 'assets'));
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#eee' } }).png().toBuffer();
  let imageReads = 0;
  const service = createWorkflowService({ repo, store, imageStore, executionConfig: config, wiki: { async image() { imageReads++; return { bytes: png }; } }, ...overrides });
  service.start();
  t.after(async () => { await service.close(); db.close(); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('wiki-workflow-')); await rm(dir, { recursive: true, force: true }); });
  return { service, repo, db, store, png, imageReads: () => imageReads };
}
async function until(fn, predicate, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = fn(); if (predicate(result)) return result; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error(`workflow timeout: ${JSON.stringify(fn())}`);
}
function create(service, d) { return service.create({ requestKey: key(), name: 'test', definition: d }); }
async function run(service, w, inputs = {}) { return service.createRun(w.id, { requestKey: key(), revision: w.revision, inputs }); }

test('temporary generation settings are validated and frozen without saving; changed image settings reuse the model output', async (t) => {
  let modelCalls = 0;
  const submitted = [];
  const fx = await fixture(t, {
    executionConfig: () => ({ ...config(), imageGeneration: { comfyui: { baseUrl: 'http://127.0.0.1:8188' } } }),
    model: async (_snapshot, options) => { modelCalls++; options.onRequest(); return { text: 'frozen model answer' }; },
    generate: async (snapshot, value, options) => { options.onDispatch(); submitted.push({ width: snapshot.settings.workflow['1'].inputs.width, prompt: value.prompt, images: value.images.length }); return { bytes: fx.png }; },
  });
  const mapping = { workflowName: 'sizes.json', workflow: { '1': { class_type: 'Render', inputs: { text: '', width: 512, height: 512 } }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } } }, outputNodeId: '2', prompt: { nodeId: '1', input: 'text' }, imageInputs: [], promptMode: 'input' };
  // No remote ComfyUI is contacted: only submission data and scheduler reuse are under test.
  const w = create(fx.service, definition([
    n('photo', 'element', { source: 'runtime', parameter: 'photo', valueType: 'list<image>' }),
    n('model', 'model', { adapterId: 'grok-text', outputType: 'text' }, { prompt: c('describe'), images: o('photo') }),
    n('image', 'image.generate', { adapterId: 'comfyui', adapterConfig: mapping }, { prompt: o('model'), images: c([]) }),
  ]));
  const override = structuredClone(w.definition);
  override.nodes.find((node) => node.id === 'image').config.adapterConfig.workflow['1'].inputs.width = 768;
  const request = { requestKey: key(), revision: w.revision, definition: override, inputs: { photo: [{ elementId: 1 }] } };
  const started = await fx.service.createRun(w.id, request);
  const first = await until(() => fx.service.run(started.id), (r) => r.state === 'succeeded');
  assert.equal((await fx.service.createRun(w.id, request)).id, first.id, 'retrying the same creation is idempotent');
  assert.equal(modelCalls, 1); assert.equal(fx.imageReads(), 1);
  assert.deepEqual(submitted, [{ width: 768, prompt: 'frozen model answer', images: 0 }]);
  assert.deepEqual(fx.service.get(w.id).definition, w.definition);
  assert.equal(fx.service.get(w.id).revision, w.revision);
  const next = structuredClone(first.definition);
  next.nodes.find((node) => node.id === 'image').config.adapterConfig.workflow['1'].inputs.width = 1024;
  const derived = await fx.service.derive(first.id, { requestKey: key(), definition: next, regenerate: ['image'] });
  const second = await until(() => fx.service.run(derived.id), (r) => r.state === 'succeeded');
  assert.equal(modelCalls, 1, 'changing image settings never calls the text model again');
  assert.equal(fx.imageReads(), 1, 'parent input images are reused without rereading library files');
  assert.deepEqual(submitted[1], { width: 1024, prompt: 'frozen model answer', images: 0 });
  assert.ok(second.rootInstances.find((i) => i.nodeId === 'model').data.reusedFrom);
  assert.deepEqual(fx.service.run(first.id).definition, first.definition);
  assert.deepEqual(fx.service.get(w.id).definition, w.definition);
  const invalid = structuredClone(override); invalid.nodes.find((node) => node.id === 'image').config.adapterConfig.outputNodeId = 'missing';
  await assert.rejects(fx.service.createRun(w.id, { ...request, requestKey: key(), definition: invalid }), /输出|连接/);
  await assert.rejects(fx.service.createRun(w.id, { ...request, requestKey: key(), revision: w.revision + 1 }), /草稿已改变/);
  assert.equal(submitted.length, 2, 'invalid requests never dispatch');
});

test('uploaded workflow attachments persist outside the library and enter it only through a save node', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wiki-workflow-attachments-'));
  let app = await createServer({ port: 0, dataDir: dir });
  t.after(async () => { await app.close(); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('wiki-workflow-attachments-')); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); });
  const post = (route, payload) => fetch(new URL(route, app.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const libraryCount = async () => (await repoFetch(app, 'api/elements?pageSize=1')).pagination.total;
  const before = await libraryCount();
  const png = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#446688' } }).png().toBuffer();
  const response = await fetch(new URL('api/workflow-input-images', app.url), { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'pasted.png' }, body: png });
  assert.equal(response.status, 200);
  const attachment = await response.json();
  assert.deepEqual(Object.keys(attachment), ['attachmentId']);
  assert.equal(await libraryCount(), before);
  const mediaRoute = `api/workflow-input-images/${attachment.attachmentId}/media`;
  let media = await fetch(new URL(mediaRoute, app.url));
  assert.equal(media.status, 200); assert.equal(media.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), png);
  const invalid = await fetch(new URL('api/workflow-input-images', app.url), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'not an image' });
  assert.equal(invalid.status, 400);
  assert.equal((await fetch(new URL('api/workflow-input-images/00000000-0000-4000-8000-000000000000/media', app.url))).status, 404);
  assert.equal((await fetch(new URL('api/workflow-input-images/not-a-uuid/media', app.url))).status, 404);
  assert.equal((await fetch(new URL('api/workflow-input-images/aaaa/media', app.url))).status, 400);
  const makeNodes = () => [n('fixed', 'element', { source: 'fixed', parameter: 'fixed', valueType: 'list<image>', default: [attachment] }), n('input', 'element', { source: 'runtime', parameter: 'input', valueType: 'list<image>' })];
  const created = await post('api/workflows', { name: '附件隔离', requestKey: key(), definition: definition(makeNodes()) });
  assert.equal(created.status, 200); const w = await created.json();
  assert.equal((await (await post(`api/workflows/${w.id}/validate`, {})).json()).valid, true);
  await app.close(); app = await createServer({ port: 0, dataDir: dir });
  media = await fetch(new URL(mediaRoute, app.url));
  assert.equal(media.status, 200); assert.deepEqual(Buffer.from(await media.arrayBuffer()), png, 'attachments survive restarting the server');
  const started = await post(`api/workflows/${w.id}/runs`, { requestKey: key(), revision: w.revision, inputs: { input: [attachment] } });
  assert.equal(started.status, 200); const runId = (await started.json()).id;
  async function finished(id) {
    for (let tries = 0; tries < 100; tries++) { const r = await repoFetch(app, `api/workflow-runs/${id}`); if (r.state === 'succeeded') return r; if (r.state === 'failed') assert.fail(JSON.stringify(r)); await new Promise((resolve) => setTimeout(resolve, 20)); }
    assert.fail('workflow did not finish');
  }
  const done = await finished(runId);
  assert.ok(done.inputs.fixed[0].artifactId); assert.deepEqual(done.inputs.fixed, done.inputs.input);
  assert.equal(await libraryCount(), before, 'upload, restart and execution create no library entry');
  const snapshot = await fetch(new URL(`api/workflow-artifacts/${done.inputs.input[0].artifactId}/media?runId=${runId}`, app.url));
  assert.deepEqual(Buffer.from(await snapshot.arrayBuffer()), png);
  const derivedResponse = await post(`api/workflow-runs/${runId}/derive`, { requestKey: key() });
  assert.equal(derivedResponse.status, 200); await finished((await derivedResponse.json()).id);
  assert.equal(await libraryCount(), before);
  const saveWorkflow = await (await post('api/workflows', { name: '显式保存附件', requestKey: key(), definition: definition([...makeNodes(), n('save', 'library.save', { valueType: 'list<image>' }, { value: o('input') })]) })).json();
  const savedRun = await (await post(`api/workflows/${saveWorkflow.id}/runs`, { requestKey: key(), revision: saveWorkflow.revision, inputs: { input: [attachment] } })).json();
  await finished(savedRun.id);
  assert.equal(await libraryCount(), before + 1, 'only an explicit library.save node inserts the image into the library');
});

test('structured model fields and raw text flow independently through consumers, saves and loop returns', async (t) => {
  const raw = JSON.stringify({ title: '标题', score: 7 });
  const { service, repo, db } = await fixture(t, { model: async (_snapshot, options) => { options.onRequest(); return { text: raw }; } });
  const model = () => n('model', 'model', { adapterId: 'grok-text', outputType: 'json', jsonSchema: { type: 'object', properties: { title: { type: 'string' }, score: { type: 'number' } }, required: ['title', 'score'] } }, { prompt: c('返回 JSON') });
  const title = { ...o('model'), port: 'structured_output', path: ['title'] }, text = { ...o('model'), port: 'text' };
  const body = { nodes: [model()], outputs: { title, text } };
  const w = create(service, definition([model(), n('save', 'library.save', { valueType: 'text' }, { value: title }), n('saveRaw', 'library.save', { valueType: 'text' }, { value: text }), n('title', 'preview', { valueType: 'text' }, { value: title }), n('score', 'preview', { valueType: 'number' }, { value: { ...o('model'), path: ['score'] } }), n('loop', 'foreach', { itemsType: 'list<text>', maxItems: 1, captureTypes: {}, body }, { items: c(['one']) })]));
  const r = await run(service, w);
  const done = await until(() => service.run(r.id), (v) => !['queued', 'running'].includes(v.state));
  assert.equal(done.state, 'succeeded', JSON.stringify(done.instances));
  const value = (id) => repo.artifact(done.rootInstances.find((i) => i.nodeId === id).outputs.value).value;
  assert.equal(value('title'), '标题'); assert.equal(value('score'), 7);
  const saved = value('save')[0], savedRaw = value('saveRaw')[0];
  assert.notEqual(saved, savedRaw, 'a field save must not reuse the whole object artifact identity');
  assert.equal(db.prepare('SELECT body FROM elements WHERE id=?').get(saved).body, '标题');
  assert.equal(db.prepare('SELECT body FROM elements WHERE id=?').get(savedRaw).body, raw);
  const row = value('loop')[0];
  assert.equal(row.outputs.title.type, 'text'); assert.deepEqual(row.outputs.title.path, ['title']);
  assert.equal(row.outputs.text.type, 'text');
  assert.equal(repo.artifact(row.outputs.text.artifactRef).value, raw);
  const nextDefinition = structuredClone(done.definition);
  nextDefinition.nodes.push(n('newConsumer', 'preview', { valueType: 'text' }, { value: { ...o('model'), port: 'text' } }));
  const derived = await service.derive(r.id, { requestKey: key(), definition: nextDefinition });
  const next = await until(() => service.run(derived.id), (v) => v.state === 'succeeded');
  assert.ok(next.rootInstances.find((i) => i.nodeId === 'model').data.reusedFrom, 'new named selectors can consume reused historical artifact ports');
  assert.equal(repo.artifact(next.rootInstances.find((i) => i.nodeId === 'newConsumer').outputs.value).value, raw);
});

test('schema failures retain raw model text and block consumers of structured fields', async (t) => {
  const { service, repo } = await fixture(t, { model: async (_snapshot, options) => { options.onRequest(); return { text: '{"title":42}' }; } });
  const w = create(service, definition([n('model', 'model', { adapterId: 'grok-text', outputType: 'json', jsonSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }, { prompt: c('JSON') }), n('title', 'preview', { valueType: 'text' }, { value: { ...o('model'), path: ['title'] } })]));
  const r = await run(service, w), done = await until(() => service.run(r.id), (v) => ['failed', 'partial_failed'].includes(v.state));
  const model = done.instances.find((i) => i.nodeId === 'model');
  assert.equal(model.state, 'failed'); assert.equal(model.outputs.value, undefined);
  assert.equal(repo.artifact(model.outputs.raw).value, '{"title":42}');
  assert.equal(done.instances.find((i) => i.nodeId === 'title').state, 'blocked');
});

for (const inLoop of [false, true]) test(`registered adapters supply contracts, opaque snapshots and safe recovery without workflow provider branches (${inLoop ? 'loop' : 'root'})`, async (t) => {
  const { createAdapterRegistry } = await import('../../src/server/application/modelAdapters/index.js');
  let submitted = 0, recovered = 0, configured = 0, revision = 'original', png;
  const adapter = {
    id: 'fixture-provider', label: '测试图片适配器', version: 1, nodeType: 'image.generate', outputTypes: ['list<image>'], maxImages: 8, formats: ['image/png'],
    inputs: (config) => config.adapterConfig?.preset ? { images: 'list<image>' } : { prompt: 'text', images: 'list<image>' },
    snapshot: (config) => ({ settings: { revision, preset: config.adapterConfig.preset } }),
    resource: (snapshot) => `fixture:${snapshot.settings.revision}`,
    async generate(snapshot, input, options) {
      assert.equal(snapshot.settings.revision, 'original'); assert.equal(input.prompt, '');
      submitted++; options.onDispatch(); options.onProgress({ type: 'metadata', metadata: { providerJob: 'job-1' } });
      throw Object.assign(new Error('response lost'), { unknown: true });
    },
    recoveryTicket: (attempt) => attempt?.data.providerJob,
    async recover(snapshot, ticket) { assert.equal(snapshot.settings.revision, 'original'); assert.equal(ticket, 'job-1'); recovered++; return { bytes: png }; },
    configuration: { choices: { method: 'GET', execute() { configured++; return { choices: ['preset-1'] }; } } },
  };
  const adapters = createAdapterRegistry([adapter]);
  const f = await fixture(t, { adapters }); png = f.png;
  const image = n('image', 'image.generate', { adapterId: adapter.id, adapterConfig: { preset: 'preset-1' }, adapterInputs: { prompt: 'text' } });
  const d = definition(inLoop ? [n('loop', 'foreach', { itemsType: 'list<text>', maxItems: 1, captureTypes: {}, body: { nodes: [image], outputs: { image: o('image') } } }, { items: c(['first']) })] : [image]);
  assert.deepEqual(f.service.catalog().adapters.map((entry) => entry.id), [adapter.id]);
  assert.deepEqual(await f.service.adapterConfiguration(adapter.id, 'choices'), { choices: ['preset-1'] });
  assert.equal(configured, 1);
  await assert.rejects(f.service.adapterConfiguration(adapter.id, 'choices', {}, 'POST'), /HTTP 方法/);
  await assert.rejects(f.service.adapterConfiguration(adapter.id, 'constructor'), /不支持/);
  const w = create(f.service, d), r = await run(f.service, w);
  const unknown = await until(() => f.service.run(r.id), (value) => value.state === 'needs_attention');
  const instance = unknown.instances.find((entry) => entry.state === 'unknown');
  assert.equal(instance.canRecover, true);
  assert.deepEqual((inLoop ? unknown.definition.nodes[0].config.body.nodes[0] : unknown.definition.nodes[0]).config.adapterInputs, { images: 'list<image>' }, 'adapter is authoritative over persisted input hints');
  if (inLoop) assert.equal(f.service.batch(r.id, unknown.rootInstances[0].id).items[0].instances[0].canRecover, true);
  revision = 'changed';
  await f.service.nodeAction(r.id, instance.id, { action: 'recover', controlVersion: unknown.controlVersion, requestKey: key() });
  await until(() => f.service.run(r.id), (value) => value.state === 'succeeded');
  assert.equal(submitted, 1); assert.equal(recovered, 1, 'recovery must never resubmit');
});

test('sample runs limit each loop at execution, preserve reference lists and leave saved drafts unchanged', async (t) => {
  const { service, repo } = await fixture(t);
  const body = { nodes: [n('text', 'element', { source: 'fixed', valueType: 'text', parts: [{ kind: 'ref', ref: { kind: 'item' } }] })], outputs: { text: o('text') } };
  const loop = (id, items) => n(id, 'foreach', { itemsType: 'list<text>', maxItems: 2, captureTypes: {}, body }, { items });
  const w = create(service, definition([
    n('fixed', 'element', { source: 'fixed', parameter: 'fixed', valueType: 'list<text>', default: ['甲', '乙'] }),
    n('runtime', 'element', { source: 'runtime', parameter: 'runtime', valueType: 'list<text>' }),
    n('photos', 'element', { source: 'fixed', parameter: 'photos', valueType: 'list<image>', default: [{ elementId: 1 }, { elementId: 2 }] }),
    loop('fixedLoop', o('fixed')), loop('runtimeLoop', o('runtime')), loop('emptyLoop', c([])),
  ]));
  const sample = await service.createRun(w.id, { requestKey: key(), revision: w.revision, inputs: { runtime: ['丙', '丁'] }, sample: true });
  const done = await until(() => service.run(sample.id), (r) => r.state === 'succeeded');
  assert.equal(done.inputs.photos.length, 2, 'reference lists are not sample tasks');
  assert.deepEqual(done.inputs.runtime, ['丙', '丁']);
  assert.equal(service.batch(sample.id, done.rootInstances.find((i) => i.nodeId === 'fixedLoop').id).total, 1);
  assert.equal(service.batch(sample.id, done.rootInstances.find((i) => i.nodeId === 'emptyLoop').id).total, 0);
  for (const id of ['fixedLoop', 'runtimeLoop']) {
    const root = done.rootInstances.find((i) => i.nodeId === id);
    assert.equal(repo.artifact(root.outputs.value).value.length, 1);
  }
  assert.equal(service.get(w.id).definition.nodes.find((node) => node.id === 'fixedLoop').config.sampleSize, undefined);
  const repeated = await service.derive(sample.id, { requestKey: key(), regenerate: ['fixedLoop'] });
  const repeatedDone = await until(() => service.run(repeated.id), (r) => r.state === 'succeeded');
  assert.equal(service.batch(repeated.id, repeatedDone.rootInstances.find((i) => i.nodeId === 'fixedLoop').id).total, 1, 'rerunning samples keeps the sample limit');
  const normal = await run(service, w, { runtime: ['丙', '丁'] });
  const full = await until(() => service.run(normal.id), (r) => r.state === 'succeeded');
  assert.equal(service.batch(normal.id, full.rootInstances.find((i) => i.nodeId === 'fixedLoop').id).total, 2);
});

test('editing legacy single-image sources preserves ordered image collection after normalization', async (t) => {
  const { editableDefinition } = await import('../../src/shared/domain/workflow/contracts.js');
  const { inferGraphTypes } = await import('../../src/renderer/src/features/workflow/workflowBindings.js');
  const { service, repo } = await fixture(t);
  const historical = definition([
    n('one', 'element', { source: 'fixed', parameter: 'one', valueType: 'image', default: { elementId: 1 } }),
    n('many', 'element', { source: 'fixed', parameter: 'many', valueType: 'list<image>', default: [{ elementId: 2 }, { elementId: 3 }] }),
    n('collect', 'transform', { operation: 'list', keys: ['a', 'b'], valueType: 'list<image>' }, { a: o('one'), b: o('many') }),
  ]);
  const edited = inferGraphTypes(editableDefinition(historical));
  const r = await run(service, create(service, edited));
  const done = await until(() => service.run(r.id), (value) => value.state === 'succeeded');
  const result = repo.artifact(done.rootInstances.find((i) => i.nodeId === 'collect').outputs.value).value;
  assert.deepEqual(result, [...done.inputs.one, ...done.inputs.many]);
  assert.equal(historical.nodes[0].config.valueType, 'image', 'history stays unchanged');
});

test('loop-local text elements reference the current item and captured text without template nodes', async (t) => {
  const { service, repo } = await fixture(t);
  const d = definition([n('loop', 'foreach', { itemsType: 'list<text>', maxItems: 2, captureTypes: { prefix: 'text' }, body: {
    nodes: [n('text', 'element', { source: 'fixed', valueType: 'text', parts: [{ kind: 'ref', ref: { kind: 'capture', name: 'prefix' } }, { kind: 'ref', ref: { kind: 'item' } }] })], outputs: { text: o('text') },
  } }, { items: c(['甲', '乙']), prefix: c('前缀：') })]);
  const r = await run(service, create(service, d));
  const done = await until(() => service.run(r.id), (value) => value.state === 'succeeded');
  const rows = repo.artifact(done.rootInstances[0].outputs.value).value;
  assert.deepEqual(rows.map((row) => repo.artifact(row.outputs.text.artifactRef).value), ['前缀：甲', '前缀：乙']);
});

test('text elements and model prompts embed references directly with dependency-aware execution and derivation', async (t) => {
  let calls = 0;
  const { service, repo } = await fixture(t, { model: async (_snapshot, options) => { options.onRequest(); calls++; return { text: options.prompt }; } });
  const parts = [{ kind: 'text', text: '翻译：' }, { kind: 'ref', ref: o('source') }, { kind: 'text', text: '。保留 {{普通文字}}' }];
  const d = definition([
    n('model', 'model', { executor: 'grok-text', outputType: 'text' }, { prompt: { kind: 'text', parts: [{ kind: 'text', text: '请处理 ' }, { kind: 'ref', ref: o('composed') }] } }),
    n('composed', 'element', { source: 'fixed', valueType: 'text', parts }),
    n('source', 'element', { source: 'runtime', valueType: 'text', parameter: 'source' }),
  ]);
  const w = create(service, d), r = await run(service, w, { source: '{{模型返回也不展开}}' });
  const done = await until(() => service.run(r.id), (value) => value.state === 'succeeded');
  assert.equal(calls, 1);
  assert.equal(repo.artifact(done.instances.find((i) => i.nodeId === 'model').outputs.value).value, '请处理 翻译：{{模型返回也不展开}}。保留 {{普通文字}}');
  assert.equal(done.instances.length, 3, 'composition is a text element, with no extra template node');
  assert.deepEqual(Object.keys(done.inputs), ['source'], 'computed text is not a run parameter');
  const next = await service.derive(r.id, { requestKey: key(), inputs: { source: '新内容' } });
  const derived = await until(() => service.run(next.id), (value) => value.state === 'succeeded');
  assert.equal(calls, 2);
  assert.ok(derived.instances.every((i) => !i.data.reusedFrom));
  assert.equal(repo.artifact(derived.instances.find((i) => i.nodeId === 'model').outputs.value).value, '请处理 翻译：新内容。保留 {{普通文字}}');
});

test('the reduced example passes current images and captured text directly, supports review and exposes stable root results', async (t) => {
  const { describeImagesExample } = await import('../../src/shared/domain/workflow/examples.js');
  let png, modelCalls = 0, imageCalls = 0;
  const f = await fixture(t, {
    model: async (_snapshot, options) => { options.onRequest(); assert.equal(options.images.length, 1); assert.equal(options.prompt, '描述这张图片'); modelCalls++; return { text: '生成用提示词' }; },
    generate: async (_snapshot, input, options) => { options.onDispatch(); assert.equal(input.images.length, 1); assert.equal(input.prompt, '检查后的提示词'); imageCalls++; return { bytes: png }; },
  });
  png = f.png;
  const w = create(f.service, describeImagesExample());
  const r = await run(f.service, w, { images: [{ elementId: 1 }], instruction: '描述这张图片' });
  let detail = await until(() => f.service.run(r.id), (v) => v.state === 'waiting_review');
  assert.equal(detail.rootInstances.length, 3);
  const check = detail.instances.find((i) => i.nodeId === 'check');
  f.service.nodeAction(r.id, check.id, { requestKey: key(), controlVersion: detail.controlVersion, action: 'accept', value: '检查后的提示词' });
  detail = await until(() => f.service.run(r.id), (v) => v.state === 'succeeded');
  assert.equal(modelCalls, 1); assert.equal(imageCalls, 1);
  assert.equal(detail.instances.length, 6, 'no transfer, list-packaging or preview instances');
  assert.equal(f.service.run(r.id, { after: check.id }).rootInstances.length, 3, 'diagnostic pagination must not hide normal root results');
});

test('elements separate fixed content, runtime content and upstream results; derivation only invalidates changed content', async (t) => {
  const { service, repo } = await fixture(t);
  const d = definition([
    n('fixed', 'element', { source: 'fixed', parameter: 'fixed', valueType: 'text', default: '固定内容' }),
    n('runtime', 'element', { source: 'runtime', parameter: 'question', valueType: 'text' }),
    n('upstream', 'element', { source: 'upstream', valueType: 'text' }, { value: o('runtime') }),
    n('join', 'transform', { operation: 'concat', valueType: 'text' }, { a: o('fixed'), b: o('upstream') }),
  ]);
  const w = create(service, d);
  await assert.rejects(run(service, w, { fixed: '覆盖', question: '问题' }), /未声明/);
  await assert.rejects(run(service, w), /提供内容/);
  const r = await run(service, w, { question: '问题' });
  const done = await until(() => service.run(r.id), (v) => v.state === 'succeeded');
  assert.equal(repo.artifact(done.instances.find((i) => i.nodeId === 'join').outputs.value).value, '固定内容问题');
  const derived = await service.derive(r.id, { requestKey: key(), inputs: { question: '新问题' } });
  const next = await until(() => service.run(derived.id), (v) => v.state === 'succeeded');
  assert.ok(next.instances.find((i) => i.nodeId === 'fixed').data.reusedFrom);
  assert.ok(!next.instances.find((i) => i.nodeId === 'runtime').data.reusedFrom);
  assert.equal(repo.artifact(next.instances.find((i) => i.nodeId === 'join').outputs.value).value, '固定内容新问题');
});

test('fixed image elements snapshot library selections and retain snapshots when deriving without rereading sources', async (t) => {
  const { service, repo, imageReads } = await fixture(t);
  const d = definition([
    n('pictures', 'element', { source: 'fixed', parameter: 'pictures', valueType: 'list<image>', default: [{ elementId: 1 }, { elementId: 2 }], allowEmpty: false }),
    n('view', 'preview', { valueType: 'list<image>' }, { value: o('pictures') }),
  ]);
  const r = await run(service, create(service, d));
  const done = await until(() => service.run(r.id), (v) => v.state === 'succeeded');
  assert.equal(imageReads(), 2);
  assert.equal(done.inputs.pictures.length, 2);
  assert.ok(done.inputs.pictures.every((ref) => repo.hasAccess(r.id, ref.artifactId)));
  const derived = await service.derive(r.id, { requestKey: key() });
  const next = await until(() => service.run(derived.id), (v) => v.state === 'succeeded');
  assert.equal(imageReads(), 2, 'unchanged fixed sources must use the parent snapshot');
  assert.deepEqual(next.inputs, done.inputs);
  assert.ok(next.instances.every((i) => i.data.reusedFrom));
  const changed = structuredClone(d); changed.nodes[0].config.default = [{ elementId: 3 }];
  const updated = await service.derive(r.id, { requestKey: key(), definition: changed });
  const changedDone = await until(() => service.run(updated.id), (v) => v.state === 'succeeded');
  assert.equal(imageReads(), 3);
  assert.equal(changedDone.inputs.pictures.length, 1);
  assert.ok(changedDone.instances.every((i) => !i.data.reusedFrom));
});

test('fixed library text is resolved as content and frozen in the run', async (t) => {
  const { service, repo } = await fixture(t, { wiki: { get(id) { return { id, kind: 'text', body: '资料库文字' }; } } });
  const w = create(service, definition([n('text', 'element', { source: 'fixed', parameter: 'text', valueType: 'text', default: { elementId: 3 } })]));
  const r = await run(service, w);
  const done = await until(() => service.run(r.id), (v) => v.state === 'succeeded');
  assert.equal(repo.artifact(done.instances[0].outputs.value).value, '资料库文字');
  assert.ok(done.inputArtifacts.some((a) => a.metadata.sourceElementId === 3));
});

test('workflow review survives refresh; editing keeps original; save receipt is atomic and derivation reuses unaffected outputs', async (t) => {
  const { service, repo, db } = await fixture(t);
  const w = create(service, definition([
    n('source', 'input', { parameter: 'text', valueType: 'text', required: true }),
    n('check', 'review', { valueType: 'text' }, { value: o('source') }),
    n('save', 'library.save', { valueType: 'text', tags: ['workflow'], source: 'test source' }, { value: o('check') }),
  ]));
  const payload = { requestKey: key(), revision: w.revision, inputs: { text: 'original' } };
  const r = await service.createRun(w.id, payload);
  assert.equal((await service.createRun(w.id, payload)).id, r.id);
  await assert.rejects(service.createRun(w.id, { ...payload, inputs: { text: 'different' } }), /载荷不同/);
  let detail = await until(() => service.run(r.id), (v) => v.state === 'waiting_review');
  const check = detail.instances.find((i) => i.nodeId === 'check'), original = check.outputs.value;
  const command = { requestKey: key(), controlVersion: detail.controlVersion, action: 'accept', value: 'edited' };
  service.nodeAction(r.id, check.id, command);
  service.nodeAction(r.id, check.id, command);
  assert.throws(() => service.nodeAction(r.id, check.id, { ...command, requestKey: key() }), /版本已改变/);
  detail = await until(() => service.run(r.id), (v) => v.state === 'succeeded');
  assert.equal(repo.artifact(original).value, 'original');
  assert.equal(repo.artifact(repo.instance(check.id).outputs.value).value, 'edited');
  assert.equal(db.prepare('SELECT count(*) AS n FROM workflow_save_receipts').get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM elements WHERE body='edited'").get().n, 1);
  const derived = await service.derive(r.id, { requestKey: key() });
  const done = await until(() => service.run(derived.id), (v) => v.state === 'succeeded');
  assert.ok(done.instances.every((i) => i.data.reusedFrom));
  assert.equal(db.prepare('SELECT count(*) AS n FROM workflow_save_receipts').get().n, 1);
});
test('workflow incremental foreach preserves original positions and captures, supports empty input and partial failure', async (t) => {
  const { service, repo } = await fixture(t);
  const d = definition([
    n('list', 'input', { parameter: 'items', valueType: 'list<json>' }),
    n('loop', 'foreach', { itemsType: 'list<json>', maxItems: 20, captureTypes: {}, body: { nodes: [
      n('extract', 'transform', { operation: 'field', path: ['text'], valueType: 'text' }, { value: { kind: 'item' } }),
    ], outputs: { text: o('extract') } } }, { items: o('list') }),
  ]);
  const w = create(service, d), r = await run(service, w, { items: [{ text: 'zero' }, { missing: 'one' }, { text: 'two' }] });
  let done = await until(() => service.run(r.id), (v) => ['partial_failed', 'failed'].includes(v.state));
  const parent = done.instances.find((i) => i.nodeId === 'loop'), rows = repo.artifact(parent.outputs.value).value;
  assert.deepEqual(rows.map((r) => r.index), [0, 1, 2]);
  assert.deepEqual(rows.map((r) => r.status), ['succeeded', 'failed', 'succeeded']);
  assert.equal(repo.artifact(rows[2].outputs.text.artifactRef).value, 'two');
  assert.equal(new Set(rows.map((r) => r.itemId)).size, 3);
  const empty = await run(service, w, { items: [] });
  done = await until(() => service.run(empty.id), (v) => v.state === 'succeeded');
  assert.deepEqual(repo.artifact(done.instances.find((i) => i.nodeId === 'loop').outputs.value).value, []);
  assert.equal(done.instances.length, 2);
});
test('workflow unknown is never ordinary retry; explicit reexecution keeps old attempts and reuses successful upstream', async (t) => {
  let calls = 0;
  const { service, repo } = await fixture(t, { model: async (_snapshot, options) => { options.onRequest(); if (++calls === 1) throw new Error('connection lost after submission'); return { text: 'done' }; } });
  const w = create(service, definition([n('prompt', 'input', { parameter: 'prompt', valueType: 'text', default: 'hello' }), n('model', 'model', { executor: 'grok-text', outputType: 'text' }, { prompt: o('prompt') }), n('preview', 'preview', { valueType: 'text' }, { value: o('model') })]));
  const r = await run(service, w);
  let detail = await until(() => service.run(r.id), (v) => v.state === 'needs_attention');
  const instance = detail.instances.find((i) => i.nodeId === 'model');
  assert.equal(instance.state, 'unknown');
  assert.throws(() => service.nodeAction(r.id, instance.id, { requestKey: key(), controlVersion: detail.controlVersion, action: 'retry' }), /未知/);
  service.nodeAction(r.id, instance.id, { requestKey: key(), controlVersion: detail.controlVersion, action: 'reexecute', acknowledgeDuplicate: true });
  detail = await until(() => service.run(r.id), (v) => v.state === 'succeeded');
  assert.equal(calls, 2);
  assert.deepEqual(repo.attempts(instance.id).map((a) => a.state), ['unknown', 'succeeded']);
  assert.equal(repo.attempts(detail.instances.find((i) => i.nodeId === 'prompt').id).length, 1);
});
test('workflow input image copies are fixed; managed image outputs have run-bound access and provenance', async (t) => {
  let png, refs;
  const fx = await fixture(t, { generate: async (_snapshot, value) => { refs = value.images; return { bytes: png }; } });
  png = fx.png;
  const { service, repo } = fx;
  const w = create(service, definition([n('input', 'input', { parameter: 'images', valueType: 'list<image>' }), n('gen', 'image.generate', { executor: 'grok-build' }, { prompt: c('verbatim prompt'), images: o('input') })]));
  const r = await run(service, w, { images: [{ elementId: 42 }] });
  const detail = await until(() => service.run(r.id), (v) => v.state === 'succeeded');
  assert.equal(fx.imageReads(), 1);
  assert.equal(refs.length, 1);
  const result = repo.artifact(detail.instances.find((i) => i.nodeId === 'gen').outputs.value).value;
  const artifact = await service.artifact(result[0].artifactId, r.id);
  assert.equal(artifact.metadata.prompt, 'verbatim prompt');
  assert.equal(artifact.metadata.referenceIds[0], r.inputs.images[0].artifactId);
  await assert.rejects(service.artifact(artifact.id, 999), /不属于/);
  await assert.rejects(run(service, w, { images: [{ path: 'C:/sensitive.png' }] }), /不接受文件路径/);
});
test('saving workflow JPEG and WebP images preserves MIME, download names and deduplication', async (t) => {
  let bytes;
  const f = await fixture(t, { generate: async () => ({ bytes }) });
  for (const [format, extension] of [['jpeg', 'jpg'], ['webp', 'webp']]) {
    bytes = await sharp(f.png).toFormat(format).toBuffer();
    const w = create(f.service, definition([
      n('generate', 'image.generate', { executor: 'grok-build' }, { prompt: c('image'), images: c([]) }),
      n('save', 'library.save', { valueType: 'list<image>' }, { value: o('generate') }),
    ]));
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await run(f.service, w);
      await until(() => f.service.run(r.id), (v) => v.state === 'succeeded');
    }
    const rows = f.db.prepare('SELECT original_name,mime_type FROM element_images WHERE mime_type=?').all(`image/${format}`);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].original_name.endsWith(`.${extension}`));
  }
});
test('workflow restart recovers local claims and marks dispatched external claims unknown; stale attempts cannot replace current output', async (t) => {
  const { service, repo } = await fixture(t);
  await service.close();
  repo.initializeOwner();
  const d = definition([n('local', 'template', { parts: [{ kind: 'text', text: 'x' }] }), n('remote', 'model', { executor: 'grok-text' }, { prompt: c('x') })]);
  const w = repo.create('recovery', d), r = repo.createRun(w.id, d, {}, {});
  const local = repo.claim(repo.instances(r.id)[0].id), remote = repo.claim(repo.instances(r.id)[1].id);
  repo.dispatch(remote.id, remote.attemptId, {});
  repo.initializeOwner(); repo.recover();
  assert.equal(repo.instance(local.id).state, 'pending');
  assert.equal(repo.instance(remote.id).state, 'unknown');
  repo.retry(remote.id, true);
  const next = repo.claim(remote.id);
  repo.complete(remote.id, next.attemptId, 'succeeded', [{ type: 'text', value: 'new' }]);
  repo.complete(remote.id, remote.attemptId, 'succeeded', [{ type: 'text', value: 'old' }]);
  assert.equal(repo.artifact(repo.instance(remote.id).outputs.value).value, 'new');
});
test('workflow endpoints enforce revisions, HTTP body boundaries and LAN denial for every resource family', async (t) => {
  for (const route of ['/api/workflows', '/api/workflows/1', '/api/workflow-node-types', '/api/workflow-runs/1/events', '/api/workflow-runs/1/actions', '/api/workflow-artifacts/a/media', '/api/workflow-input-images', '/api/workflow-input-images/a/media']) for (const method of ['GET', 'POST', 'PUT', 'HEAD']) assert.match(lanRestriction(method, route, { allowWrite: true }), /仅限本机/);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wiki-workflow-api-'));
  const app = await createServer({ port: 0, dataDir: dir });
  t.after(async () => { await app.close(); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('wiki-workflow-api-')); await rm(dir, { recursive: true, force: true }); });
  const post = async (route, payload, method = 'POST') => fetch(new URL(route, app.url), { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const response = await post('api/workflows', { name: 'HTTP', requestKey: key(), definition: definition([n('a', 'template', { parts: [{ kind: 'text', text: 'ok' }] })]) });
  assert.equal(response.status, 200);
  const w = await response.json();
  assert.equal((await post(`api/workflows/${w.id}`, { ...w, revision: 0 }, 'PUT')).status, 409);
  const r = await (await post(`api/workflows/${w.id}/runs`, { requestKey: key(), revision: w.revision })).json();
  // Poll HTTP without a synchronous-predicate helper.
  let detail;
  for (let tries = 0; tries < 100; tries++) { detail = await repoFetch(app, `api/workflow-runs/${r.id}`); if (detail.state === 'succeeded') break; await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(detail.state, 'succeeded');
  assert.equal((await repoFetch(app, `api/workflow-runs/${r.id}/events?after=0`)).events.length > 0, true);
  const artifactId = detail.instances[0].outputs.value;
  assert.equal((await fetch(new URL(`api/workflow-artifacts/${artifactId}?runId=999`, app.url))).status, 404);
});
async function repoFetch(app, route) { return (await fetch(new URL(route, app.url))).json(); }

test('twenty batch items keep stable identities despite completion order; one item failure does not terminate its peers', async (t) => {
  const completed = [];
  const { service, repo } = await fixture(t, { model: async (_snapshot, options) => {
    options.onRequest();
    const index = Number(options.prompt);
    await new Promise((r) => setTimeout(r, (20 - index) * 2));
    completed.push(index);
    if (index === 7) throw Object.assign(new Error('confirmed failure'), { unknown: false });
    return { text: `description-${index}` };
  } });
  const d = definition([n('items', 'input', { valueType: 'list<json>', parameter: 'items' }), n('loop', 'foreach', { itemsType: 'list<json>', maxItems: 20, captureTypes: {}, body: { nodes: [
    n('extract', 'transform', { operation: 'field', path: ['prompt'], valueType: 'text' }, { value: { kind: 'item' } }),
    n('model', 'model', { executor: 'grok-text' }, { prompt: o('extract') }),
  ], outputs: { description: o('model') } } }, { items: o('items') })]);
  const r = await run(service, create(service, d), { items: Array.from({ length: 20 }, (_, index) => ({ prompt: String(index) })) });
  const done = await until(() => service.run(r.id), (v) => v.state === 'partial_failed');
  const loop = done.instances.find((i) => i.nodeId === 'loop'), rows = repo.artifact(loop.outputs.value).value;
  assert.equal(rows.length, 20);
  assert.equal(new Set(rows.map((r) => r.itemId)).size, 20);
  assert.deepEqual(rows.map((r) => r.index), Array.from({ length: 20 }, (_, i) => i));
  assert.equal(rows[7].status, 'failed');
  for (const row of rows.filter((r) => r.status === 'succeeded')) assert.equal(repo.artifact(row.outputs.description.artifactRef).value, `description-${row.index}`);
  assert.equal(completed.length, 20);
  assert.equal(service.batch(r.id, loop.id, 0).total, 20);
});

test('graph composition supports zip, fixed references, translation, two image branches, alternate executors and saving only descriptions', async (t) => {
  let png, modelCalls = 0;
  const images = [];
  const fx = await fixture(t, { model: async (_s, options) => { options.onRequest(); modelCalls++; return { text: `translated:${options.prompt}` }; }, generate: async (snapshot, value, options) => { options.onDispatch(); images.push({ executor: snapshot.id, prompt: value.prompt, refs: value.images }); return { bytes: png }; } });
  png = fx.png;
  const { service, repo, db } = fx;
  const body = { nodes: [
    n('original', 'transform', { operation: 'field', valueType: 'image', path: ['a'] }, { value: { kind: 'item' } }),
    n('list', 'transform', { operation: 'list', valueType: 'list<image>', keys: ['a'] }, { a: o('original') }),
    n('translate', 'model', { executor: 'grok-text' }, { prompt: { kind: 'capture', name: 'prompt' }, images: o('list') }),
    n('first', 'image.generate', { executor: 'grok-build' }, { prompt: o('translate'), images: { kind: 'capture', name: 'fixed' } }),
    n('second', 'image.generate', { executor: 'comfyui', comfyui: { workflow: { '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } }, '2': { class_type: 'LoadImage', inputs: { image: 'x.png' } }, '3': { class_type: 'SaveImage', inputs: { conditioning: ['1', 0], images: ['2', 0] } } }, prompt: { nodeId: '1', input: 'text' }, outputNodeId: '3' } }, { prompt: o('translate'), images: o('list') }),
  ], outputs: { first: o('first'), second: o('second'), description: o('translate') } };
  const d = definition([
    n('a', 'input', { parameter: 'a', valueType: 'list<image>' }), n('b', 'input', { parameter: 'b', valueType: 'list<image>' }), n('fixed', 'input', { parameter: 'fixed', valueType: 'list<image>' }),
    n('pairs', 'transform', { operation: 'zip', listType: 'list<image>', valueType: 'list<json>' }, { a: o('a'), b: o('b') }),
    n('loop', 'foreach', { itemsType: 'list<json>', maxItems: 10, captureTypes: { prompt: 'text', fixed: 'list<image>' }, body }, { items: o('pairs'), prompt: c('describe'), fixed: o('fixed') }),
  ]);
  const serverConfig = config();
  serverConfig.imageGeneration.comfyui = { baseUrl: 'http://127.0.0.1:8188', workflowName: '', workflow: null, prompt: null, outputNodeId: '' };
  const w = create(service, d);
  // A different service factory allows a configured backend without a live network service.
  const localService = createWorkflowService({ repo, store: fx.store, imageStore: createImageStore(path.join(os.tmpdir(), `unused-${key()}`)), wiki: { image: async () => ({ bytes: png }) }, executionConfig: () => serverConfig,
    model: async (_s, opts) => { opts.onRequest(); modelCalls++; return { text: `translated:${opts.prompt}` }; },
    generate: async (snapshot, value, opts) => { opts.onDispatch(); images.push({ executor: snapshot.id, prompt: value.prompt, refs: value.images }); return { bytes: png }; },
  });
  // Keep one scheduler owner; this secondary service only prepares the run.
  const inputs = { a: [{ elementId: 1 }, { elementId: 2 }], b: [{ elementId: 3 }, { elementId: 4 }], fixed: [{ elementId: 5 }] };
  const r = await localService.createRun(w.id, { revision: w.revision, requestKey: key(), inputs });
  const done = await until(() => service.run(r.id), (v) => v.state === 'succeeded');
  assert.equal(modelCalls, 2);
  assert.equal(images.length, 4);
  assert.deepEqual(new Set(images.map((i) => i.executor)), new Set(['grok-build', 'comfyui']));
  assert.ok(images.every((i) => i.prompt === 'translated:describe' && i.refs.length === 1));
  const rows = repo.artifact(done.instances.find((i) => i.nodeId === 'loop').outputs.value).value;
  assert.equal(rows.length, 2);
  const onlyDescription = definition([n('describe', 'model', { executor: 'grok-text' }, { prompt: c('describe') }), n('save', 'library.save', { valueType: 'text', tags: [], source: 'only description' }, { value: o('describe') })]);
  const descriptionRun = await run(service, create(service, onlyDescription));
  await until(() => service.run(descriptionRun.id), (v) => v.state === 'succeeded');
  assert.equal(images.length, 4);
  assert.equal(db.prepare("SELECT count(*) AS n FROM elements WHERE body='translated:describe'").get().n, 1);
  const mismatch = await localService.createRun(w.id, { revision: w.revision, requestKey: key(), inputs: { ...inputs, b: [] } });
  await until(() => service.run(mismatch.id), (v) => v.instances.some((i) => i.nodeId === 'pairs' && i.state === 'failed'));
  assert.equal(images.length, 4);
});

test('cancelled remote attempts can archive late results without running downstream; pause does not dispatch new dependents', async (t) => {
  let finish, calls = 0;
  const { service, repo } = await fixture(t, { model: async (_s, opts) => { opts.onRequest(); calls++; return new Promise((resolve) => { finish = resolve; }); } });
  const w = create(service, definition([n('model', 'model', { executor: 'grok-text' }, { prompt: c('work') }), n('downstream', 'preview', { valueType: 'text' }, { value: o('model') })]));
  const r = await run(service, w);
  let detail = await until(() => service.run(r.id), () => !!finish);
  service.control(r.id, { requestKey: key(), controlVersion: detail.controlVersion, action: 'pause' });
  finish({ text: 'result' });
  await until(() => service.run(r.id), (r) => r.instances[0].state === 'succeeded');
  detail = service.run(r.id); assert.equal(detail.state, 'paused'); assert.equal(detail.instances[1].state, 'pending');
  service.control(r.id, { requestKey: key(), controlVersion: detail.controlVersion, action: 'resume' });
  await until(() => service.run(r.id), (r) => r.state === 'succeeded');
  finish = null;
  const second = await run(service, w);
  detail = await until(() => service.run(second.id), () => !!finish);
  service.control(second.id, { requestKey: key(), controlVersion: detail.controlVersion, action: 'cancel' });
  finish({ text: 'late result' });
  await until(() => repo.attempts(detail.instances[0].id), (v) => v[0]?.state === 'succeeded');
  detail = service.run(second.id);
  assert.equal(detail.state, 'cancelled');
  assert.ok(detail.instances.every((i) => i.state === 'cancelled'));
  assert.equal(repo.attempts(detail.instances[1].id).length, 0);
  assert.equal(calls, 2);
});

test('save failure retries only the atomic library commit, preserving generated images and original model answers', async (t) => {
  let modelCalls = 0;
  const { service, db, repo } = await fixture(t, { model: async (_s, opts) => { opts.onRequest(); modelCalls++; return { text: 'saved text' }; } });
  db.exec("CREATE TRIGGER workflow_fail_receipt BEFORE INSERT ON workflow_save_receipts BEGIN SELECT RAISE(ABORT,'fixture save failure'); END");
  const r = await run(service, create(service, definition([n('model', 'model', { executor: 'grok-text' }, { prompt: c('describe') }), n('save', 'library.save', { valueType: 'text', tags: [] }, { value: o('model') })])));
  let detail = await until(() => service.run(r.id), (v) => v.instances.some((i) => i.nodeId === 'save' && i.state === 'failed'));
  assert.equal(db.prepare("SELECT count(*) AS n FROM elements WHERE body='saved text'").get().n, 0);
  db.exec('DROP TRIGGER workflow_fail_receipt');
  const failed = detail.instances.find((i) => i.nodeId === 'save');
  service.nodeAction(r.id, failed.id, { action: 'retry', requestKey: key(), controlVersion: detail.controlVersion });
  detail = await until(() => service.run(r.id), (v) => v.state === 'succeeded');
  assert.equal(modelCalls, 1);
  assert.equal(repo.attempts(failed.id).length, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM elements WHERE body='saved text'").get().n, 1);
});

test('out-of-order human decisions keep loop pairing stable and expansion stays bounded', async (t) => {
  const { service, repo } = await fixture(t);
  const w = create(service, definition([n('items', 'input', { parameter: 'items', valueType: 'list<text>' }), n('loop', 'foreach', { itemsType: 'list<text>', maxItems: 1000, captureTypes: {}, body: { nodes: [n('review', 'review', { valueType: 'text' }, { value: { kind: 'item' } })], outputs: { text: o('review') } } }, { items: o('items') })]));
  const r = await run(service, w, { items: Array.from({ length: 20 }, (_, i) => `source-${i}`) });
  let count = 0;
  while (count < 20) {
    const detail = await until(() => service.run(r.id), (v) => v.instances.some((i) => i.state === 'waiting_review'));
    const waiting = detail.instances.filter((i) => i.state === 'waiting_review').sort((a, b) => b.context.index - a.context.index);
    assert.ok(waiting.length <= 8);
    for (const i of waiting) {
      const controlVersion = service.run(r.id).controlVersion;
      service.nodeAction(r.id, i.id, { requestKey: key(), action: 'accept', controlVersion, value: `edited-${i.context.index}` }); count++;
    }
  }
  const done = await until(() => service.run(r.id), (v) => v.state === 'succeeded');
  const rows = repo.artifact(done.instances.find((i) => i.nodeId === 'loop').outputs.value).value;
  assert.deepEqual(rows.map((r) => repo.artifact(r.outputs.text.artifactRef).value), Array.from({ length: 20 }, (_, i) => `edited-${i}`));
});
