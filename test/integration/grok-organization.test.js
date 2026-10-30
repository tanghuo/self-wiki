import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { grokOrganization } from "../../src/agent/executors/grokOrganization.js";
import { defaultOrganizationConfig } from "../../src/shared/domain/organization.js";

const organizationJson = JSON.stringify({ summary: "一张图", tagAdds: [], relationAdds: [], queries: [], imageRequests: [] });

test("grok organization executor pins grok-4.7, reads images and rejects tools or invalid JSON", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-grok-organization-"));
  const previousHome = process.env.GROK_HOME;
  process.env.GROK_HOME = root;
  const executable = path.join(root, "grok.mjs");
  await writeFile(executable, await readFile(new URL("../fixtures/grok-acp.txt", import.meta.url)));
  t.after(async () => {
    if (previousHome === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = previousHome;
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("wiki-grok-organization-"));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const config = defaultOrganizationConfig().executor;
  config.type = "grok-build";
  config.grokBuild = { executable, model: "grok-4.7" };
  const probe = await grokOrganization.probe(config);
  assert.equal(probe.available, true, probe.diagnostic);
  assert.match(probe.diagnostic, /grok-4.7/);
  const missing = await grokOrganization.probe({ ...config, grokBuild: { executable, model: "missing-model" } });
  assert.equal(missing.code, "MODEL_UNKNOWN");
  await writeFile(path.join(root, "fixture-answer.txt"), `说明\n\`\`\`json\n${organizationJson}\n\`\`\``);
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } }).png().toBuffer();
  const result = await grokOrganization.execute({ prompt: "整理这张图", images: [{ elementId: 7, bytes: png }] }, { config, signal: AbortSignal.timeout(15000) });
  assert.equal(result.output.summary, "一张图");
  assert.equal(result.execution.executor, "grok-build");
  assert.equal(result.execution.model, "grok-4.7");
  const inputs = (await readFile(path.join(root, "acp-inputs.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const image = inputs.at(-1).prompt.find((entry) => entry.type === "image");
  assert.equal(image.mimeType, "image/png");
  await rm(path.join(root, "fixture-answer.txt"), { force: true });
  await assert.rejects(grokOrganization.execute({ prompt: "DENY_SHELL", images: [] }, { config, signal: AbortSignal.timeout(15000) }), /拒绝工具/);
  await assert.rejects(grokOrganization.execute({ prompt: "整理", images: [] }, { config: { ...config, grokBuild: { ...config.grokBuild, model: "ignored-model" } }, signal: AbortSignal.timeout(15000) }), /未按配置生效/);
  await writeFile(path.join(root, "fixture-answer.txt"), "不是 JSON");
  await assert.rejects(grokOrganization.execute({ kind: "image-description", prompt: "描述", images: [{ elementId: 7, bytes: png }] }, { config, signal: AbortSignal.timeout(15000) }), (error) => {
    assert.equal(error.code, "INVALID_OUTPUT");
    return true;
  });
});
