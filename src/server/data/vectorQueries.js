import { Worker } from "node:worker_threads";

const workerUrl = new URL("./vectorWorker.js", import.meta.url);

// Read-only vector queries. File databases use a worker thread with its own
// connection; in-memory databases (tests) or a failed worker fall back to the
// main connection so results are always available.
export function createVectorQueries(db, dbPath) {
  let worker, broken = dbPath === ":memory:" || !dbPath, closed = false, nextId = 0;
  const pending = new Map();
  const fallback = (sql, params) => db.prepare(sql).all(...params);
  function failAll(error) {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }
  function start() {
    worker = new Worker(workerUrl, { workerData: { dbPath } });
    worker.unref();
    worker.on("message", ({ id, rows, error }) => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (error) entry.reject(Object.assign(new Error(error.message), { code: error.code }));
      else entry.resolve(rows);
    });
    worker.on("error", (error) => {
      console.error("[self-wiki] vector worker failed; using the main connection:", error?.message || error);
      broken = true; worker = undefined; failAll(error);
    });
    worker.on("exit", () => { worker = undefined; if (!closed) failAll(new Error("向量检索线程已退出")); });
  }
  return {
    async all(sql, params = []) {
      if (closed) throw new Error("应用正在退出");
      if (broken) return fallback(sql, params);
      if (!worker) {
        try { start(); } catch { broken = true; return fallback(sql, params); }
      }
      const id = ++nextId;
      try {
        return await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          worker.postMessage({ id, sql, params });
        });
      } catch (error) {
        // Worker infrastructure failure (not an SQL error): answer from the main connection.
        if (broken && !closed) return fallback(sql, params);
        throw error;
      }
    },
    get usesWorker() { return Boolean(worker); },
    async close() {
      closed = true;
      const current = worker; worker = undefined;
      failAll(new Error("应用正在退出"));
      await current?.terminate();
    },
  };
}
