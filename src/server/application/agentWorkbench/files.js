import { readFile, realpath, lstat, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { containsPath, localPath, pathIdentity } from './workspaces.js';
import { agentError } from '../../../shared/domain/agentWorkbench/contracts.js';

const maxBytes = 2 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function decode(bytes) {
  if (bytes.length > maxBytes || bytes.includes(0)) throw agentError('UNSUPPORTED_FILE', '只支持不超过 2 MiB 的 UTF-8 文本');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw agentError('UNSUPPORTED_FILE', '文件不是 UTF-8 文本，不会自动转码'); }
}
export function createFileGateway({ workspace, readRoots = [], approve, assertLive, onChange }) {
  const roots = [workspace.path, ...readRoots];
  async function target(value, write = false) {
    const file = localPath(value), root = (write ? [workspace.path] : roots).find(root => containsPath(root, file));
    if (!root) throw agentError('PATH_DENIED', '路径不在授权范围内', 403);
    if (pathIdentity(await realpath(root)) !== pathIdentity(root)) throw agentError('PATH_CHANGED', '授权根已变化', 409);
    const parts = path.relative(root, file).split(path.sep).filter(Boolean);
    if (!parts.length || parts.some(part => ['.git', '.grok', '.codex', '.agents', '.runtime'].includes(part.toLowerCase()) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || /[. ]$/.test(part))) throw agentError('PROTECTED_PATH', '拒绝修改执行配置、仓库元数据或设备路径', 403);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const info = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info) return file;
      if (info.isSymbolicLink() || !containsPath(root, await realpath(current))) throw agentError('PATH_DENIED', '不允许通过符号链接或 junction 访问文件', 403);
      if (i < parts.length - 1 && !info.isDirectory()) throw agentError('INVALID_PATH', '父路径不是目录');
    }
    return file;
  }
  async function snapshot(file) {
    const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && (!info.isFile() || info.size > maxBytes)) throw agentError('UNSUPPORTED_FILE', '只支持不超过 2 MiB 的普通文本文件');
    const bytes = await readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    return bytes === null ? { hash: null, text: '', bytes: null } : { hash: hash(bytes), text: decode(bytes), bytes };
  }
  return {
    target,
    async read(params) {
      assertLive(); const file = await target(params.path), original = await snapshot(file);
      if (original.bytes === null) throw agentError('FILE_NOT_FOUND', '文件不存在', 404);
      if (params.line !== undefined && (!Number.isInteger(params.line) || params.line < 1) || params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1)) throw agentError('INVALID_RANGE', '无效的行范围');
      const lines = original.text.split('\n');
      return { content: lines.slice((params.line || 1) - 1, params.limit === undefined ? undefined : (params.line || 1) - 1 + params.limit).join('\n') };
    },
    async write(params) {
      assertLive();
      if (typeof params.content !== 'string' || Buffer.byteLength(params.content) > maxBytes || params.content.includes('\0')) throw agentError('UNSUPPORTED_FILE', '写入只支持不超过 2 MiB 的 UTF-8 文本');
      const file = await target(params.path, true), before = await snapshot(file);
      const afterBytes = Buffer.from(params.content), afterHash = hash(afterBytes);
      const operation = { kind: 'file.write', path: file, beforeHash: before.hash, afterHash, before: before.text, after: params.content };
      if (!await approve(operation)) throw agentError('APPROVAL_REJECTED', '文件写入未获批准', 403);
      assertLive(); await target(file, true);
      if ((await snapshot(file)).hash !== before.hash) throw agentError('FILE_CONFLICT', '文件在审批期间发生变化，请重新读取和审批', 409);
      await mkdir(path.dirname(file), { recursive: true }); await target(file, true); assertLive();
      const temp = path.join(path.dirname(file), `.self-wiki-${randomUUID()}.tmp`);
      try {
        const mode = (await lstat(file).catch(() => null))?.mode;
        await writeFile(temp, afterBytes, { flag: 'wx', ...(mode && { mode }) });
        await target(file, true);
        if ((await snapshot(file)).hash !== before.hash) throw agentError('FILE_CONFLICT', '写入前文件已变化', 409);
        assertLive(); await rename(temp, file);
      } finally { await rm(temp, { force: true }); }
      await onChange({ ...operation, source: 'host' }); return {};
    },
  };
}
