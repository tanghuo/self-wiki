import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { extractVideoFrames, probeVideoTools } from "../src/server/assets/videoAnalysisFrames.js";
import { videoAnalysisOutput } from "../src/shared/domain/videoAnalysisOutput.js";
import { codexCli } from "../src/agent/executors/codexCli.js";
import { defaultOrganizationConfig } from "../src/shared/domain/organization.js";

const exec = promisify(execFile);
const commands = { ffmpeg: process.env.FFMPEG_PATH || "ffmpeg", ffprobe: process.env.FFPROBE_PATH || "ffprobe" };
async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wiki-video-frames-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("video observations enforce bounded frame evidence and reject malformed tags", () => {
  assert.deepEqual(videoAnalysisOutput({ observations: [{ frameIds: [1, 1, 2], body: " 街道 ", tags: ["夜晚", "夜晚"] }] }),
    { observations: [{ frameIds: [1, 2], body: "街道", tags: ["夜晚"] }] });
  for (const invalid of [null, { observations: [{ frameIds: [], body: "街道", tags: [] }] },
    { observations: [{ frameIds: [1.1], body: "街道", tags: [] }] },
    { observations: [{ frameIds: [1], body: "街道", tags: ["坏\n标签"] }] },
    { observations: [{ frameIds: [1], body: "街道", tags: [], confidence: 0.99 }] }]) assert.throws(() => videoAnalysisOutput(invalid));
});

test("video executor keeps two frames of the same video as separate attachments", async (t) => {
  const directory = await temporary(t), executable = path.join(directory, "codex.mjs");
  await writeFile(executable, await readFile(new URL("./fixtures/video-analysis-codex.txt", import.meta.url)));
  const config = defaultOrganizationConfig().executor;
  config.codexCli = { ...config.codexCli, executable, model: "fixture-video" };
  const bytes = [Buffer.from("first-image"), Buffer.from("second-image")], usage = [];
  const request = { kind: "video-analysis", prompt: JSON.stringify(bytes.map((item) => item.toString("base64"))),
    images: bytes.map((value, index) => ({ elementId: 7, attachmentId: `frame-${101 + index}`, bytes: value })) };
  const result = await codexCli.execute(request, { config, signal: AbortSignal.timeout(10000), onUsage: (record) => usage.push(record) });
  assert.deepEqual(result.output.observations[0].frameIds, [101, 102]);
  assert.equal(result.execution.model, "fixture-video");
  assert.equal(usage.at(-1).usage.input_tokens, 42);
  await assert.rejects(codexCli.execute({ ...request, images: [request.images[0], request.images[0]] }, { config }), { code: "INVALID_INPUT" });
  await assert.rejects(codexCli.execute({ ...request, images: [{ ...request.images[0], attachmentId: "../escape" }] }, { config }), { code: "INVALID_INPUT" });
});

test("missing video tools and cancellation are explicit and leave no assets", async (t) => {
  const directory = await temporary(t), missing = path.join(directory, "missing-ffmpeg.exe");
  assert.equal((await probeVideoTools({ ffmpeg: missing, ffprobe: missing })).available, false);
  await assert.rejects(extractVideoFrames({ inputPath: path.join(directory, "input.mp4"), outputDir: path.join(directory, "frames"), ffprobe: missing },
    { signal: AbortSignal.abort() }), { code: "CANCELLED" });
  assert.deepEqual(await readdir(directory), []);
});

