import test from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { createServer, fetch } from "../helpers/authenticatedServer.js";
import { defaultVideoAnalysisConfig, videoAnalysisConfig } from "../../src/shared/domain/videoAnalysis.js";
import { defaultOrganizationConfig } from "../../src/shared/domain/organization.js";
import { encodeVisual } from "../../src/server/semantic/visualEncoderClient.js";
import { probeVideoTools } from "../../src/server/assets/videoAnalysisFrames.js";
import { initDb } from "../../src/server/data/sqlite.js";
import { createElementRepository } from "../../src/server/data/elementRepository.js";
import { createVideoAnalysisRepository } from "../../src/server/data/videoAnalysisRepository.js";
import { createVideoAnalysisService } from "../../src/server/application/videoAnalysisService.js";
import { createHash } from "node:crypto";

test("resuming published application needs neither media tools nor model execution", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wiki-video-resume-"));
  const db = initDb(":memory:"), wiki = createElementRepository(db), repo = createVideoAnalysisRepository(db, { wiki });
  let service;
  t.after(async () => { await service?.close(); db.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("wiki-video-resume-")); await rm(directory, { recursive: true, force: true }); });
  const config = { ...defaultVideoAnalysisConfig(), ffmpeg: "missing-ffmpeg-for-resume", ffprobe: "missing-ffprobe-for-resume" };
  const organization = defaultOrganizationConfig(); organization.executor.codexCli.executable = "missing-codex-for-resume";
  await writeFile(path.join(directory, "video-analysis.json"), JSON.stringify(config));
  const configKey = createHash("sha256").update(JSON.stringify(["video-analysis-v1", config.ffmpeg, config.ffprobe, config.frameIntervalMs,
    { type: organization.executor.type, codexCli: organization.executor.codexCli }])).digest("hex");
  const video = wiki.importVideo({ tags: [] }, { storageKey: "resume.mp4", contentHash: "resume", mimeType: "video/mp4", byteSize: 10, originalName: "resume.mp4" }).element;
  repo.enqueue(video.id, { configKey, auto: true });
  const run = repo.claim(configKey);
  repo.saveExtraction(run.id, run.token, { durationMs: 10000, coveredUntilMs: 5000, complete: false,
    frames: [{ key: "resume", timestampMs: 1000, shotId: "one", windowId: "one", path: "resume.png" }] });
  const batch = repo.batches(run.id, run.token)[0];
  repo.completeBatch(run.id, run.token, { batchKey: batch.key, observations: [{ frameIds: [batch.frames[0].id], body: "saved observation", tags: [] }] });
  db.exec("CREATE TEMP TRIGGER fail_resume BEFORE INSERT ON video_markers BEGIN SELECT RAISE(ABORT,'write failed'); END");
  assert.throws(() => repo.finish(run.id, run.token), /write failed/);
  db.exec("DROP TRIGGER fail_resume");
  service = await createVideoAnalysisService({ repo, wiki: { ...wiki, videoStorage: (id) => wiki.video(id) }, dataDir: directory, executionConfig: () => organization.executor, getEmbeddingConfig: () => organization.embedding });
  service.start();
  await eventually(() => service.status(video.id).run.state === "partial", "application did not resume without external tools");
  const status = service.status(video.id);
  assert.equal(status.run.applicationPending, false);
  assert.equal(status.run.completedBatches, 1);
  assert.equal(status.run.extractedUntilMs, 5000);
  assert.equal(status.results[0].state, "applied");
  assert.equal(wiki.markers.list(video.id).pagination.total, 1);
});

