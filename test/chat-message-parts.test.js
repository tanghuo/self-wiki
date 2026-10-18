import { test } from "node:test";
import assert from "node:assert/strict";
import { chatMessageParts } from "../src/shared/domain/chatMessageParts.js";

test("consecutive tools merge in both timelines without crossing text or images", () => {
  const first = { id: "first", command: "执行命令", startedAnswerOffset: 0, appearedAt: 1 };
  const second = { id: "second", command: "修改文件", startedAnswerOffset: 0, appearedAt: 2 };
  const third = { id: "third", command: "执行命令", startedAnswerOffset: 1, appearedAt: 4, artifact: "image", answerOffset: 1, imageAppearance: { appearedAt: 5 } };
  const fourth = { id: "fourth", command: "执行命令", startedAnswerOffset: 1, appearedAt: 6 };
  const text = { type: "text", startOffset: 0, endOffset: 1, appearedAt: 3 };
  const labels = (parts) => parts.map((p) => p.type === "text" ? p.text : p.type === "image" ? p.artifact : p.data.map((e) => e.id));
  const events = [first, second, text, third, fourth];
  assert.deepEqual(labels(chatMessageParts("文", events)), [["first", "second"], "文", ["third"], "image", ["fourth"]]);
  const legacy = events.filter((e) => e.command).map(({ appearedAt, imageAppearance, ...event }) => event);
  assert.deepEqual(labels(chatMessageParts("文", legacy)), [["first", "second"], "文", ["third"], "image", ["fourth"]]);
  second.state = "completed";
  assert.equal(chatMessageParts("", [first, second])[0].data[1].state, "completed");
});

test("all message elements share time ordering, with receive sequence breaking timestamp ties", () => {
  const events = [
    { type: "text", id: "after", startOffset: 1, endOffset: 2, appearedAt: 300, sequence: 6 },
    { id: "tool", command: "读取", state: "running", appearedAt: 200, sequence: 3 },
    { type: "text", id: "before", startOffset: 0, endOffset: 1, appearedAt: 200, sequence: 1 },
    { id: "image", command: "生成图片", appearedAt: 200, sequence: 2, artifact: "result", imageAppearance: { appearedAt: 200, sequence: 5 } },
  ];
  const labels = () => chatMessageParts("前后", events).map((p) => p.type === "text" ? p.text : p.type === "image" ? p.artifact : p.data.map((e) => e.id).join(","));
  assert.deepEqual(labels(), ["前", "image,tool", "result", "后"]);
  events[1].state = "completed"; events[1].finishedAt = 400;
  assert.deepEqual(labels(), ["前", "image,tool", "result", "后"], "State changes do not reposition an existing element");
  assert.equal(chatMessageParts("", events).some((p) => p.type === "text" && p.text), false, "Removed answer text is not retained in timeline metadata");
});

test("tool calls separate preceding and following text while status updates stay in place", () => {
  const first = { id: "first", command: "生成图片", state: "running", startedAnswerOffset: 1 };
  assert.deepEqual(chatMessageParts("前", [first]), [{ type: "text", text: "前" }, { type: "data", name: "wiki-tool", data: [first] }]);
  first.state = "failed"; first.error = "生成结果被内容审核拦截：性相关内容。";
  const retry = { id: "retry", command: "生成图片", startedAnswerOffset: 2, answerOffset: 2, artifact: "result" };
  const parts = chatMessageParts("前中后", [first, retry]);
  assert.deepEqual(parts.map((part) => part.type === "text" ? part.text : part.type === "data" ? part.data[0].id : part.artifact), ["前", "first", "中", "retry", "result", "后"]);
  assert.equal(parts[1].data[0].error, first.error);
});

test("image placement preserves all text and completion order, including image-only and legacy turns", () => {
  assert.deepEqual(chatMessageParts("前中后", [
    { artifact: "second", answerOffset: 2 }, { state: "failed" },
    { artifact: "first", answerOffset: 1 }, { artifact: "third", answerOffset: 2 },
  ]), [
    { type: "text", text: "前" }, { type: "image", artifact: "first" },
    { type: "text", text: "中" }, { type: "image", artifact: "second" },
    { type: "image", artifact: "third" }, { type: "text", text: "后" },
  ]);
  assert.deepEqual(chatMessageParts("旧回复", [{ artifact: "old" }]), [
    { type: "text", text: "旧回复" }, { type: "image", artifact: "old" },
  ]);
  assert.deepEqual(chatMessageParts("", [{ artifact: "only", answerOffset: 0 }]), [{ type: "image", artifact: "only" }]);
  const answer = "😀说明\n\n**完成**";
  const parts = chatMessageParts(answer, [{ artifact: "image", answerOffset: 4 }]);
  assert.equal(parts.filter((p) => p.type === "text").map((p) => p.text).join(""), answer);
});
