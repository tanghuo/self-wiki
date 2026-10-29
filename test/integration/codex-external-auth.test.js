import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile, unlink, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { codexCli } from "../../src/agent/executors/codexCli.js";
import { startCodexAppServer } from "../../src/agent/executors/codexAppServer.js";
import { localCodexAuth } from "../../src/agent/executors/codexLocalAuth.js";
import { defaultOrganizationConfig } from "../../src/shared/domain/organization.js";
import { createServer, fetch } from "../helpers/authenticatedServer.js";

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-external-auth-")), previous = process.env.CODEX_HOME;
  const source = path.join(root, "desktop"), home = path.join(root, "wiki-codex");
  await mkdir(source); await mkdir(home);
  process.env.CODEX_HOME = source;
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("wiki-external-auth-"));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const login = (revision = 1, seconds = 3600) => JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "test-account",
    access_token: `test.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds, revision })).toString("base64url")}.signature`,
    refresh_token: "desktop-refresh-token-never-forwarded" } });
  await writeFile(path.join(source, "auth.json"), login());
  const config = defaultOrganizationConfig().executor;
  config.codexCli = { ...config.codexCli, executable: path.join(root, "codex.mjs"), codexHome: home, reuseLocalAuth: true };
  await writeFile(config.codexCli.executable, await readFile(new URL("../fixtures/codex-external-auth.txt", import.meta.url)));
  return { root, source, home, login, config };
}

test("external authentication executes structured image turns, isolates storage and never publishes refresh tokens", async (t) => {
  const { source, home, login, config } = await setup(t), expired = login(0, -3600);
  const original = await readFile(path.join(source, "auth.json"), "utf8");
  await writeFile(path.join(home, "auth.json"), expired);
  assert.equal((await codexCli.probe(config)).available, true);
  const usage = [];
  const result = await codexCli.execute({ kind: "image-description", prompt: "识别图片", images: [{ elementId: 1, bytes: Buffer.from("fixture-image") }] },
    { config, signal: AbortSignal.timeout(4000), onUsage: (value) => usage.push(value) });
  assert.equal(result.output.summary, "已识别画面"); assert.equal(result.execution.model, "fixture-external-model");
  assert.equal(usage.at(-1).usage.input_tokens, 10); assert.equal(usage.at(-1).state, "completed");
  assert.equal(await readFile(path.join(home, "auth.json"), "utf8"), expired);
  assert.equal(await readFile(path.join(source, "auth.json"), "utf8"), original);
  assert.ok(!JSON.stringify({ result, usage }).includes("token-never-forwarded"));
  await unlink(path.join(home, "auth.json"));
  assert.equal((await codexCli.probe(config)).available, true);
  assert.deepEqual(await readdir(home), []);
  await assert.rejects(codexCli.execute({ prompt: "WAIT", images: [] }, { config, signal: AbortSignal.timeout(600) }), /取消|超时/);
});

test("a running app-server takes a rotated desktop token and refuses an unchanged rejected token", async (t) => {
  const { source, config, login } = await setup(t);
  const exits = [];
  const client = await startCodexAppServer(config, { configurationOnly: true, onNotification() {}, onExit: (error) => exits.push(error) });
  try {
    await writeFile(path.join(source, "auth.json"), login(2));
    assert.deepEqual(await client.request("fixture/refresh"), { accepted: true, changed: true });
    await client.request("fixture/refresh").catch((error) => assert.equal(error.code, "AUTH_REQUIRED"));
    assert.equal(exits[0].code, "AUTH_REQUIRED");
    assert.equal((await codexCli.probe(config)).code, "AUTH_REQUIRED");
    await writeFile(path.join(source, "auth.json"), login(3));
    assert.equal((await codexCli.probe(config)).available, true);
  } finally { await client.close(); }
});

test("authorization rejection is redacted and cannot retry until desktop credentials change", async (t) => {
  const { root, source, config, login } = await setup(t);
  await writeFile(path.join(root, "reject-auth"), "");
  await assert.rejects(codexCli.execute({ prompt: "test", images: [] }, { config, signal: AbortSignal.timeout(4000) }), (error) => {
    assert.equal(error.code, "AUTH_REQUIRED"); assert.ok(!error.message.includes("private-provider-secret")); return true;
  });
  assert.equal((await codexCli.probe(config)).code, "AUTH_REQUIRED");
  await unlink(path.join(root, "reject-auth"));
  assert.equal((await codexCli.probe(config)).available, false);
  await writeFile(path.join(source, "auth.json"), login(2));
  assert.equal((await codexCli.probe(config)).available, true);
  await writeFile(path.join(source, "auth.json"), login(3, -1));
  await assert.rejects(localCodexAuth(config), { code: "AUTH_REQUIRED" });
});

test("worker waits through expired desktop login then completes the retained task automatically", { timeout: 20000 }, async (t) => {
  const { root, source, config, login } = await setup(t), settings = defaultOrganizationConfig();
  settings.enabled = true; settings.executor = { ...config, codexCli: { ...config.codexCli, codexHome: null } };
  delete settings.executor.codexCli.reuseLocalAuth;
  await writeFile(path.join(root, "organization.json"), JSON.stringify(settings));
  await writeFile(path.join(source, "auth.json"), login(1, -1));
  const app = await createServer({ port: 0, dataDir: root });
  try {
    const created = await fetch(new URL("api/elements", app.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "需要保留的整理任务" }) });
    assert.equal(created.status, 201);
    const sourceElement = await created.json();
    const status = async () => (await fetch(new URL(`api/organization/status?elementId=${sourceElement.id}`, app.url))).json();
    const pausedBy = Date.now() + 4000;
    while ((await status()).executor.code !== "AUTH_REQUIRED") { assert.ok(Date.now() < pausedBy, JSON.stringify(await status())); await new Promise((resolve) => setTimeout(resolve, 50)); }
    assert.equal((await status()).jobs[0].attempts, 0);
    await writeFile(path.join(source, "auth.json"), login(2));
    const completedBy = Date.now() + 14000;
    while ((await status()).jobs[0].state !== "succeeded") { assert.ok(Date.now() < completedBy); await new Promise((resolve) => setTimeout(resolve, 100)); }
    assert.equal((await status()).jobs[0].attempts, 1); assert.equal((await status()).results.length, 1);
  } finally { await app.close(); }
});
