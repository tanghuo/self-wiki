import { codexCli } from "./codexCli.js";

export function executorFor(type) {
  if (type === "codex-cli") return codexCli;
  throw new Error(`不支持的执行器：${type}`);
}
