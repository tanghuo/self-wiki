import { spawn } from "node:child_process";
import path from "node:path";

// Readiness belongs to this child, not to whichever process owns a public port.
export async function startBackendProcess({ nodeBinary, appDir, dataDir, port = 0 }) {
  const child = spawn(nodeBinary, [path.join(appDir, "src/server/server.js"), "--port", String(port), "--data-dir", dataDir], {
    cwd: appDir,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  let exited = false;
  let closing = false;
  let stderr = "";
  const finished = new Promise((resolve) => {
    child.once("exit", () => { exited = true; resolve(); });
    child.once("error", () => { exited = true; resolve(); });
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[api] ${chunk}`));
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
    process.stderr.write(`[api] ${chunk}`);
  });

  let closePromise;
  function close() {
    closePromise ||= (async () => {
      closing = true;
      if (exited) return;
      if (child.connected) child.send({ type: "shutdown" }, () => {});
      else child.kill();
      const timer = setTimeout(() => { if (!exited) child.kill(); }, 5000);
      try { await finished; } finally { clearTimeout(timer); }
    })();
    return closePromise;
  }

  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error("API server did not start in time.")), 15000);
      function done(error, value) {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("exit", onExit);
        if (error) reject(error); else resolve(value);
      }
      function onMessage(message) {
        if (message?.type === "ready") done(null, message.url);
      }
      function onError(error) { done(error); }
      function onExit(code, signal) {
        done(new Error(`API process exited before readiness (${code ?? signal}): ${stderr.trim()}`));
      }
      child.on("message", onMessage);
      child.once("error", onError);
      child.once("exit", onExit);
    });
    // After readiness, an unexpected exit must be surfaced instead of leaving a dead window.
    function onExit(listener) {
      const notify = (code, signal) => { if (!closing) listener({ code, signal, stderr: stderr.trim() }); };
      if (exited) notify(child.exitCode, child.signalCode);
      else child.once("exit", notify);
    }
    return { url, close, onExit, pid: child.pid };
  } catch (error) {
    await close();
    throw error;
  }
}
