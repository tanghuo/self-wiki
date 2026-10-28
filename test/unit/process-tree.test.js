import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { terminateProcessTree } from '../../src/agent/executors/processTree.js';

test('termination kills a process tree even when descendants hold pipes and ignore SIGTERM', { timeout: 12000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-process-tree-'));
  const file = path.join(root, 'hang.cjs'), ready = path.join(root, 'ready.json');
  await writeFile(file, `
    process.on('SIGTERM', () => {});
    if (process.argv[2] === 'child') { process.send(process.pid); }
    else {
      const child = require('node:child_process').spawn(process.execPath, [__filename, 'child'], { stdio: ['ignore', 1, 2, 'ipc'] });
      child.on('message', (pid) => require('node:fs').writeFileSync(process.argv[2], JSON.stringify([process.pid, pid])));
    }
    setInterval(() => {}, 1000);
  `);
  const child = spawn(process.execPath, [file, ready], { detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    await terminateProcessTree(child, { graceMs: 100 });
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('wiki-process-tree-'));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  let pids;
  for (let i = 0; i < 100; i++) {
    try { pids = JSON.parse(await readFile(ready, 'utf8')); break; } catch { await sleep(20); }
  }
  assert.equal(pids?.length, 2, 'both processes must start before testing termination');
  await terminateProcessTree(child, { graceMs: 100 });
  for (const pid of pids) {
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try { process.kill(pid, 0); await sleep(20); } catch (error) { assert.equal(error.code, 'ESRCH'); alive = false; }
    }
    assert.equal(alive, false, `process ${pid} must be terminated`);
  }
});
