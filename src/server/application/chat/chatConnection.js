import path from "node:path";
import { mkdir } from "node:fs/promises";
import { background } from "../background.js";
import { openCodexSession, openGrokSession } from "../executorsPort.js";
import { chatEngineLabel } from "../../../shared/domain/chatEngine.js";
import { elementError } from "../../../shared/domain/elements.js";

/**
 * Codex session connection pool for chatService.
 * Callbacks keep turn/tool orchestration in the service while connection lifecycle lives here.
 */
export function createChatConnections({
  workspace,
  connections,
  closingConnections,
  active,
  isClosed,
  setDiagnostic,
  publishAll,
  onNotification,
  onToolCall,
  onConnectionExit,
}) {
  function idleConnection(entry) {
    if (!entry || active.has(entry.sessionId)) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => { background(closeConnection(entry), "chat idle close"); }, 60000);
    entry.idleTimer.unref?.();
  }

  function closeConnection(entry) {
    if (!entry) return;
    if (entry.closing) return entry.closing;
    if (connections.get(entry.sessionId) === entry) connections.delete(entry.sessionId);
    clearTimeout(entry.idleTimer);
    closingConnections.add(entry);
    entry.closing = (async () => {
      entry.controller.abort();
      await entry.starting?.catch(() => {});
      await entry.client?.close();
    })().finally(() => { closingConnections.delete(entry); });
    return entry.closing;
  }

  async function connection(sessionId = null, config) {
    if (isClosed()) throw elementError("应用正在退出", 503);
    const next = JSON.stringify(config);
    const previous = connections.get(sessionId);
    if (previous) {
      if (previous.signature !== next) { await closeConnection(previous); return connection(sessionId, config); }
      clearTimeout(previous.idleTimer);
      const opened = previous.client || await previous.starting;
      idleConnection(previous); return opened;
    }
    const entry = { sessionId, signature: next, controller: new AbortController() };
    connections.set(sessionId, entry);
    entry.starting = (async () => {
      const cwd = sessionId === null ? workspace : path.join(workspace, String(sessionId));
      await mkdir(cwd, { recursive: true });
      const engine = config.chat?.engine || "codex", label = chatEngineLabel(engine);
      const opened = await (engine === "grok-build" ? openGrokSession : openCodexSession)(config, {
        cwd, signal: entry.controller.signal,
        onEvent: (update) => connections.get(sessionId) === entry && onNotification(sessionId, update),
        onToolCall: (params) => {
          if (connections.get(sessionId) !== entry) throw elementError("此连接已关闭", 409);
          return onToolCall(sessionId, params);
        },
        onExit(error) {
          if (connections.get(sessionId) !== entry) return;
          connections.delete(sessionId); clearTimeout(entry.idleTimer);
          setDiagnostic({ available: false, message: error.message });
          onConnectionExit(sessionId, entry, error);
          background(closeConnection(entry), "chat connection exit");
        },
      });
      if (isClosed() || entry.controller.signal.aborted) { await opened.close(); throw elementError("此连接已关闭", 503); }
      entry.client = opened;
      const available = opened.available;
      setDiagnostic({
        available, version: opened.version, engine,
        message: available ? `${label} 已连接` : `此 Codex 数据目录尚未登录：${config.codexCli.codexHome}。请使用此目录登录 Codex 后重新检测。`,
      });
      publishAll();
      idleConnection(entry); return opened;
    })().catch((error) => {
      if (connections.get(sessionId) === entry) connections.delete(sessionId);
      if (!entry.controller.signal.aborted) setDiagnostic({ available: false, message: error.message });
      throw error;
    }).finally(() => { entry.starting = null; });
    return entry.starting;
  }

  async function probe(openConnection, getStatus) {
    const idle = [];
    for (const entry of connections.values()) {
      if (active.has(entry.sessionId)) entry.signature = null;
      else idle.push(entry);
    }
    await Promise.all(idle.map(closeConnection));
    try { await openConnection(); } catch { /* Diagnostic is shown with retry and settings. */ }
    return getStatus();
  }

  return { connection, closeConnection, idleConnection, probe };
}
