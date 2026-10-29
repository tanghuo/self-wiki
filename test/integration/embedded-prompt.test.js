import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { createServer, fetch } from "../helpers/authenticatedServer.js";
import { pngText, pngWithChunks } from "../pngText.js";

async function appFor(t) {
  let app;
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-prompt-"));
  t.after(async () => {
    await app?.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("wiki-prompt-"));
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  app = await createServer({ port: 0, dataDir: dir });
  return app;
}

async function upload(app, bytes, name) {
  const response = await fetch(new URL("api/images", app.url), {
    method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": name }, body: bytes,
  });
  assert.equal(response.status, 201);
  return response.json();
}

test("image detail can read embedded generation text and ignores other content", async (t) => {
  const app = await appFor(t);
  const prompt = {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "库内的猫" } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "不要文字" } },
    "3": { class_type: "KSampler", inputs: { seed: 7, steps: 15, cfg: 6, sampler_name: "euler", scheduler: "normal", positive: ["6", 0], negative: ["7", 0], model: ["4", 0] } },
  };
  const image = await upload(app, await pngWithChunks([
    pngText("prompt", JSON.stringify(prompt)),
    pngText("workflow", JSON.stringify({ secret: "WORKFLOW_SECRET_MARKER" })),
  ]), "comfy.png");
  const plain = await upload(app, await sharp({ create: { width: 3, height: 3, channels: 3, background: "#456" } }).png().toBuffer(), "plain.png");
  const note = await (await fetch(new URL("api/elements", app.url), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "一条文字" }),
  })).json();

  const info = await (await fetch(new URL(`api/elements/${image.id}/embedded-prompt`, app.url))).json();
  assert.equal(info.found, true);
  assert.equal(info.sections[0].text, "库内的猫");
  assert.equal(info.parameters.find((item) => item.label === "种子").value, "7");
  assert.equal(JSON.stringify(info).includes("WORKFLOW_SECRET_MARKER"), false);
  assert.deepEqual(await (await fetch(new URL(`api/elements/${plain.id}/embedded-prompt`, app.url))).json(), { found: false });
  assert.equal((await fetch(new URL(`api/elements/${note.id}/embedded-prompt`, app.url))).status, 404);
  assert.equal((await fetch(new URL(`api/elements/${image.id}/embedded-prompt`, app.url), { method: "POST" })).status, 405);
});
