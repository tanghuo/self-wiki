import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { agentError } from '../../shared/domain/agentWorkbench/contracts.js';

export function createAgentCommandStore(dataDir) {
  const root = path.join(dataDir, 'agent-command-output');
  function location(turnId, commandId) {
    if (!Number.isSafeInteger(turnId) || turnId < 1 || !/^[a-f0-9-]{36}$/.test(commandId)) throw agentError('INVALID_COMMAND', '无效的命令标识');
    return path.join(root, String(turnId), `${commandId}.txt`);
  }
  return {
    async save(turnId, commandId, result) {
      const file = location(turnId, commandId), bytes = Buffer.from(result.output);
      if (bytes.length > 1024 * 1024) throw agentError('OUTPUT_LIMIT', '命令输出超过宿主限制');
      await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes, { flag: 'wx' });
      let start = Math.max(0, bytes.length - 4096);
      while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
      return { commandId, byteLength: bytes.length, output: bytes.subarray(start).toString('utf8'), previewOffset: start, truncated: result.truncated, exitCode: result.exitCode, signal: result.signal };
    },
    async page(turnId, commandId, offset = 0) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw agentError('INVALID_CURSOR', '无效的输出游标');
      const bytes = await readFile(location(turnId, commandId));
      let end = Math.min(bytes.length, offset + 65536);
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      if (offset > bytes.length || offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) throw agentError('INVALID_CURSOR', '游标不在 UTF-8 字符边界');
      return { offset, next: end, byteLength: bytes.length, output: bytes.subarray(offset, end).toString('utf8'), done: end === bytes.length };
    },
  };
}
