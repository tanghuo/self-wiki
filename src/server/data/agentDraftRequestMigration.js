export function migrateAgentDraftRequests(db) {
  if (db.prepare('SELECT 1 FROM wiki_schema WHERE version=43').get()) return;
  db.exec('BEGIN IMMEDIATE');
  try { db.exec('ALTER TABLE agent_drafts ADD COLUMN request_key TEXT; INSERT INTO wiki_schema VALUES(43)'); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