test("visual rejection refills results for image, evidence-frame and whole-video searches", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wiki-video-rejections-"));
  const db = initDb(":memory:"), wiki = createElementRepository(db), repo = createVideoAnalysisRepository(db, { wiki });
  let service;
  t.after(async () => { await service?.close(); db.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("wiki-video-rejections-")); await rm(directory, { recursive: true, force: true }); });
  const visual = { ...defaultVideoAnalysisConfig().visual, enabled: true, model: "fixture", baseUrl: await encoder(t) };
  const { space } = await encodeVisual(visual, { texts: ["fixture"] });
  const imageBytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } }).png().toBuffer();
  const images = Array.from({ length: 14 }, (_, index) => wiki.importImage({ tags: [] }, {
    storageKey: `rejection-${index}.png`, contentHash: `rejection-${index}`, mimeType: "image/png", byteSize: imageBytes.length, originalName: `rejection-${index}.png`,
  }).element);
  repo.putVectors("image", space, images.map((image, index) => ({ id: image.id, contentHash: `rejection-${index}`, vector: [1, 0, 0] })));
  const video = wiki.importVideo({ tags: [] }, { storageKey: "source.mp4", contentHash: "source-video", mimeType: "video/mp4", byteSize: 10, originalName: "source.mp4" }).element;
  repo.enqueue(video.id, { configKey: "fixture" }); const run = repo.claim("fixture");
  repo.saveExtraction(run.id, run.token, { durationMs: 2000, coveredUntilMs: 2000, complete: true,
    frames: [{ key: "source", timestampMs: 1000, shotId: "one", windowId: "one", path: "source.png" }] });
  const batch = repo.batches(run.id, run.token)[0], frameId = batch.frames[0].id;
  repo.completeBatch(run.id, run.token, { batchKey: batch.key, observations: [] }); repo.finish(run.id, run.token);
  repo.putVectors("frame", space, [{ id: frameId, vector: [1, 0, 0] }]);
  for (const target of images.slice(1, 13)) repo.rejectMatch(images[0].id, target.id);
  repo.rejectMatch(images[0].id, video.id);
  for (const target of images.slice(0, 13)) repo.rejectMatch(video.id, target.id);
  await mkdir(path.join(directory, "video-analysis-cache"));
  await writeFile(path.join(directory, "video-analysis-cache", "source.png"), imageBytes);
  await writeFile(path.join(directory, "video-analysis.json"), JSON.stringify({ ...defaultVideoAnalysisConfig(), visual }));
  const organization = defaultOrganizationConfig();
  service = await createVideoAnalysisService({ repo, wiki: { ...wiki, videoStorage: (id) => wiki.video(id), thumbnail: async () => ({ bytes: imageBytes }) },
    dataDir: directory, executionConfig: () => organization.executor, getEmbeddingConfig: () => organization.embedding });
  for (const input of [{ elementId: images[0].id }, { elementId: video.id, frameId }, { elementId: video.id }]) {
    assert.deepEqual((await service.search(input)).matches.map((hit) => hit.elementId), [images.at(-1).id]);
  }
});

