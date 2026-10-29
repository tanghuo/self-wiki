export function migrateAgentWorkbench(db) {
  if (db.prepare('SELECT 1 FROM wiki_schema WHERE version=41').get()) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE agent_workspaces(id INTEGER PRIMARY KEY, kind INTEGER NOT NULL CHECK(kind IN(0,1)), user_path TEXT NOT NULL, canonical_path TEXT NOT NULL, identity TEXT NOT NULL, trusted_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE agent_sessions(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES agent_workspaces(id), engine TEXT NOT NULL, purpose INTEGER NOT NULL DEFAULT 0 CHECK(purpose IN(0,1)), state INTEGER NOT NULL DEFAULT 0, policy TEXT NOT NULL, capabilities TEXT NOT NULL DEFAULT '{}', engine_session_id TEXT, engine_version TEXT, generation INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, seq INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
      CREATE TABLE agent_turns(id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES agent_sessions(id), request_key TEXT NOT NULL, input_hash TEXT NOT NULL, input TEXT NOT NULL, state INTEGER NOT NULL DEFAULT 0, delivery TEXT NOT NULL DEFAULT 'not_sent', generation INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, finished_at INTEGER, UNIQUE(session_id,request_key));
      CREATE UNIQUE INDEX agent_one_active_turn ON agent_turns(session_id) WHERE state IN(0,1,2,3);
      CREATE TABLE agent_events(session_id INTEGER NOT NULL REFERENCES agent_sessions(id), seq INTEGER NOT NULL, turn_id INTEGER REFERENCES agent_turns(id), generation INTEGER NOT NULL, type TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL, source_event_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(session_id,seq));
      CREATE INDEX agent_events_turn ON agent_events(turn_id,seq);
      CREATE TABLE agent_approvals(id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES agent_sessions(id), turn_id INTEGER NOT NULL REFERENCES agent_turns(id), generation INTEGER NOT NULL, operation_hash TEXT NOT NULL, policy_revision INTEGER NOT NULL, state INTEGER NOT NULL DEFAULT 0, operation TEXT NOT NULL, decision TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE agent_operations(id INTEGER PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, owner_session_id INTEGER NOT NULL REFERENCES agent_sessions(id), origin_turn_id INTEGER NOT NULL REFERENCES agent_turns(id), kind TEXT NOT NULL, input_hash TEXT NOT NULL, input TEXT NOT NULL, executor TEXT NOT NULL, state INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, task_id INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE agent_tasks(id INTEGER PRIMARY KEY, owner_session_id INTEGER NOT NULL REFERENCES agent_sessions(id), origin_turn_id INTEGER NOT NULL REFERENCES agent_turns(id), operation_id INTEGER NOT NULL UNIQUE REFERENCES agent_operations(id), kind TEXT NOT NULL, input_hash TEXT NOT NULL, executor TEXT NOT NULL, state INTEGER NOT NULL DEFAULT 0, attempt_id INTEGER, cancel_requested INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
      CREATE TABLE agent_task_attempts(id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES agent_tasks(id), number INTEGER NOT NULL, state INTEGER NOT NULL DEFAULT 0, dispatch INTEGER NOT NULL DEFAULT 0, remote_id TEXT, data TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, UNIQUE(task_id,number));
      CREATE TABLE agent_artifacts(id INTEGER PRIMARY KEY, type TEXT NOT NULL, storage_key TEXT NOT NULL UNIQUE, hash TEXT NOT NULL, byte_size INTEGER NOT NULL, mime_type TEXT NOT NULL, producer TEXT NOT NULL, task_id INTEGER REFERENCES agent_tasks(id), turn_id INTEGER REFERENCES agent_turns(id), save_state INTEGER NOT NULL DEFAULT 1, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
      CREATE TABLE agent_artifact_refs(artifact_id INTEGER NOT NULL REFERENCES agent_artifacts(id), session_id INTEGER NOT NULL REFERENCES agent_sessions(id), task_id INTEGER REFERENCES agent_tasks(id), PRIMARY KEY(artifact_id,session_id));
      CREATE TABLE agent_commands(scope TEXT NOT NULL, request_key TEXT NOT NULL, hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(scope,request_key));
      INSERT INTO wiki_schema VALUES(41);
    `);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
