export function migrateWorkflow(db) {
  if (db.prepare('SELECT 1 FROM wiki_schema WHERE version=40').get()) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE workflows(id INTEGER PRIMARY KEY, name TEXT NOT NULL, draft TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, archived_at INTEGER, updated_at INTEGER NOT NULL);
      CREATE TABLE workflow_versions(id INTEGER PRIMARY KEY, workflow_id INTEGER NOT NULL REFERENCES workflows(id), version INTEGER NOT NULL, definition TEXT NOT NULL, hash TEXT NOT NULL, UNIQUE(workflow_id,version));
      CREATE TABLE workflow_runs(id INTEGER PRIMARY KEY, version_id INTEGER NOT NULL REFERENCES workflow_versions(id), parent_id INTEGER REFERENCES workflow_runs(id), inputs TEXT NOT NULL, executor_snapshot TEXT NOT NULL, state INTEGER NOT NULL DEFAULT 0, control_version INTEGER NOT NULL DEFAULT 1, paused INTEGER NOT NULL DEFAULT 0, cancelled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE workflow_node_instances(id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES workflow_runs(id), scope TEXT NOT NULL, node_id TEXT NOT NULL, item_id TEXT, context TEXT NOT NULL DEFAULT '{}', state INTEGER NOT NULL DEFAULT 0, attempt_id INTEGER, outputs TEXT NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}', UNIQUE(run_id,scope,node_id));
      CREATE INDEX workflow_instances_state ON workflow_node_instances(run_id,state,id);
      CREATE TABLE workflow_node_attempts(id INTEGER PRIMARY KEY, instance_id INTEGER NOT NULL REFERENCES workflow_node_instances(id), number INTEGER NOT NULL, generation TEXT NOT NULL, state INTEGER NOT NULL DEFAULT 1, dispatch_started INTEGER NOT NULL DEFAULT 0, request TEXT NOT NULL DEFAULT '{}', remote_id TEXT, error TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, UNIQUE(instance_id,number));
      CREATE TABLE workflow_artifacts(id TEXT PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES workflow_runs(id), instance_id INTEGER REFERENCES workflow_node_instances(id), attempt_id INTEGER REFERENCES workflow_node_attempts(id), type TEXT NOT NULL, value TEXT, storage_key TEXT, hash TEXT NOT NULL, byte_size INTEGER NOT NULL, metadata TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE workflow_artifact_refs(run_id INTEGER NOT NULL REFERENCES workflow_runs(id), instance_id INTEGER REFERENCES workflow_node_instances(id), artifact_id TEXT NOT NULL REFERENCES workflow_artifacts(id), role TEXT NOT NULL, port TEXT NOT NULL, UNIQUE(run_id,instance_id,artifact_id,role,port));
      CREATE INDEX workflow_refs_artifact ON workflow_artifact_refs(artifact_id);
      CREATE TABLE workflow_events(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL REFERENCES workflow_runs(id), type TEXT NOT NULL, instance_id INTEGER REFERENCES workflow_node_instances(id), attempt_id INTEGER REFERENCES workflow_node_attempts(id), data TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX workflow_events_cursor ON workflow_events(run_id,id);
      CREATE TABLE workflow_save_receipts(instance_id INTEGER NOT NULL REFERENCES workflow_node_instances(id), artifact_id TEXT NOT NULL REFERENCES workflow_artifacts(id), element_id INTEGER REFERENCES elements(id) ON DELETE SET NULL, source TEXT NOT NULL, PRIMARY KEY(instance_id,artifact_id));
      CREATE TABLE workflow_commands(scope TEXT NOT NULL, request_key TEXT NOT NULL, hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(scope,request_key));
      CREATE TABLE workflow_owner(id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT NOT NULL);
      INSERT INTO wiki_schema VALUES(40);
    `);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
