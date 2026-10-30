import { mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentError } from '../../../shared/domain/agentWorkbench/contracts.js';

export const pathIdentity = value => process.platform === 'win32' ? value.toLowerCase() : value;
export function containsPath(root, file) {
  const relative = path.relative(pathIdentity(root), pathIdentity(file));
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
export const pathsOverlap = (a, b) => containsPath(a, b) || containsPath(b, a);
export function localPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || /^(?:\\\\|\/\/)/.test(value)
      || process.platform === 'win32' && (value.slice(2).includes(':') || /[<>"|?*]/.test(value))) {
    throw agentError('INVALID_PATH', '请选择本机绝对路径，不支持网络或设备路径');
  }
  return path.resolve(value);
}
export async function registerWorkspace(repo, dataDir, input) {
  if (input.trusted !== true) throw agentError('TRUST_REQUIRED', '请先确认信任项目配置及当前用户权限的命令执行', 403);
  const dataRoot = await realpath(dataDir);
  const kind = input.kind === 'scratch' ? 'scratch' : input.kind === 'project' ? 'project' : null;
  if (!kind) throw agentError('INVALID_WORKSPACE', '请选择项目或临时工作区');
  let userPath = input.path;
  if (kind === 'scratch') {
    userPath = path.join(dataRoot, 'agent-workspaces', randomUUID());
    await mkdir(userPath, { recursive: true });
  }
  const canonical = await realpath(localPath(userPath));
  if (!(await stat(canonical)).isDirectory()) throw agentError('INVALID_WORKSPACE', '工作区必须是目录');
  if (canonical === path.parse(canonical).root) throw agentError('PROTECTED_PATH', '不能把整个磁盘作为工作区', 403);
  let name = '';
  if (kind === 'project') {
    name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '';
    if (input.name != null && !name) throw agentError('INVALID_PROJECT', '请填写项目名称');
    if (!name) name = path.basename(canonical) || '项目';
    const existing = repo.projectByIdentity(pathIdentity(canonical));
    if (existing) return input.name != null && existing.name !== name ? repo.renameProject(existing.id, name) : existing;
  }
  return repo.createWorkspace({ kind, userPath, path: canonical, identity: pathIdentity(canonical), name });
}

// Idle sessions hold no lock. FIFO among overlapping roots; unrelated roots can run.
export function createWorkspaceScheduler() {
  const running = new Set(), queue = [];
  function drain() {
    for (let i = 0; i < queue.length;) {
      const job = queue[i];
      if ([...running].some(other => pathsOverlap(other.root, job.root)) || queue.slice(0, i).some(other => pathsOverlap(other.root, job.root))) { i++; continue; }
      queue.splice(i, 1); running.add(job); job.signal.removeEventListener('abort', job.abort);
      let released = false;
      job.resolve(() => { if (released) return; released = true; running.delete(job); drain(); });
    }
  }
  return {
    acquire(root, signal) {
      signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        const job = { root, signal, resolve, reject };
        job.abort = () => { const i = queue.indexOf(job); if (i !== -1) { queue.splice(i, 1); reject(signal.reason); drain(); } };
        signal.addEventListener('abort', job.abort, { once: true }); queue.push(job); drain();
      });
    },
  };
}
