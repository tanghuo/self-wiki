export function migrateAgentWorkflow(db) {
  if (db.prepare('SELECT 1 FROM wiki_schema WHERE version=44').get()) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE agent_workflow_runs(attempt_id INTEGER PRIMARY KEY REFERENCES agent_task_attempts(id), task_id INTEGER NOT NULL REFERENCES agent_tasks(id), workflow_id INTEGER NOT NULL REFERENCES workflows(id), run_id INTEGER NOT NULL UNIQUE REFERENCES workflow_runs(id), parent_task_id INTEGER REFERENCES agent_tasks(id), chain TEXT NOT NULL);
      INSERT INTO wiki_schema VALUES(44);`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
