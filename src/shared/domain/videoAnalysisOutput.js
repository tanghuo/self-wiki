import { elementError, elementTags, maxTagLength } from "./elements.js";

export const videoAnalysisOutputSchema = {
  type: "object", additionalProperties: false, required: ["observations"], properties: {
    observations: { type: "array", maxItems: 24, items: {
      type: "object", additionalProperties: false, required: ["frameIds", "body", "tags"], properties: {
        frameIds: { type: "array", minItems: 1, maxItems: 8, items: { type: "integer", minimum: 1 } },
        body: { type: "string", minLength: 1, maxLength: 2000 },
        tags: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: maxTagLength } },
      },
    } },
  },
};

export function videoAnalysisOutput(value) {
  const invalid = () => { throw elementError("视频分析结果无效"); };
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "observations") ||
      !Array.isArray(value.observations) || value.observations.length > 24) invalid();
  return { observations: value.observations.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !["frameIds", "body", "tags"].includes(key)) ||
        !Array.isArray(item.frameIds) || !item.frameIds.length || item.frameIds.length > 8 || item.frameIds.some((id) => !Number.isSafeInteger(id) || id < 1) ||
        typeof item.body !== "string" || !item.body.trim() || item.body.length > 2000 || /\0/.test(item.body) ||
        !Array.isArray(item.tags) || item.tags.length > 12) invalid();
    return { frameIds: [...new Set(item.frameIds)], body: item.body.trim(), tags: elementTags(item.tags) };
  }) };
}
