import { chatgptWebImageExecutor, comfyuiImageExecutor, grokBuildImageExecutor } from "../executorsPort.js";
import { imageExecutorDefinition } from "../../../shared/domain/imageGeneration.js";

// Static registration keeps backend configuration and persisted continuation
// state out of chat orchestration. Adapters never receive a repository handle.
const toolExecutors = {
  "grok-build": { adapter: grokBuildImageExecutor, configKey: "grokBuild" },
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
export function createChatImageExecutor(config, { repo, sessionId, direct = false, explicit = false, nativeGrok = false } = {}) {
  // Existing direct turns explicitly target the web backend, independently of
  // the normal image setting. Keep this policy at the selection boundary.
  const definition = imageExecutorDefinition(direct && !explicit ? "chatgpt-web" : config.executor);
  if (nativeGrok && ["codex-cli", "grok-build"].includes(definition.id)) return { id: "grok-build", label: "Grok Build", mode: "native",
    instructions: `本轮在同一个 Grok 会话内生图。文生图调用 image_gen，改图调用 image_edit 并引用待编辑图片；连续改图优先引用当前分支上一张生成结果。未指定比例时使用 ${config.grokBuild?.aspectRatio || "auto"}。每次调用只生成一张，失败不自动重发。应用会取回并展示图片，回复无需重复嵌入。选区图片只是位置指示，不是蒙版。没有种子、批量张数或精确尺寸参数。` };
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
