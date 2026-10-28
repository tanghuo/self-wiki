import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { imageErrorMessage, openImageErrorLog, unknownImageError } from "../../src/agent/executors/codexImageErrors.js";

const moderation = 'image generation failed: http 400 Bad Request: Some("{\\"error\\":{\\"message\\":\\"Your request was rejected by the safety system. safety_violations=[sexual].\\",\\"code\\":\\"moderation_blocked\\",\\"moderation_details\\":{\\"moderation_stage\\":\\"output\\",\\"categories\\":[\\"sexual\\"]}}}")';
const expected = "生成结果被内容审核拦截：性相关内容。";

test("image errors distinguish moderation, quota, other failures and missing details", () => {
  assert.equal(imageErrorMessage(moderation), expected);
  assert.equal(imageErrorMessage({ message: moderation }), expected);
  assert.equal(imageErrorMessage({ message: "Your request was rejected by the safety system.", code: "moderation_blocked", moderation_details: { moderation_stage: "output", categories: ["sexual"] } }), expected);
  assert.equal(imageErrorMessage({ type: "usageLimitExceeded", limitId: "image", resetsAt: null }), "图片生成额度已用完，请在额度恢复后重试。");
  assert.equal(imageErrorMessage({ message: "连接超时，请稍后重试" }), "连接超时，请稍后重试");
  assert.equal(imageErrorMessage(null), unknownImageError);
  assert.equal(imageErrorMessage("moderation_blocked"), "图片生成请求被内容审核拦截。");
});

test("image log reads only new matching tool errors across partial UTF-8 lines and skips image data", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-image-errors-"));
  t.after(async () => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("wiki-image-errors-"));
    await rm(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, "rollout.jsonl");
  const record = (turn, id, error = moderation) => JSON.stringify({ type: "response_item", payload: { type: "function_call_output", id,
    output: [{ type: "input_text", text: JSON.stringify({ view: "正面平视", error }) }, { type: "input_image", image_url: "ignored" }],
    internal_chat_message_metadata_passthrough: { turn_id: turn } } }) + "\n";
  await writeFile(file, record("current", "already-before-run"));
  const read = await openImageErrorLog(file);
  await appendFile(file, record("previous", "wrong-turn") + record("current", "unrelated", "command failed: timeout"));
  await appendFile(file, JSON.stringify({ type: "response_item", payload: { result: "A".repeat(300000) } }) + "\n");
  const bytes = Buffer.from(record("current", "blocked")), split = bytes.indexOf(Buffer.from("正面")) + 1;
  await appendFile(file, bytes.subarray(0, split));
  assert.deepEqual(await read("current"), []);
  await appendFile(file, bytes.subarray(split));
  assert.deepEqual(await read("current"), [{ id: "blocked", errors: [{ label: "正面平视", error: expected }] }]);
  assert.deepEqual(await read("current"), [], "Already read errors must not be emitted twice");
  const delayed = path.join(dir, "delayed.jsonl");
  const readDelayed = await openImageErrorLog(delayed);
  await assert.rejects(readDelayed("current"), { code: "ENOENT" });
  const prettyError = `image generation failed: http 400 Bad Request: Some(${JSON.stringify(JSON.stringify({ error: {
    message: "Your request was rejected by the safety system. safety_violations=[sexual].", code: "moderation_blocked",
    moderation_details: { moderation_stage: "output", categories: ["sexual"] },
  } }, null, 2))})`;
  await writeFile(delayed, JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "direct-call",
    output: [{ type: "input_text", text: "Script failed\nWall time 59.0 seconds\nOutput:\n" }, { type: "input_text", text: `Script error:\n${prettyError}` }],
    internal_chat_message_metadata_passthrough: { turn_id: "current" } } }) + "\n");
  assert.deepEqual(await readDelayed("current"), [{ id: "direct-call", errors: [{ label: "", error: expected }] }]);
});