const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(fn, message, timeout = 30000) {
  const start = Date.now(); let result;
  while (Date.now() - start < timeout) { result = await fn(); if (result) return result; await sleep(150); }
  assert.fail(`${message}; last result ${JSON.stringify(result)}`);
}
async function encoder(t, onEncode) {
  const server = httpServer(async (req, res) => {
    try {
      if (req.url === "/health") { res.end(JSON.stringify({ model: "fixture", revision: "1", ready: true })); return; }
      let text = ""; for await (const part of req) text += part;
      const body = JSON.parse(text);
      if (await onEncode?.(body, res)) return;
      const embeddings = body.images ? await Promise.all(body.images.map(async (image) => {
        const stats = await sharp(Buffer.from(image, "base64")).stats();
        return stats.channels[2].mean > stats.channels[0].mean ? [0, 0, 1] : [1, 0, 0];
      })) : body.texts.map((q) => q.includes("蓝") ? [0, 0, 1] : [1, 0, 0]);
      res.end(JSON.stringify({ model: body.model, revision: body.revision, fingerprint: "a".repeat(64), dimensions: 3, embeddings }));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("video config validates limits and visual model identity partitions vectors", async (t) => {
  assert.deepEqual(videoAnalysisConfig({}), defaultVideoAnalysisConfig());
  for (const input of [{ maxFrames: 1001 }, { timeoutMs: 600001 }, { frameIntervalMs: 0 }, { enabled: "yes" }, { unknown: true },
    { visual: { baseUrl: "http://example.com/path" } }, { visual: { baseUrl: "http://name:secret@localhost" } }]) assert.throws(() => videoAnalysisConfig(input));
  const visual = { ...defaultVideoAnalysisConfig().visual, baseUrl: await encoder(t), model: "fixture" };
  const one = await encodeVisual(visual, { texts: ["蓝"] }, AbortSignal.timeout(5000));
  const two = await encodeVisual({ ...visual, revision: "2" }, { texts: ["蓝"] }, AbortSignal.timeout(5000));
  assert.deepEqual(one.vectors, [[0, 0, 1]]); assert.notEqual(one.space, two.space);
});

test("video HTTP routes reject invalid config and preserve startup without optional dependencies", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wiki-video-status-"));
  let app;
  t.after(async () => { await app?.close(); await rm(directory, { recursive: true, force: true }); });
  app = await createServer({ port: 0, dataDir: directory });
  const status = await (await fetch(`${app.url}api/video-analysis/status`)).json();
  assert.equal(status.config.enabled, false); assert.equal(status.visual.enabled, false);
  const bad = await fetch(`${app.url}api/video-analysis/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: '{"maxFrames":1001}' });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${app.url}api/visual-search`)).status, 400);
  assert.equal((await fetch(`${app.url}api/video-analysis/frames/999`)).status, 404);
  const cli = JSON.parse((await exec(process.execPath, ["src/cli/main.js", "video-analysis", "status", "--url", app.url, '--token-file', app.credentialFile], { windowsHide: true })).stdout);
  assert.ok(JSON.stringify(cli).includes('"enabled":false'));
  const config = { ...status.config, visual: { ...status.config.visual, enabled: true, model: "fixture", baseUrl: await encoder(t) } };
  const save = (body) => fetch(`${app.url}api/video-analysis/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await save(config)).status, 200);
  await mkdir(path.join(directory, "video-analysis.json.tmp"));
  assert.equal((await save({ ...config, frameIntervalMs: 1000 })).status, 500);
  assert.equal((await fetch(`${app.url}api/visual-search?q=blue`)).status, 200, "failed config persistence must restore the old service signal");
  assert.equal((await (await fetch(`${app.url}api/video-analysis/status`)).json()).config.frameIntervalMs, config.frameIntervalMs);
});

test("visual search waits for a busy background encoder and returns the indexed image", { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wiki-video-busy-"));
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), contention = Promise.withResolvers();
  let app, active = false, first = true, busyForever = false;
  t.after(async () => { release.resolve(); await app?.close(); await rm(directory, { recursive: true, force: true }); });
  const baseUrl = await encoder(t, async (_body, res) => {
    if (active || busyForever) { res.statusCode = 429; res.end(); contention.resolve(); return true; }
    if (first) { first = false; active = true; entered.resolve(); await release.promise; active = false; }
    return false;
  });
  app = await createServer({ port: 0, dataDir: directory });
  const bytes = await sharp({ create: { width: 24, height: 24, channels: 3, background: "blue" } }).png().toBuffer();
  const image = await (await fetch(`${app.url}api/images`, { method: "POST", headers: { "x-file-name": "blue.png" }, body: bytes })).json();
  const config = defaultVideoAnalysisConfig(); config.visual = { ...config.visual, enabled: true, model: "fixture", baseUrl, timeoutMs: 1000 };
  assert.equal((await fetch(`${app.url}api/video-analysis/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(config) })).status, 200);
  await entered.promise;
  const pending = fetch(`${app.url}api/visual-search?q=${encodeURIComponent("蓝")}`).then((response) => response.json());
  await contention.promise;
  release.resolve();
  const result = await pending;
  assert.equal(result.diagnostic, "");
  assert.ok(result.matches.some((hit) => hit.elementId === image.id));
  const status = await (await fetch(`${app.url}api/visual-index/status`)).json();
  assert.equal(status.ready, true);
  busyForever = true;
  const red = await sharp({ create: { width: 24, height: 24, channels: 3, background: "red" } }).png().toBuffer();
  await fetch(`${app.url}api/images`, { method: "POST", headers: { "x-file-name": "red.png" }, body: red });
  const busy = await eventually(async () => {
    const value = await (await fetch(`${app.url}api/visual-index/status`)).json();
    return value.diagnostic.includes("达到本次等待时限") && value;
  }, "background contention did not reach its bounded wait", 6000);
  assert.equal(busy.ready, true, "a healthy but busy encoder must retain its established readiness");
});

