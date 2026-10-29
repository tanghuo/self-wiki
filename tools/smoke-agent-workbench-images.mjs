import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initDb } from '../src/server/data/sqlite.js';
import { createAgentWorkbenchRepository } from '../src/server/data/agentWorkbenchRepository.js';
import { createAgentTaskRepository } from '../src/server/data/agentTaskRepository.js';
import { createAgentArtifactStore } from '../src/server/assets/agentArtifactStore.js';
import { createAgentTaskService } from '../src/server/application/agentTasks/service.js';

if (!process.argv.includes('--live')) throw new Error('--live required; this submits real image tasks');
const output = process.argv[process.argv.indexOf('--output') + 1]; if (!output || output.startsWith('--')) throw new Error('--output required');
const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-workbench-images-')), dataDir = path.join(root, 'data'); await mkdir(dataDir);
const db = initDb(path.join(dataDir, 'library.sqlite3')), sessions = createAgentWorkbenchRepository(db), repo = createAgentTaskRepository(db), store = createAgentArtifactStore(dataDir);
const service = createAgentTaskService({ repo, sessions, store, executionConfig: () => ({ imageGeneration: { grokBuild: { executable: 'grok', model: 'grok-4.6', aspectRatio: '1:1' } } }) });
const report = { root, modelCalls: 0, paidImageCalls: 0, tasks: [], checks: {} };
try {
  const workspace = sessions.createWorkspace({ kind: 'scratch', userPath: root, path: root, identity: root }), session = sessions.createSession({ workspaceId: workspace.id, engine: 'grok-build', policy: {} });
  const turn = sessions.startTurn(sessions.queueTurn(session.id, 'image-task-fixture', { text: 'Synthetic image task acceptance' }).id);
  async function generate(prompt, referenceArtifactIds = []) {
    const op = service.submit(session.id, turn.id, { prompt, referenceArtifactIds, aspectRatio: '1:1' });
    report.checks.approvalBeforeDispatch = service.list(session.id).length === report.tasks.length;
    const approved = service.decide(op.id, session.id, { requestKey: `approve-image-${report.tasks.length}`, hash: op.hash, decision: 'allow' }); report.modelCalls++; report.paidImageCalls++;
    const again = service.decide(op.id, session.id, { requestKey: `approve-image-${report.tasks.length}`, hash: op.hash, decision: 'allow' });
    report.checks.sameTaskOnDuplicate = again.taskId === approved.taskId;
    const end = Date.now() + 240000; let previous;
    while (Date.now() < end) {
      const task = service.get(approved.taskId, session.id);
      if (task.state !== previous) { console.log(JSON.stringify({ taskId: task.id, state: task.state })); previous = task.state; }
      if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(task.state)) { report.tasks.push(task); return task; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const task = service.get(approved.taskId, session.id); service.cancel(task.id, session.id, { requestKey: 'timeout-cancel-image', revision: task.revision }); throw new Error('Image task timed out; no automatic retry');
  }
  const first = await generate('A simple flat illustration of a blue circle centered on a plain white square background. One shape only. Synthetic software acceptance image.');
  if (first.state !== 'succeeded') throw new Error(first.data.error || `First image ended ${first.state}`);
  report.checks.generatedArtifact = (await service.content(first.data.artifactIds[0], session.id)).bytes.length > 0;
  const edited = await generate('Change the blue circle to green. Keep the composition and plain white square background.', first.data.artifactIds);
  report.checks.editedArtifact = edited.state === 'succeeded' && (await service.content(edited.data.artifactIds[0], session.id)).bytes.length > 0;
  report.checks.bothSaved = service.list(session.id).every(task => task.state === 'succeeded' && task.data.saved);
  sessions.finish(turn.id, 'completed');
} catch (error) { report.error = error.message; }
finally { await service.close(); db.close(); }
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ checks: report.checks, error: report.error, modelCalls: report.modelCalls, paidImageCalls: report.paidImageCalls, output }));
if (report.error || !Object.values(report.checks).every(Boolean)) process.exitCode = 1;
