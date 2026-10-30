import { codexCli } from "./codexCli.js";
import { grokOrganization } from "./grokOrganization.js";

export function executorFor(type) {
  if (type === "codex-cli") return codexCli;
  if (type === "grok-build") return grokOrganization;
  throw new Error(`不支持的执行器：${type}`);
}
