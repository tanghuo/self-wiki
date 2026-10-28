import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

// A session-local MCP endpoint. All business operations still execute in the
// application's existing tool handler; the bearer grants access to this session only.
export async function createGrokTools(onToolCall) {
  const token = randomBytes(32).toString("hex");
  let tools = [], current;
  const server = createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization || ""), expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401); res.end(); return; }
    if (req.method !== "POST" || req.url !== "/mcp") { res.writeHead(405); res.end(); return; }
    let message;
    function respond(result, error) {
      if (res.destroyed) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message?.id ?? null, ...(error ? { error: { code: -32602, message: error.message } } : { result }) }));
    }
    try {
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 256 * 1024) throw new Error("MCP 请求超过限制"); chunks.push(chunk); }
      message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (message.id === undefined) { res.writeHead(202); res.end(); return; }
      if (message.method === "initialize") return respond({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "self-wiki", version: "1" } });
      if (message.method === "ping") return respond({});
      if (message.method === "tools/list") return respond({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      if (message.method !== "tools/call" || !current || !tools.some((tool) => tool.name === message.params?.name)) throw new Error("工具调用不属于活动会话");
      const turn = current;
      const result = await onToolCall({ threadId: turn.threadId, turnId: turn.turnId, callId: `grok-mcp:${String(message.id)}:${turn.sequence++}`,
        tool: message.params.name, arguments: message.params.arguments });
      if (current !== turn) throw new Error("本轮工具调用已结束");
      const content = result.contentItems.map((item) => {
        if (item.type === "inputImage") {
          const match = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(item.imageUrl);
          if (match) return { type: "image", mimeType: match[1], data: match[2] };
          throw new Error("不支持的工具图片结果");
        }
        return { type: "text", text: item.text || "" };
      });
      respond({ content, isError: !result.success });
    } catch (error) { respond(undefined, error); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    definition: { name: "self_wiki", type: "http", url: `http://127.0.0.1:${server.address().port}/mcp`, headers: [{ name: "Authorization", value: `Bearer ${token}` }] },
    configure(value) { tools = value; },
    begin(threadId, turnId) { current = { threadId, turnId, sequence: 0 }; },
    end() { current = undefined; },
    async close() { current = undefined; server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}
