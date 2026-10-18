import { startCodexAppServer } from "./codexAppServer.js";
import { codexAuthError, isCodexAuthError, localCodexAuth, rejectLocalCodexAuth } from "./codexLocalAuth.js";

// Isolated, ephemeral structured turns use the same external-auth channel as
// chat. No model tools or dynamic tools are available to background analysis.
export async function codexStructured({ config, signal, cwd, prompt, images, schema, model, onEvent, onUsage }) {
  let client, threadId, text = "", usage;
  const completion = Promise.withResolvers();
  // Startup/turn RPCs may still be pending when the process exits.
  void completion.promise.catch(() => {});
  const auth = await localCodexAuth(config);
  const abort = () => completion.reject(Object.assign(new Error("执行已取消或超时"), {
    code: signal?.reason?.name === "TimeoutError" ? "TIMEOUT" : "CANCELLED", retryable: signal?.reason?.name === "TimeoutError",
  }));
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    client = await startCodexAppServer(config, { cwd, signal, restricted: true, onExit: completion.reject,
      onNotification(method, params) {
        onEvent?.({ type: method });
        if (!threadId || params.threadId !== threadId) return;
        if (method === "item/completed" && params.item?.type === "agentMessage") text = params.item.text || "";
        if (method === "thread/tokenUsage/updated") {
          const total = params.tokenUsage?.total;
          if (total) { usage = { input_tokens: total.inputTokens, output_tokens: total.outputTokens, cached_input_tokens: total.cachedInputTokens }; onUsage?.(usage); }
        }
        if (method === "turn/completed") {
          if (params.turn.status === "completed") completion.resolve();
          else if (isCodexAuthError(params.turn.error?.message)) { rejectLocalCodexAuth(auth); completion.reject(codexAuthError()); }
          else completion.reject(Object.assign(new Error("Codex 执行失败，请检查模型与网络"), { code: "EXECUTOR_ERROR", retryable: true }));
        }
      },
    });
    const started = await client.request("thread/start", { cwd, model, ephemeral: true, sandbox: "read-only", approvalPolicy: "never" });
    threadId = started.thread.id;
    await client.request("turn/start", { threadId, model, outputSchema: schema,
      input: [{ type: "text", text: prompt }, ...images.map((path) => ({ type: "localImage", path }))] });
    await completion.promise;
    return { text, usage };
  } finally {
    signal?.removeEventListener("abort", abort);
    await client?.close();
  }
}
