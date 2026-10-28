import { elementError, elementId, elementTags, relationName, relationSemantics } from "./elements.js";
import { defaultEmbeddingConfig, embeddingConfig } from "./embedding.js";
import { defaultImageGenerationConfig, imageGenerationConfig } from "./imageGeneration.js";
import { isNetworkPath, validExecutable } from "./executablePath.js";
import { defaultChatEngineConfig, chatEngineConfig } from "./chatEngine.js";

export function defaultOrganizationConfig() {
  return { schemaVersion: 1, enabled: false, applyMode: "suggest", executor: {
    type: "codex-cli", timeoutMs: 180000, codexCli: { executable: "codex", codexHome: null, model: null },
  }, embedding: defaultEmbeddingConfig(), imageGeneration: defaultImageGenerationConfig(), chat: defaultChatEngineConfig() };
}

function object(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw elementError("自动整理配置或请求包含无效字段");
  }
}

export function organizationConfig(value) {
  object(value, ["schemaVersion", "enabled", "applyMode", "executor", "embedding", "imageGeneration", "chat"]);
  object(value.executor, ["type", "timeoutMs", "codexCli"]);
  object(value.executor.codexCli, ["executable", "codexHome", "model", "allowShell"]);
  const { executor } = value, { executable, codexHome, model, allowShell } = executor.codexCli;
  if (value.schemaVersion !== 1 || typeof value.enabled !== "boolean" || !["suggest", "auto"].includes(value.applyMode) ||
      executor.type !== "codex-cli" || !Number.isInteger(executor.timeoutMs) || executor.timeoutMs < 1000 || executor.timeoutMs > 1800000 ||
      !validExecutable(executable) ||
      !(codexHome === null || typeof codexHome === "string" && /^(?:[A-Za-z]:[\\/]|\/)/.test(codexHome) && !isNetworkPath(codexHome) && !/[\r\n\0]/.test(codexHome)) ||
      !(model === null || typeof model === "string" && /^[\w./:-]{1,160}$/.test(model)) ||
      !(allowShell === undefined || typeof allowShell === "boolean")) {
    throw elementError("请检查自动整理版本、模式、执行器与 Codex 目录路径（须为本机路径，不支持 \\\\服务器 网络路径）、模型及超时（1000–1800000 毫秒）");
  }
  return { ...structuredClone(value), embedding: embeddingConfig(value.embedding === undefined ? defaultEmbeddingConfig() : value.embedding), imageGeneration: imageGenerationConfig(value.imageGeneration), chat: chatEngineConfig(value.chat) };
}

const evidenceSchema = { type: "object", additionalProperties: false, required: ["kind", "elementId", "quote", "reason"], properties: {
  kind: { type: "string", enum: ["text", "visual", "inference"] }, elementId: { type: "integer" },
  quote: { type: "string" }, reason: { type: "string" },
} };
export const organizationOutputSchema = {
  type: "object", additionalProperties: false, required: ["summary", "tagAdds", "relationAdds", "queries", "imageRequests"], properties: {
    summary: { type: "string" }, queries: { type: "array", items: { type: "string" } },
    imageRequests: { type: "array", items: { type: "integer" } },
    tagAdds: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "evidence"],
      properties: { name: { type: "string" }, evidence: evidenceSchema } } },
    relationAdds: { type: "array", items: { type: "object", additionalProperties: false, required: ["targetId", "name", "direction", "reverseName", "evidence"],
      properties: { targetId: { type: "integer" }, name: { type: "string" }, direction: { type: "string", enum: ["symmetric", "forward", "reverse"] }, reverseName: { type: "string" }, evidence: evidenceSchema } } },
  },
};

export function organizationOutput(value) {
  object(value, ["summary", "tagAdds", "relationAdds", "queries", "imageRequests"]);
  const imageRequests = value.imageRequests ?? [];
  if (!Array.isArray(imageRequests) || imageRequests.length > 8 || imageRequests.some((id) => !Number.isSafeInteger(id) || id < 1)) throw elementError("待查看图片无效");
  if (typeof value.summary !== "string" || value.summary.length > 2000 || !Array.isArray(value.tagAdds) || value.tagAdds.length > 20 ||
      !Array.isArray(value.relationAdds) || value.relationAdds.length > 20 || !Array.isArray(value.queries) || value.queries.length > 3 ||
      value.queries.some((q) => typeof q !== "string" || !q.trim() || q.length > 80)) throw elementError("整理结果格式或数量无效");
  const evidence = (entry) => {
    object(entry, ["kind", "elementId", "quote", "reason"]);
    if (!["text", "visual", "inference"].includes(entry.kind) || typeof entry.quote !== "string" || entry.quote.length > 1000 ||
        typeof entry.reason !== "string" || !entry.reason.trim() || entry.reason.length > 1000) throw elementError("整理依据无效");
    return { ...entry, elementId: elementId(entry.elementId) };
  };
  return { summary: value.summary, queries: value.queries, imageRequests: [...new Set(imageRequests)], tagAdds: value.tagAdds.map((item) => {
    object(item, ["name", "evidence"]);
    return { name: elementTags([item.name])[0], evidence: evidence(item.evidence) };
  }), relationAdds: value.relationAdds.map((item) => {
    object(item, ["targetId", "name", "direction", "reverseName", "evidence"]);
    const name = relationName(item.name);
    if (!name) throw elementError("自动关联需要明确名称");
    return { targetId: elementId(item.targetId), name, ...relationSemantics(item), evidence: evidence(item.evidence) };
  }) };
}
