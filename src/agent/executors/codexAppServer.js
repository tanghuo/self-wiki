import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { resolveCodexCommand } from "./codexCommand.js";
import { codexEnvironment, codexMcpOverrides } from "./codexEnvironment.js";
import { localCodexAuth, rejectLocalCodexAuth, codexAuthError, isCodexAuthError } from "./codexLocalAuth.js";
import { imageExecutorDefinition } from "../../shared/domain/imageGeneration.js";

// Chat sessions run with approvalPolicy "never", so shell access is opt-in:
// without codexCli.allowShell the agent works only through Wiki tools.
export function chatShellAllowed(config) {
  return config?.codexCli?.allowShell === true;
}

export function chatFeatureArgs(config) {
  const args = [];
  for (const feature of ["code_mode_host", "apps", "plugins", "skill_search", "view_image", "multi_agent"]) args.push("--enable", feature);
  for (const feature of ["shell_tool", "unified_exec"]) args.push(chatShellAllowed(config) ? "--enable" : "--disable", feature);
  args.push(imageExecutorDefinition(config.imageGeneration?.executor).mode === "native" ? "--enable" : "--disable", "image_generation");
  return args;
}

export async function startCodexAppServer(config, { cwd, onNotification, onToolCall, onExit, configurationOnly = false, restricted = false, signal }) {
  signal?.throwIfAborted();
  const command = await resolveCodexCommand(config);
  const env = await codexEnvironment(config, { shareCapabilities: !configurationOnly && !restricted });
  let auth = await localCodexAuth(config);
  const args = [...command.prefix, "app-server", "--listen", "stdio://", "-c", `web_search="${restricted ? "disabled" : "live"}"`];
  if (auth) args.push("-c", 'cli_auth_credentials_store="ephemeral"');
  if (restricted) {
    args.push("-c", "project_doc_max_bytes=0", ...await codexMcpOverrides(env));
    for (const feature of ["shell_tool", "unified_exec", "apps", "plugins", "hooks", "multi_agent", "browser_use", "in_app_browser", "image_generation", "skill_search", "view_image"]) args.push("--disable", feature);
  } else if (!configurationOnly) args.push(...chatFeatureArgs(config));
  const child = spawn(command.executable, args, { cwd, shell: false, windowsHide: true,
    env, stdio: ["pipe", "pipe", "pipe"] });
  const decoder = new StringDecoder("utf8"), pending = new Map();
  let sequence = 0, buffer = "", ended = false, closing = false, closePromise;
  let notifications = Promise.resolve();
  const exited = new Promise((resolve) => child.once("close", resolve));
  function write(value) { if (!ended && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(value)}\n`); }
  function fail(error) {
    if (ended) return;
    ended = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    if (!closing) onExit(error);
  }
  function request(method, params = {}, timeout = 20000) {
    if (ended) return Promise.reject(new Error("Codex 会话进程已停止"));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex 请求超时：${method}`)); }, timeout);
      pending.set(id, { resolve, reject, timer }); write({ id, method, params });
    });
  }
  function message(value) {
    if (value.method && value.id !== undefined) {
      if (value.method === "account/chatgptAuthTokens/refresh" && auth) {
        void (async () => {
          try {
            const next = await localCodexAuth(config);
            if (!next || next.chatgptAccountId !== auth.chatgptAccountId ||
                value.params?.previousAccountId && value.params.previousAccountId !== auth.chatgptAccountId || next.accessToken === auth.accessToken) throw codexAuthError();
            auth = next;
            write({ id: value.id, result: auth });
          } catch {
            rejectLocalCodexAuth(auth);
            const error = codexAuthError();
            write({ id: value.id, error: { code: -32001, message: error.message } });
            fail(error); void close();
          }
        })();
        return;
      }
      if (value.method !== "item/tool/call") { write({ id: value.id, error: { code: -32601, message: "This client only supports dynamic tool requests" } }); return; }
      // Start the call after notifications already received, without blocking
      // later notifications on the tool's asynchronous execution.
      notifications.then(() => onToolCall(value.params)).then(
        (result) => write({ id: value.id, result }),
        (error) => write({ id: value.id, result: { success: false, contentItems: [{ type: "inputText", text: error.message }] } }),
      );
    } else if (value.id !== undefined) {
      const current = pending.get(value.id); if (!current) return;
      pending.delete(value.id); clearTimeout(current.timer);
      if (value.error) {
        if (isCodexAuthError(value.error.message)) { rejectLocalCodexAuth(auth); current.reject(codexAuthError()); }
        else current.reject(new Error(String(value.error.message || "Codex 请求失败").slice(0, 1000)));
      } else current.resolve(value.result);
    } else if (value.method) {
      if ((value.method === "error" && !value.params?.willRetry && isCodexAuthError(value.params?.error?.message)) ||
          (value.method === "turn/completed" && isCodexAuthError(value.params?.turn?.error?.message))) {
        rejectLocalCodexAuth(auth); fail(codexAuthError()); void close(); return;
      }
      notifications = notifications.then(() => onNotification(value.method, value.params || {})).catch((error) => fail(error));
    }
  }
  child.stdout.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    if (buffer.length > 40 * 1024 * 1024) { fail(new Error("Codex 事件超过大小限制")); child.kill(); return; }
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try { message(JSON.parse(line)); } catch { fail(new Error("Codex 返回了无效协议事件")); child.kill(); return; }
    }
  });
  child.stderr.resume(); // Diagnostics can contain provider configuration; do not expose them to the renderer.
  child.stdin.on("error", () => fail(new Error("Codex 会话连接已关闭")));
  child.once("error", () => fail(new Error("无法启动 Codex，请检查设置中的程序路径")));
  child.once("close", () => fail(new Error("Codex 会话进程已退出；可以重新检测并继续会话")));
  async function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      child.stdin.end();
      const timer = setTimeout(() => {
        if (!child.pid || child.exitCode !== null) return;
        if (process.platform === "win32") {
          const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
          killer.on("error", () => child.kill());
        } else child.kill("SIGKILL");
      }, 1500);
      await exited; clearTimeout(timer);
    })();
    return closePromise;
  }
  const abort = () => { fail(signal.reason || new Error("Codex 连接已取消")); void close(); };
  signal?.addEventListener("abort", abort, { once: true });
  void exited.then(() => signal?.removeEventListener("abort", abort));
  try {
    if (signal?.aborted) { abort(); signal.throwIfAborted(); }
    const initialized = await request("initialize", { clientInfo: { name: "self_wiki", title: "self-wiki", version: "0.2.0" }, capabilities: { experimentalApi: true } });
    write({ method: "initialized", params: {} });
    if (auth) await request("account/login/start", { type: "chatgptAuthTokens", ...auth });
    const account = await request("account/read", { refreshToken: false });
    const settings = await request("config/read", { includeLayers: false });
    return { request, close, account, defaultModel: settings.config?.model || "", defaultEffort: settings.config?.model_reasoning_effort || "", version: initialized.userAgent || "Codex app-server",
      async models() {
        const entries = new Map(), cursors = new Set();
        let cursor;
        do {
          const page = await request("model/list", { limit: 100, includeHidden: false, ...(cursor && { cursor }) });
          if (!Array.isArray(page.data)) throw new Error("Codex 返回了无效的模型列表");
          for (const entry of page.data) if (!entry.hidden && typeof entry.model === "string") entries.set(entry.model, {
            id: entry.model, label: entry.displayName || entry.model, isDefault: Boolean(entry.isDefault), defaultReasoningEffort: entry.defaultReasoningEffort || "",
            supportedReasoningEfforts: entry.supportedReasoningEfforts || [],
          });
          cursor = page.nextCursor;
          if (cursor && (cursors.has(cursor) || cursors.size >= 9)) throw new Error("Codex 模型列表分页异常，请重新检测连接");
          if (cursor) cursors.add(cursor);
        } while (cursor);
        return [...entries.values()];
      },
    };
  } catch (error) { await close(); throw error; }
}
