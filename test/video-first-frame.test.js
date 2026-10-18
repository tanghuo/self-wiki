import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { createServer } from "../src/server/server.js";
import { createVideoStore } from "../src/server/assets/videoStore.js";
import { extractVideoFirstFrame, probeVideoTools } from "../src/server/assets/videoAnalysisFrames.js";
import { defaultVideoAnalysisConfig } from "../src/shared/domain/videoAnalysis.js";
import { defaultOrganizationConfig } from "../src/shared/domain/organization.js";
import { inspectWikiAssets } from "../tools/wiki-assets.mjs";

const exec = promisify(execFile);
const commands = { ffmpeg: process.env.FFMPEG_PATH || "ffmpeg", ffprobe: process.env.FFPROBE_PATH || "ffprobe" };
async function directory(t, close = async () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-first-frame-"));
  t.after(async () => {
    await close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("wiki-first-frame-"));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return root;
}
async function video(root, name = "first.webm", duration = 2) {
  const file = path.join(root, name);
  // Frame 0 is red, all later frames are blue; choosing a cover near 1s is wrong.
  await exec(commands.ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=blue:s=64x48:r=4:d=${duration}`,
    "-vf", "drawbox=c=red:t=fill:enable='eq(n,0)'", "-c:v", "libvpx-vp9", "-lossless", "1", "-threads", "1", file], { windowsHide: true, timeout: 30000 });
  return { file, bytes: await readFile(file) };
}
const red = async (bytes) => { const stats = await sharp(bytes).stats(); assert.ok(stats.channels[0].mean > 240 && stats.channels[2].mean < 10); };

test("first frame validates local paths and propagates cancellation and missing FFmpeg", async (t) => {
  const root = await directory(t);
  await assert.rejects(extractVideoFirstFrame({ inputPath: "https://example.com/video.mp4" }), { code: "INVALID_INPUT" });
  await assert.rejects(extractVideoFirstFrame({ inputPath: path.join(root, "video.mp4") }, { signal: AbortSignal.abort() }), { code: "CANCELLED" });
  await assert.rejects(extractVideoFirstFrame({ inputPath: path.join(root, "video.mp4"), ffmpeg: path.join(root, "missing.exe") }), { code: "DEPENDENCY_MISSING" });
});

test("real first frame differs from cover, is cached, rejects corrupt input and is removed with the video", { timeout: 30000 }, async (t) => {
  if (!(await probeVideoTools(commands)).available) return t.skip("Set FFMPEG_PATH and FFPROBE_PATH for real frame validation");
  const root = await directory(t), fixture = await video(root), store = createVideoStore(path.join(root, "videos"));
  const file = await store.save(Readable.from([fixture.bytes]), "frame.webm");
  const blue = await sharp({ create: { width: 64, height: 48, channels: 3, background: "blue" } }).jpeg().toBuffer();
  await store.saveCover(file.storageKey, { url: `data:image/jpeg;base64,${blue.toString("base64")}`, duration: 2, time: 1 });
  const frame = await store.firstFrame(file.storageKey, commands); await red(frame);
  assert.deepEqual(await store.firstFrame(file.storageKey, { ffmpeg: "must-not-run-from-cache" }), frame);
  await store.remove(file.storageKey); assert.deepEqual(await readdir(path.join(root, "videos")), []);
  await writeFile(path.join(root, "bad.mp4"), "broken video");
  await assert.rejects(extractVideoFirstFrame({ inputPath: path.join(root, "bad.mp4"), ...commands }), /无法提取视频首帧/);
});

test("video first-frame organization recalls an older image, supports suggest/auto, and stacks images and videos without whole-video analysis", { timeout: 90000 }, async (t) => {
  if (!(await probeVideoTools(commands)).available) return t.skip("Set FFMPEG_PATH and FFPROBE_PATH for real pipeline validation");
  let app, encoder;
  const root = await directory(t, async () => {
    await app?.close();
    if (encoder) await new Promise((resolve) => { encoder.close(resolve); encoder.closeAllConnections(); });
  }), fixture = await video(root);
  await writeFile(path.join(root, "expected-frame.png"), await extractVideoFirstFrame({ inputPath: fixture.file, ...commands }));
  encoder = createHttpServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    if (req.url.endsWith("/embeddings")) {
      res.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) })); return;
    }
    const embeddings = body.images ? await Promise.all(body.images.map(async (value) => {
      const stats = await sharp(Buffer.from(value, "base64")).stats();
      return stats.channels[0].mean > stats.channels[2].mean ? [1, 0] : [0, 1];
    })) : body.texts.map(() => [1, 0]);
    res.end(JSON.stringify({ model: body.model, revision: body.revision, fingerprint: "b".repeat(64), dimensions: 2, embeddings }));
  });
  await new Promise((resolve) => encoder.listen(0, "127.0.0.1", resolve));
  const config = defaultOrganizationConfig(), videoConfig = defaultVideoAnalysisConfig();
  config.executor.codexCli = { ...config.executor.codexCli, executable: path.join(root, "codex.mjs"), codexHome: path.join(root, "isolated-auth"), model: "fixture" };
  await writeFile(config.executor.codexCli.executable, await readFile(new URL("./fixtures/video-organization-codex.txt", import.meta.url)));
  config.embedding = { ...config.embedding, enabled: true, dimensions: 2, baseUrl: `http://127.0.0.1:${encoder.address().port}/v1` };
  Object.assign(videoConfig, commands);
  videoConfig.visual = { ...videoConfig.visual, enabled: true, baseUrl: `http://127.0.0.1:${encoder.address().port}` };
  await writeFile(path.join(root, "organization.json"), JSON.stringify(config));
  await writeFile(path.join(root, "video-analysis.json"), JSON.stringify(videoConfig));
  app = await createServer({ port: 0, dataDir: root });
  const api = async (route, body, method = body ? "POST" : "GET") => {
    const response = await fetch(new URL(`api/${route}`, app.url), { method, headers: { "content-type": "application/json" }, ...(body && { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  const upload = async (kind, name, bytes) => {
    const response = await fetch(new URL(`api/${kind}`, app.url), { method: "POST", headers: { "x-file-name": name }, body: bytes });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  async function until(fn) {
    const end = Date.now() + 25000;
    while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 100)); }
    assert.fail("First-frame pipeline did not complete");
  }
  const finished = (id) => until(async () => {
    const value = await api(`organization/status?elementId=${id}`);
    assert.notEqual(value.jobs[0]?.state, "failed", value.jobs[0]?.error);
    return value.results[0] ? api(`organization/results/${value.results[0].id}`) : null;
  });
  const imageBytes = async (color, width) => sharp({ create: { width, height: 48, channels: 3, background: color } }).png().toBuffer();
  const original = await upload("images", "older.png", await imageBytes("red", 64));
  for (let i = 0; i < 15; i++) await upload("images", `noise-${i}.png`, await imageBytes("blue", 65 + i));
  const first = await upload("videos", "first.webm", fixture.bytes);
  await until(async () => { const status = await api("visual-index/status"); return status.ready && status.pending === 0 && status.indexed >= 16; });
  await api("organization/enqueue", { elementId: first.id });
  const suggested = await finished(first.id);
  assert.equal(suggested.context.visual.matches[0].elementId, original.id);
  assert.ok(suggested.execution.rounds >= 2, "Video uses its first-frame description for a second semantic search");
  assert.deepEqual(suggested.execution.firstFrameIds, [first.id]);
  assert.equal(suggested.actions[0].state, "suggested");
  assert.equal((await api(`elements/${first.id}/relations`)).relations.length, 0);
  await api(`organization/results/${suggested.id}/accept`, { indices: [0] });
  assert.equal((await api(`elements?stackOf=${first.id}`)).elements.length, 2);
  await api(`organization/results/${suggested.id}/undo`, {});
  assert.equal((await api(`elements?stackOf=${first.id}`)).elements.length, 1);
  config.enabled = true; config.applyMode = "auto"; await api("organization/config", config, "PUT");
  const second = await upload("videos", "second.webm", (await video(root, "second.webm", 3)).bytes);
  const applied = await finished(second.id);
  assert.ok(applied.actions.every((a) => a.state === "applied")); assert.equal(applied.actions.length, 2);
  assert.ok(applied.execution.firstFrameIds.includes(first.id) && applied.execution.firstFrameIds.includes(second.id));
  const stack = (await api("elements?stackSimilar=1")).elements.find((e) => e.id === second.id);
  assert.equal(stack.similarStack.count, 3);
  assert.deepEqual((await api(`elements?stackOf=${second.id}`)).elements.map((e) => e.id), [second.id, first.id, original.id]);
  const status = await api("video-analysis/status"); assert.equal(status.config.enabled, false);
  assert.equal((await api(`elements/${first.id}/video-analysis`)).results.length, 0);
  const assets = await inspectWikiAssets(root);
  assert.ok(![...assets.unused, ...assets.unknown].some((name) => name.includes("first-frame")));
  await api(`elements/${second.id}`, undefined, "DELETE");
  assert.equal((await fetch(new URL(`api/elements/${second.id}/video-first-frame`, app.url))).status, 404);
  await api("trash/purge", { ids: [second.id] });
  assert.equal((await readdir(path.join(root, "assets", "videos"))).filter((name) => name.endsWith("first-frame-v1.png")).length, 1);
});
