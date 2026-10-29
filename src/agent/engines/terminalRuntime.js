import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { childEnvironment } from '../../shared/runtime/childEnvironment.js';
import { terminateProcessTree } from '../executors/processTree.js';

// Authorization runs for every create and must
// approve the immutable, normalized operation, including effective environment.
export function createTerminalRuntime({ approve, onCreate = () => {}, onExit = () => {}, outputByteLimit = 1024 * 1024 }) {
  if (typeof approve !== 'function') throw new Error('Approval callback is required');
  const terminals = new Map();
  let closed = false, closing;
  async function stop(terminal) {
    if (terminal.exitStatus) return terminal.exited;
    terminal.stopping ||= terminateProcessTree(terminal.child);
    const stopped = await terminal.stopping;
    if (!terminal.exitStatus || !stopped?.treeConfirmed) throw new Error('Terminal termination is unconfirmed');
    return terminal.exited;
  }
  return {
    async create(operation) {
      if (closed || await approve(operation) !== true || closed) throw new Error('Terminal denied');
      const terminalId = randomUUID(); await onCreate(operation, terminalId);
      if (closed) throw new Error('Terminal closed before dispatch');
      const child = spawn(operation.program, operation.args, { cwd: operation.cwd, env: { ...childEnvironment(), ...Object.fromEntries(operation.environment.map(entry => [entry.name, entry.value])) },
        shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      const terminal = { child, output: '', truncated: false, exitStatus: null };
      const decoder = new StringDecoder('utf8');
      function append(value) {
        terminal.output += value;
        if (Buffer.byteLength(terminal.output) > outputByteLimit) {
          terminal.truncated = true;
          let bytes = Buffer.from(terminal.output).subarray(-outputByteLimit);
          while (bytes.length && (bytes[0] & 0xc0) === 0x80) bytes = bytes.subarray(1);
          terminal.output = bytes.toString('utf8');
        }
      }
      child.stdout.on('data', chunk => append(decoder.write(chunk)));
      const stderrDecoder = new StringDecoder('utf8');
      child.stderr.on('data', chunk => append(stderrDecoder.write(chunk)));
      terminal.exited = new Promise(resolve => {
        child.once('error', () => { terminal.exitStatus = { exitCode: null, signal: null }; terminal.spawnFailed = true; });
        child.once('close', (exitCode, signal) => {
          append(decoder.end()); append(stderrDecoder.end());
          terminal.exitStatus = { exitCode, signal };
          Promise.resolve(onExit(operation, { output: terminal.output, truncated: terminal.truncated, ...terminal.exitStatus }, terminalId))
            .catch(error => { terminal.outputError = error; }).finally(() => resolve(terminal.exitStatus));
        });
      });
      terminals.set(terminalId, terminal);
      return { terminalId };
    },
    async request(method, terminalId) {
      const terminal = terminals.get(terminalId);
      if (closed || !terminal) throw new Error('Unknown terminal');
      if (method === 'terminal/output') return { output: terminal.output, truncated: terminal.truncated, ...(terminal.exitStatus && { exitStatus: terminal.exitStatus }) };
      if (method === 'terminal/wait_for_exit') return terminal.exited;
      if (method === 'terminal/kill') { await stop(terminal); return {}; }
      if (method === 'terminal/release') { await stop(terminal); terminals.delete(terminalId); return {}; }
      throw new Error('Unsupported terminal method');
    },
    async close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        const results = await Promise.allSettled([...terminals.values()].map(stop)); terminals.clear();
        return { terminationUnknown: results.filter(result => result.status === 'rejected').length };
      })();
      return closing;
    },
  };
}
