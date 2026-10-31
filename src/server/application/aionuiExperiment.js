import path from 'node:path';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { terminateProcessTree } from './executorsPort.js';

export function createAionuiExperiment({ root, dataDir, timeoutMs = 120000 }) {
  const directory = path.join(dataDir, 'aionui-experiment');
  const runtime = path.join(root, '.local/aionui-experiment');
  let child, pending, stopping, ready, failure = '', closed = false, generation = 0;
  const temporaryDirectories = new WeakMap();
  async function terminate(current) {
    const result = await terminateProcessTree(current);
    const temporary = temporaryDirectories.get(current);
    if (result.treeConfirmed && temporary && path.dirname(temporary) === directory && path.basename(temporary).startsWith('runtime-temp-')) {
      await rm(temporary, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }
  const files = [path.join(runtime, 'host.mjs'), path.join(runtime, 'backend/aioncore.exe'), path.join(root, '.local/references/AionUi/out/renderer/index.html')];
  async function status() {
    const prepared = (await Promise.all(files.map(file => access(file).then(() => true, () => false)))).every(Boolean);
    return { prepared, state: ready ? 'running' : pending ? 'starting' : failure ? 'failed' : 'stopped', url: ready?.url || '', agentName: ready?.agentName || 'Google 官方 ACP · self-wiki', dataDir: directory, error: failure, version: 'AionUi 2.2.2 / AionCore 0.2.2' };
  }
  function start() {
    if (closed) return Promise.reject(new Error('实验服务正在关闭'));
    if (stopping) return stopping.then(() => start());
    if (ready) return Promise.resolve(ready);
    if (pending) return pending;
    const epoch = ++generation;
    return pending ||= (async () => {
      if (!(await status()).prepared) throw new Error('AionUi 实验环境尚未准备，请运行 tools/setup-aionui-experiment.ps1');
      await mkdir(directory, { recursive: true });
      const temporary = await mkdtemp(path.join(directory, 'runtime-temp-'));
      if (closed || epoch !== generation) throw new Error('AionUi 启动已取消');
      const log = createWriteStream(path.join(directory, 'launcher.log'), { flags: 'a' });
      log.on('error', () => {});
      failure = '';
      const nodeBinary = process.versions.electron ? process.env.NODE_BINARY || 'node' : process.execPath;
      const current = spawn(nodeBinary, [files[0], directory, '--managed'], {
        cwd: root, windowsHide: true, shell: false, detached: process.platform !== 'win32',
        env: { ...process.env, SELF_WIKI_ROOT: root, AIONUI_LOG_LEVEL: 'warn', TEMP: temporary, TMP: temporary, TMPDIR: temporary }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      child = current;
      temporaryDirectories.set(current, temporary);
      current.stdin.on('error', () => {});
      current.stderr.on('data', chunk => log.write(chunk));
      current.once('close', () => {
        log.end();
        if (ready && !stopping && !closed) failure = 'AionUi 实验服务意外退出；可重新打开，消息不会自动重发';
        if (child === current) { child = null; ready = null; }
      });
      try {
        return await new Promise((resolve, reject) => {
          let buffer = '', settled = false;
          const finish = (error, info) => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            if (error) { failure = error.message; reject(error); }
            else { ready = info; resolve(info); }
          };
          const timer = setTimeout(() => finish(new Error('AionUi 启动超时；请查看实验数据目录中的 launcher.log')), timeoutMs);
          current.once('error', () => finish(new Error('无法启动 AionUi 实验服务')));
          current.once('close', () => finish(new Error('AionUi 实验服务已退出；请查看 launcher.log')));
          current.stdout.on('data', chunk => {
            log.write(chunk); buffer += chunk.toString();
            if (buffer.length > 1024 * 1024) buffer = buffer.slice(-65536);
            let end;
            while ((end = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
              if (!line.startsWith('SELF_WIKI_AIONUI_READY ')) continue;
              try {
                const info = JSON.parse(line.slice('SELF_WIKI_AIONUI_READY '.length));
                const url = new URL(info.url);
                if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || !Number.isInteger(info.backendPort) || info.backendPort < 1 || info.backendPort > 65535) throw new Error();
                finish(null, info);
              } catch { finish(new Error('AionUi 返回了无效的本机地址')); }
            }
          });
        });
      } catch (error) {
        await terminate(current);
        throw error;
      }
    })().catch(error => { failure = error.message; throw error; }).finally(() => { pending = null; });
  }
  async function launch() {
    const info = await start();
    // The upstream browser UI needs its own login cookie even in local mode.
    // Mint it through the upstream one-time QR exchange, without a saved password.
    const base = `http://127.0.0.1:${info.backendPort}`;
    const qr = await fetch(new URL('/api/webui/generate-qr-token', base), { method: 'POST', signal: AbortSignal.timeout(10000) });
    const token = await qr.json();
    if (!qr.ok || !token.data?.token) throw new Error('AionUi 本机登录初始化失败');
    const login = await fetch(new URL('/api/auth/qr-login', base), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ qr_token: token.data.token }), signal: AbortSignal.timeout(10000),
    });
    if (!login.ok) throw new Error('AionUi 本机登录失败');
    const cookies = login.headers.getSetCookie();
    if (!cookies.length || cookies.some(cookie => !/^aionui-(session|refresh)=/.test(cookie))) throw new Error('AionUi 未返回有效的登录凭据');
    return { status: await status(), cookies };
  }
  function stop() {
    generation++;
    return stopping ||= (async () => {
      const current = child;
      ready = null;
      if (current) {
        current.stdin.end();
        await terminate(current);
      }
      await pending?.catch(() => {});
    })().finally(() => { stopping = null; });
  }
  return { status, launch, stop, async close() { closed = true; await stop(); } };
}
