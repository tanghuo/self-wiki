import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "../../src/server/server.js";
import { defaultOrganizationConfig } from "../../src/shared/domain/organization.js";

test("text worker retrieves old candidates, records suggestions, then automatically rechecks edits and new text", { timeout: 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-text-similarity-"));
  let app;
  t.after(async () => {
    await app?.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("wiki-text-similarity-"));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const config = defaultOrganizationConfig();
  config.executor.codexCli = { ...config.executor.codexCli, executable: path.join(root, "codex.mjs"), codexHome: path.join(root, "auth"), model: "fixture" };
  await writeFile(config.executor.codexCli.executable, await readFile(new URL("../fixtures/text-similarity-codex.txt", import.meta.url)));
  await writeFile(path.join(root, "organization.json"), JSON.stringify(config));
  app = await createServer({ port: 0, dataDir: root });
  const api = async (route, body, method = body ? "POST" : "GET") => {
    const response = await fetch(new URL(`api/${route}`, app.url), { method, headers: { "content-type": "application/json" }, ...(body && { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  };
  async function finished(id, after = 0) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const status = await api(`organization/status?elementId=${id}`);
      assert.notEqual(status.jobs[0]?.state, "failed", status.jobs[0]?.error);
      if (status.results[0]?.id > after) return api(`organization/results/${status.results[0].id}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail("Text comparison did not complete");
  }
  const body = "拍摄雨夜街道，人物撑透明雨伞，背景保留霓虹倒影，暖色侧光。".repeat(100);
  const older = await api("elements", { body: `${body}结尾要求：不要出现文字水印。` });
  const opposite = await api("elements", { body: `${body}结尾要求：必须出现文字水印。` });
  for (let i = 0; i < 30; i++) await api("elements", { body: `无关的近期资料 ${i}` });
  const variant = await api("elements", { body: `${body}结尾要求：避免文字水印。` });
  await api("organization/enqueue", { elementId: variant.id });
  const suggestion = await finished(variant.id);
  assert.deepEqual(suggestion.actions.map((a) => [a.targetId, a.state]), [[older.id, "suggested"]]);
  assert.equal((await api(`elements/${variant.id}/relations`)).relations.length, 0);
  await api(`organization/results/${suggestion.id}/accept`, { indices: [0] });
  await api(`elements/${older.id}/usage`, { action: "copy" });
  await api(`elements/${older.id}/usage`, { action: "reference" });
  let stack = await api(`elements?stackOf=${variant.id}`);
  assert.deepEqual(stack.elements.map((e) => e.id), [older.id, variant.id]);
  assert.equal((await api(`elements/${opposite.id}/relations`)).relations.length, 0);
  config.enabled = true; config.applyMode = "auto";
  await api("organization/config", config, "PUT");
  await api(`elements/${variant.id}`, { body: `${body}结尾要求：避免任何文字水印。` }, "PATCH");
  assert.equal((await api(`elements/${variant.id}/relations`)).relations.length, 0);
  const applied = await finished(variant.id, suggestion.id);
  assert.equal(applied.actions[0].state, "applied");
  const newest = await api("elements", { body: `${body}结尾要求：禁止文字水印。` });
  const newResult = await finished(newest.id);
  assert.equal(newResult.actions.filter((a) => a.state === "applied").length, 2);
  stack = await api(`elements?stackOf=${newest.id}`);
  assert.equal(stack.pagination.total, 3); assert.equal(stack.elements[0].id, older.id);
  assert.equal((await api("element-usage")).summary.total, 2);
});
