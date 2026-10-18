import { elementError } from "./elements.js";
import { comfyuiConfig, defaultComfyuiConfig } from "./comfyui.js";

// Native images are produced inside the model session. Tool executors are
// called by the application and describe their inputs with their own schema.
export const imageExecutors = [
  { id: "codex-cli", label: "Codex CLI", mode: "native", directInput: false },
  { id: "chatgpt-web", label: "ChatGPT 网页版", mode: "tool", directInput: true },
  { id: "comfyui", label: "ComfyUI", mode: "tool", directInput: true },
];

export function imageExecutorDefinition(id = "codex-cli") {
  const definition = imageExecutors.find((entry) => entry.id === id);
  if (!definition) throw elementError("不支持的生图执行器");
  return definition;
}

export function defaultImageGenerationConfig() {
  return { executor: "codex-cli", chatgptWeb: { python: "python", browser: "chrome-use", profile: "relay" }, comfyui: defaultComfyuiConfig() };
}

export function imageGenerationConfig(value = defaultImageGenerationConfig()) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["executor", "chatgptWeb", "comfyui"].includes(key))
      || !imageExecutors.some((entry) => entry.id === value.executor)) throw elementError("请选择有效的生图执行器");
  const web = value.chatgptWeb;
  if (!web || typeof web !== "object" || Array.isArray(web) || Object.keys(web).some((key) => !["python", "browser", "profile"].includes(key))
      || ["python", "browser", "profile"].some((key) => typeof web[key] !== "string" || !web[key].trim() || web[key].length > 1000 || /[\r\n\0]/.test(web[key]))) {
    throw elementError("请检查网页版生图的 Python、chrome-use 程序和浏览器配置名称");
  }
  const comfyui = comfyuiConfig(value.comfyui);
  return { executor: value.executor, chatgptWeb: Object.fromEntries(Object.entries(web).map(([key, entry]) => [key, entry.trim()])), comfyui };
}
