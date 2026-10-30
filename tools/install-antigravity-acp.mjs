import { mkdir, writeFile, rename, rm, access } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('此安装脚本目前仅支持 Windows x64；其他平台请手动安装官方 ACP 并设置 ANTIGRAVITY_ACP_EXECUTABLE');
const directory = path.resolve(import.meta.dirname, '../.local/antigravity-acp');
const runtime = path.join(directory, 'runtime');
try { await access(path.join(runtime, 'agy_acp_server.exe')); console.log('Antigravity ACP 已安装；升级时请先停止工作台并另行检查版本。'); process.exit(0); } catch {}
await mkdir(directory, { recursive: true });
const token = randomUUID(), archive = path.join(directory, `${token}.zip`), staging = path.join(directory, token);
try {
  const response = await fetch('https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.5-windows-x86_64.zip', { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== 'd24f4c73c9f96d4f44384e281c855a56c72d8eaa9c5b0fad7ccb1635c6b63f50') throw new Error('官方归档 SHA256 校验失败，未安装');
  await writeFile(archive, bytes, { flag: 'wx' });
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${staging.replaceAll("'", "''")}'`], { windowsHide: true });
  await access(path.join(staging, 'agy_acp_server.exe'));
  await rename(staging, runtime);
  console.log('已安装 Google Antigravity ACP 1.4.5；可在工作台选择 Antigravity。');
} finally {
  await rm(archive, { force: true });
  if (path.dirname(staging) !== directory) throw new Error('Invalid staging directory');
  await rm(staging, { recursive: true, force: true });
}
