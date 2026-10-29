import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { grokTerminalOperation } from '../../src/agent/engines/grokTerminal.js';
import { createProbeTerminalHost } from '../../tools/lib/probeTerminalHost.mjs';

async function fixture(t, approve = () => true, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-terminal-'));
  const host = createProbeTerminalHost({ approve, ...options });
  t.after(async () => {
    await host.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('wiki-terminal-'));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const operation = code => grokTerminalOperation({ command: process.execPath, args: ['-e', code], cwd: root });
  return { root, host, operation };
}

test('terminal approval is required and rejected commands cannot create a file', async t => {
  const f = await fixture(t, () => false), target = path.join(f.root, 'denied.txt');
  await assert.rejects(f.host.create(f.operation(`require('fs').writeFileSync(${JSON.stringify(target)},'bad')`)), /denied/);
  assert.equal(await stat(target).catch(() => null), null);
});

test('terminal runs asynchronously, reports actual output/exit and invalidates released IDs', async t => {
  const f = await fixture(t), { terminalId } = await f.host.create(f.operation("setTimeout(()=>{console.log('中文 output');process.exit(7)},100)"));
  assert.equal((await f.host.request('terminal/output', terminalId)).exitStatus, undefined);
  assert.equal((await f.host.request('terminal/wait_for_exit', terminalId)).exitCode, 7);
  assert.match((await f.host.request('terminal/output', terminalId)).output, /中文 output/);
  await f.host.request('terminal/release', terminalId);
  await assert.rejects(f.host.request('terminal/output', terminalId), /Unknown/);
});

test('terminal output is bounded and UTF-8 truncation does not introduce replacement characters', async t => {
  const f = await fixture(t, () => true, { outputByteLimit: 64 });
  const { terminalId } = await f.host.create(f.operation("process.stdout.write('中文'.repeat(100))"));
  await f.host.request('terminal/wait_for_exit', terminalId);
  const result = await f.host.request('terminal/output', terminalId);
  assert.equal(result.truncated, true); assert.ok(Buffer.byteLength(result.output) <= 64); assert.ok(!result.output.includes('\ufffd'));
});

test('kill and release terminate running commands and close prevents new creates', async t => {
  const f = await fixture(t), { terminalId } = await f.host.create(f.operation('setInterval(()=>{},1000)'));
  await f.host.request('terminal/kill', terminalId);
  const result = await f.host.request('terminal/wait_for_exit', terminalId);
  assert.ok(result.signal || result.exitCode !== 0);
  const second = await f.host.create(f.operation('setInterval(()=>{},1000)'));
  await f.host.request('terminal/release', second.terminalId);
  await f.host.close(); await assert.rejects(f.host.create(f.operation('')), /denied/);
});

test('stopping an owned terminal reaps its spawned child process', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), pidFile = path.join(f.root, 'child-pid.txt');
  const childCode = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  const parentCode = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore',windowsHide:true});setInterval(()=>{},1000)`;
  const { terminalId } = await f.host.create(f.operation(parentCode));
  let childPid;
  for (let attempt = 0; attempt < 200; attempt++) {
    childPid = Number(await readFile(pidFile, 'utf8').catch(() => ''));
    if (childPid) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(childPid > 0, 'Owned child started');
  assert.doesNotThrow(() => process.kill(childPid, 0));
  await f.host.request('terminal/kill', terminalId);
  let alive = true;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(childPid, 0); } catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(alive, false, 'The terminal child must exit with its owner');
});

test('normalization binds the effective environment and rejects executable injection via environment', () => {
  const cwd = process.cwd();
  const first = grokTerminalOperation({ command: process.execPath, cwd, env: [{ name: 'FORCE_COLOR', value: '1' }, { name: 'MAVEN_OPTS', value: 'private-value' }] });
  assert.deepEqual(first.environment, [{ name: 'FORCE_COLOR', value: '1' }]);
  assert.deepEqual(first.omittedEnvironment, ['MAVEN_OPTS']);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.args) && Object.isFrozen(first.environment[0]));
  assert.notEqual(first.hash, grokTerminalOperation({ command: process.execPath, cwd, env: [{ name: 'FORCE_COLOR', value: '0' }, { name: 'MAVEN_OPTS', value: 'private-value' }] }).hash);
  for (const name of ['PATH', 'NODE_OPTIONS', 'HTTP_PROXY', 'PSModulePath', 'UNKNOWN_KEY']) assert.throws(() => grokTerminalOperation({ command: process.execPath, cwd, env: [{ name, value: 'evil' }] }), /Unsupported/);
  assert.throws(() => grokTerminalOperation({ command: 'node', cwd, env: [{ name: 'TERM', value: 'xterm' }, { name: 'term', value: 'xterm' }] }), /Duplicate/);
});

test('explicit PowerShell preserves quoted paths, Unicode and pipe syntax without splitting the command', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const target = path.join(f.root, '中文 path.txt');
  const command = `[IO.File]::WriteAllText('${target.replaceAll("'", "''")}', 'hello 中文'); 'abc 中文' | ForEach-Object { $_.ToUpper() }; exit 7`;
  const operation = grokTerminalOperation({ command, cwd: f.root }, { shell: { dialect: 'powershell', program: path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') } });
  const { terminalId } = await f.host.create(operation);
  assert.equal((await f.host.request('terminal/wait_for_exit', terminalId)).exitCode, 7);
  assert.match((await f.host.request('terminal/output', terminalId)).output, /ABC 中文/);
  assert.equal(await readFile(target, 'utf8'), 'hello 中文');
});
