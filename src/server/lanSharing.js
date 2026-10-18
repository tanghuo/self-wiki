import { createServer } from "node:http";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { lanAddresses } from "./http/lanRoutes.js";
import { createRequestHandler } from "./http/routes.js";

function validate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !["autoStart", "port"].includes(key)) ||
      typeof value.autoStart !== "boolean" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw Object.assign(new Error("请设置有效的自动开启选项和端口（1–65535）"), { statusCode: 400 });
  }
  return { autoStart: value.autoStart, port: value.port };
}

export async function createLanSharing({ dataDir, services }) {
  const configPath = path.join(dataDir, "lan-sharing.json");
  let config = { autoStart: false, port: 8766 };
  let error = "";
  try { config = validate(JSON.parse(await readFile(configPath, "utf8"))); }
  catch (failure) { if (failure.code !== "ENOENT") error = `无法读取局域网配置：${failure.message}`; }
  let server;
  let closed = false;
  let queue = Promise.resolve();
  const requests = new Set();

  function status() {
    return { ...config, enabled: Boolean(server), error, urls: lanAddresses().map((address) => `http://${address}:${config.port}/`) };
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
      void running.finally(() => requests.delete(running));
    });
    await new Promise((resolve, reject) => {
      candidate.once("error", reject);
      candidate.listen(config.port, "0.0.0.0", () => { candidate.off("error", reject); resolve(); });
    });
    server = candidate;
  }
  const sharing = {
    status,
    configure(value) {
      return serial(async () => {
        if (closed) throw Object.assign(new Error("应用正在退出"), { statusCode: 503 });
        const next = validate(value);
        if (server && next.port !== config.port) throw Object.assign(new Error("请先关闭共享再修改端口"), { statusCode: 409 });
        await writeFile(`${configPath}.tmp`, `${JSON.stringify(next, null, 2)}\n`, "utf8");
        await rename(`${configPath}.tmp`, configPath);
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
  const handler = createRequestHandler({ ...services, sharing, access: "lan" });
  return sharing;
}
