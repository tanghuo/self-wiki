// Runs the unmodified upstream WebUI in its own runtime and data directory.
import path from 'node:path';
import { mkdir, access, writeFile } from 'node:fs/promises';
import { startWebHost } from '../.local/references/AionUi/packages/web-host/src/index.ts';
import { grokEnvironment } from '../src/agent/executors/grokEnvironment.js';

const root = path.resolve(process.env.SELF_WIKI_ROOT || process.cwd());
const source = path.join(root, '.local/references/AionUi');
const dataDir = path.resolve(process.argv[2] || path.join(root, 'data/aionui-experiment'));
const executable = process.env.ANTIGRAVITY_ACP_EXECUTABLE || path.join(root, '.local/antigravity-acp/runtime/agy_acp_server.exe');
await mkdir(dataDir, { recursive: true });
const handle = await startWebHost({
  app: { version: '2.2.2', isPackaged: false, resourcesPath: source, userDataPath: dataDir },
  staticDir: path.join(source, 'out/renderer'),
  port: 0, allowRemote: false, dataDir, logDir: path.join(dataDir, 'logs'),
  dirs: { cacheDir: dataDir, workDir: path.join(dataDir, 'workspaces'), logDir: path.join(dataDir, 'logs') },
  backend: { kind: 'ownBackend', resolveBackend: () => path.join(root, '.local/aionui-experiment/backend/aioncore.exe') },
});
let stopping;
const stop = () => stopping ||= handle.stop().finally(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
if (process.argv.includes('--managed')) {
  process.stdin.resume();
  process.stdin.on('end', stop);
}

try {
  await access(executable);
  const api = async (route, options) => {
    const response = await fetch(new URL(route, `http://127.0.0.1:${handle.backendPort}`), options);
    const value = await response.json();
    if (!response.ok || value.success === false) throw new Error(value.error || `AionUi HTTP ${response.status}`);
    return value.data;
  };
  const name = 'Google 官方 ACP · self-wiki';
  const agents = await api('/api/agents/management');
  const grok = agents.find(agent => agent.backend === 'grok' && agent.agent_source === 'builtin');
  if (grok) {
    // Match the working self-wiki CLI transport, including its local proxy.
    const previous = await api(`/api/agents/${grok.id}/overrides`);
    const environment = grokEnvironment();
    const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
    const overrides = [...(previous.env_override || []).filter(entry => !names.includes(entry.name)), ...names.map(name => ({ name, value: environment[name] }))];
    if (names.some(name => !(previous.env_override || []).some(entry => entry.name === name && entry.value === environment[name]))) {
      await api(`/api/agents/${grok.id}/overrides`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ env_override: overrides }) });
    }
  }
  const existing = agents.find(agent => agent.name === name && agent.agent_source === 'custom');
  const payload = { name, command: executable, args: [], icon: '🌐', advanced: { description: 'self-wiki 原有 Google 官方 Antigravity ACP 服务端。' } };
  const agent = existing && existing.command === executable && !existing.args?.length ? existing : await api(existing ? `/api/agents/custom/${encodeURIComponent(existing.id)}` : '/api/agents/custom', {
    method: existing ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const info = { url: handle.localUrl, agentId: agent.id, agentName: name, dataDir, backendPort: handle.backendPort };
  await writeFile(path.join(dataDir, 'experiment-instance.json'), JSON.stringify(info, null, 2));
  process.stdout.write(`SELF_WIKI_AIONUI_READY ${JSON.stringify(info)}\n`);
} catch (error) {
  console.error(`AionUi 官方 ACP 配置失败：${error.message}`);
  await handle.stop();
  process.exit(1);
}
