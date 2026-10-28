import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { resolveBrowserPath } from "../resolveBrowserPath.js";
import { createServer } from "../../src/server/server.js";
import { defaultVideoAnalysisConfig } from "../../src/shared/domain/videoAnalysis.js";
import { initDb } from "../../src/server/data/sqlite.js";
import { createElementRepository } from "../../src/server/data/elementRepository.js";
import { createVideoAnalysisRepository } from "../../src/server/data/videoAnalysisRepository.js";
import sharp from "sharp";

const browserPath = resolveBrowserPath();
const options = { timeout: 60000, skip: !browserPath && "Browser required" };

test("real analysis history shows rejected and corrected decisions after refreshing with usable frame evidence", options, async (t) => {
  const { app, page, video } = await setup(t);
  await page.unroute("**/api/**");
  const db = initDb(path.join(app.dataDir, "library.sqlite3"));
  let observations;
  try {
    const wiki = createElementRepository(db), repo = createVideoAnalysisRepository(db, { wiki });
    repo.enqueue(video.id, { configKey: "history-ui" }); const run = repo.claim("history-ui");
    repo.saveExtraction(run.id, run.token, { durationMs: 1500, coveredUntilMs: 1500, complete: true,
      frames: [{ key: "history", timestampMs: 300, shotId: "one", windowId: "one", path: "history.png" }] });
    const batch = repo.batches(run.id, run.token)[0];
    observations = repo.completeBatch(run.id, run.token, { batchKey: batch.key, observations: [
      { frameIds: [batch.frames[0].id], body: "拒绝的旧说明", tags: ["旧标签"] },
      { frameIds: [batch.frames[0].id], body: "待人工纠正", tags: ["旧识别"] },
    ] });
    repo.finish(run.id, run.token);
  } finally { db.close(); }
  await writeFile(path.join(app.dataDir, "video-analysis-cache", "history.png"),
    await sharp({ create: { width: 12, height: 12, channels: 3, background: "green" } }).png().toBuffer());
  await page.getByRole("button", { name: "打开内容：自动标注演示.webm", exact: true }).click();
  const analysis = page.getByRole("region", { name: "视频自动标注", exact: true });
  const rejected = analysis.locator(`[data-result-id="${observations[0].id}"]`), corrected = analysis.locator(`[data-result-id="${observations[1].id}"]`);
  await rejected.getByRole("button", { name: "拒绝结果", exact: true }).click();
  await rejected.waitFor({ state: "hidden" });
  await analysis.getByRole("checkbox", { name: "显示已拒绝结果" }).check();
  await rejected.getByText("已拒绝", { exact: true }).waitFor();
  await rejected.locator("summary").click();
  await page.waitForFunction((id) => document.querySelector(`[data-result-id="${id}"] img`)?.naturalWidth > 0, observations[0].id);
  await corrected.getByRole("button", { name: "应用标注", exact: true }).click();
  await corrected.getByText("AI 已应用", { exact: true }).waitFor();
  const status = await (await fetch(new URL(`api/elements/${video.id}/video-analysis`, app.url))).json();
  const markerId = status.results.find((row) => row.id === observations[1].id).markerId;
  const marker = await (await fetch(new URL(`api/video-markers/${markerId}`, app.url))).json();
  const updated = await fetch(new URL(`api/video-markers/${markerId}`, app.url), { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ startMs: marker.startMs, endMs: marker.endMs, body: "人工确认的说明", tags: ["新标签"], targetIds: [], revision: marker.revision }) });
  assert.ok(updated.ok);
  await corrected.getByText("人工已接管", { exact: true }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "打开内容：自动标注演示.webm", exact: true }).click();
  await corrected.getByText("人工已接管", { exact: true }).waitFor();
  await analysis.getByRole("checkbox", { name: "显示已拒绝结果" }).check();
  await rejected.getByText("已拒绝", { exact: true }).waitFor();
  const search = await (await fetch(new URL(`api/visual-search?q=${encodeURIComponent("拒绝的旧说明")}`, app.url))).json();
  assert.equal(search.matches.length, 0);
});

