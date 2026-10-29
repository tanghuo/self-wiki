import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { initDb } from '../../src/server/data/sqlite.js';
import { createAgentWorkbenchRepository } from '../../src/server/data/agentWorkbenchRepository.js';
import { createAgentTaskRepository } from '../../src/server/data/agentTaskRepository.js';
import { createAgentArtifactStore } from '../../src/server/assets/agentArtifactStore.js';
import { createAgentWikiRepository } from '../../src/server/data/agentWikiRepository.js';

test('closed complete-library backup restores drafts, artifact bytes and idempotency through two starts', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-agent-restore-')), data = path.join(root, 'data'), backup = path.join(root, 'backup'), restored = path.join(root, 'restored'); await mkdir(data);
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('wiki-agent-restore-')); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  let db = initDb(path.join(data, 'library.sqlite3'));
  const sessions = createAgentWorkbenchRepository(db), repo = createAgentTaskRepository(db), wiki = createAgentWikiRepository(db);
  const workspace = sessions.createWorkspace({ kind: 'scratch', userPath: data, path: data, identity: data }), session = sessions.createSession({ workspaceId: workspace.id, engine: 'grok-build', policy: {} });
  const png = await sharp({ create: { width: 6, height: 6, channels: 3, background: '#369' } }).png().toBuffer();
  const artifact = repo.publishArtifact(session.id, await createAgentArtifactStore(data).saveImage(png));
  const draft = wiki.saveDraft(session.id, { revision: 0, text: '恢复演练草稿', attachments: [artifact.id] });
  db.close(); await cp(data, backup, { recursive: true });
  db = initDb(path.join(data, 'library.sqlite3')); db.prepare('UPDATE agent_drafts SET text=?').run('after backup'); db.close();
  await cp(backup, restored, { recursive: true });
  for (let i = 0; i < 2; i++) {
    db = initDb(path.join(restored, 'library.sqlite3'));
    try {
      assert.deepEqual(createAgentWikiRepository(db).draft(session.id), draft);
      const value = createAgentTaskRepository(db).artifact(artifact.id, session.id);
      assert.deepEqual(await createAgentArtifactStore(restored).read(value), png);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
  }
});
