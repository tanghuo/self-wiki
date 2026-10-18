import { DatabaseSync } from "node:sqlite";
import { migrateWiki } from "./wikiMigrations.js";
import { load } from "sqlite-vec";

export function initDb(dbPath) {
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
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