test("real FFmpeg and process fixture complete HTTP analysis, visual retrieval and correction", { timeout: 90000 }, async (t) => {
  const commands = { ffmpeg: process.env.FFMPEG_PATH || "ffmpeg", ffprobe: process.env.FFPROBE_PATH || "ffprobe" };
  if (!(await probeVideoTools(commands)).available) { t.skip("Set FFMPEG_PATH and FFPROBE_PATH for end-to-end media validation"); return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), "wiki-video-flow-"));
  let app;
  t.after(async () => { await app?.close(); await rm(directory, { recursive: true, force: true }); });
  const executable = path.join(directory, "codex-fixture.mjs");
  await writeFile(executable, `import {readFile,writeFile} from 'node:fs/promises';
const args=process.argv.slice(2);
if(args.includes('--version')){console.log('codex-cli fixture');process.exit(0)}
if(args.includes('--help')){console.log('--image --output-schema --ephemeral');process.exit(0)}
if(args[0]==='login'){console.log('Logged in');process.exit(0)}
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const frames=JSON.parse(prompt.split('附件顺序和来源：').at(-1));
const files=args.flatMap((value,i)=>value==='--image'?[args[i+1]]:[]);
if(files.length!==frames.length||new Set(files).size!==files.length)process.exit(3);
for(const file of files)if(!(await readFile(file)).length)process.exit(4);
const observations=frames.map(f=>({frameIds:[f.frameId],body:'蓝色测试画面',tags:['蓝色']}));
await writeFile(args[args.indexOf('-o')+1],JSON.stringify({observations}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:42,output_tokens:12}}));`);
  const organization = defaultOrganizationConfig();
  organization.executor.codexCli = { ...organization.executor.codexCli, executable, codexHome: path.join(directory, "model-home"), model: "fixture-video" };
  await writeFile(path.join(directory, "organization.json"), JSON.stringify(organization));
  app = await createServer({ port: 0, dataDir: directory });
  async function api(route, method = "GET", body) {
    const response = await fetch(`${app.url}api/${route}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  }
  const config = { ...defaultVideoAnalysisConfig(), ...commands, frameIntervalMs: 500,
    visual: { ...defaultVideoAnalysisConfig().visual, enabled: true, model: "fixture", baseUrl: await encoder(t) } };
  await api("video-analysis/config", "PUT", config);
  const videoPath = path.join(directory, "blue.mp4");
  await exec(commands.ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x90:d=2:r=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", videoPath], { windowsHide: true, timeout: 30000 });
  const uploaded = await fetch(`${app.url}api/videos`, { method: "POST", headers: { "x-file-name": "blue.mp4" }, body: await readFile(videoPath) });
  assert.equal(uploaded.status, 201); const video = await uploaded.json();
  const blueImage = await sharp({ create: { width: 24, height: 24, channels: 3, background: "blue" } }).png().toBuffer();
  const image = await (await fetch(`${app.url}api/images`, { method: "POST", headers: { "x-file-name": "blue.png" }, body: blueImage })).json();
  await api(`elements/${video.id}/video-analysis`, "POST", {});
  let ready = await eventually(async () => {
    const value = await api(`elements/${video.id}/video-analysis`);
    if (value.run?.state === "failed") assert.fail(value.run.error);
    return value.run?.state === "ready" && value;
  }, "analysis did not complete");
  assert.ok(ready.results.length); assert.equal(ready.results[0].state, "suggested");
  await api("video-analysis/config", "PUT", { ...config, enabled: true });
  organization.imageGeneration.executor = "chatgpt-web";
  organization.executor.timeoutMs += 1000;
  await api("organization/config", "PUT", organization);
  await sleep(2200);
  assert.equal((await api(`elements/${video.id}/video-analysis`)).run.id, ready.run.id,
    "image generation and execution time budgets must not reanalyze completed videos");
  organization.executor.codexCli.model = "fixture-video-next";
  await api("organization/config", "PUT", organization);
  ready = await eventually(async () => {
    const value = await api(`elements/${video.id}/video-analysis`);
    return value.run?.id !== ready.run.id && value.run?.state === "ready" && value;
  }, "changing the analysis model must create a new run");
  const observation = ready.results[0];
  assert.equal((await fetch(`${app.url}api/video-analysis/frames/${observation.frameIds[0]}`)).headers.get("content-type"), "image/png");
  const accepted = await api(`video-analysis/results/${observation.id}/accept`, "POST", { revision: observation.revision });
  assert.ok(accepted.markerId);
  const related = await eventually(async () => {
    const result = await api(`visual-search?elementId=${image.id}`);
    return result.matches.some((hit) => hit.elementId === video.id && hit.frameId) && result;
  }, "visual indexing did not connect image to video frame");
  assert.ok(related.matches[0].startMs >= 0);
  await api("visual-search/rejections", "POST", { sourceId: image.id, targetId: video.id });
  assert.ok(!(await api(`visual-search?elementId=${image.id}&q=${encodeURIComponent("蓝色")}`)).matches.some((hit) => hit.elementId === video.id));
  const marker = await api(`video-markers/${accepted.markerId}`);
  await api(`video-markers/${marker.id}`, "PUT", { startMs: marker.startMs, endMs: marker.endMs, body: "人工修正画面", tags: ["修正"], targetIds: [], revision: marker.revision });
  const current = await api(`elements/${video.id}/video-analysis`);
  assert.equal(current.results.find((result) => result.id === observation.id).state, "modified");
  assert.ok((await api(`visual-search?q=${encodeURIComponent("人工修正")}`)).matches.some((hit) => hit.markerId === marker.id));
  await api(`elements/${video.id}`, "DELETE");
  assert.equal((await fetch(`${app.url}api/video-analysis/frames/${observation.frameIds[0]}`)).status, 404);
});
