import { createServer } from "node:http";
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomBytes, randomInt } from "node:crypto";
import path from "node:path";
const settingKeys = ["autoStart", "port", "allowWrite", "requireToken"];
const newToken = () => randomBytes(24).toString("base64url");
const newPairingCode = () => String(randomInt(1_000_000)).padStart(6, "0");

function validate(value, current = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !settingKeys.includes(key)) ||
      typeof value.autoStart !== "boolean" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      value.allowWrite !== undefined && typeof value.allowWrite !== "boolean" ||
      value.requireToken !== undefined && typeof value.requireToken !== "boolean") {
    throw Object.assign(new Error("请设置有效的自动开启选项和端口（1–65535）"), { statusCode: 400 });
  }
  return { autoStart: value.autoStart, port: value.port,
    allowWrite: value.allowWrite ?? current.allowWrite ?? false, requireToken: value.requireToken ?? current.requireToken ?? true };
}

function stored(value) {
  const { token, pairingCode, ...settings } = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (token !== undefined && (typeof token !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(token))) throw new Error("配对码格式无效");
  if (pairingCode !== undefined && (typeof pairingCode !== "string" || !/^\d{6}$/.test(pairingCode))) throw new Error("配对码格式无效");
  return { ...validate(settings), token: token || newToken(), pairingCode: pairingCode ?? newPairingCode() };
}

export async function createLanSharing({ dataDir, listAddresses, createHandler }) {
  const configPath = path.join(dataDir, "lan-sharing.json");
  // Unpaired LAN devices get nothing; paired ones are read-only unless editing is allowed locally.
  let config = { autoStart: false, port: 8766, allowWrite: false, requireToken: true, token: newToken(), pairingCode: newPairingCode() };
  let error = "", persistToken = false;
  try {
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    config = stored(saved);
    persistToken = !saved.token || saved.pairingCode === undefined;
  } catch (failure) {
    if (failure.code === "ENOENT") persistToken = true;
    else error = `无法读取局域网配置：${failure.message}`;
  }
  async function save(next) {
    await writeFile(`${configPath}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(`${configPath}.tmp`, configPath);
  }
  // Keep a generated pairing code stable across restarts for existing configurations.
  if (persistToken) await save(config).catch(() => {});
  let server;
  let closed = false;
  let queue = Promise.resolve();
  const requests = new Set();

  function status(view = "local") {
    const { token, pairingCode, ...settings } = config;
    const urls = listAddresses().map((address) => `http://${address}:${config.port}/`);
    const result = { ...settings, enabled: Boolean(server), error, urls };
    // The pairing code is only revealed to the local app, never to LAN visitors.
    if (view === "local") {
      result.token = token;
      result.pairingCode = pairingCode;
      result.pairUrls = urls.map((url) => config.requireToken ? `${url}?pair=${encodeURIComponent(token)}` : url);
    }
    return result;
  }
  function serial(action) {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  }
  async function stop(response) {
    if (!server) return;
    const previous = server;
    server = undefined;
    const stopped = new Promise((resolve) => previous.close(resolve));
    if (response && !response.destroyed) {
      // Let the LAN request that disables sharing receive its result before disconnecting it.
      response.setHeader("connection", "close");
      response.once("finish", () => previous.closeAllConnections());
      response.once("close", () => previous.closeAllConnections());
      return;
    }
    previous.closeAllConnections();
    await stopped;
  }
  async function start() {
    if (server) return;
    const candidate = createServer((req, res) => {
      const running = handler(req, res);
      requests.add(running);
      running.finally(() => requests.delete(running)).catch((error) => console.error("[self-wiki] LAN request failed:", error?.stack || error));
    });
    await new Promise((resolve, reject) => {
      candidate.once("error", reject);
      candidate.listen(config.port, "0.0.0.0", () => { candidate.off("error", reject); resolve(); });
    });
    server = candidate;
  }
  const sharing = {
    status,
    policy() { return { allowWrite: config.allowWrite, requireToken: config.requireToken, token: config.token, pairingCode: config.pairingCode }; },
    regenerateToken() {
      return serial(async () => {
        if (closed) throw Object.assign(new Error("应用正在退出"), { statusCode: 503 });
        let pairingCode;
        do { pairingCode = newPairingCode(); } while (pairingCode === config.pairingCode);
        const next = { ...config, token: newToken(), pairingCode };
        await save(next);
        config = next;
        // Drop connections that were authorised with the previous code.
        if (server) server.closeAllConnections();
        return status();
      });
    },
    configure(value) {
      return serial(async () => {
        if (closed) throw Object.assign(new Error("应用正在退出"), { statusCode: 503 });
        const next = { ...validate(value, config), token: config.token, pairingCode: config.pairingCode };
        if (server && next.port !== config.port) throw Object.assign(new Error("请先关闭共享再修改端口"), { statusCode: 409 });
        await save(next);
        config = next;
        error = "";
        return status();
      });
    },
    setEnabled(enabled, response) {
      return serial(async () => {
        if (closed) throw Object.assign(new Error("应用正在退出"), { statusCode: 503 });
        if (typeof enabled !== "boolean") throw Object.assign(new Error("无效的开关状态"), { statusCode: 400 });
        try { if (enabled) await start(); else await stop(response); error = ""; }
        catch (failure) {
          error = failure.code === "EADDRINUSE" ? `端口 ${config.port} 已被占用，请更换端口` : `局域网服务无法启动：${failure.message}`;
          throw Object.assign(new Error(error), { statusCode: 409 });
        }
        return status();
      });
    },
    close() {
      closed = true;
      // Drain outside the queue so requests waiting for a queued mutation can finish.
      return serial(() => stop()).then(() => Promise.allSettled([...requests]));
    },
  };
  const handler = createHandler(sharing);
  return sharing;
}
