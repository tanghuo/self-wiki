import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server/server.js";
import { defaultOrganizationConfig } from "../src/shared/domain/organization.js";
import { codexEnvironment, codexMcpOverrides } from "../src/agent/executors/codexEnvironment.js";
import { parse } from "smol-toml";
import { localCodexAuth } from "../src/agent/executors/codexLocalAuth.js";

test("Wiki chat and worker isolate the default Codex home and honor overrides", { timeout: 20000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-codex-home-"));
  const previousHome = process.env.CODEX_HOME;
  const source = path.join(dir, "desktop-codex");
  await mkdir(source);
  await mkdir(path.join(source, "skills"));
  await mkdir(path.join(source, "plugins"));
  await writeFile(path.join(source, "skills", "fixture.txt"), "shared skill");
  await writeFile(path.join(source, "auth.json"), '{"fixture":"desktop-login"}');
  await writeFile(path.join(source, "config.toml"), 'model = "desktop-only"');
  process.env.CODEX_HOME = source;
  let app;
  t.after(async () => {
    await app?.close();
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("wiki-codex-home-"));
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const executable = path.join(dir, "codex.mjs");
  const fixture = await readFile(new URL("./fixtures/chat-app-server.txt", import.meta.url), "utf8");
  await writeFile(executable, `import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(path.join(import.meta.dirname, args.includes('app-server') ? 'chat-home.txt' : 'worker-home.txt'), process.env.CODEX_HOME || '');
if (args.includes('--version')) { console.log('fixture'); process.exit(0); }
if (args.includes('--help')) { console.log('--image --output-schema --ignore-user-config --ephemeral'); process.exit(0); }
if (args[0] === 'login') process.exit(0);
${fixture}`);
  app = await createServer({ port: 0, dataDir: dir });
  async function api(route, body, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(new URL(`api/${route}`, app.url), { method,
      headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  }
  const defaultHome = path.join(dir, "wiki-codex");
  assert.equal((await api("organization/status")).defaultCodexHome, defaultHome);
  const config = defaultOrganizationConfig(); config.executor.codexCli.executable = executable;
  for (const home of [null, path.join(dir, "custom-codex"), null]) {
    config.executor.codexCli.codexHome = home;
    await api("organization/config", config, "PUT");
    assert.equal((await api("chat/probe", {})).available, true);
    assert.equal(await readFile(path.join(dir, "chat-home.txt"), "utf8"), home || defaultHome);
    if (home) await assert.rejects(readFile(path.join(home, "auth.json")), { code: "ENOENT" });
    else {
      assert.equal(await readFile(path.join(defaultHome, "skills", "fixture.txt"), "utf8"), "shared skill");
      assert.deepEqual(await readdir(path.join(defaultHome, "plugins")), []);
      assert.equal(await readFile(path.join(defaultHome, "auth.json"), "utf8"), '{"fixture":"desktop-login"}');
      assert.ok((await readFile(path.join(defaultHome, "config.toml"), "utf8")).endsWith('model = "desktop-only"'));
      await unlink(path.join(defaultHome, "auth.json")); // Worker must also be able to bootstrap authentication.
    }
    await api("organization/probe", {});
    const end = Date.now() + 5000;
    while (!(await api("organization/status")).executor.available) {
      assert.ok(Date.now() < end, "worker probe timed out");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(await readFile(path.join(dir, "worker-home.txt"), "utf8"), home || defaultHome);
    if (!home) assert.equal(await readFile(path.join(defaultHome, "auth.json"), "utf8"), '{"fixture":"desktop-login"}');
  }
  await app.close(); app = await createServer({ port: 0, dataDir: dir });
  await writeFile(path.join(source, "config.toml"), 'model = "updated-model"');
  assert.equal((await api("chat/probe", {})).available, true);
  assert.ok((await readFile(path.join(defaultHome, "config.toml"), "utf8")).endsWith('model = "updated-model"'));
  await writeFile(path.join(source, "config.toml"), 'respect_system_proxy = true');
  await api("chat/probe", {});
  assert.ok((await readFile(path.join(defaultHome, "config.toml"), "utf8")).endsWith('respect_system_proxy = true'));
  assert.equal(await readFile(path.join(dir, "chat-home.txt"), "utf8"), defaultHome);
  assert.equal(await readFile(path.join(source, "auth.json"), "utf8"), '{"fixture":"desktop-login"}');
});

test("Codex config refresh follows source replacement and deletion without overwriting custom config", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-config-sync-"));
  const previousHome = process.env.CODEX_HOME;
  const source = path.join(dir, "source"), home = path.join(dir, "wiki");
  process.env.CODEX_HOME = source;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("wiki-config-sync-"));
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  await mkdir(source);
  const config = { codexCli: { codexHome: home, reuseLocalAuth: true } };
  const original = 'respect_system_proxy = true\n[model_providers.custom]\nbase_url = "https://example.test"\n[mcp_servers."test.server"]\ncommand = "fixture"\nenabled = true\n';
  await writeFile(path.join(source, "config.toml"), original);
  await Promise.all(Array.from({ length: 4 }, () => codexEnvironment(config)));
  assert.ok((await readFile(path.join(home, "config.toml"), "utf8")).endsWith(original));
  const overrides = await codexMcpOverrides({ CODEX_HOME: home });
  assert.equal(parse(overrides[1]).mcp_servers["test.server"].enabled, false);
  assert.equal(await readFile(path.join(source, "config.toml"), "utf8"), original);
  await unlink(path.join(source, "config.toml"));
  await writeFile(path.join(source, "config.toml"), 'respect_system_proxy = false');
  await codexEnvironment(config);
  assert.ok((await readFile(path.join(home, "config.toml"), "utf8")).endsWith('respect_system_proxy = false'));
  await unlink(path.join(source, "config.toml"));
  await codexEnvironment(config);
  await assert.rejects(readFile(path.join(home, "config.toml")), { code: "ENOENT" });
  await writeFile(path.join(home, "config.toml"), 'model = "private"');
  await assert.rejects(codexEnvironment(config), /已有独立 config/);
  await codexEnvironment({ codexCli: { codexHome: home } });
  assert.equal(await readFile(path.join(home, "config.toml"), "utf8"), 'model = "private"');
  await writeFile(path.join(home, "config.toml"), '[broken');
  await assert.rejects(codexMcpOverrides({ CODEX_HOME: home }), /格式无效/);
});

test("credential reuse is exclusive, complete under concurrency, and tolerates no source login", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-codex-auth-"));
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(dir, "source");
  t.after(async () => {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("wiki-codex-auth-"));
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const home = path.join(dir, "wiki");
  const config = { codexCli: { codexHome: home, reuseLocalAuth: true } };
  assert.equal((await codexEnvironment(config)).CODEX_HOME, home);
  assert.deepEqual(await readdir(home), []);
  await mkdir(process.env.CODEX_HOME);
  const auth = JSON.stringify({ fixture: "x".repeat(100000) });
  await writeFile(path.join(process.env.CODEX_HOME, "auth.json"), auth);
  await Promise.all(Array.from({ length: 8 }, () => codexEnvironment(config)));
  assert.equal(await readFile(path.join(home, "auth.json"), "utf8"), auth);
  assert.deepEqual(await readdir(home), ["auth.json"]);
  await writeFile(path.join(home, "auth.json"), '{"fixture":"wiki-login"}');
  await codexEnvironment(config);
  assert.equal(await readFile(path.join(home, "auth.json"), "utf8"), '{"fixture":"wiki-login"}');
  assert.equal(await readFile(path.join(process.env.CODEX_HOME, "auth.json"), "utf8"), auth);
});

test("managed ChatGPT authentication reads current desktop access tokens without copying or refreshing credentials", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-codex-refresh-"));
  const source = path.join(dir, "source"), home = path.join(dir, "wiki"), previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = source;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("wiki-codex-refresh-"));
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  await mkdir(source); await mkdir(home);
  const auth = (account, seconds) => JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: account,
    access_token: `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds })).toString("base64url")}.signature`,
    refresh_token: `fixture-${account}-${seconds}` } });
  const expired = auth("same-account", -3600), fresh = auth("same-account", 3600);
  const sourcePath = path.join(source, "auth.json"), targetPath = path.join(home, "auth.json");
  const config = { codexCli: { codexHome: home, reuseLocalAuth: true } };
  await writeFile(sourcePath, fresh); await writeFile(targetPath, expired);
  await Promise.all(Array.from({ length: 8 }, () => codexEnvironment(config)));
  assert.equal(await readFile(targetPath, "utf8"), expired);
  assert.equal(await readFile(sourcePath, "utf8"), fresh);
  assert.deepEqual(await readdir(home), ["auth.json"]);
  assert.deepEqual(await localCodexAuth(config), { accessToken: JSON.parse(fresh).tokens.access_token, chatgptAccountId: "same-account" });
  const newer = auth("same-account", 7200);
  await writeFile(sourcePath, newer);
  assert.equal((await localCodexAuth(config)).accessToken, JSON.parse(newer).tokens.access_token);
  for (const [local, current] of [[fresh, auth("another-account", -3600)],
    [expired, expired], ['{"unknown":"format"}', expired], [fresh, 'not-json']]) {
    await writeFile(sourcePath, local); await writeFile(targetPath, current);
    await assert.rejects(codexEnvironment(config), { code: "AUTH_REQUIRED" });
    assert.equal(await readFile(targetPath, "utf8"), current);
  }
  await writeFile(sourcePath, fresh); await writeFile(targetPath, expired);
  await codexEnvironment({ codexCli: { codexHome: home } });
  assert.equal(await readFile(targetPath, "utf8"), expired);
  await unlink(sourcePath);
  await assert.rejects(codexEnvironment(config), { code: "AUTH_REQUIRED" });
  assert.equal(await readFile(targetPath, "utf8"), expired);
  await writeFile(sourcePath, fresh); await unlink(targetPath);
  await codexEnvironment(config);
  await assert.rejects(readFile(targetPath), { code: "ENOENT" });
});
