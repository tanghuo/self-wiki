import { elementError } from "./elements.js";
import { validExecutable } from "./executablePath.js";

export const chatEngines = [{ id: "codex", label: "Codex" }, { id: "grok-build", label: "Grok Build" }];
export const defaultChatEngineConfig = () => ({ engine: "codex", grokBuild: { executable: "grok", model: "grok-4.6" } });
export function chatEngineConfig(value = defaultChatEngineConfig()) {
  const grok = value?.grokBuild;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["engine", "grokBuild"].includes(key))
      || !chatEngines.some((entry) => entry.id === value.engine) || !grok || typeof grok !== "object" || Array.isArray(grok)
      || Object.keys(grok).some((key) => !["executable", "model"].includes(key)) || !validExecutable(grok.executable)
      || /\.(?:cmd|bat)$/i.test(grok.executable.trim()) || typeof grok.model !== "string" || !/^[\w.-]{1,100}$/.test(grok.model)) throw elementError("无效的聊天引擎或 Grok 程序、模型配置");
  return { engine: value.engine, grokBuild: { executable: grok.executable.trim(), model: grok.model } };
}

export function chatEngineLabel(engine = "codex") { return chatEngines.find((entry) => entry.id === engine)?.label || engine; }

export function effectiveChatImageOptions(options, engine) {
  return engine === "grok-build" && options?.executor === "codex-cli" && !options.direct ? { ...options, executor: "grok-build" } : options;
}
