import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateGrokBuild, probeGrokBuild } from "../../src/agent/executors/grokBuild.js";
import { defaultImageGenerationConfig, imageGenerationConfig } from "../../src/shared/domain/imageGeneration.js";
import { chatImageOptions } from "../../src/shared/domain/chatImageOptions.js";
import { createChatImageExecutor } from "../../src/server/application/chatImageExecutor.js";
import { createChatImageSettings } from "../../src/server/application/chatImageSettings.js";
import { createServer } from "../../src/server/server.js";
import { defaultOrganizationConfig } from "../../src/shared/domain/organization.js";
import { setTimeout as sleep } from "node:timers/promises";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-grok-"));
  const workspace = path.join(root, "workspace"); await mkdir(workspace);
  const previous = process.env.GROK_HOME; process.env.GROK_HOME = root;
  const executable = path.join(root, "grok 中文.mjs");
  await writeFile(executable, await readFile(new URL("../fixtures/grok-build.txt", import.meta.url)));
  const config = { executable, model: "grok-4.6", aspectRatio: "16:9" };
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup) await close();
    if (previous === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = previous;
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("wiki-grok-"));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { root, workspace, config, cleanup, generate: (value = {}, options = {}) => generateGrokBuild({ prompt: "橘猫 ` $() \n", ...value }, { config, workspace, ...options }),
    observed: async () => JSON.parse(await readFile(path.join(root, "observed.json"), "utf8")) };
}

test("Grok options migrate old configs and keep per-session ratio snapshots", () => {
  const config = defaultImageGenerationConfig(); delete config.grokBuild;
  assert.equal(imageGenerationConfig(config).grokBuild.executable, "grok");
  for (const executable of ["\\\\host\\share\\grok.exe", "//host/grok", "grok.cmd", "grok.bat"]) {
    assert.throws(() => imageGenerationConfig({ ...config, grokBuild: { executable, model: "grok-4.6", aspectRatio: "auto" } }));
  }
  assert.deepEqual(chatImageOptions({ executor: "grok-build", direct: true }), { executor: "grok-build", direct: true, aspectRatio: "auto" });
  assert.equal(chatImageOptions({ executor: "grok-build", direct: false, aspectRatio: "4:3" }).aspectRatio, "4:3");
  assert.throws(() => chatImageOptions({ executor: "grok-build", direct: false, aspectRatio: "5:7" }));
  assert.throws(() => imageGenerationConfig({ ...defaultImageGenerationConfig(), grokBuild: { executable: 'grok', model: '--yolo', aspectRatio: 'auto' } }));
  const settings = createChatImageSettings({}, {});
  const current = defaultImageGenerationConfig();
  const snapshot = settings.configuration(current, { executor: "grok-build", direct: false, aspectRatio: "9:16" });
  assert.equal(snapshot.grokBuild.aspectRatio, "9:16");
  assert.equal(current.grokBuild.aspectRatio, "auto");
  assert.equal(createChatImageExecutor(snapshot, { direct: true, explicit: true }).id, "grok-build");
});

test("Grok CLI boundary probes, generates once and returns verified image bytes", async (t) => {
  const f = await fixture(t), events = [];
  assert.equal((await probeGrokBuild(f.config, f.workspace)).available, true);
  assert.equal((await probeGrokBuild({ ...f.config, executable: path.join(f.root, "missing.exe") }, f.workspace)).available, false);
  const result = await f.generate({}, { onProgress: (event) => events.push(event) });
  assert.equal(result.bytes.subarray(1, 4).toString(), "PNG");
  assert.ok(result.savedPath.startsWith(await realpath(f.workspace) + path.sep));
  const observed = await f.observed(), input = JSON.parse(observed.request.split('\n').slice(1).join('\n'));
  assert.equal(input.prompt, "橘猫 ` $() \n"); assert.equal(input.aspect_ratio, "16:9");
  assert.equal(observed.args[observed.args.indexOf("--tools") + 1], "image_gen");
  assert.equal(events.filter((event) => event.type === "submitted").length, 1);
  assert.ok(events.find((event) => event.metadata?.grokBuild?.input.prompt === input.prompt));
});

