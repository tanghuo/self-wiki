export function verifyWorkbenchMcpCatalog(catalog, definition) {
  if (!catalog || !Array.isArray(catalog.servers) || catalog.sessionMcpResolved === false) throw new Error('Grok 应用工具目录尚未就绪');
  const enabled = catalog.servers.filter(server => server.session?.enabled !== false && !server.session?.blockedReason);
  if (!definition) {
    if (enabled.length) throw new Error('Grok 会话加载了其他 MCP；为保持工作台权限范围，本次不会发送任务');
    return { tools: [], transport: 'none' };
  }
  // The pinned CLI represents session-only SDK servers as an empty stdio
  // placeholder. The namespace is fresh and unpredictable for each connection.
  if (definition.serverId) {
    if (!enabled.length) throw new Error('Grok 未连接工作台应用工具');
    if (enabled.length !== 1 || enabled[0].name !== definition.name || enabled[0].type !== 'stdio' || enabled[0].command !== '' || enabled[0].args?.length || enabled[0].env?.length) throw new Error('Grok 会话加载了其他 MCP；为保持工作台权限范围，本次不会发送任务');
    if (enabled[0].session.status !== 'ready') throw new Error('Grok 未连接工作台应用工具');
    return { server: definition.name, tools: enabled[0].session.tools || [], transport: 'acp' };
  }
  if (enabled.some(server => server.name !== definition.name || !definition.serverId && (server.type !== 'http' || server.url !== definition.url))) throw new Error('Grok 会话加载了其他 MCP；为保持工作台权限范围，本次不会发送任务');
  const own = enabled.find(server => server.name === definition.name);
  if (!own || own.session?.status !== 'ready') throw new Error('Grok 未连接工作台应用工具');
  return { server: own.name, tools: (own.session.tools || []).filter(tool => tool.enabled !== false).map(tool => tool.name) };
}
