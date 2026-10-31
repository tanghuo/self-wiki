import { access } from 'node:fs/promises';

export async function registerGoogleAgent({ api, agents, executable }) {
  try { await access(executable); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    return null;
  }
  const name = 'Google 官方 ACP · self-wiki';
  const existing = agents.find(agent => agent.name === name && agent.agent_source === 'custom');
  const payload = { name, command: executable, args: [], icon: '🌐', advanced: { description: 'self-wiki 原有 Google 官方 Antigravity ACP 服务端。' } };
  if (existing && existing.command === executable && !existing.args?.length) return existing;
  return api(existing ? `/api/agents/custom/${encodeURIComponent(existing.id)}` : '/api/agents/custom', {
    method: existing ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
}
