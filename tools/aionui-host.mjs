// Runs the unmodified upstream WebUI in its own runtime and data directory.
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { startWebHost } from '../.local/references/AionUi/packages/web-host/src/index.ts';
import { grokEnvironment } from '../src/agent/executors/grokEnvironment.js';
import { prepareGrokExperimentHome } from '../src/agent/executors/grokExperimentHome.js';
import { registerGoogleAgent } from './aionui-google-agent.mjs';

const root = path.resolve(process.env.SELF_WIKI_ROOT || process.cwd());
const source = path.join(root, '.local/references/AionUi');
const dataDir = path.resolve(process.argv[2] || path.join(root, 'data/aionui-experiment'));
const executable = process.env.ANTIGRAVITY_ACP_EXECUTABLE || path.join(root, '.local/antigravity-acp/runtime/agy_acp_server.exe');
await mkdir(dataDir, { recursive: true });
// Set this before startWebHost: its initial health checks can install Grok.
process.env.GROK_HOME = await prepareGrokExperimentHome(dataDir);
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
  const api = async (route, options) => {
    const response = await fetch(new URL(route, `http://127.0.0.1:${handle.backendPort}`), options);
    const value = await response.json();
    if (!response.ok || value.success === false) throw new Error(value.error || `AionUi HTTP ${response.status}`);
    return value.data;
  };
  const agents = await api('/api/agents/management');
  const grok = agents.find(agent => agent.backend === 'grok' && agent.agent_source === 'builtin');
  if (grok) {
    // Match the working self-wiki CLI transport, including its local proxy.
    const previous = await api(`/api/agents/${grok.id}/overrides`);
    const environment = grokEnvironment();
    const names = ['GROK_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
    const overrides = [...(previous.env_override || []).filter(entry => !names.includes(entry.name)), ...names.map(name => ({ name, value: environment[name] }))];
    if (names.some(name => !(previous.env_override || []).some(entry => entry.name === name && entry.value === environment[name]))) {
      await api(`/api/agents/${grok.id}/overrides`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ env_override: overrides }) });
    }
  }
  const agent = await registerGoogleAgent({ api, agents, executable });
  if (!agent) console.warn('Google 官方 ACP 程序未安装，Grok 和其他已有引擎仍可使用');
  const info = { url: handle.localUrl, agentId: agent?.id || null, agentName: agent?.name || 'Grok Build', dataDir, backendPort: handle.backendPort };
  await writeFile(path.join(dataDir, 'experiment-instance.json'), JSON.stringify(info, null, 2));
  process.stdout.write(`SELF_WIKI_AIONUI_READY ${JSON.stringify(info)}\n`);
} catch (error) {
  console.error(`AionUi 引擎配置失败：${error.message}`);
  await handle.stop();
  process.exit(1);
}
