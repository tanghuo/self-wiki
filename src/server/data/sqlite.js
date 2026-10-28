import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { latestWikiVersion, migrateWiki, pendingWikiVersions } from "./wikiMigrations.js";
import { load } from "sqlite-vec";

const keptBackups = 5;

// The library database is the only copy of the user's data: snapshot it before any
// schema upgrade so a faulty migration can be rolled back by restoring the file.
export function backupBeforeMigration(db, dbPath, pending) {
  if (dbPath === ":memory:" || !pending?.length) return null;
  const dir = path.join(path.dirname(dbPath), "backups");
  mkdirSync(dir, { recursive: true });
  const from = Math.max(0, ...db.prepare("SELECT version FROM wiki_schema").all().map(({ version }) => version));
  const stamp = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}Z`; // UTC
  const file = path.join(dir, `${path.basename(dbPath, path.extname(dbPath))}-v${from}-to-v${latestWikiVersion}-${stamp}.sqlite3`);
  db.prepare("VACUUM INTO ?").run(file);
  const prefix = `${path.basename(dbPath, path.extname(dbPath))}-v`;
  const old = readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith(".sqlite3"))
    .map((name) => ({ name, time: statSync(path.join(dir, name)).mtimeMs })).sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
  for (const { name } of old.slice(keptBackups)) rmSync(path.join(dir, name), { force: true });
  return file;
}

export function initDb(dbPath, { backup = true } = {}) {
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
    if (dbPath !== ":memory:") {
      // WAL lets readers proceed during writes and makes commits cheaper; it silently stays
      // in the previous mode on file systems that cannot support it.
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
    }
    if (backup) backupBeforeMigration(db, dbPath, pendingWikiVersions(db));
    migrateWiki(db);
    // Index tables are ordinary SQLite tables, so unavailable native search never blocks opening the library.
    try { load(db); } catch { /* Report extension availability in semantic status. */ }
    db.enableLoadExtension(false);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
