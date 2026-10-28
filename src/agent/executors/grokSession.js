import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { startGrokAcp } from "./grokProcess.js";
import { createGrokTools } from "./grokTools.js";
import { acquireExternalResource } from './resourceGate.js';

const inside = (root, file) => { const rel = path.relative(root, file); return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };

export async function openGrokSession(config, { cwd, signal, onEvent, onToolCall, onExit, restrictedText = false }) {
  const settings = config.chat.grokBuild;
  let client, current, bridge, notifications = Promise.resolve(), processing = Promise.resolve(), closePromise, catalog = [], thread, bridgeTools = [], threadSignature;
  const calls = new Map();
  function enqueue(event) { notifications = notifications.then(() => onEvent(event)); return notifications; }
  function modelList(values = []) {
    return values.map((entry) => ({ id: entry.modelId, model: entry.modelId, displayName: entry.name || entry.modelId,
      description: entry.description || "", isDefault: entry.modelId === settings.model,
      supportedReasoningEfforts: (entry._meta?.reasoningEfforts || []).map((effort) => ({ reasoningEffort: effort.value || effort.id, description: effort.description || effort.label || effort.id })),
      defaultReasoningEffort: entry._meta?.reasoningEffort || "" }));
  }
  async function update(method, params) {
    if (method !== "session/update" || !current || params.sessionId !== thread) return;
    const turn = current, value = params.update;
    const base = { threadId: thread, turnId: turn.id, progress: true };
    if (value.sessionUpdate === "agent_message_chunk" && value.content?.type === "text") {
      await enqueue({ ...base, type: "text-delta", id: turn.messageId, text: value.content.text }); return;
    }
    if (!["tool_call", "tool_call_update"].includes(value.sessionUpdate)) return;
    const previous = calls.get(value.toolCallId) || {};
    const item = { ...previous, ...Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null && field !== undefined)) };
    calls.set(value.toolCallId, item);
    const name = item._meta?.["x.ai/tool"]?.name || item.toolName || item.title?.split(":")[0] || "tool";
    const dynamicName = turn.tools.find((tool) => name === tool.name || name.endsWith(`__${tool.name}`))?.name;
    const image = ["image_gen", "image_edit", "imagine", "imagine-edit"].includes(name) || item.kind === "image_gen";
    const state = item.status === "failed" ? "failed" : item.status === "completed" ? "completed" : "running";
    if (image && state === "failed") turn.imageFailed = true;
    const input = item.rawInput || {}, output = item.rawOutput;
    const tool = { id: `grok:${item.toolCallId}`, toolType: image ? "imageGeneration" : "mcpToolCall", dynamicName,
      label: image ? name === "image_edit" || name === "imagine-edit" ? "编辑图片 · Grok Build" : "生成图片 · Grok Build" : name,
      state, trace: { type: image ? "imageGeneration" : "mcpToolCall", observedVia: "Grok ACP 事件", input,
        output: { status: item.status, ...(output && { result: output }) } },
      ...(image && { parameters: { prompt: input.prompt, aspectRatio: input.aspect_ratio, executor: "grok-build" } }),
      ...(state === "failed" && { error: "Grok 工具执行失败，请查看本机 Grok 会话；不会自动重发" }),
    };
    if (image && state === "completed" && !previous.imageCopied) {
      try {
        if (typeof output?.path !== "string") throw new Error("未返回图片路径");
        const source = await realpath(output.path);
        const sessions = await realpath(path.join(process.env.GROK_HOME || path.join(homedir(), ".grok"), "sessions"));
        const parts = path.relative(sessions, source).split(path.sep);
        if (!inside(sessions, source) || parts.at(-3) !== thread || parts.at(-2) !== "images" || (await stat(source)).size > 25 * 1024 * 1024) throw new Error("图片不属于本次 Grok 会话或超过大小限制");
        const local = path.join(cwd, `grok-result-${randomUUID()}${path.extname(source)}`);
        await writeFile(local, await readFile(source), { flag: "wx" });
        tool.image = { savedPath: local }; item.imageCopied = true;
      } catch (error) { turn.imageFailed = true; tool.state = "failed"; tool.error = `Grok 图片取回失败：${error.message}`; }
    }
    await enqueue({ ...base, type: "tool", tool });
  }
  async function close() {
    if (closePromise) return closePromise;
    current?.release?.(); current = undefined; bridge?.end();
    closePromise = (async () => { await client?.close(); await bridge?.close(); })();
    return closePromise;
  }
  try {
    bridge = await createGrokTools(onToolCall);
    client = await startGrokAcp(settings, { cwd, signal, onNotification(method, params) {
      // Serialize image copy and tool updates before completion, including replay events.
      processing = processing.then(() => update(method, params));
      return processing;
    }, onRequest(method, params) {
      method = method.replace(/^_/, "");
      if (method === "x.ai/hooks/run") {
        if (restrictedText) { if (current) current.policyError = '受限模型节点拒绝工具调用'; return { decision: 'deny', reason: '此会话仅允许文字输出，所有工具均已禁用。' }; }
        const name = params.toolName || params.tool_name;
        const input = params.toolInput || params.tool_input || {};
        const allowed = current && params.sessionId === thread && (
          name === "search_tool" || ["image_gen", "image_edit"].includes(name) && current.nativeImages && !current.imageFailed
          || current.tools.some((tool) => name === `self_wiki__${tool.name}` || name === `mcp__self_wiki__${tool.name}`)
          || name === "use_tool" && current.tools.some((tool) => input.tool_name === `self_wiki__${tool.name}`));
        if (allowed && ++current.hookCalls <= 40) return { decision: "continue" };
        return { decision: "deny", reason: "本接入仅允许图片工具和 self_wiki 应用工具。请通过 search_tool 查找应用工具，不要调用原生 Shell、读写文件、其他 MCP、子 agent 或重复失败的图片任务。" };
      }
      if (method !== "session/request_permission" || !current || params.sessionId !== thread) throw new Error("Unsupported client request");
      if (restrictedText) { current.policyError = '受限模型节点拒绝工具调用'; return { outcome: { outcome: 'cancelled' } }; }
      const call = params.toolCall || {}, name = call._meta?.["x.ai/tool"]?.name || call.toolName || "";
      const target = call.rawInput?.tool_name;
      const allowed = ["image_gen", "image_edit"].includes(name) && current.nativeImages
        || current.tools.some((tool) => name === tool.name || name === `mcp__self_wiki__${tool.name}` || name === `self_wiki__${tool.name}`
          || name === "use_tool" && target === `self_wiki__${tool.name}`);
      const option = params.options?.find((entry) => entry.kind === (allowed ? "allow_once" : "reject_once"));
      return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
    }, onExit(error) { current?.release?.(); onExit(error); } });
    const init = await client.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "self-wiki", version: "0.2.0" } });
    if (!init.agentCapabilities?.promptCapabilities?.image || !init.agentCapabilities?.mcpCapabilities?.http
        || !init.agentCapabilities?._meta?.["x.ai/hooks"]?.blockingEvents?.includes("pre_tool_use")) throw new Error("此 Grok Build 不支持所需的图片、HTTP MCP 或客户端工具门禁，请更新本机 CLI");
    if (!init.authMethods?.some((entry) => entry.id === "cached_token")) throw new Error("Grok 未提供本机登录认证，请先运行 grok login");
    await client.request("authenticate", { methodId: "cached_token", _meta: { headless: true } });
    catalog = modelList(init._meta?.modelState?.availableModels);
    return {
      available: true, engine: "grok-build", version: init._meta?.agentVersion || "Grok Build", defaultModel: settings.model, defaultEffort: "",
      models: async () => catalog, close,
      async openThread({ model, instructions, tools, continuation, onRequest }) {
        if (restrictedText && (tools?.length || continuation)) throw new Error('受限模型节点不接受工具或会话继续');
        const nativeImages = !restrictedText && ["grok-build", "codex-cli"].includes(config.imageGeneration?.executor);
        const signature = createHash("sha256").update(JSON.stringify({ instructions, tools, nativeImages })).digest("hex");
        const previous = continuation?.previousRequest;
        const resumed = Boolean(continuation?.threadId && previous?.chatEngine === "grok-build" && previous.grokSignature === signature
          && previous.turn?.params?.threadId === continuation.threadId && previous.turn?.delivery === "acknowledged");
        bridge.configure(tools);
        bridgeTools = tools;
        const request = { method: resumed ? "session/load" : "session/new", params: { cwd,
          ...(resumed && { sessionId: continuation.threadId }), mcpServers: [bridge.definition],
          _meta: { rules: instructions, yoloMode: false, autoMode: false,
            "x.ai/hooks": { pre_tool_use: [{ hookCallbackIds: ["self-wiki-tools"], timeout: 10 }] } } }, delivery: "attempted" };
        // Keep the local bridge bearer out of persisted request records.
        const publicRequest = { ...request, params: { cwd, model, developerInstructions: instructions, ...(resumed && { sessionId: continuation.threadId }), mcpServers: [{ name: "self_wiki", transport: "local HTTP" }] } };
        onRequest(publicRequest,
          { contextFormat: "content-only", contextMode: resumed ? "resumed" : "replayed", chatEngine: "grok-build", grokSignature: signature });
        const result = resumed && thread === continuation.threadId && threadSignature === signature ? { sessionId: thread } : await client.request(request.method, request.params, 60000);
        thread = resumed ? continuation.threadId : result.sessionId;
        publicRequest.delivery = "acknowledged"; threadSignature = signature;
        if (!thread) throw new Error("Grok 未返回会话编号");
        if (result.models?.availableModels) catalog = modelList(result.models.availableModels);
        await client.request("session/set_config_option", { sessionId: thread, configId: "model", value: model });
        return { id: thread, resumed, logPath: null };
      },
      async startTurn({ threadId, model, effort, text, attachments, onRequest }) {
        if (current) throw new Error("Grok 会话已有运行中的请求");
        if (threadId !== thread) throw new Error("Grok 会话编号不匹配");
        if (effort) await client.request("session/set_config_option", { sessionId: thread, configId: "reasoning_effort", value: effort });
        const id = randomUUID(), prompt = [{ type: "text", text }];
        for (const attachment of attachments) {
          let url = attachment.url;
          if (attachment.type === "localImage") {
            const file = await realpath(attachment.path), root = await realpath(cwd);
            if (!inside(root, file) || (await stat(file)).size > 25 * 1024 * 1024) throw new Error("Grok 图片附件不在当前会话目录内或超过限制");
            const bytes = await readFile(file);
            url = `data:image/png;base64,${bytes.toString("base64")}`;
          }
          const match = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url || "");
          if (!match) throw new Error("无效的 Grok 图片附件");
          prompt.push({ type: "image", mimeType: match[1], data: match[2] });
        }
        const tools = bridgeTools;
        const release = await acquireExternalResource('grok', signal);
        if (closePromise) { release(); throw new Error('Grok 会话已关闭'); }
        current = { id, tools, release, hookCalls: 0, messageId: `grok-message-${id}`, nativeImages: !restrictedText && ["grok-build", "codex-cli"].includes(config.imageGeneration?.executor) };
        calls.clear(); bridge.begin(thread, id);
        onRequest({ method: "session/prompt", params: { threadId, model, effort, input: [{ type: "text", text }, ...attachments] }, delivery: "attempted" });
        await onEvent({ type: "turn-started", threadId, turnId: id, progress: true });
        const turn = current;
        void client.request("session/prompt", { sessionId: thread, prompt }, 1800000).then(async (result) => {
          await processing; await notifications;
          if (current !== turn) return;
          turn.release();
          current = undefined; bridge.end();
          await onEvent({ type: "turn-completed", threadId, turnId: id,
            state: turn.policyError ? 'failed' : result.stopReason === "end_turn" ? "completed" : result.stopReason === "cancelled" ? "interrupted" : "failed",
            ...(turn.policyError ? { error: turn.policyError } : result.stopReason !== "end_turn" && { error: `Grok 已结束：${result.stopReason}` }) });
        }, async (error) => {
          await processing.catch(() => {}); await notifications.catch(() => {});
          if (current !== turn) return;
          turn.release();
          current = undefined; bridge.end();
          await onEvent({ type: "turn-completed", threadId, turnId: id, state: "failed", error: turn.policyError || `${error.message}；请求状态可能未知，不会自动重发` });
        }).catch((error) => onExit(error));
        return { id };
      },
      async interrupt(threadId) { bridge.end(); client.notify("session/cancel", { sessionId: threadId }); },
    };
  } catch (error) { await close(); throw error; }
}