async function setup(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wiki-video-analysis-ui-"));
  const app = await createServer({ port: 0, dataDir });
  let browser;
  t.after(async () => {
    await browser?.close(); await app.close();
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("wiki-video-analysis-ui-"));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
  });
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(12000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  async function upload(file, name) {
    const response = await fetch(new URL("api/videos", app.url), { method: "POST", headers: { "x-file-name": encodeURIComponent(name) }, body: await readFile(new URL(`../fixtures/${file}`, import.meta.url)) });
    assert.ok(response.ok); return response.json();
  }
  const video = await upload("sample.webm", "自动标注演示.webm"), target = await upload("sample.mp4", "相似视频.mp4");
  const state = {
    config: defaultVideoAnalysisConfig(),
    run: { id: "run-1", videoId: video.id, state: "partial", completedBatches: 1, totalBatches: 3, coverageMs: 500, durationMs: 1500 },
    results: [{ id: "result-1", videoId: video.id, startMs: 300, endMs: 900, body: "街道上的车辆", tags: ["街道", "车辆"], state: "suggested", revision: 4, frameIds: ["frame-1"] },
      { id: "result-2", videoId: video.id, startMs: 900, endMs: null, body: "需要纠正的识别", tags: ["错误概念"], state: "suggested", revision: 2, frameIds: [] }],
    writes: [], searches: [], rejectConflict: true, visualRejected: false,
  };
  await page.route("**/api/**", async (route) => {
    const incoming = route.request(), url = new URL(incoming.url()), endpoint = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (endpoint === "/api/video-analysis/status") return json({ config: state.config, diagnostic: "抽帧与分析依赖可用", run: url.searchParams.get("videoId") === String(video.id) ? state.run : null,
      results: url.searchParams.get("videoId") === String(video.id) ? state.results : [], visual: { enabled: state.config.visual.enabled, ready: true, diagnostic: "视觉服务可用", indexed: 3, pending: 0 } });
    if (endpoint === "/api/video-analysis/config") { state.config = incoming.postDataJSON(); state.writes.push({ endpoint, body: state.config }); return json({ config: state.config }); }
    if (["/api/video-analysis/probe", "/api/visual-index/rebuild"].includes(endpoint)) { state.writes.push({ endpoint }); return json({ diagnostic: "依赖已检测" }); }
    if (endpoint === `/api/elements/${video.id}/video-analysis`) { const body = incoming.postDataJSON(); state.writes.push({ endpoint, body }); state.run = { ...state.run, state: "queued" }; return json({ run: state.run }); }
    if (endpoint === `/api/elements/${video.id}/video-analysis/cancel`) { state.run = { ...state.run, state: "cancelled" }; return json({ run: state.run }); }
    if (endpoint.startsWith("/api/video-analysis/results/")) {
      const body = incoming.postDataJSON(), result = state.results.find((item) => endpoint.includes(item.id));
      state.writes.push({ endpoint, body });
      assert.equal(body.revision, result.revision);
      if (endpoint.endsWith("/reject")) {
        if (state.rejectConflict) { state.rejectConflict = false; return json({ error: "结果已更新，请刷新后再操作" }, 409); }
        result.state = "rejected"; result.revision++;
      } else {
        const response = await fetch(new URL(`api/elements/${video.id}/markers`, app.url), { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ startMs: result.startMs, endMs: result.endMs, body: result.body, tags: result.tags, requestKey: "ui-ai-result-accept" }) });
        assert.ok(response.ok); const marker = await response.json(); result.state = "applied"; result.markerId = marker.id; result.revision++;
      }
      return json(result);
    }
    if (endpoint.startsWith("/api/video-analysis/frames/")) return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#52695e"/></svg>' });
    if (endpoint === "/api/visual-search/rejections") { state.writes.push({ endpoint, body: incoming.postDataJSON() }); state.visualRejected = true; return json({ ok: true }); }
    if (endpoint === "/api/visual-search") {
      state.searches.push(Object.fromEntries(url.searchParams));
      return json({ matches: !state.visualRejected && (url.searchParams.get("frameId") || url.searchParams.get("q")) ? [{ elementId: target.id, kind: "video", label: "相似视频.mp4", frameId: "frame-2", startMs: 400, endMs: 900, score: 0.78, thumbnailUrl: "/api/video-analysis/frames/frame-2" }] : [], diagnostic: "" });
    }
    return route.continue();
  });
  await page.goto(`${app.url}#wiki`);
  return { app, page, video, target, state };
}

