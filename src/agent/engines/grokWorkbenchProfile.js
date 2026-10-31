import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

// ACP ignores the headless --tools flags. An explicit toolConfig also removes
// search_tool/use_tool, which otherwise rediscover unlisted native tools.
export const workbenchToolIds = Object.freeze(['GrokBuild:read_file', 'GrokBuild:search_replace', 'OpenCode:write', 'GrokBuild:run_terminal_cmd']);
export function grokWorkbenchProfile({ restricted = false, applicationTools = false } = {}) {
  const textOnly = restricted && !applicationTools;
  return {
    name: restricted ? textOnly ? 'self-wiki-workflow-text-v2' : 'self-wiki-workflow-text-v1' : 'self-wiki-workbench-v1',
    description: 'Self Wiki execution host; exact tools verified before prompting',
    // Grok 1.0.70 rejects an empty curated registry during session/new.
    // Register one known tool, then exclude it from the model's callable tools.
    // File access is independently disabled by the restricted ACP client.
    toolConfig: { tools: [...(textOnly ? ['GrokBuild:read_file'] : restricted ? [] : workbenchToolIds), ...(applicationTools ? ['GrokBuild:search_tool', 'GrokBuild:use_tool'] : [])].map(id => ({ id })) },
    injectDefaultTools: false, discoverSkills: false, agentsMd: false,
    disallowedTools: ['Agent', ...(textOnly ? ['read_file'] : [])], mcpInheritance: 'none',
  };
}

export async function verifyGrokWorkbenchProfile({ cwd, sessionId, profile, explicitlySelected = false, requireEmptyTools = false, home = process.env.GROK_HOME || path.join(homedir(), '.grok') }) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('Grok 返回了无效会话标识');
  const sessions = await realpath(path.join(home, 'sessions'));
  const folder = await realpath(path.join(sessions, encodeURIComponent(cwd), sessionId));
  const relative = path.relative(sessions, folder);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Grok 会话目录越界');
  const summary = JSON.parse(await readFile(path.join(folder, 'summary.json'), 'utf8'));
  // Some CLI builds persist only agent_name. For those builds, accept the
  // selected name only when the caller explicitly selected this ACP profile
  // via GROK_AGENT, preventing the model's default harness from overriding it.
  // A persisted full profile must still pass every configuration check below.
  const selectionConfirmed = explicitlySelected && summary.agent_profile == null && summary.agent_name === profile.name;
  const actual = selectionConfirmed ? profile : summary.agent_profile;
  const ids = value => value?.toolConfig?.tools?.map(tool => tool.id).sort();
  if (actual?.name !== profile.name || actual.injectDefaultTools !== false || actual.discoverSkills !== false
      || actual.agentsMd !== false || actual.mcpInheritance !== 'none' || JSON.stringify(ids(actual)) !== JSON.stringify(ids(profile))
      || JSON.stringify([...(actual.disallowedTools || [])].sort()) !== JSON.stringify([...profile.disallowedTools].sort())) {
    throw new Error('Grok 未应用工作台工具配置；禁止发送任务');
  }
  // Tool definitions are written on the first prompt, not session creation.
  if (requireEmptyTools) {
    const tools = JSON.parse(await readFile(path.join(folder, 'tool_definitions.json'), 'utf8'));
    if (!Array.isArray(tools) || tools.length) throw new Error('受限模型节点出现可调用工具，拒绝接收结果');
  }
  return { verified: true, profile: profile.name, profileVerification: selectionConfirmed ? 'explicit-selection' : 'persisted-profile', toolIds: ids(actual).filter(id => !profile.disallowedTools.includes(id.split(':').at(-1))) };
}
