import { randomUUID } from 'node:crypto';

// The ACP reverse channel is private to one engine process. No HTTP listener,
// bearer or management credential is passed to Grok.
export function createGrokSdkTools(tools, call) {
  const serverId = randomUUID(); let turn, sequence = 0, initialized = false;
  return {
    definition: { name: `self_wiki_${serverId.replaceAll('-', '')}`, serverId },
    get initialized() { return initialized; },
    begin(value) { turn = value; }, end() { turn = undefined; },
    async request(params) {
      if (params.serverId !== serverId) throw new Error('应用工具服务器不匹配');
      const message = params.message;
      if (!message || message.jsonrpc !== '2.0') throw new Error('应用工具消息无效');
      const result = value => ({ jsonrpc: '2.0', id: message.id, result: value });
      if (message.method === 'initialize') { initialized = true; return result({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'self-wiki', version: '1' } }); }
      if (message.method?.startsWith('notifications/')) return {};
      if (message.method === 'ping') return result({});
      if (message.method === 'tools/list') return result({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      if (message.method !== 'tools/call' || !turn || !tools.some(tool => tool.name === message.params?.name)) throw new Error('此工具不属于活动轮次或声明范围');
      const current = turn;
      try {
        const value = await call({ ...current, callId: `sdk:${sequence++}`, name: message.params.name, input: message.params.arguments || {} });
        if (turn !== current) throw new Error('工具轮次已结束');
        return result({ content: Array.isArray(value?.content) ? value.content : [{ type: 'text', text: JSON.stringify(value) }] });
      } catch (error) { return result({ content: [{ type: 'text', text: error.message }], isError: true }); }
    },
  };
}
