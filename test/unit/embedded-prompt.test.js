import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { readEmbeddedPrompt } from "../../src/server/application/embeddedPrompt.js";
import { pngText, pngWithChunks } from "../pngText.js";

const prompt = {
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } },
  "5": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 768, batch_size: 1 } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "一只白猫", clip: ["4", 1] } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "模糊", clip: ["4", 1] } },
  "10": { class_type: "ConditioningCombine", inputs: { conditioning_1: ["6", 0], conditioning_2: ["11", 0] } },
  "11": { class_type: "CLIPTextEncode", inputs: { text: "窗边", clip: ["4", 1] } },
  "3": { class_type: "KSampler", inputs: { seed: 42, steps: 20, cfg: 7.5, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["4", 0], positive: ["10", 0], negative: ["7", 0], latent_image: ["5", 0] } },
  "12": { class_type: "CLIPTextEncodeSDXL", inputs: { text_g: "未连接", text_l: "补充", clip: ["4", 1] } },
};

test("ComfyUI prompt text is read from the original PNG", async () => {
  const info = readEmbeddedPrompt(await pngWithChunks([
    pngText("prompt", JSON.stringify(prompt)),
    pngText("workflow", JSON.stringify({ nodes: [{ secret: "WORKFLOW_SECRET_MARKER" }] })),
  ]));
  assert.equal(info.found, true);
  assert.equal(info.source, "comfyui");
  assert.equal(info.hasWorkflow, true);
  assert.deepEqual(info.sections.map((section) => section.title), ["正向提示词", "负向提示词", "SDXL 文本编码 · 节点 12"]);
  assert.equal(info.sections[0].text, "一只白猫\n\n窗边");
  assert.equal(info.sections[1].text, "模糊");
  assert.equal(info.sections[2].text, "未连接\n补充");
  assert.deepEqual(info.parameters, [
    { label: "模型", value: "model.safetensors" },
    { label: "尺寸", value: "512×768" },
    { label: "采样器", value: "euler" },
    { label: "调度器", value: "normal" },
    { label: "步数", value: "20" },
    { label: "提示词强度", value: "7.5" },
    { label: "种子", value: "42" },
  ]);
  assert.equal(JSON.stringify(info).includes("WORKFLOW_SECRET_MARKER"), false);
  assert.equal(info.rawTruncated, false);
});

test("multiple samplers stay separate and compressed WebUI text is recognized", async () => {
  const graph = {
    "6": { class_type: "CLIPTextEncode", inputs: { text: "第一张" } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "不要第一张" } },
    "3": { class_type: "KSampler", inputs: { seed: 1, steps: 10, cfg: 4, sampler_name: "euler", scheduler: "simple", denoise: 0.6, positive: ["6", 0], negative: ["7", 0] } },
    "16": { class_type: "CLIPTextEncode", inputs: { text: "第二张" } },
    "17": { class_type: "CLIPTextEncode", inputs: { text: "不要第二张" } },
    "13": { class_type: "KSamplerAdvanced", inputs: { noise_seed: 8, steps: 12, cfg: 5, sampler_name: "dpmpp_2m", scheduler: "karras", positive: ["16", 0], negative: ["17", 0] } },
  };
  const info = readEmbeddedPrompt(await pngWithChunks([pngText("prompt", JSON.stringify(graph), { compress: true })]));
  assert.deepEqual(info.sections.map((section) => [section.title, section.text]), [
    ["采样 1 · 正向提示词", "第一张"],
    ["采样 1 · 负向提示词", "不要第一张"],
    ["采样 2 · 正向提示词", "第二张"],
    ["采样 2 · 负向提示词", "不要第二张"],
  ]);
  assert.equal(info.parameters.find((item) => item.label === "采样 1 · 降噪强度").value, "0.6");
  assert.equal(info.parameters.find((item) => item.label === "采样 2 · 种子").value, "8");
  assert.equal(info.parameters.some((item) => item.label === "采样 1 · 降噪强度" && item.value === "1"), false);
});

test("WebUI parameters keep the prompt and the known settings", async () => {
  const parameters = [
    "一只猫, masterpiece",
    "Negative prompt: 低质量",
    "Steps: 28, Sampler: DPM++ 2M Karras, Schedule type: Karras, CFG scale: 6, Seed: 99, Size: 640x960, Model hash: abcd, Model: pastel.safetensors, Denoising strength: 0.4, Version: v1.9.0",
  ].join("\n");
  const info = readEmbeddedPrompt(await pngWithChunks([pngText("parameters", parameters, { international: true })]));
  assert.equal(info.source, "webui");
  assert.equal(info.hasWorkflow, false);
  assert.deepEqual(info.sections, [
    { title: "正向提示词", text: "一只猫, masterpiece" },
    { title: "负向提示词", text: "低质量" },
  ]);
  assert.deepEqual(info.parameters.map((item) => item.label), ["步数", "采样器", "调度器", "提示词强度", "种子", "尺寸", "模型", "降噪强度"]);
  assert.equal(info.parameters.find((item) => item.label === "模型").value, "pastel.safetensors");
  assert.equal(info.parameters.some((item) => item.value === "abcd"), false);
});

test("images without generation text report nothing", async () => {
  const plain = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#fff" } }).png().toBuffer();
  const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#fff" } }).jpeg().toBuffer();
  assert.deepEqual(readEmbeddedPrompt(plain), { found: false });
  assert.deepEqual(readEmbeddedPrompt(jpeg), { found: false });
  assert.deepEqual(readEmbeddedPrompt(Buffer.alloc(0)), { found: false });
  const broken = await pngWithChunks([pngText("prompt", "not-json"), pngText("parameters", "只是一句提示词")]);
  const fallback = readEmbeddedPrompt(broken);
  assert.equal(fallback.source, "webui");
  assert.equal(fallback.sections[0].text, "只是一句提示词");
});

test("a prompt stored on a linked string node is still shown", async () => {
  const graph = {
    "481": { class_type: "PrimitiveStringMultiline", inputs: { value: "教室里的人物" } },
    "474": { class_type: "TextEncodeQwenImage21", inputs: { prompt: ["481", 0], negative_prompt: "", clip: ["453", 0] } },
    "479": { class_type: "UNETLoader", inputs: { unet_name: "qwen.safetensors", weight_dtype: "default" } },
    "458": { class_type: "KSampler", inputs: { seed: 7, steps: 8, cfg: 1, sampler_name: "euler", scheduler: "simple", positive: ["474", 0], negative: ["474", 1], model: ["479", 0] } },
  };
  const info = readEmbeddedPrompt(await pngWithChunks([pngText("prompt", JSON.stringify(graph))]));
  assert.equal(info.found, true);
  assert.deepEqual(info.sections, [{ title: "正向提示词", text: "教室里的人物" }]);
  assert.equal(info.parameters.find((item) => item.label === "模型").value, "qwen.safetensors");
});

test("an oversized compressed chunk is ignored", async () => {
  const info = readEmbeddedPrompt(await pngWithChunks([
    pngText("prompt", "a".repeat(1024 * 1024 + 32), { compress: true }),
  ]));
  assert.deepEqual(info, { found: false });
});
