import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electron from "electron";
import { _electron } from "playwright-core";

const root = path.resolve(import.meta.dirname, "..");
const dir = await mkdtemp(path.join(os.tmpdir(), "self-wiki-single-instance-"));
const args = [root, `--user-data-dir=${path.join(dir, "profile")}`];
const env = { ...process.env, APP_DATA_DIR: path.join(dir, "data") };
for (const key of ["ELECTRON_RUN_AS_NODE", "EXTERNAL_API_URL", "VITE_DEV_SERVER_URL", "API_PORT", "NODE_BINARY"]) delete env[key];
let desktop;
let child;
try {
  desktop = await _electron.launch({ executablePath: electron, args, env, cwd: root, timeout: 20000 });
  child = desktop.process();
  const page = await desktop.firstWindow();
  await page.waitForLoadState();
  const url = page.url();
  assert.equal((await fetch(new URL('api/instance', url))).status, 401);
  assert.equal(await page.evaluate(async () => (await fetch('/api/instance')).status), 200);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  const second = spawn(electron, args, { env, cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  second.stdout.on("data", chunk => { output += chunk; });
  second.stderr.on("data", chunk => { output += chunk; });
  const timeout = setTimeout(() => second.kill(), 10000);
  try {
    const [code] = await once(second, "exit");
    assert.equal(code, 0, output);
    assert.doesNotMatch(output, /API running|Unable to (?:move|create).*cache|Gpu Cache Creation failed/);
  } finally { clearTimeout(timeout); }
  const deadline = Date.now() + 5000;
  while (!(await desktop.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    return windows.length === 1 && !windows[0].isMinimized() && windows[0].isVisible() && windows[0].isFocused();
  }))) {
    assert.ok(Date.now() < deadline, "Existing window should restore and focus");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const processExit = once(child, "exit");
  await desktop.evaluate(({ BrowserWindow }) => { setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 0); });
  const exitTimeout = setTimeout(() => child.kill(), 10000);
  try {
    const [code] = await processExit;
    assert.equal(code, 0, "Closing the last window should exit normally");
  } finally { clearTimeout(exitTimeout); }
  await assert.rejects(fetch(new URL("api/instance", url)));
  console.log("single-instance smoke ok: duplicate exits, window restores/focuses, window close stops desktop and API");
} finally {
  if (desktop && child?.exitCode === null) await desktop.close();
  if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith("self-wiki-single-instance-")) throw new Error("Invalid temporary cleanup path");
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
