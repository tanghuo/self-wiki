import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateWorkflow } from '../../src/server/data/workflowMigration.js';

test('workflow migration is additive, idempotent and rolls back partial DDL', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE wiki_schema(version INTEGER PRIMARY KEY); INSERT INTO wiki_schema VALUES(39); CREATE TABLE elements(id INTEGER PRIMARY KEY,body TEXT); INSERT INTO elements VALUES(1,\'keep\');');
    const original = db.exec;
    db.exec = function (sql) { const value = original.call(this, sql); if (sql.includes('INSERT INTO wiki_schema VALUES(40)')) throw new Error('simulated migration interruption'); return value; };
    assert.throws(() => migrateWorkflow(db), /interruption/);
    db.exec = original;
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='workflows'").get().n, 0);
    assert.equal(db.prepare('SELECT max(version) AS v FROM wiki_schema').get().v, 39);
    migrateWorkflow(db); migrateWorkflow(db);
    assert.equal(db.prepare('SELECT body FROM elements WHERE id=1').get().body, 'keep');
    assert.equal(db.prepare('SELECT count(*) AS n FROM wiki_schema WHERE version=40').get().n, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});
