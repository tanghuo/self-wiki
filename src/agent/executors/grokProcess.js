import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export async function grokCommand(executable = "grok") {
  if (executable === "grok") {
    const installed = path.join(homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
    try { await access(installed); executable = installed; } catch { /* Use PATH. */ }
  }
  return /\.(?:mjs|cjs|js)$/i.test(executable) ? { executable: process.execPath, prefix: [executable] } : { executable, prefix: [] };
}

export async function startGrokAcp(config, { cwd, signal, onNotification = () => {}, onRequest = async () => { throw new Error("Unsupported client request"); }, onExit = () => {} }) {
  signal?.throwIfAborted();
  const command = await grokCommand(config.executable);
  // ACP ignores the TUI/headless --tools filter. The session's client hook is
  // the execution gate; do not imply that those flags restrict this transport.
  const child = spawn(command.executable, [...command.prefix, "--no-auto-update", "agent", "--no-leader", "-m", config.model, "stdio"],
    { cwd, shell: false, windowsHide: true, env: { ...process.env, GROK_MEMORY: "0" }, stdio: ["pipe", "pipe", "pipe"] });
  const decoder = new StringDecoder("utf8"), pending = new Map();
  let sequence = 0, buffer = "", ended = false, closing = false, closePromise;
  const exited = new Promise((resolve) => child.once("close", resolve));
  const write = (value) => { if (!ended && !child.stdin.destroyed) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n"); };
  function fail(error) {
    if (ended) return; ended = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear();
    if (!closing) onExit(error);
  }
  function request(method, params = {}, timeout = 30000) {
    if (ended) return Promise.reject(new Error("Grok ACP 连接已关闭"));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Grok 请求超时：${method}`)); }, timeout);
      pending.set(id, { resolve, reject, timer, method }); write({ id, method, params });
    });
  }
  function message(value) {
    if (value.method && value.id !== undefined) {
      Promise.resolve().then(() => onRequest(value.method, value.params || {})).then(
        (result) => write({ id: value.id, result }), (error) => write({ id: value.id, error: { code: -32601, message: error.message } }));
    } else if (value.id !== undefined) {
      const entry = pending.get(value.id); if (!entry) return;
      pending.delete(value.id); clearTimeout(entry.timer);
      if (value.error) entry.reject(Object.assign(new Error(`${entry.method}: ${String(value.error.message || "Grok 请求失败").slice(0, 1500)}`), { details: value.error.data }));
      else entry.resolve(value.result);
    } else if (value.method) {
      Promise.resolve(onNotification(value.method, value.params || {})).catch((error) => { fail(error); void close(); });
    }
  }
  child.stdout.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    if (buffer.length > 40 * 1024 * 1024) { fail(new Error("Grok ACP 事件超过限制")); void close(); return; }
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (line.trim()) { try { message(JSON.parse(line)); } catch { fail(new Error("Grok 返回无效 ACP 事件")); void close(); return; } }
    }
  });
  child.stderr.resume();
  child.stdin.on("error", () => fail(new Error("Grok ACP 输入连接已关闭")));
  child.once("error", () => fail(new Error("无法启动 Grok Build，请检查程序路径")));
  child.once("close", () => fail(new Error("Grok ACP 进程已退出")));
  async function close() {
    if (closePromise) return closePromise; closing = true;
    closePromise = (async () => {
      child.stdin.end();
      const timer = setTimeout(() => {
        if (child.exitCode !== null || !child.pid) return;
        if (process.platform === "win32") {
          const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
          killer.on("error", () => child.kill()); killer.on("exit", (code) => { if (code) child.kill(); });
        } else child.kill("SIGKILL");
      }, 500);
      const fallback = setTimeout(() => child.kill(), 2500);
      await exited; clearTimeout(timer); clearTimeout(fallback);
      signal?.removeEventListener("abort", abort);
    })(); return closePromise;
  }
  function abort() { void close(); }
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return { request, notify: (method, params) => write({ method, params }), close };
}
