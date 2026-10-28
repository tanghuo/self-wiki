import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_TEXT = 1024 * 1024;
const RAW_LIMIT = 100_000;
const TEXT_FIELDS = ["text", "text_g", "text_l", "clip_l", "t5xxl", "prompt"];
const WEBUI_LABELS = {
  Steps: "步数",
  Sampler: "采样器",
  "Schedule type": "调度器",
  "CFG scale": "提示词强度",
  Seed: "种子",
  Size: "尺寸",
  Model: "模型",
  "Denoising strength": "降噪强度",
};

export function readEmbeddedPrompt(bytes) {
  if (!Buffer.isBuffer(bytes)) return { found: false };
  const texts = readPngTexts(bytes);
  if (!texts) return { found: false };
  const comfy = texts.prompt ? parseComfyPrompt(texts.prompt) : null;
  if (comfy) return { found: true, source: "comfyui", sourceLabel: "ComfyUI", hasWorkflow: texts.hasWorkflow, ...comfy, ...cap(texts.prompt) };
  const webui = texts.parameters ? parseWebuiParameters(texts.parameters) : null;
  if (webui) return { found: true, source: "webui", sourceLabel: "Stable Diffusion WebUI", hasWorkflow: false, ...webui, ...cap(texts.parameters) };
  return { found: false };
}

function cap(text) {
  if (text.length <= RAW_LIMIT) return { raw: text, rawTruncated: false };
  return { raw: text.slice(0, RAW_LIMIT), rawTruncated: true };
}

function readPngTexts(bytes) {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const texts = { hasWorkflow: false };
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) break;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IEND") break;
    if (type !== "tEXt" && type !== "zTXt" && type !== "iTXt") continue;
    const entry = decodeTextChunk(type, data);
    if (!entry) continue;
    if (entry.keyword === "workflow") texts.hasWorkflow = true;
    else if ((entry.keyword === "prompt" || entry.keyword === "parameters") && texts[entry.keyword] === undefined) texts[entry.keyword] = entry.text;
  }
  return texts;
}

function decodeTextChunk(type, data) {
  const keyEnd = data.indexOf(0);
  if (keyEnd <= 0 || keyEnd > 79) return null;
  const keyword = data.toString("latin1", 0, keyEnd);
  if (keyword !== "prompt" && keyword !== "parameters" && keyword !== "workflow") return null;
  if (keyword === "workflow") return { keyword, text: "" };
  try {
    if (type === "tEXt") return { keyword, text: decodeBytes(data.subarray(keyEnd + 1)) };
    if (type === "zTXt") {
      if (data[keyEnd + 1] !== 0) return null;
      return { keyword, text: decodeBytes(inflateSync(data.subarray(keyEnd + 2), { maxOutputLength: MAX_TEXT })) };
    }
    return decodeInternational(keyword, data, keyEnd);
  } catch {
    return null;
  }
}

function decodeInternational(keyword, data, keyEnd) {
  if (keyEnd + 4 >= data.length) return null;
  const compression = data[keyEnd + 1];
  const method = data[keyEnd + 2];
  const languageEnd = data.indexOf(0, keyEnd + 3);
  if (languageEnd < 0) return null;
  const translatedEnd = data.indexOf(0, languageEnd + 1);
  if (translatedEnd < 0) return null;
  let text = data.subarray(translatedEnd + 1);
  if (compression === 1) {
    if (method !== 0) return null;
    text = inflateSync(text, { maxOutputLength: MAX_TEXT });
  } else if (compression !== 0) return null;
  return { keyword, text: decodeBytes(text) };
}

function decodeBytes(data) {
  if (data.length > MAX_TEXT) return "";
  const utf8 = data.toString("utf8");
  return Buffer.from(utf8, "utf8").equals(data) ? utf8 : data.toString("latin1");
}

