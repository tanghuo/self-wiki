import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { mkdir, lstat, realpath, open, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const maxDurationMs = 7 * 24 * 60 * 60 * 1000;
const sceneThreshold = 0.3;

function failure(message, code = "VIDEO_DECODE_ERROR") { return Object.assign(new Error(message), { code }); }

// No shell or network protocols: executable paths and local media are separate arguments.
async function run(command, args, { signal, timeoutMs, onStdout, onStderr } = {}) {
  if (signal?.aborted) throw failure("视频分析已取消", "CANCELLED");
  if (typeof command !== "string" || !command.trim() || /[\r\n\0]/.test(command)) throw failure("FFmpeg 路径无效", "DEPENDENCY_MISSING");
  const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stopped, stdout = "", stderr = "";
  const outDecoder = new StringDecoder("utf8"), errDecoder = new StringDecoder("utf8");
  const stop = (error) => { if (!stopped) { stopped = error; child.kill("SIGKILL"); } };
  const abort = () => stop(failure("视频分析已取消", "CANCELLED"));
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop(failure("视频抽帧达到时间预算", "TIMEOUT")), timeoutMs || 10000);
  const closed = new Promise((resolve, reject) => {
    child.on("error", (error) => reject(failure(`无法启动视频工具：${error.code || "进程错误"}`, "DEPENDENCY_MISSING")));
    child.on("close", (code) => resolve(code));
  });
  child.stderr.on("data", (chunk) => {
    const text = errDecoder.write(chunk); stderr = (stderr + text).slice(-12000);
    try { onStderr?.(text); } catch (error) { stop(error); }
  });
  const read = (async () => {
    try {
      for await (const chunk of child.stdout) {
        if (stopped) continue;
        if (onStdout) await onStdout(chunk, stop);
        else { stdout += outDecoder.write(chunk); if (stdout.length > 1024 * 1024) stop(failure("视频工具输出超过限制")); }
      }
    } catch (error) { stop(error); }
  })();
  try {
    const [code] = await Promise.all([closed, read]);
    if (!onStdout) stdout += outDecoder.end();
    if (stopped) throw stopped;
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", abort);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

export async function probeVideoTools({ ffmpeg = "ffmpeg", ffprobe = "ffprobe" } = {}, { signal } = {}) {
  try {
    const results = await Promise.all([run(ffmpeg, ["-version"], { signal }), run(ffprobe, ["-version"], { signal })]);
    if (results.some((result) => result.code !== 0)) throw failure("FFmpeg 或 ffprobe 无法执行", "DEPENDENCY_MISSING");
    return { available: true, code: "READY", diagnostic: "FFmpeg 和 ffprobe 已就绪",
      ffmpegVersion: results[0].stdout.split(/\r?\n/)[0].slice(0, 200), ffprobeVersion: results[1].stdout.split(/\r?\n/)[0].slice(0, 200) };
  } catch (error) {
    if (error.code === "CANCELLED") throw error;
    return { available: false, code: error.code || "DEPENDENCY_MISSING", diagnostic: error.message };
  }
}

// Decode from the start, without seeking or substituting the browser's preview cover.
export async function extractVideoFirstFrame({ inputPath, ffmpeg = "ffmpeg" }, { signal } = {}) {
  if (!path.isAbsolute(inputPath || "") || /[\r\n\0]/.test(inputPath)) throw failure("视频路径无效", "INVALID_INPUT");
  const chunks = [];
  let size = 0;
  const result = await run(ffmpeg, ["-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file,pipe",
    "-i", inputPath, "-map", "0:V:0", "-an", "-sn", "-dn", "-frames:v", "1",
    "-vf", "scale=w='max(1,trunc(iw*sar*min(1,800/max(iw*sar,ih))))':h='max(1,trunc(ih*min(1,800/max(iw*sar,ih))))',setsar=1",
    "-threads", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1"], {
    signal, timeoutMs: 30000,
    onStdout(chunk) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw failure("视频首帧超过大小限制");
      chunks.push(chunk);
    },
  });
  const bytes = Buffer.concat(chunks);
  if (result.code !== 0 || !bytes.subarray(0, 8).equals(pngSignature)) throw failure("无法提取视频首帧，请检查文件与 FFmpeg 编解码支持");
  return bytes;
}

function validateOptions({ inputPath, outputDir, startMs, frameIntervalMs, maxFrames, timeoutMs, maxCacheBytes }) {
  if (!path.isAbsolute(inputPath || "") || !path.isAbsolute(outputDir || "") || /[\r\n\0]/.test(inputPath + outputDir) ||
      !Number.isSafeInteger(startMs) || startMs < 0 || startMs > maxDurationMs ||
      !Number.isSafeInteger(frameIntervalMs) || frameIntervalMs < 250 || frameIntervalMs > 30000 ||
      !Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 1000 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600000 ||
      !Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 1024 || maxCacheBytes > 1024 * 1024 * 1024) throw failure("视频抽帧参数无效", "INVALID_INPUT");
}

export async function extractVideoFrames({ inputPath, outputDir, ffmpeg = "ffmpeg", ffprobe = "ffprobe", startMs = 0,
  frameIntervalMs = 2000, maxFrames = 120, timeoutMs = 120000, maxCacheBytes = 67108864 }, { signal } = {}) {
  validateOptions({ inputPath, outputDir, startMs, frameIntervalMs, maxFrames, timeoutMs, maxCacheBytes });
  const startedAt = Date.now();
  const remaining = () => Math.max(1, timeoutMs - (Date.now() - startedAt));
  const probe = await run(ffprobe, ["-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "V:0", "-show_entries",
    "format=duration,start_time:stream=codec_type,duration,start_time", "-of", "json", inputPath], { signal, timeoutMs: remaining() });
  let metadata;
  try { metadata = JSON.parse(probe.stdout); } catch { throw failure("无法读取视频时长与时间轴"); }
  const stream = metadata.streams?.[0];
  const durationMs = Math.round(Math.max(Number(metadata.format?.duration) || 0,
    (Number(stream?.duration) || 0) + Math.max(0, Number(stream?.start_time) || 0)) * 1000);
  const timeOriginMs = Math.round(Number(metadata.format?.start_time ?? stream?.start_time ?? 0) * 1000);
  if (probe.code || !stream || !Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > maxDurationMs || !Number.isSafeInteger(timeOriginMs)) throw failure("视频缺少有效画面、时长或时间轴");
  if (startMs >= durationMs) return { durationMs, timeOriginMs, frames: [], coveredUntilMs: durationMs, complete: true, bytes: 0 };
  let directory = path.resolve(outputDir);
  if (directory === path.parse(directory).root) throw failure("视频帧缓存目录无效", "INVALID_INPUT");
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink()) throw failure("视频帧缓存不能使用符号链接目录", "INVALID_INPUT");
  directory = path.resolve(await realpath(directory));

  const extractionId = randomUUID(), files = [], frameInfo = [], frames = [];
  let bytes = 0, pending = Buffer.alloc(0), logPending = "", infoIndex = -1, limitReason = null;
  const readMetadata = (text) => {
    logPending += text;
    if (logPending.length > 65536) throw failure("视频帧时间戳输出超过限制");
    const lines = logPending.split(/\r?\n/); logPending = lines.pop();
    for (const line of lines) {
      const frame = /\bframe:(\d+)\s+pts:\s*(-?\d+)\s+pts_time:([\d.eE+-]+)/.exec(line);
      if (frame) {
        infoIndex = Number(frame[1]);
        const timestampMs = Math.round(Number(frame[3]) * 1000);
        if (infoIndex > maxFrames + 16 || !Number.isSafeInteger(timestampMs) || timestampMs < startMs - 2 || timestampMs > durationMs + 1000) throw failure("视频帧时间戳无效");
        frameInfo[infoIndex] = { timestampMs: Math.max(startMs, timestampMs), sceneScore: 0 };
      }
      const score = /lavfi\.scene_score=([\d.eE+-]+)/.exec(line);
      if (score && frameInfo[infoIndex]) frameInfo[infoIndex].sceneScore = Number(score[1]);
    }
  };
  const saveFrames = async (chunk, stop) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 8) {
      if (!pending.subarray(0, 8).equals(pngSignature)) throw failure("FFmpeg 返回了无效帧图片");
      let offset = 8, end = 0;
      while (offset + 12 <= pending.length) {
        const length = pending.readUInt32BE(offset);
        if (length > 8 * 1024 * 1024) throw failure("视频单帧超过大小限制");
        if (offset + 12 + length > pending.length) break;
        const type = pending.toString("ascii", offset + 4, offset + 8);
        offset += length + 12;
        if (type === "IEND") { end = offset; break; }
      }
      if (frames.length === maxFrames || bytes + (end || pending.length) > maxCacheBytes) {
        limitReason = frames.length === maxFrames ? "frame-limit" : "cache-limit";
        stop(failure("视频抽帧达到资源预算", "BUDGET_LIMIT")); return;
      }
      if (!end) break;
      const key = `${extractionId}-${frames.length}.png`, file = path.join(directory, key);
      if (path.dirname(file) !== directory) throw failure("视频帧缓存路径无效");
      const handle = await open(file, "wx"); files.push(file);
      try { await handle.writeFile(pending.subarray(0, end)); } finally { await handle.close(); }
      frames.push({ key, path: file }); bytes += end; pending = pending.subarray(end);
    }
    if (pending.length > 8 * 1024 * 1024) throw failure("视频单帧超过大小限制");
  };
  // HTML video keeps a positive media start time (e.g. the first WebM frame can
  // be at currentTime=5). Never subtract it from output evidence. Input -ss is
  // relative to the container start; copyts preserves the original output clock.
  const filters = [`select='gte(t,${startMs / 1000})*(isnan(prev_selected_t)+gte(t-prev_selected_t,${frameIntervalMs / 1000})+gt(scene,${sceneThreshold}))'`,
    "metadata=print:key=lavfi.scene_score",
    "scale=w='max(1,trunc(iw*sar*min(1,768/max(iw*sar,ih))))':h='max(1,trunc(ih*min(1,768/max(iw*sar,ih))))'", "setsar=1"];
  try {
    try {
      const result = await run(ffmpeg, ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "info", "-protocol_whitelist", "file,pipe", "-copyts",
        ...(startMs > timeOriginMs ? ["-ss", String((startMs - timeOriginMs) / 1000)] : []), "-i", inputPath, "-map", "0:V:0", "-an", "-sn", "-dn",
        "-vf", filters.join(","), "-fps_mode", "passthrough", "-frames:v", String(maxFrames + 1), "-threads", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1"],
      { signal, timeoutMs: remaining(), onStdout: saveFrames, onStderr: readMetadata });
      if (result.code !== 0) throw failure("视频解码失败，请检查视频文件与 FFmpeg 编解码支持");
      if (pending.length && !limitReason) throw failure("视频最后一帧不完整");
    } catch (error) {
      if (error.code === "TIMEOUT" && frames.length) limitReason = "timeout";
      else if (error.code !== "BUDGET_LIMIT") throw error;
    }
    readMetadata("\n");
    if (!frames.length) throw failure(limitReason ? "抽帧预算不足以生成一张完整图片" : "视频没有可分析的画面", limitReason ? "BUDGET_LIMIT" : "VIDEO_DECODE_ERROR");
    let shotStartMs = startMs, previousMs = -1;
    for (let index = 0; index < frames.length; index++) {
      const info = frameInfo[index];
      if (!info || info.timestampMs < previousMs) throw failure("无法将视频图片与呈现时间戳对齐");
      if (index === 0 || info.sceneScore > sceneThreshold) shotStartMs = info.timestampMs;
      frames[index] = { ...frames[index], timestampMs: info.timestampMs, shotId: `shot-${shotStartMs}`,
        windowId: `shot-${shotStartMs}-window-${Math.floor((info.timestampMs - shotStartMs) / 14000)}` };
      previousMs = info.timestampMs;
    }
    const complete = !limitReason;
    const coveredUntilMs = complete ? durationMs : Math.min(durationMs, frameInfo[frames.length]?.timestampMs ?? (frames.at(-1).timestampMs + 1));
    return { durationMs, timeOriginMs, frames, coveredUntilMs, complete, bytes, ...(limitReason ? { reason: limitReason } : {}) };
  } catch (error) {
    // Only unlink the files created by this invocation; never recurse into a caller directory.
    await Promise.allSettled(files.map((file) => rm(file, { force: true })));
    throw error;
  }
}
