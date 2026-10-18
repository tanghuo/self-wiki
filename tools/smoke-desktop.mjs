import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electron from "electron";

const root = path.resolve(import.meta.dirname, "..");
const packaged = process.argv.includes("--packaged");
const dataDir = await mkdtemp(path.join(os.tmpdir(), "llb-desktop-smoke-"));
const executable = packaged ? path.join(root, "release/win-unpacked/self-wiki.exe") : electron;
const env = { ...process.env, APP_DATA_DIR: path.join(dataDir, "data") };
for (const key of ["ELECTRON_RUN_AS_NODE", "EXTERNAL_API_URL", "VITE_DEV_SERVER_URL", "API_PORT", "NODE_BINARY"]) delete env[key];
try {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [...(packaged ? [] : [root]), "--smoke", `--user-data-dir=${path.join(dataDir, "profile")}`], {
      cwd: dataDir, env, stdio: "inherit", windowsHide: true,
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Desktop smoke timed out")); }, 30000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`Desktop smoke exited ${code}`)); });
  });
} finally {
  if (path.dirname(dataDir) !== path.resolve(os.tmpdir()) || !path.basename(dataDir).startsWith("llb-desktop-smoke-")) throw new Error("Invalid temporary cleanup path");
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
