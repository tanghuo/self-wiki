import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { childEnvironment } from '../../shared/runtime/childEnvironment.js';
import { terminateProcessTree } from './processTree.js';

export const antigravityVersion = '1.4.5';
export async function antigravityExecutable(executable) {
  const candidate = executable || process.env.ANTIGRAVITY_ACP_EXECUTABLE || path.resolve(import.meta.dirname, '../../../.local/antigravity-acp/runtime/agy_acp_server.exe');
  if (!path.isAbsolute(candidate) || !/\.(exe|mjs|cjs|js)$/i.test(candidate)) throw new Error('Antigravity ACP 程序路径必须是绝对路径');
  try { await access(candidate); } catch { throw new Error('尚未安装 Antigravity ACP：运行 node tools/install-antigravity-acp.mjs，或设置 ANTIGRAVITY_ACP_EXECUTABLE'); }
  return candidate;
}

export async function startAntigravityAcp(settings, { cwd, signal, onNotification = () => {}, onRequest = async () => { throw new Error('不支持的 ACP 请求'); }, onExit = () => {} }) {
  signal?.throwIfAborted();
  const executable = await antigravityExecutable(settings.executable);
  signal?.throwIfAborted();
  const script = /\.(mjs|cjs|js)$/i.test(executable);
  const child = spawn(script ? process.execPath : executable, script ? [executable] : [], { cwd, windowsHide: true, shell: false,
    detached: process.platform !== 'win32', env: childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(), decoder = new StringDecoder('utf8');
  let sequence = 0, buffer = '', ended = false, closing = false, closePromise, hostRequests = 0;
  const write = value => { if (!ended && !child.stdin.destroyed) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n'); };
  function fail(error) {
    if (ended) return; ended = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear(); if (!closing) onExit(error);
  }
  function request(method, params = {}, timeout = 30000) {
    if (ended) return Promise.reject(new Error('Antigravity ACP 连接已关闭'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const entry = { resolve, reject, method, remaining: timeout, timer: null, startedAt: 0 };
      entry.arm = () => {
        entry.startedAt = performance.now();
        entry.timer = setTimeout(() => { pending.delete(id); reject(new Error(`Antigravity 请求超时：${method}`)); }, entry.remaining);
      };
      pending.set(id, entry);
      if (method !== 'session/prompt' || !hostRequests) entry.arm();
      write({ id, method, params });
    });
  }
  function message(value) {
    if (value.method && value.id !== undefined) {
      if (hostRequests++ === 0) for (const entry of pending.values()) if (entry.method === 'session/prompt' && entry.timer) {
        clearTimeout(entry.timer); entry.timer = null;
        entry.remaining = Math.max(0, entry.remaining - (performance.now() - entry.startedAt));
      }
      Promise.resolve().then(() => onRequest(value.method, value.params || {})).then(
        result => write({ id: value.id, result }), error => write({ id: value.id, error: { code: -32601, message: error.message } }),
      ).finally(() => { if (--hostRequests === 0) for (const entry of pending.values()) if (entry.method === 'session/prompt' && !entry.timer) entry.arm(); });
    } else if (value.id !== undefined) {
      const entry = pending.get(value.id); if (!entry) return;
      pending.delete(value.id); clearTimeout(entry.timer);
      if (value.error) {
        const auth = value.error.code === -32000 && /auth/i.test(value.error.message || '');
        // Do not persist arbitrary RPC diagnostics or stderr containing account data.
        entry.reject(Object.assign(new Error(auth ? 'Antigravity ACP 需要连接账号；桌面版登录可能未共享给 ACP，请点击“连接 Antigravity 账号”' : `Antigravity ${entry.method} 请求失败（${value.error.code}）`), { code: auth ? 'AUTH_REQUIRED' : 'ACP_ERROR' }));
      } else entry.resolve(value.result);
    } else if (value.method) Promise.resolve().then(() => onNotification(value.method, value.params || {})).catch(error => { fail(error); void close(); });
  }
  child.stdout.on('data', chunk => {
    buffer += decoder.write(chunk);
    if (buffer.length > 40 * 1024 * 1024) { fail(new Error('Antigravity ACP 事件超过限制')); void close(); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (line.trim()) { try { message(JSON.parse(line)); } catch { fail(new Error('Antigravity 返回无效 ACP 事件')); void close(); return; } }
    }
  });
  child.stderr.resume();
  child.stdin.on('error', () => fail(new Error('Antigravity 输入连接关闭')));
  child.once('error', () => fail(new Error('无法启动 Antigravity ACP')));
  child.once('close', () => fail(new Error('Antigravity ACP 进程已退出')));
  async function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => { child.stdin.end(); await terminateProcessTree(child); fail(new Error('Antigravity ACP 连接已关闭')); signal?.removeEventListener('abort', abort); })();
    return closePromise;
  }
  function abort() { void close(); }
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  return { request, notify: (method, params) => write({ method, params }), close };
}