test("Grok editing validates references and preserves single-image aspect ratio", async (t) => {
  const f = await fixture(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  await writeFile(path.join(f.workspace, "reference.png"), png);
  await writeFile(path.join(f.root, "outside.png"), png);
  await assert.rejects(f.generate({ referencePaths: ["../outside.png"] }), /当前会话/);
  await assert.rejects(f.generate({ referencePaths: Array(9).fill("reference.png") }), /无效/);
  await assert.rejects(f.generate({ aspectRatio: "5:7" }), /无效/);
  await f.generate({ referencePaths: ["reference.png"], aspectRatio: "9:16" });
  let observed = await f.observed(), input = JSON.parse(observed.request.slice(observed.request.indexOf('\n') + 1));
  assert.equal(observed.args[observed.args.indexOf("--tools") + 1], "image_edit");
  assert.equal(input.image.length, 1); assert.equal(input.aspect_ratio, undefined);
  await f.generate({ referencePaths: ["reference.png", "reference.png"], aspectRatio: "9:16" });
  observed = await f.observed(); input = JSON.parse(observed.request.slice(observed.request.indexOf('\n') + 1));
  assert.equal(input.aspect_ratio, "9:16"); assert.equal(input.image.length, 2);
});

test("Grok rejects malformed, failed, duplicate and foreign-session results without retry", async (t) => {
  const f = await fixture(t);
  for (const [prompt, message] of [["malformed", /无效事件/], ["failed", /图片工具执行失败/], ["duplicate", /重复图片/], ["wrong-session", /不属于本次会话/]]) {
    await assert.rejects(f.generate({ prompt }), message);
  }
});

test("Grok cancellation terminates the local process and does not confirm pending calls", async (t) => {
  const f = await fixture(t), controller = new AbortController(), events = [];
  await assert.rejects(f.generate({ prompt: "hang" }, { signal: controller.signal, onProgress(event) {
    events.push(event); if (event.metadata?.grokBuild) controller.abort();
  } }), /已停止/);
  assert.equal(events.some((event) => event.type === "submitted"), false);
});

test("Grok direct chat persists ratios, records actual calls and archives images without Codex", { timeout: 20000 }, async (t) => {
  const f = await fixture(t), config = defaultOrganizationConfig();
  config.executor.codexCli.executable = path.join(f.root, "missing-codex.exe");
  config.imageGeneration.grokBuild = f.config;
  await writeFile(path.join(f.root, "organization.json"), JSON.stringify(config));
  let app = await createServer({ port: 0, dataDir: f.root }); f.cleanup.push(() => app.close());
  async function api(route, body) {
    const response = await fetch(new URL(`api/${route}`, app.url), { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, ...(body && { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  }
  const started = await api("chat/sessions/start", { text: "  原样橘猫 ` $() \n", sourceIds: [], requestKey: "grok-direct", directImage: true,
    imageOptions: { executor: "grok-build", direct: true, aspectRatio: "9:16" } });
  let data;
  for (let count = 0; count < 200; count++) {
    data = await api(`chat/sessions/${started.session.id}`);
    if (data.turns.at(-1)?.state === "completed" || data.turns.at(-1)?.state === "failed") break;
    await sleep(30);
  }
  const turn = data.turns.at(-1); assert.equal(turn.state, "completed", turn.error);
  assert.equal(turn.directImage, true); assert.equal(turn.imageOptions.aspectRatio, "9:16");
  const event = turn.events.find((entry) => entry.artifact); assert.ok(event);
  const trace = await api(`chat/turns/${turn.id}/trace?event=${encodeURIComponent(event.id)}`);
  assert.equal(trace.record.value.grokBuild.tool, "image_gen");
  assert.equal(trace.record.value.grokBuild.input.aspect_ratio, "9:16");
  assert.equal(trace.record.value.grokBuild.input.prompt, "  原样橘猫 ` $() \n");
  await app.close(); app = await createServer({ port: 0, dataDir: f.root });
  assert.equal((await api(`chat/sessions/${started.session.id}`)).session.imageOptions.aspectRatio, "9:16");
});
