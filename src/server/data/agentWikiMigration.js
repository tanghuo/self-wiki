export function migrateAgentWiki(db) {
  if (db.prepare('SELECT 1 FROM wiki_schema WHERE version=42').get()) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE agent_wiki_proposals(id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES agent_sessions(id), turn_id INTEGER NOT NULL REFERENCES agent_turns(id), request_key TEXT NOT NULL, state INTEGER NOT NULL DEFAULT 0 CHECK(state IN(0,1,2)), payload TEXT NOT NULL, snapshots TEXT NOT NULL, result TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, UNIQUE(turn_id,request_key));
      CREATE TABLE agent_drafts(session_id INTEGER PRIMARY KEY REFERENCES agent_sessions(id), revision INTEGER NOT NULL DEFAULT 1, text TEXT NOT NULL DEFAULT '', attachments TEXT NOT NULL DEFAULT '[]');
      INSERT INTO wiki_schema VALUES(42);`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
