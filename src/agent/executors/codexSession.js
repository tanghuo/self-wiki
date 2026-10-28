import { chatShellAllowed, startCodexAppServer } from "./codexAppServer.js";
import { imageErrorMessage } from "./codexImageErrors.js";
import { imageExecutorDefinition } from "../../shared/domain/imageGeneration.js";

const toolLabels = { imageGeneration: "生成图片", webSearch: "联网搜索", commandExecution: "执行命令", fileChange: "修改文件", mcpToolCall: "调用插件", dynamicToolCall: "调用工具", collabAgentToolCall: "协作任务", browserToolCall: "浏览网页" };

export function codexToolTrace(item) {
  const inputKeys = {
    commandExecution: ["command", "cwd"],
    imageGeneration: ["prompt", "model", "size", "quality", "background", "seed", "transparentBackground", "referencedImagePaths", "numLastImagesToInclude"],
    mcpToolCall: ["server", "tool", "arguments"],
    dynamicToolCall: ["namespace", "tool", "arguments"],
    webSearch: ["query", "action"],
    fileChange: ["changes"],
    collabAgentToolCall: ["tool", "prompt", "model", "reasoningEffort", "senderThreadId", "receiverThreadIds"],
    browserToolCall: ["tool", "arguments"],
  }[item.type] || ["arguments"];
  const record = { type: item.type, observedVia: "CLI 事件", input: {}, output: {} };
  for (const key of inputKeys) if (item[key] !== undefined && item[key] !== null) record.input[key] = item[key];
  for (const key of ["status", "error", "failure", "revisedPrompt", "aggregatedOutput", "exitCode", "durationMs", "contentItems", "results", "savedPath", "success"]) {
    if (item[key] !== undefined && item[key] !== null) record.output[key] = item[key];
  }
  if (item.result !== undefined && item.result !== null && item.result !== "") {
    record.output.result = item.type === "imageGeneration" ? `data:image/png;base64,${item.result.replace(/^data:image\/[^;]+;base64,/, "")}` : item.result;
  }
  return record;
}

function sessionEvent(method, params) {
  const event = { threadId: params.threadId, turnId: params.turnId || params.turn?.id,
    progress: method.startsWith("item/") || method === "turn/started" };
  if (method === "thread/tokenUsage/updated") return { ...event, type: "usage", usage: params.tokenUsage };
  if (method === "turn/started") return { ...event, type: "turn-started" };
  if (method === "item/agentMessage/delta") return { ...event, type: "text-delta", id: params.itemId, text: params.delta };
  if (method === "error" && !params.willRetry) return { ...event, type: "error", error: String(params.error?.message || "模型调用失败").slice(0, 1000) };
  if (method === "turn/completed") return { ...event, type: "turn-completed", error: params.turn.error?.message,
    state: params.turn.status === "interrupted" ? "interrupted" : params.turn.status === "completed" ? "completed" : "failed" };
  const item = params.item, completed = method === "item/completed";
  if (completed && item?.type === "agentMessage") return { ...event, type: "text-completed", id: item.id, text: item.text || "" };
  if (["item/started", "item/completed"].includes(method) && item && toolLabels[item.type]) {
    const tool = { id: `codex:${item.id}`, toolType: item.type, label: toolLabels[item.type],
      dynamicName: item.type === "dynamicToolCall" ? item.tool : null, trace: codexToolTrace(item),
      state: completed ? item.error || item.failure || ["failed", "declined", "cancelled"].includes(item.status) ? "failed" : "completed" : "running" };
    if (item.type === "imageGeneration") {
      tool.parameters = {};
      for (const key of ["prompt", "revisedPrompt", "model", "size", "quality", "background", "seed"]) {
        const value = item[key];
        if (typeof value === "string" && value.length <= 12000 || typeof value === "number" && Number.isFinite(value)) tool.parameters[key] = value;
      }
      if (completed && tool.state === "completed") {
        tool.image = item.result && /^(?:data:image\/\w+;base64,)?[A-Za-z0-9+/=\r\n]+$/.test(item.result)
          ? { bytes: Buffer.from(item.result.replace(/^data:image\/\w+;base64,/, ""), "base64") } : { savedPath: item.savedPath };
      }
    }
    if (tool.state === "failed") tool.error = item.type === "imageGeneration" ? imageErrorMessage(item.failure || item.error)
      : String(item.error?.message || item.error || (item.type === "commandExecution" && item.aggregatedOutput?.trim()) || "工具执行失败，未返回具体原因。").slice(0, 1000);
    return { ...event, type: "tool", tool };
  }
  return { ...event, type: "progress" };
}

// The application owns business state and receives only session events. Raw
// requests remain available to its bounded audit recorder, not as executable API.
export async function openCodexSession(config, { cwd, signal, onEvent, onToolCall, onExit }) {
  const client = await startCodexAppServer(config, { cwd, signal, onToolCall, onExit,
    onNotification: (method, params) => onEvent(sessionEvent(method, params)) });
  const imageExecutor = imageExecutorDefinition(config.imageGeneration?.executor);
  const toolsetVersion = imageExecutor.mode === "tool" ? 2 : 1;
  return {
    available: Boolean(client.account.account) || client.account.requiresOpenaiAuth === false,
    version: client.version, defaultModel: client.defaultModel, defaultEffort: client.defaultEffort,
    models: client.models, close: client.close,
    async openThread({ model, instructions, tools, ephemeral, continuation, onRequest }) {
      const previous = continuation?.previousRequest;
      // The installed CLI cannot replace dynamic tools on thread/resume.
      const resumed = Boolean(continuation?.threadId && previous?.contextFormat === "content-only"
        && (previous.imageExecutor || "codex-cli") === imageExecutor.id
        && previous.toolsetVersion === toolsetVersion && previous.turn?.params?.threadId === continuation.threadId);
      const options = { cwd, sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: instructions,
        // Sandbox network access only matters for shell commands; keep it with the shell opt-in.
        config: { "sandbox_workspace_write.network_access": chatShellAllowed(config) }, model };
      const request = { method: resumed ? "thread/resume" : "thread/start",
        params: resumed ? { ...options, threadId: continuation.threadId } : { ...options, dynamicTools: tools, ephemeral }, delivery: "attempted" };
      onRequest(request, { contextFormat: "content-only", toolsetVersion, contextMode: resumed ? "resumed" : "replayed" });
      const result = await client.request(request.method, request.params);
      request.delivery = "acknowledged";
      return { id: result.thread.id, logPath: result.thread.path, resumed };
    },
    async startTurn({ threadId, model, effort, text, attachments, onRequest }) {
      const request = { method: "turn/start", params: { threadId, model, ...(effort && { effort }),
        input: [{ type: "text", text }, ...attachments] }, delivery: "attempted" };
      onRequest(request);
      const result = await client.request(request.method, request.params);
      return { id: result.turn.id };
    },
    interrupt(threadId, turnId) { return client.request("turn/interrupt", { threadId, turnId }, 3000); },
  };
}
