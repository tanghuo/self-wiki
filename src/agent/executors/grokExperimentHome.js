import { mkdir, copyFile, readdir, cp, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// The npm Grok installer replaces GROK_HOME/bin/grok.exe even when another
// version is already installed. An experiment must never share that home.
export async function prepareGrokExperimentHome(directory, sourceHome = process.env.GROK_HOME || path.join(homedir(), '.grok')) {
  const home = path.resolve(directory, 'grok-home');
  sourceHome = path.resolve(sourceHome);
  if (home === sourceHome) throw new Error('Grok 实验目录不能与原安装目录相同');
  await mkdir(home, { recursive: true });
  try { await copyFile(path.join(sourceHome, 'auth.json'), path.join(home, 'auth.json'), constants.COPYFILE_EXCL); }
  catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
  // Preserve existing AionUi conversations created before home isolation.
  // Other workbench sessions, binaries and configuration stay in their home.
  const workspace = path.resolve(directory, 'workspaces');
  let entries;
  try { entries = await readdir(path.join(sourceHome, 'sessions'), { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let cwd;
    try { cwd = decodeURIComponent(entry.name); } catch { continue; }
    const relative = path.relative(workspace, path.resolve(cwd));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    const destination = path.join(home, 'sessions', entry.name);
    try { await access(destination); continue; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await cp(path.join(sourceHome, 'sessions', entry.name), destination, { recursive: true, force: false });
  }
  return home;
}