test("real FFmpeg samples cuts, VFR presentation times, resumes and respects resource budgets", { timeout: 120000 }, async (t) => {
  const status = await probeVideoTools(commands);
  if (!status.available) { t.skip("FFmpeg/ffprobe unavailable; set FFMPEG_PATH and FFPROBE_PATH for real media validation"); return; }
  const directory = await temporary(t), inputPath = path.join(directory, "variable frame rate.mkv");
  // Deliberately uneven PTS, a nonzero container origin, and a brief bright shot.
  await exec(commands.ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=6",
    "-vf", "select='not(mod(n,3))+eq(n,11)+eq(n,12)',drawbox=color=white:t=fill:enable='between(t,1.1,1.2)',setpts=PTS+5/TB",
    "-fps_mode", "passthrough", "-c:v", "ffv1", inputPath], { windowsHide: true, timeout: 30000 });
  const options = { ...commands, inputPath, outputDir: path.join(directory, "full"), frameIntervalMs: 2000, maxFrames: 100, timeoutMs: 30000 };
  const full = await extractVideoFrames(options);
  assert.equal(full.complete, true);
  assert.equal(full.timeOriginMs, 5000);
  assert.ok(full.frames.some((frame) => Math.abs(frame.timestampMs - 6100) <= 1), "brief shot between periodic samples was retained");
  assert.ok(new Set(full.frames.map((frame) => frame.shotId)).size > 1);
  const probe = JSON.parse((await exec(commands.ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", inputPath], { windowsHide: true })).stdout);
  const pts = new Set(probe.frames.map((frame) => Math.round(Number(frame.best_effort_timestamp_time) * 1000)));
  for (const frame of full.frames) {
    assert.ok(pts.has(frame.timestampMs), `frame ${frame.timestampMs} uses actual PTS`);
    assert.equal(path.dirname(frame.path), await realpath(options.outputDir));
  }
  assert.equal(full.bytes, (await Promise.all(full.frames.map(async (frame) => (await stat(frame.path)).size))).reduce((sum, value) => sum + value, 0));
  const partial = await extractVideoFrames({ ...options, outputDir: path.join(directory, "partial"), maxFrames: 2 });
  assert.equal(partial.complete, false); assert.equal(partial.reason, "frame-limit"); assert.equal(partial.frames.length, 2);
  const resumed = await extractVideoFrames({ ...options, outputDir: path.join(directory, "resumed"), startMs: partial.coveredUntilMs });
  assert.equal(resumed.complete, true);
  assert.ok(resumed.frames[0].timestampMs >= partial.coveredUntilMs);
  assert.ok(resumed.frames[0].timestampMs - partial.coveredUntilMs <= 300);
  const cacheBudget = Math.max(1024, Math.floor((await stat(full.frames[0].path)).size * 1.5));
  const bounded = await extractVideoFrames({ ...options, outputDir: path.join(directory, "bounded"), maxCacheBytes: cacheBudget });
  assert.equal(bounded.complete, false); assert.equal(bounded.reason, "cache-limit"); assert.ok(bounded.bytes <= cacheBudget);
  await assert.rejects(extractVideoFrames({ ...options, outputDir: path.join(directory, "cancelled") }, { signal: AbortSignal.timeout(10) }), { code: "CANCELLED" });
  const invalidPath = path.join(directory, "broken.mp4"); await writeFile(invalidPath, "not a video");
  await assert.rejects(extractVideoFrames({ ...options, inputPath: invalidPath }), { code: "VIDEO_DECODE_ERROR" });
});

test("extracted MP4 and WebM timestamps seek to the same pixels in an HTML video", { timeout: 120000 }, async (t) => {
  if (!(await probeVideoTools(commands)).available) { t.skip("FFmpeg/ffprobe unavailable"); return; }
  const browserPath = [process.env.RENDERER_BROWSER_PATH, chromium.executablePath(), "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium"].find((value) => value && existsSync(value));
  if (!browserPath) { t.skip("Chromium unavailable for HTML media clock validation"); return; }
  const directory = await temporary(t), browser = await chromium.launch({ executablePath: browserPath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  for (const extension of ["mp4", "webm"]) {
    const inputPath = path.join(directory, `offset.${extension}`);
    await exec(commands.ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:size=160x90:rate=10:duration=6",
      "-vf", "drawbox=color=white:t=fill:enable='between(t,1,2)',setpts=PTS+5/TB", "-fps_mode", "passthrough",
      "-c:v", extension === "mp4" ? "libx264" : "libvpx-vp9", ...(extension === "mp4" ? ["-use_editlist", "0"] : []), inputPath], { windowsHide: true, timeout: 30000 });
    const result = await extractVideoFrames({ ...commands, inputPath, outputDir: path.join(directory, extension), timeoutMs: 30000 });
    assert.ok(result.timeOriginMs > 0, `${extension} fixture has a positive presentation start`);
    let brightFrame;
    for (const frame of result.frames) if ((await sharp(frame.path).raw().toBuffer())[0] > 240) { brightFrame = frame; break; }
    assert.ok(brightFrame, `${extension} bright scene was extracted`);
    const source = `data:video/${extension};base64,${(await readFile(inputPath)).toString("base64")}`;
    const displayed = await page.evaluate(async ({ source: src, timestampMs }) => {
      const video = document.createElement("video"); video.muted = true;
      await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; video.src = src; });
      const start = video.currentTime, duration = video.duration;
      await new Promise((resolve) => { video.onseeked = resolve; video.currentTime = timestampMs / 1000; });
      const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 90;
      const context = canvas.getContext("2d"); context.drawImage(video, 0, 0);
      return { start, duration, time: video.currentTime, red: context.getImageData(50, 50, 1, 1).data[0] };
    }, { source, timestampMs: brightFrame.timestampMs });
    assert.ok(Math.abs(displayed.start * 1000 - result.frames[0].timestampMs) <= 1, `${extension} starts on the browser clock`);
    assert.ok(Math.abs(displayed.time * 1000 - brightFrame.timestampMs) <= 1, `${extension} seeks to the extracted PTS`);
    assert.ok(displayed.red > 240, `${extension} timestamp displays the extracted bright scene`);
    assert.ok(result.durationMs >= displayed.duration * 1000 - 1);
  }
});
