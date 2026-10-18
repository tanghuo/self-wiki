import { chatgptWebImageExecutor } from "../../agent/executors/chatgptWeb.js";
import { comfyuiImageExecutor } from "../../agent/executors/comfyui.js";
import { imageExecutorDefinition } from "../../shared/domain/imageGeneration.js";

// Static registration keeps backend configuration and persisted continuation
// state out of chat orchestration. Adapters never receive a repository handle.
const toolExecutors = {
  comfyui: { adapter: comfyuiImageExecutor, configKey: "comfyui" },
  "chatgpt-web": {
    adapter: chatgptWebImageExecutor,
    configKey: "chatgptWeb",
    continuation(repo, sessionId) {
      const revision = repo.session(sessionId).branchRevision;
      return {
        read: () => repo.webConversation(sessionId, revision),
        save: (url) => repo.bindWebConversation(sessionId, revision, url),
      };
    },
  },
};

// Native executors intentionally have no standalone generate/probe methods;
// their lifecycle and diagnostics belong to the model session.
export function createChatImageExecutor(config, { repo, sessionId, direct = false, explicit = false } = {}) {
  // Existing direct turns explicitly target the web backend, independently of
  // the normal image setting. Keep this policy at the selection boundary.
  const definition = imageExecutorDefinition(direct && !explicit ? "chatgpt-web" : config.executor);
  if (definition.mode === "native") return { ...definition };
  const registration = toolExecutors[definition.id], { adapter } = registration;
  const settings = structuredClone(config[registration.configKey]);
  return {
    ...definition, tool: adapter.tool, instructions: adapter.instructions,
    probe: (workspace) => adapter.probe(settings, workspace),
    generate(value, options) {
      if (options.verbatim && !definition.directInput) throw new Error("此生图执行器不支持原文直发");
      options.signal?.throwIfAborted();
      return adapter.generate(value, { ...options, config: settings, continuation: registration.continuation?.(repo, sessionId) });
    },
  };
}
