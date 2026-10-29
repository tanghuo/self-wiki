import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "../helpers/authenticatedServer.js";
import sharp from "sharp";
import { resolveBrowserPath } from "../resolveBrowserPath.js";
import { createServer, fetch } from "../helpers/authenticatedServer.js";
import { pngText, pngWithChunks } from "../pngText.js";

const browserPath = resolveBrowserPath();
const options = { timeout: 60000, skip: !browserPath && "Browser required" };

test("image detail opens embedded generation text in a dialog and hides the entry when absent", options, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wiki-ui-"));
  const app = await createServer({ port: 0, dataDir });
  let browser;
  t.after(async () => {
    await browser?.close();
    await app.close();
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("wiki-ui-"));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
  });
  const prompt = {
    "6": { class_type: "CLIPTextEncode", inputs: { text: "一只白猫，坐在窗边" } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "模糊，多余的手指" } },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "cat.safetensors" } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 832, height: 1216, batch_size: 1 } },
    "3": { class_type: "KSampler", inputs: { seed: 1234, steps: 24, cfg: 5.5, sampler_name: "euler", scheduler: "simple", positive: ["6", 0], negative: ["7", 0], model: ["4", 0], latent_image: ["5", 0] } },
  };
  const comfy = await pngWithChunks([
    pngText("prompt", JSON.stringify(prompt)),
    pngText("workflow", JSON.stringify({ nodes: [{ id: 1 }] })),
  ]);
  const plain = await sharp({ create: { width: 24, height: 24, channels: 3, background: "#789" } }).png().toBuffer();
  for (const [name, bytes] of [["plain-photo.png", plain], ["comfy-cat.png", comfy]]) {
    const response = await fetch(new URL("api/images", app.url), { method: "POST", headers: { "x-file-name": name }, body: bytes });
    assert.equal(response.status, 201);
  }
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => { window.copiedText = text; } } });
  });
  await page.goto(`${app.url}#wiki`);
  await page.reload();

  const detail = page.getByRole("region", { name: "内容详情", exact: true });
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/embedded-prompt") && response.ok()),
    page.getByRole("button", { name: "打开内容：plain-photo.png", exact: true }).click(),
  ]);
  await detail.getByRole("heading", { name: "plain-photo.png", exact: true }).waitFor();
  assert.equal(await detail.getByRole("button", { name: "生成信息", exact: true }).count(), 0);

  await detail.getByRole("button", { name: "返回", exact: true }).click();
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/embedded-prompt") && response.ok()),
    page.getByRole("button", { name: "打开内容：comfy-cat.png", exact: true }).click(),
  ]);
  await detail.getByRole("button", { name: "生成信息", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "生成信息", exact: true });
  await dialog.getByText("一只白猫，坐在窗边", { exact: true }).waitFor();
  await dialog.getByText("模糊，多余的手指", { exact: true }).waitFor();
  await dialog.getByText("cat.safetensors", { exact: true }).waitFor();
  await dialog.getByText("832×1216", { exact: true }).waitFor();
  await dialog.getByText("此文件还包含可拖回 ComfyUI 的工作流。", { exact: true }).waitFor();
  assert.equal(await dialog.locator("details").evaluate((node) => node.open), false);
  await dialog.getByRole("button", { name: "复制", exact: true }).first().click();
  assert.equal(await page.evaluate(() => window.copiedText), "一只白猫，坐在窗边");
  await dialog.getByRole("button", { name: "关闭生成信息", exact: true }).click();
  await dialog.waitFor({ state: "detached" });

  await page.setViewportSize({ width: 390, height: 740 });
  await detail.getByRole("button", { name: "生成信息", exact: true }).click();
  await dialog.getByText("一只白猫，坐在窗边", { exact: true }).waitFor();
  const box = await dialog.boundingBox();
  assert.ok(box.width <= 390);
  assert.ok(box.height <= 740);
  await dialog.getByRole("button", { name: "关闭生成信息", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
});
