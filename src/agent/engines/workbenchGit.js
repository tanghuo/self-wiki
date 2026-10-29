import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { childEnvironment } from '../../shared/runtime/childEnvironment.js';

export async function workbenchGitSnapshot(cwd) {
  const run = args => promisify(execFile)('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, ...args], { cwd, windowsHide: true, env: childEnvironment(), timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
  try {
    const status = (await run(['status', '--porcelain=v1', '-z', '--untracked-files=normal'])).stdout;
    const diff = (await run(['diff', '--no-ext-diff', '--no-textconv', '--', '.'])).stdout;
    return { git: true, status: status.split('\0').filter(Boolean), diff, includesExternalChanges: true };
  } catch (error) { return { git: false, reason: error.code === 'ENOENT' ? 'git_unavailable' : 'not_git_or_snapshot_failed', includesExternalChanges: true }; }
}
