import { mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

async function restrict(target, directory = false) {
  if (process.platform !== 'win32') return;
  // Node's mode=0600 does not remove inherited Windows ACEs.
  const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${os.userInfo().username}` : os.userInfo().username;
  const rights = directory ? '(OI)(CI)(F)' : '(F)';
  await promisify(execFile)('icacls.exe', [target, '/inheritance:r', '/grant:r', `${account}:${rights}`, `*S-1-5-18:${rights}`], { windowsHide: true });
}

export async function saveLocalCredentials(runtimeDir, instanceId, token) {
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(runtimeDir, 0o700);
  await restrict(runtimeDir, true);
  const file = path.join(runtimeDir, `credentials-${instanceId}.json`);
  await writeFile(file, JSON.stringify({ instanceId, token }), { flag: 'wx', mode: 0o600 });
  try { await restrict(file); }
  catch (error) { await rm(file, { force: true }); throw error; }
  return file;
}
