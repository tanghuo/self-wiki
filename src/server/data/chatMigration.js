export function migrateChat(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=9").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try { db.exec(`
    CREATE TABLE chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, codex_thread_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE chat_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES chat_sessions(id),
      request_key TEXT NOT NULL, payload_hash TEXT NOT NULL, codex_turn_id TEXT,
      text TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', state INTEGER NOT NULL DEFAULT 0 CHECK(state BETWEEN 0 AND 3),
      input_sources TEXT NOT NULL DEFAULT '[]', sources TEXT NOT NULL DEFAULT '[]', events TEXT NOT NULL DEFAULT '[]',
      error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(session_id, request_key)
    );
    CREATE INDEX idx_chat_turns_session ON chat_turns(session_id,id);
    CREATE TABLE chat_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, turn_id INTEGER NOT NULL REFERENCES chat_turns(id),
      request_key TEXT NOT NULL, payload TEXT NOT NULL, snapshots TEXT NOT NULL,
      state INTEGER NOT NULL DEFAULT 0 CHECK(state BETWEEN 0 AND 3), changes TEXT NOT NULL DEFAULT '{}',
      after_snapshots TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,
      UNIQUE(turn_id,request_key)
    );
    INSERT INTO wiki_schema VALUES (9);
  `); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
}
