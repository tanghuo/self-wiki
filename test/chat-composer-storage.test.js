import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { createServer } from "../src/server/server.js";
import { defaultOrganizationConfig } from "../src/shared/domain/organization.js";
import { migrateChatComposerStorage } from "../src/server/data/chatComposerStorageMigration.js";
import { checkChatImageCount } from "../src/shared/domain/chat.js";

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-composer-storage-"));
  const config = defaultOrganizationConfig(); config.executor.codexCli.executable = path.join(dir, "app-server.mjs");
  await writeFile(config.executor.codexCli.executable, await readFile(new URL("./fixtures/chat-app-server.txt", import.meta.url)));
  await writeFile(path.join(dir, "organization.json"), JSON.stringify(config));
  let app = await createServer({ port: 0, dataDir: dir });
  const api = async (route, body, method = body === undefined ? "GET" : "POST", status = 200) => {
    const response = await fetch(new URL(`api/${route}`, app.url), { method, headers: { "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  t.after(async () => { await app.close(); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith("wiki-composer-storage-")); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); });
  return { api, async restart() { const previous = app.url; await app.close(); app = await createServer({ port: 0, dataDir: dir }); return [previous, app.url]; },
    async image(index, attachment = false) {
      const bytes = await sharp({ create: { width: 12 + index, height: 12, channels: 3, background: "#548" } }).png().toBuffer();
      const response = await fetch(new URL(attachment ? "api/chat/attachments" : "api/images", app.url), { method: "POST", body: bytes });
      assert.equal(response.status, 201); return response.json();
    },
    async done(id) {
      for (let i = 0; i < 400; i++) { const value = await api(`chat/sessions/${id}`); if (!value.running) return value; await new Promise((resolve) => setTimeout(resolve, 30)); }
      throw new Error("Fixture chat did not finish");
    } };
}

test("composer storage migration rolls back failures, repeats safely and preserves existing sessions", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE wiki_schema(version INTEGER PRIMARY KEY); CREATE TABLE chat_sessions(id INTEGER PRIMARY KEY, draft_text TEXT); INSERT INTO chat_sessions VALUES(1,'keep me'); CREATE TRIGGER fail_draft BEFORE INSERT ON wiki_schema WHEN NEW.version=29 BEGIN SELECT RAISE(ABORT,'migration failed'); END");
    assert.throws(() => migrateChatComposerStorage(db), /migration failed/);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='chat_new_draft'").get(), undefined);
    assert.equal(db.prepare("PRAGMA table_info(chat_sessions)").all().length, 2);
    db.exec("DROP TRIGGER fail_draft"); migrateChatComposerStorage(db); migrateChatComposerStorage(db);
    assert.deepEqual({ ...db.prepare("SELECT * FROM chat_sessions").get() }, { id: 1, draft_text: "keep me", draft_attachments: "[]", draft_attachments_revision: 0 });
    assert.equal(db.prepare("SELECT count(*) AS n FROM wiki_schema WHERE version=29").get().n, 1);
  } finally { db.close(); }
});

test("new and existing image drafts survive a port change, and late writes cannot restore cleared content", async (t) => {
  const f = await fixture(t), image = await f.image(1, true), source = await f.api("elements", { body: "reference" }, "POST", 201);
  const value = { text: "  未发送\n草稿  ", revision: 100, sources: [{ id: source.id, kind: "text", label: source.body }], attachments: [image], model: "fixture-fast", effort: "high", directImage: true, pending: { key: "input:existing-retry", requestKey: "draft-once-123" } };
  assert.deepEqual(await f.api("chat/sessions/new/draft", value, "PUT"), value);
  assert.equal((await f.api("chat/sessions")).sessions.length, 0, "Saving a draft does not create a session or Wiki record");
  const session = await f.api("chat/sessions", {}), imageDraft = { attachments: [image], revision: 101 };
  await f.api(`chat/sessions/${session.id}/image-draft`, imageDraft, "PUT");
  await f.restart();
  assert.deepEqual(await f.api("chat/sessions/new/draft"), value);
  assert.deepEqual((await f.api(`chat/sessions/${session.id}`)).session.imageDraft, imageDraft);
  const cleared = { text: "", revision: 102, sources: [], attachments: [] };
  await f.api("chat/sessions/new/draft", cleared, "PUT");
  assert.deepEqual(await f.api("chat/sessions/new/draft", value, "PUT"), cleared);
  await f.api("chat/sessions/new/draft", { ...cleared, text: "conflict" }, "PUT", 409);
  await f.api(`chat/sessions/${session.id}/image-draft`, { attachments: [], revision: 102 }, "PUT");
  assert.deepEqual(await f.api(`chat/sessions/${session.id}/image-draft`, imageDraft, "PUT"), { attachments: [], revision: 102 });
  await f.api(`chat/sessions/${session.id}/image-draft`, { attachments: [image], revision: 102 }, "PUT", 409);
});

test("image limits reject Wiki and pasted combinations before start, send or edit can consume a draft", async (t) => {
  const f = await fixture(t), images = [];
  for (let i = 0; i < 9; i++) images.push(await f.image(i));
  const pasted = await f.image(10, true), ids = images.map((image) => image.id);
  const newDraft = { text: "compare", revision: 100, sources: images.map((image) => ({ id: image.id, kind: "image", label: "image" })), attachments: [] };
  await f.api("chat/sessions/new/draft", newDraft, "PUT");
  await f.api("chat/sessions/start", { text: "compare", sourceIds: ids, requestKey: "nine-start-123" }, "POST", 400);
  assert.equal((await f.api("chat/sessions")).sessions.length, 0);
  assert.deepEqual(await f.api("chat/sessions/new/draft"), newDraft);
  const session = await f.api("chat/sessions", {}), route = `chat/sessions/${session.id}`;
  await f.api(`${route}/draft`, { text: "keep this", revision: 200 }, "PUT");
  const imageDraft = { attachments: [pasted], revision: 200 };
  await f.api(`${route}/image-draft`, imageDraft, "PUT");
  await f.api(`${route}/turns`, { text: "keep this", sourceIds: ids.slice(0, 8), attachmentIds: [pasted.id], requestKey: "mixed-send-123" }, "POST", 400);
  let current = await f.api(route);
  assert.equal(current.turns.length, 0); assert.equal(current.session.draft.text, "keep this"); assert.deepEqual(current.session.imageDraft, imageDraft);
  const valid = { text: "keep this", sourceIds: ids.slice(0, 7), attachmentIds: [pasted.id], requestKey: "eight-send-123" };
  await f.api(`${route}/turns`, valid); current = await f.done(session.id);
  assert.equal(current.turns[0].state, "completed", current.turns[0].error);
  assert.equal(current.session.draft.text, ""); assert.deepEqual(current.session.imageDraft, { attachments: [], revision: 201 });
  assert.deepEqual(await f.api(`${route}/image-draft`, imageDraft, "PUT"), { attachments: [], revision: 201 });
  await f.api(`${route}/draft`, { text: "next draft", revision: 300 }, "PUT");
  await f.api(`chat/turns/${current.turns[0].id}/edit`, { text: "edit", sourceIds: ids, attachmentIds: [], requestKey: "nine-edit-123", branchRevision: 0 }, "POST", 400);
  const after = await f.api(route);
  assert.equal(after.turns.length, 1); assert.equal(after.session.branchRevision, 0); assert.equal(after.session.draft.text, "next draft");
  const retry = await f.api(`${route}/turns`, valid);
  assert.equal(retry.turns.length, 1); assert.equal(retry.turns[0].id, current.turns[0].id); assert.equal(retry.session.draft.text, "next draft");
  checkChatImageCount(images.slice(0, 6), [], { region: {} });
  assert.throws(() => checkChatImageCount(images.slice(0, 7), [], { region: {} }), /最多添加 8/);
});
