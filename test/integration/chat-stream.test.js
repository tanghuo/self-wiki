import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { handleChatRoute } from "../../src/server/http/chatRoutes.js";

test("chat streams drain large snapshots once and retain only new pending state", async (t) => {
  let heartbeat, notify, unsubscribed = false;
  t.mock.method(globalThis, "setInterval", (callback) => { heartbeat = callback; return 0; });
  const writes = [], res = new EventEmitter();
  res.writeHead = () => {};
  res.write = (value) => { writes.push(value); return false; };
  const snapshot = { revision: 1, answer: "长会话内容".repeat(20000) };
  const chat = {
    detail: () => snapshot,
    subscribe(id, callback) { notify = callback; notify(snapshot); return () => { unsubscribed = true; }; },
  };
  await handleChatRoute(chat, { method: "GET" }, res, new URL("http://localhost/api/chat/sessions/1/events"));
  t.after(() => res.emit("close"));
  assert.ok(Buffer.byteLength(writes[0]) > 65536);
  res.emit("drain");
  assert.equal(writes.length, 1, "write(false) already accepted the snapshot; drain must not send it again");

  notify({ revision: 2, state: "running" });
  notify({ revision: 3, state: "running" });
  notify({ revision: 4, state: "interrupted" });
  heartbeat();
  assert.equal(writes.length, 2, "Blocked streams queue state without writing snapshots or heartbeats");
  res.emit("drain");
  assert.equal(writes.length, 3);
  assert.match(writes.at(-1), /"revision":4,"state":"interrupted"/);
  res.emit("drain");
  assert.equal(writes.length, 3, "The final state is delivered exactly once");

  heartbeat(); heartbeat();
  assert.equal(writes.length, 4, "Heartbeats also respect backpressure");
  notify({ revision: 5 });
  res.emit("drain");
  assert.match(writes.at(-1), /"revision":5/);
  res.destroyed = true;
  notify({ revision: 6 }); res.emit("drain"); heartbeat();
  assert.equal(writes.length, 5);
  res.emit("close");
  assert.equal(unsubscribed, true);
});

test("streaming turn deltas are written as turn events and collapse into one fresh snapshot when blocked", async (t) => {
  let notify;
  t.mock.method(globalThis, "setInterval", () => 0);
  const writes = [], res = new EventEmitter();
  let accept = true;
  res.writeHead = () => {};
  res.write = (value) => { writes.push(value); return accept; };
  let details = 0;
  const chat = {
    detail: () => ({ revision: 10 + ++details, full: true }),
    subscribe(id, callback) { notify = callback; notify({ revision: 1, full: true }); return () => {}; },
  };
  await handleChatRoute(chat, { method: "GET" }, res, new URL("http://localhost/api/chat/sessions/1/events"));
  t.after(() => res.emit("close"));
  notify({ revision: 2, turn: { id: 7, answer: "部分" } }, "turn");
  assert.match(writes.at(-1), /^event: turn\ndata: .*"answer":"部分"/);
  accept = false;
  notify({ revision: 3, turn: { id: 7, answer: "部分回答" } }, "turn");
  const blockedAt = writes.length;
  notify({ revision: 4, turn: { id: 7, answer: "部分回答继续" } }, "turn");
  assert.equal(writes.length, blockedAt, "deltas are not queued while blocked");
  accept = true;
  res.emit("drain");
  assert.match(writes.at(-1), /^event: snapshot\ndata: \{"revision":12,"full":true\}/, "a fresh snapshot replaces the missed deltas");
  res.emit("drain");
  assert.equal(details, 2, "one existence check plus one snapshot for the missed deltas");
});