test("automatic video annotation UI resumes, cancels, applies and rejects versioned results and opens visual matches at their time", options, async (t) => {
  const { page, video, state } = await setup(t);
  await page.getByRole("button", { name: "打开内容：自动标注演示.webm", exact: true }).click();
  const analysis = page.getByRole("region", { name: "视频自动标注", exact: true });
  await analysis.getByText("部分分析", { exact: true }).waitFor();
  await analysis.getByRole("button", { name: "继续分析", exact: true }).click();
  await analysis.getByRole("button", { name: "取消分析", exact: true }).click();
  await analysis.getByText("已取消", { exact: true }).waitFor();
  await analysis.getByRole("button", { name: "重新分析", exact: true }).click();
  await analysis.getByRole("button", { name: "取消分析", exact: true }).click();
  assert.deepEqual(state.writes.filter((write) => write.endpoint === `/api/elements/${video.id}/video-analysis`).map((write) => write.body), [{ restart: false }, { restart: true }]);
  await analysis.locator('[data-result-id="result-1"]').getByRole("button", { name: "应用标注", exact: true }).click();
  await analysis.locator('[data-result-id="result-1"]').getByText("AI 已应用", { exact: true }).waitFor();
  await page.getByRole("region", { name: "视频标注", exact: true }).getByText("街道上的车辆", { exact: true }).waitFor();
  const correction = analysis.locator('[data-result-id="result-2"]');
  await correction.getByRole("button", { name: "拒绝结果", exact: true }).click();
  await analysis.getByText("结果已更新，请刷新后再操作", { exact: false }).waitFor();
  assert.equal(state.results[1].state, "suggested");
  await correction.getByRole("button", { name: "拒绝结果", exact: true }).click();
  await correction.waitFor({ state: "hidden" });
  await analysis.getByLabel("显示已拒绝结果", { exact: true }).check();
  await correction.getByText("这条结果已拒绝，不再参与当前标签和说明检索。", { exact: true }).waitFor();
  assert.equal(await correction.getByText("需要纠正的识别", { exact: true }).count(), 0);
  await analysis.getByRole("button", { name: "播放 AI 片段：00:00.3–00:00.9", exact: true }).click();
  await page.waitForFunction(() => { const video = document.querySelector(".wiki-detail video"); return video?.paused && Math.abs(video.currentTime - 0.9) < 0.04; });
  await analysis.locator("summary").click();
  await analysis.getByRole("button", { name: "用第 1 张证据查找相似画面", exact: true }).click();
  const similar = page.getByRole("region", { name: "相似画面", exact: true });
  await similar.getByRole("button", { name: "打开相似内容：相似视频.mp4 · 00:00.4–00:00.9", exact: true }).click();
  await page.getByRole("heading", { name: "相似视频.mp4", exact: true }).waitFor();
  await page.waitForFunction(() => { const video = document.querySelector(".wiki-detail video"); return video?.paused && Math.abs(video.currentTime - 0.9) < 0.04; });
  assert.ok(state.searches.some((query) => query.elementId === String(video.id) && query.frameId === "frame-1"));
  await page.getByRole("link", { name: "Agent 对话", exact: true }).click();
  await page.evaluate(() => { window.location.hash = "wiki"; });
  await page.locator(".wiki-detail video").waitFor({ state: "visible" });
  await page.waitForTimeout(350);
  assert.equal(await page.locator(".wiki-detail video").evaluate((player) => player.paused), true, "Activity restore must not repeat AI navigation playback");
});

