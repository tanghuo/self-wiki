export function migrateAgentProjectNames(db) {
  if (db.prepare('SELECT 1 FROM wiki_schema WHERE version=45').get()) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('ALTER TABLE agent_workspaces ADD COLUMN name TEXT NOT NULL DEFAULT \'\'');
    const rows = db.prepare('SELECT id, canonical_path FROM agent_workspaces WHERE kind=0').all();
    const update = db.prepare('UPDATE agent_workspaces SET name=? WHERE id=?');
    for (const row of rows) update.run(row.canonical_path.split(/[\\/]/).filter(Boolean).at(-1) || '项目', row.id);
    db.exec('INSERT INTO wiki_schema VALUES(45)');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
