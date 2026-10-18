import { constants } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { setTimeout as delay } from "node:timers/promises";
import { localCodexAuth } from "./codexLocalAuth.js";

const configHeader = "# Managed by self-wiki; edit the source Codex config.toml, then reconnect.\n";

async function syncConfig(source, home) {
  const target = path.join(home, "config.toml");
  let existing;
  try { existing = await readFile(target, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing !== undefined && !existing.startsWith(configHeader)) {
    throw new Error("Wiki 默认 Codex 目录已有独立 config.toml；请移走该文件以复用本机配置，或在设置中显式指定此目录");
  }
  let content;
  try { content = await readFile(path.join(source, "config.toml"), "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (content === undefined) {
    if (existing !== undefined) await unlink(target).catch((error) => { if (error.code !== "ENOENT") throw error; });
    return;
  }
  const next = configHeader + content;
  if (existing === next) return;
  const temporary = path.join(home, `.config-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, next, { flag: "wx", mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, target); break; }
      catch (error) {
        if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 4) throw error;
        if (await readFile(target, "utf8").catch(() => undefined) === next) break;
        await delay(20 * (attempt + 1));
      }
    }
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function codexMcpOverrides(env) {
  const file = path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
  let content;
  try { content = await readFile(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  let config;
  try { config = parse(content); } catch { throw new Error("Codex config.toml 格式无效，请修正原配置后重新检测连接"); }
  // Empty tables merge with the user config; override each server explicitly.
  const servers = Object.keys(config.mcp_servers || {}).map((name) => `${JSON.stringify(name)}={enabled=false}`);
  return servers.length ? ["-c", `mcp_servers={${servers.join(",")}}`] : [];
}

export async function codexEnvironment(config, { shareCapabilities = false } = {}) {
  const home = config.codexCli.codexHome;
  const sharedLogin = await localCodexAuth(config);
  if (home && config.codexCli.reuseLocalAuth) {
    const source = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
    if (path.resolve(home) !== source) {
      await mkdir(home, { recursive: true });
      await syncConfig(source, home);
      if (shareCapabilities) {
        // Keep session storage isolated while discovering the user's installed capabilities.
        for (const name of ["skills", "plugins"]) {
          const origin = path.join(source, name), target = path.join(home, name);
          try {
            if (!(await lstat(origin)).isDirectory()) continue;
            try { await lstat(target); continue; } catch (error) { if (error.code !== "ENOENT") throw error; }
            await symlink(origin, target, process.platform === "win32" ? "junction" : "dir");
          } catch (error) { if (!["ENOENT", "EEXIST"].includes(error.code)) throw error; }
        }
      }
      const target = path.join(home, "auth.json");
      const temporary = path.join(home, `.auth-${randomUUID()}.tmp`);
      try {
        let exists = false;
        try { await lstat(target); exists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (!exists && !sharedLogin) {
          await copyFile(path.join(source, "auth.json"), temporary, constants.COPYFILE_EXCL);
          await chmod(temporary, 0o600);
          // Publish the complete cache without overwriting a concurrent login or copy.
          await link(temporary, target);
        }
      } catch (error) {
        if (!["ENOENT", "EEXIST"].includes(error.code)) {
          throw new Error("无法复用本机 Codex 登录缓存，请检查 Wiki 数据目录的读写权限");
        }
      } finally {
        await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw new Error("清理 Wiki 临时登录缓存失败"); });
      }
    }
  }
  return { ...process.env, ...(home ? { CODEX_HOME: home } : {}) };
}