function clean(text) {
  return String(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

function isLink(value) {
  return Array.isArray(value) && value.length >= 2 && (typeof value[0] === "string" || typeof value[0] === "number") && Number.isInteger(value[1]);
}

function isTextEncoder(classType) {
  return /TextEncode|CLIPText/i.test(classType);
}

function isSampler(classType, inputs) {
  if (["KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced"].includes(classType)) return true;
  return /sampler/i.test(classType) && (isLink(inputs.positive) || isLink(inputs.negative));
}

function parseComfyPrompt(raw) {
  let graph;
  try { graph = JSON.parse(raw); } catch { return null; }
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) return null;
  const nodes = Object.entries(graph).filter(([, node]) => node && typeof node === "object" && typeof node.class_type === "string" && node.inputs && typeof node.inputs === "object" && !Array.isArray(node.inputs));
  if (!nodes.length) return null;
  const byId = new Map(nodes);
  const samplers = nodes.filter(([, node]) => isSampler(node.class_type, node.inputs));
  const sections = [];
  const parameters = [];
  const used = new Set();
  samplers.forEach(([, node], index) => {
    const prefix = samplers.length > 1 ? `采样 ${index + 1} · ` : "";
    const positive = collectText(byId, node.inputs.positive, used);
    const negative = collectText(byId, node.inputs.negative, used);
    if (positive) sections.push({ title: `${prefix}正向提示词`, text: positive });
    if (negative) sections.push({ title: `${prefix}负向提示词`, text: negative });
    parameters.push(...samplerParameters(byId, node, prefix));
  });
  for (const [id, node] of nodes) {
    if (used.has(id) || !isTextEncoder(node.class_type)) continue;
    const text = encoderText(byId, node);
    if (text) sections.push({ title: encoderTitle(id, node), text });
  }
  if (!sections.length) return null;
  return { sections, parameters: uniqueParameters(parameters) };
}

function collectText(byId, link, used, seen = new Set(), depth = 0) {
  if (!isLink(link) || depth > 8) return "";
  const id = String(link[0]);
  if (seen.has(id)) return "";
  seen.add(id);
  const node = byId.get(id);
  if (!node) return "";
  if (isTextEncoder(node.class_type)) {
    used.add(id);
    return encoderText(byId, node, link[1]);
  }
  const parts = [];
  for (const value of Object.values(node.inputs)) {
    if (!isLink(value)) continue;
    const text = collectText(byId, value, used, seen, depth + 1);
    if (text) parts.push(text);
  }
  return [...new Set(parts)].join("\n\n");
}

function encoderText(byId, node, slot) {
  const fields = slot === 1
    ? ["negative_prompt"]
    : slot === 0
      ? ["prompt", ...TEXT_FIELDS.filter((field) => field !== "prompt")]
      : ["prompt", "negative_prompt", ...TEXT_FIELDS.filter((field) => field !== "prompt")];
  const parts = [];
  for (const field of fields) {
    if (!(field in node.inputs)) continue;
    const text = resolveText(byId, node.inputs[field]);
    if (text && !parts.includes(text)) parts.push(text);
    if (slot === 0 && field === "prompt" && text) break;
    if (slot === 1) break;
  }
  return parts.join("\n");
}

function resolveText(byId, value, depth = 0, seen = new Set()) {
  if (typeof value === "string") return clean(value);
  if (!isLink(value) || depth > 6) return "";
  const id = String(value[0]);
  if (seen.has(id)) return "";
  seen.add(id);
  const node = byId.get(id);
  if (!node?.inputs) return "";
  for (const key of ["value", "text", "string", "prompt"]) {
    if (!(key in node.inputs)) continue;
    const text = resolveText(byId, node.inputs[key], depth + 1, seen);
    if (text) return text;
  }
  return "";
}

function encoderTitle(id, node) {
  const names = {
    CLIPTextEncode: "文本编码",
    CLIPTextEncodeSDXL: "SDXL 文本编码",
    CLIPTextEncodeSDXLRefiner: "SDXL 精炼文本",
    CLIPTextEncodeFlux: "Flux 文本编码",
  };
  return `${names[node.class_type] || node.class_type} · 节点 ${id}`;
}

function samplerParameters(byId, node, prefix) {
  const items = [];
  const add = (label, value) => {
    if (value === null || value === undefined || value === "") return;
    items.push({ label: `${prefix}${label}`, value: String(value) });
  };
  const loader = findNode(byId, node.inputs.model, (entry) => textInput(entry, "ckpt_name") || textInput(entry, "unet_name"));
  add("模型", loader ? (textInput(loader, "ckpt_name") || textInput(loader, "unet_name")) : null);
  const latent = findNode(byId, node.inputs.latent_image, (entry) => Number.isFinite(entry.inputs.width) && Number.isFinite(entry.inputs.height));
  if (latent) add("尺寸", `${latent.inputs.width}×${latent.inputs.height}`);
  add("采样器", textInput(node, "sampler_name"));
  add("调度器", textInput(node, "scheduler"));
  add("步数", numberInput(node, "steps"));
  add("提示词强度", numberInput(node, "cfg"));
  add("种子", numberInput(node, "seed") ?? numberInput(node, "noise_seed"));
  const denoise = numberInput(node, "denoise");
  if (denoise !== null && denoise !== 1) add("降噪强度", denoise);
  return items;
}

function textInput(node, key) {
  const value = node.inputs[key];
  return typeof value === "string" && value.trim() ? clean(value) : null;
}

function numberInput(node, key) {
  const value = node.inputs[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function findNode(byId, link, predicate, depth = 0, seen = new Set()) {
  if (!isLink(link) || depth > 6) return null;
  const id = String(link[0]);
  if (seen.has(id)) return null;
  seen.add(id);
  const node = byId.get(id);
  if (!node) return null;
  if (predicate(node)) return node;
  for (const value of Object.values(node.inputs)) {
    if (!isLink(value)) continue;
    const found = findNode(byId, value, predicate, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

function uniqueParameters(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.label)) return false;
    seen.add(item.label);
    return true;
  });
}

function parseWebuiParameters(raw) {
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!text) return null;
  const stepsAt = text.search(/\nSteps: |^Steps: /);
  let promptPart = text;
  let settings = "";
  if (stepsAt >= 0) {
    promptPart = text.slice(0, stepsAt).trim();
    settings = text.slice(stepsAt).replace(/^\n/, "").trim();
  }
  let positive = promptPart;
  let negative = "";
  const marker = "Negative prompt:";
  const markerAt = promptPart.startsWith(marker) ? 0 : promptPart.indexOf(`\n${marker}`);
  if (markerAt >= 0) {
    const cut = promptPart.indexOf(marker, markerAt);
    positive = promptPart.slice(0, cut).trim();
    negative = promptPart.slice(cut + marker.length).trim();
  }
  const sections = [];
  positive = clean(positive);
  negative = clean(negative);
  if (positive) sections.push({ title: "正向提示词", text: positive });
  if (negative) sections.push({ title: "负向提示词", text: negative });
  const parameters = parseWebuiSettings(settings);
  if (!sections.length) return null;
  return { sections, parameters };
}

function parseWebuiSettings(line) {
  if (!line.startsWith("Steps:")) return [];
  const parts = line.split(/,\s*(?=[^:,]+:\s)/);
  const parameters = [];
  for (const part of parts) {
    const split = part.indexOf(": ");
    if (split <= 0) continue;
    const label = WEBUI_LABELS[part.slice(0, split).trim()];
    const value = clean(part.slice(split + 2));
    if (label && value) parameters.push({ label, value });
  }
  return uniqueParameters(parameters);
}
