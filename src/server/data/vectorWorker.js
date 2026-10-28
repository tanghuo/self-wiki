// Runs exact (brute-force) vector scoring on a separate read-only connection so
// large libraries do not block the API event loop. WAL mode lets this reader see
// committed data while the main connection writes.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { load } from "sqlite-vec";

const db = new DatabaseSync(workerData.dbPath, { readOnly: true, allowExtension: true });
db.exec("PRAGMA busy_timeout = 5000");
load(db);
db.enableLoadExtension(false);
const statements = new Map();

parentPort.on("message", ({ id, sql, params }) => {
  try {
    let statement = statements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      if (statements.size > 32) statements.clear();
      statements.set(sql, statement);
    }
    parentPort.postMessage({ id, rows: statement.all(...params) });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, code: error.code } });
  }
});