test("video settings preserve dirty drafts, show model destination and save automatic mode plus visual configuration", options, async (t) => {
  const { page, state } = await setup(t);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: "视频与画面检索", exact: false }).click();
  const settings = page.getByRole("region", { name: "视频与画面检索设置", exact: true });
  await settings.getByLabel("自动分析未处理的视频（含已有视频）", { exact: true }).check();
  await settings.getByLabel("视频标注模式", { exact: true }).selectOption("auto");
  await settings.getByLabel("启用图片与视频帧视觉索引", { exact: true }).check();
  await settings.getByLabel("视觉服务地址", { exact: true }).fill("http://127.0.0.1:9876");
  await settings.getByText("本机抽取视频画面，分析帧会交给", { exact: false }).waitFor();
  assert.equal(await settings.getByRole("button", { name: "检测视频依赖", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await page.getByRole("dialog", { name: "未保存的设置", exact: true }).getByRole("button", { name: "继续编辑", exact: true }).click();
  assert.equal(await settings.getByLabel("视觉服务地址", { exact: true }).inputValue(), "http://127.0.0.1:9876");
  await page.getByRole("region", { name: "保存设置" }).getByRole("button", { name: "保存", exact: true }).click();
  await settings.getByText("视频与画面检索配置已保存。", { exact: true }).waitFor();
  assert.equal(state.config.enabled, true); assert.equal(state.config.applyMode, "auto"); assert.equal(state.config.visual.enabled, true);
  assert.equal(state.config.ffprobe, "ffprobe"); assert.equal(state.config.maxFrames, 120);
  await settings.getByRole("button", { name: "检测视频依赖", exact: true }).click();
  await settings.getByText("依赖已检测", { exact: true }).waitFor();
  await settings.getByRole("button", { name: "建立 / 更新视觉索引", exact: true }).click();
  await settings.getByText("视觉索引任务已提交，后台会继续处理。", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
  assert.equal(state.writes.filter((write) => write.endpoint === "/api/visual-index/rebuild").length, 1);
});

test("visual text queries retain their source and rejected recommendations disappear without relation writes", options, async (t) => {
  const { page, video, target, state } = await setup(t);
  await page.getByRole("button", { name: "打开内容：自动标注演示.webm", exact: true }).click();
  const similar = page.getByRole("region", { name: "相似画面", exact: true });
  await similar.getByLabel("用文字搜索画面", { exact: true }).fill("雨夜街道");
  await similar.getByRole("button", { name: "搜索", exact: true }).click();
  await similar.getByRole("button", { name: "不再推荐：相似视频.mp4", exact: true }).click();
  await similar.getByText("暂无相似结果。", { exact: false }).waitFor();
  assert.ok(state.searches.some((query) => query.q === "雨夜街道" && query.elementId === String(video.id)));
  assert.deepEqual(state.writes, [{ endpoint: "/api/visual-search/rejections", body: { sourceId: video.id, targetId: target.id } }]);
});

test("selecting an evidence frame exits text search even when choosing the same frame again", options, async (t) => {
  const { page, video, state } = await setup(t);
  await page.getByRole("button", { name: "打开内容：自动标注演示.webm", exact: true }).click();
  const analysis = page.getByRole("region", { name: "视频自动标注", exact: true });
  const similar = page.getByRole("region", { name: "相似画面", exact: true });
  await analysis.locator("summary").click();
  for (const query of ["雨夜街道", "再次输入文字"]) {
    await similar.getByLabel("用文字搜索画面", { exact: true }).fill(query);
    const textSearch = page.waitForResponse((response) => new URL(response.url()).searchParams.get("q") === query);
    await similar.getByRole("button", { name: "搜索", exact: true }).click();
    await textSearch;
    if (query === "再次输入文字") {
      await page.getByRole("link", { name: "Agent 对话", exact: true }).click();
      await page.getByRole("main", { name: "Agent 对话", exact: true }).waitFor();
      await page.getByRole("button", { name: "全部内容", exact: true }).click();
      await similar.getByRole("button", { name: "返回当前内容的相似画面", exact: true }).waitFor();
      assert.equal(await similar.getByLabel("用文字搜索画面", { exact: true }).inputValue(), query);
    }
    const frameSearch = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/visual-search"
      && new URL(response.url()).searchParams.get("frameId") === "frame-1");
    await analysis.getByRole("button", { name: "用第 1 张证据查找相似画面", exact: true }).click();
    await frameSearch;
    await similar.getByAltText("当前查询的证据画面", { exact: true }).waitFor();
    assert.equal(await similar.getByLabel("用文字搜索画面", { exact: true }).inputValue(), "");
    assert.deepEqual(state.searches.at(-1), { elementId: String(video.id), frameId: "frame-1" });
  }
  assert.equal(state.searches.filter((query) => query.frameId === "frame-1").length, 2);
});

test("real video HTTP configuration reports missing extraction dependencies while playback remains usable", options, async (t) => {
  const { app, page, video } = await setup(t);
  await page.unroute("**/api/**");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: "视频与画面检索", exact: false }).click();
  const settings = page.getByRole("region", { name: "视频与画面检索设置", exact: true });
  await settings.getByLabel("FFmpeg 程序路径", { exact: true }).fill("definitely-missing-video-analysis-test-ffmpeg");
  await settings.getByLabel("ffprobe 程序路径", { exact: true }).fill("definitely-missing-video-analysis-test-ffprobe");
  await page.getByRole("region", { name: "保存设置" }).getByRole("button", { name: "保存", exact: true }).click();
  await settings.getByText("视频与画面检索配置已保存。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await page.getByRole("button", { name: "打开内容：自动标注演示.webm", exact: true }).click();
  const analysis = page.getByRole("region", { name: "视频自动标注", exact: true });
  await analysis.getByRole("button", { name: "手动分析此视频", exact: true }).click();
  await analysis.getByText("分析失败", { exact: true }).waitFor();
  await analysis.getByRole("button", { name: "继续分析", exact: true }).waitFor();
  const status = await (await fetch(new URL(`api/video-analysis/status?videoId=${video.id}`, app.url))).json();
  assert.equal(status.run.state, "failed"); assert.match(status.run.error, /视频工具|FFmpeg/);
  assert.equal(status.config.enabled, false); assert.equal(status.results.length, 0);
  await page.waitForFunction(() => document.querySelector(".wiki-detail video")?.readyState >= 1);
  await page.locator(".wiki-detail video").evaluate(async (player) => { player.muted = true; player.currentTime = 0.3; await player.play(); });
  await page.waitForFunction(() => document.querySelector(".wiki-detail video")?.currentTime > 0.5);
});
