import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer } from "../src/server/server.js";
import { initDb } from "../src/server/data/sqlite.js";
import { createChatRepository } from "../src/server/data/chatRepository.js";
import { createElementRepository } from "../src/server/data/elementRepository.js";
import { migrateChat } from "../src/server/data/chatMigration.js";
import { migrateChatBranches } from "../src/server/data/chatBranchMigration.js";
import { defaultOrganizationConfig } from "../src/shared/domain/organization.js";

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-branches-"));
  const config = defaultOrganizationConfig(); config.executor.codexCli.executable = path.join(dir, "app-server.mjs");
  await writeFile(config.executor.codexCli.executable, await readFile(new URL("./fixtures/chat-app-server.txt", import.meta.url)));
  await writeFile(path.join(dir, "organization.json"), JSON.stringify(config));
  let app = await createServer({ port: 0, dataDir: dir });
  t.after(async () => { await app.close(); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith("wiki-branches-")); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); });
  const api = async (route, body, status = 200) => {
    const response = await fetch(new URL(`api/chat/${route}`, app.url), { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  };
  async function done(id) {
    for (let i = 0; i < 400; i++) { const data = await api(`sessions/${id}`); if (data.turns.at(-1)?.state !== "running") return data; await sleep(30); }
    throw new Error("Turn timed out");
  }
  let n = 0;
  async function send(id, text = `BRANCH_CONTEXT ${++n}`, extra = {}) {
    await api(`sessions/${id}/turns`, { text, requestKey: `branch-send-${++n}`, sourceIds: [], ...extra }); return done(id);
  }
  return { api, done, send, dir, async restart() { await app.close(); app = await createServer({ port: 0, dataDir: dir }); } };
}

test("editing preserves versions and their continuations, isolates model context, and survives restart", async (t) => {
  const f = await fixture(t), session = await f.api("sessions", {});
  const first = (await f.send(session.id, "BRANCH_CONTEXT original root")).turns[0];
  const original = await f.send(session.id, "BRANCH_CONTEXT old continuation");
  const second = original.turns[1];
  const payload = { text: "BRANCH_CONTEXT edited root", requestKey: "edit-root-once", branchRevision: 0 };
  await f.api(`turns/${first.id}/edit`, payload);
  let edited = await f.done(session.id);
  assert.equal(edited.turns.length, 1);
  assert.deepEqual(edited.turns[0].versions, [first.id, edited.turns[0].id]);
  assert.equal(edited.session.branchRevision, 1);
  assert.deepEqual(JSON.parse(edited.turns[0].answer).history, []);
  assert.notEqual(edited.session.threadId, original.session.threadId);
  const editedRoot = edited.turns[0];
  assert.equal((await f.api(`turns/${first.id}/edit`, payload)).turns.length, 1, "A lost acknowledgement must not create a third version");
  await f.api(`turns/${first.id}/edit`, { ...payload, text: "conflicting body" }, 409);
  await f.api(`sessions/${session.id}/turns`, { text: "stale", sourceIds: [], requestKey: "stale-branch-send", branchRevision: 0 }, 409);
  edited = await f.send(session.id, "BRANCH_CONTEXT new continuation", { branchRevision: 1 });
  const newEnd = edited.turns[1].id;
  await f.restart();
  assert.deepEqual((await f.api(`sessions/${session.id}`)).turns.map((t) => t.id), [editedRoot.id, newEnd]);
  const restored = await f.api(`turns/${first.id}/select`, { branchRevision: 1 });
  assert.deepEqual(restored.turns.map((t) => t.id), [first.id, second.id]);
  assert.equal(restored.session.threadId, null);
  const continued = await f.send(session.id, "BRANCH_CONTEXT after restoring old", { branchRevision: 2 });
  assert.deepEqual(JSON.parse(continued.turns.at(-1).answer).history.map((t) => t.turnId), [first.id, second.id]);
  assert.ok(!continued.turns.some((t) => t.id === newEnd));
  const newRestored = await f.api(`turns/${editedRoot.id}/select`, { branchRevision: 2 });
  assert.deepEqual(newRestored.turns.map((t) => t.id), [editedRoot.id, newEnd]);
  await f.api(`turns/${first.id}/fork`, { requestKey: "hidden-fork-denied", branchRevision: 3 }, 409);
  const around = await f.api(`sessions/${session.id}?around=${second.id}`);
  assert.equal(around.requestedVersion, second.id, "A deep link can explicitly request its hidden version without mutating on GET");
});

test("editing a middle message replays only the common prefix and remembers nested versions", async (t) => {
  const f = await fixture(t), s = await f.api("sessions", {});
  const first = (await f.send(s.id)).turns[0];
  const second = (await f.send(s.id)).turns[1];
  const old = await f.send(s.id);
  await f.api(`turns/${second.id}/edit`, { text: "BRANCH_CONTEXT middle edit", requestKey: "edit-middle-first", branchRevision: 0 });
  let edited = await f.done(s.id);
  const replacement = edited.turns[1];
  assert.deepEqual(JSON.parse(replacement.answer).history.map((t) => t.turnId), [first.id]);
  const later = (await f.send(s.id)).turns.at(-1);
  await f.api(`turns/${later.id}/edit`, { text: "BRANCH_CONTEXT nested edit", requestKey: "edit-middle-nested", branchRevision: 1 });
  edited = await f.done(s.id);
  const nested = edited.turns.at(-1);
  await f.api(`turns/${second.id}/select`, { branchRevision: 2 });
  assert.deepEqual((await f.api(`sessions/${s.id}`)).turns.map((t) => t.id), old.turns.map((t) => t.id));
  const restored = await f.api(`turns/${replacement.id}/select`, { branchRevision: 3 });
  assert.deepEqual(restored.turns.map((t) => t.id), [first.id, replacement.id, nested.id]);
  await f.api(`turns/${later.id}/select`, { branchRevision: 3 }, 409);
});

test("late model acknowledgements cannot restore the model thread of a version already switched away", async (t) => {
  const f = await fixture(t), s = await f.api("sessions", {});
  const original = (await f.send(s.id)).turns[0];
  await f.api(`turns/${original.id}/edit`, { text: "BRANCH_CONTEXT DELAY_ACK", requestKey: "edit-delayed-ack", branchRevision: 0 });
  const edited = await f.done(s.id);
  assert.equal(edited.turns[0].state, "completed");
  await f.api(`turns/${original.id}/select`, { branchRevision: 1 });
  await sleep(650);
  const restored = await f.api(`sessions/${s.id}`);
  assert.equal(restored.session.threadId, null);
  assert.equal(restored.session.activeTurnId, original.id);
});

test("fork copies only the selected prefix, creates once, preserves images and references, and continues independently", async (t) => {
  const f = await fixture(t), s = await f.api("sessions", {});
  const generated = await f.send(s.id, "GENERATE_IMAGE");
  const imageTurn = generated.turns[0], artifact = imageTurn.events.find((e) => e.artifact).artifact;
  await f.send(s.id, "BRANCH_CONTEXT suffix excluded");
  const input = { requestKey: "fork-image-prefix", branchRevision: 0 };
  const fork = await f.api(`turns/${imageTurn.id}/fork`, input);
  assert.notEqual(fork.id, s.id); assert.notEqual(fork.elementId, s.elementId);
  assert.equal(fork.threadId, null); assert.equal(fork.draft.text, "");
  assert.equal((await f.api(`turns/${imageTurn.id}/fork`, input)).id, fork.id);
  const copied = await f.api(`sessions/${fork.id}`);
  assert.equal(copied.turns.length, 1); assert.deepEqual(copied.proposals, []);
  assert.notEqual(copied.turns[0].id, imageTurn.id);
  assert.equal(copied.turns[0].events.find((e) => e.artifact).artifact, artifact);
  assert.deepEqual(copied.turns[0].sources, imageTurn.sources);
  const continuation = await f.send(fork.id, "BRANCH_CONTEXT fork continuation");
  const result = JSON.parse(continuation.turns.at(-1).answer);
  assert.equal(result.images, 1);
  assert.deepEqual(result.history.map((t) => t.turnId), [copied.turns[0].id]);
  assert.equal(result.history[0].outputs.find((e) => e.historyAttachment).historyAttachment, 1);
  assert.equal((await f.api(`sessions/${s.id}`)).turns.length, 2);
  await f.restart();
  assert.equal((await f.api(`sessions/${fork.id}`)).turns.length, 2);
  await f.api(`turns/${copied.turns[0].id}/fork`, input, 409);
});

test("running turns reject edits, version switches and forks without creating partial history", async (t) => {
  const f = await fixture(t), s = await f.api("sessions", {});
  const first = (await f.send(s.id)).turns[0];
  await f.api(`sessions/${s.id}/turns`, { text: "SLOW", sourceIds: [], requestKey: "running-to-block" });
  await f.api(`turns/${first.id}/edit`, { text: "BRANCH_CONTEXT blocked", requestKey: "blocked-edit-key", branchRevision: 0 }, 409);
  await f.api(`turns/${first.id}/select`, { branchRevision: 0 }, 409);
  await f.api(`turns/${first.id}/fork`, { requestKey: "blocked-fork-key", branchRevision: 0 }, 409);
  assert.equal((await f.api("sessions")).sessions.length, 1);
  assert.equal((await f.api(`sessions/${s.id}`)).turns.length, 2);
  await f.api(`sessions/${s.id}/stop`, {});
});

test("editing image instructions keeps their original image and forked references use copied turn IDs", async (t) => {
  const f = await fixture(t), s = await f.api("sessions", {});
  const original = (await f.send(s.id, "GENERATE_IMAGE")).turns[0];
  const artifact = original.events.find((e) => e.artifact).artifact;
  const imageEdit = { turnId: original.id, artifact, region: { x: .1, y: .1, width: .4, height: .4 } };
  const editedImage = (await f.send(s.id, "EDIT_IMAGE EXPECT_REGION", { imageEdit })).turns.at(-1);
  await f.api(`turns/${editedImage.id}/edit`, { text: "BRANCH_CONTEXT revised image instructions", requestKey: "edit-image-message", branchRevision: 0 });
  const updated = await f.done(s.id), edited = updated.turns.at(-1);
  assert.deepEqual(edited.imageEdit, imageEdit);
  const result = JSON.parse(edited.answer);
  assert.equal(result.images, 3, "Original, selection guide, and the historical generated image reach the new thread");
  assert.deepEqual(result.history.map((t) => t.turnId), [original.id]);
  const fork = await f.api(`turns/${edited.id}/fork`, { requestKey: "fork-image-instructions", branchRevision: 1 });
  const copied = (await f.api(`sessions/${fork.id}`)).turns;
  assert.equal(copied[1].imageEdit.turnId, copied[0].id);
  assert.deepEqual(copied[1].imageEdit.region, imageEdit.region);
  const continued = await f.send(fork.id, "BRANCH_CONTEXT continue editing");
  const replay = JSON.parse(continued.turns.at(-1).answer);
  assert.deepEqual(replay.history[1].imageEdit, { historyAttachment: 1, region: imageEdit.region });
  assert.equal(replay.images, 1, "Historical edits point to the same attached original without exposing stored artifact names");
});

test("purging one conversation preserves fork images and the last purge releases unarchived files", () => {
  const db = initDb(":memory:");
  try {
    const repo = createChatRepository(db), wiki = createElementRepository(db), s = repo.create();
    const artifact = "00000000-0000-4000-8000-000000000001.png";
    const original = repo.begin(s.id, { text: "Original prompt", sourceIds: [], requestKey: "shared-image-original" }).turn;
    repo.updateTurn({ ...original, state: "completed", answer: "Original answer", events: [{ id: "image-1", artifact, state: "completed", parameters: { prompt: "Original prompt" } }] });
    const fork = repo.fork(original.id, "shared-image-fork", 0);
    wiki.trash(s.elementId); wiki.purge(s.elementId);
    assert.equal(repo.detail(fork.id).turns[0].answer, "Original answer");
    assert.equal(repo.detail(fork.id).turns[0].events[0].artifact, artifact);
    assert.equal(repo.turn(original.id).events[0].artifact, undefined);
    assert.equal(db.prepare("SELECT 1 FROM chat_file_cleanup WHERE name=?").get(artifact), undefined);
    wiki.trash(fork.elementId); wiki.purge(fork.elementId);
    assert.ok(db.prepare("SELECT 1 FROM chat_file_cleanup WHERE name=?").get(artifact));
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

test("pagination and extraction evidence stay on the chosen path even with interleaved version IDs", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-branches-pages-")), db = initDb(path.join(dir, "wiki.sqlite3"));
  t.after(async () => { db.close(); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); });
  const repo = createChatRepository(db), s = repo.create();
  const complete = (turn) => repo.updateTurn({ ...turn, state: "completed", answer: `Answer ${turn.id}` });
  const original = [];
  for (let i = 0; i < 25; i++) { const { turn } = repo.begin(s.id, { text: `Original ${i}`, sourceIds: [], requestKey: `page-original-${i}` }); complete(turn); original.push(turn.id); }
  const editInput = { text: "Replacement at position 22", sourceIds: [], requestKey: "page-edit-message", branchRevision: 0 };
  const { turn } = repo.begin(s.id, editInput, false, original[21]); complete(turn);
  const latest = repo.detail(s.id);
  assert.deepEqual(latest.turns.map((t) => t.id), [...original.slice(2, 21), turn.id]);
  assert.equal(latest.hasOlder, true);
  assert.deepEqual(repo.detail(s.id, latest.turns[0].id).turns.map((t) => t.id), original.slice(0, 2));
  assert.deepEqual(repo.promptContext(turn.id).history.map((t) => t.id), latest.turns.map((t) => t.id));
  assert.throws(() => repo.propose(turn.id, "hidden-excerpt", { kind: "create_text", body: "hidden", sourceIds: [], excerpts: [{ turnId: original[22], role: "user", quote: "Original 22" }] }, []), /前文/);
  assert.equal(repo.session(s.id).activeTurnId, turn.id);
  // Internal image extraction is anchored to the saved turn, even on a hidden version.
  const internal = repo.begin(s.id, { text: "extract", sourceIds: [], requestKey: "hidden-image-extract", contextTurnId: original[22] }, true).turn;
  assert.ok(repo.promptContext(internal.id).history.some((t) => t.id === original[22]));
  assert.equal(repo.session(s.id).activeTurnId, turn.id);
  complete(internal);
});

test("branch migration preserves old linear histories, ignores internal turns, and is atomic and repeatable", () => {
  for (const fail of [false, true]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys=ON; CREATE TABLE wiki_schema(version INTEGER PRIMARY KEY)"); migrateChat(db);
      db.exec(`ALTER TABLE chat_turns ADD COLUMN internal INTEGER NOT NULL DEFAULT 0;
        INSERT INTO chat_sessions(title,created_at,updated_at) VALUES('Old',1,1),('Empty',1,1);
        INSERT INTO chat_turns(session_id,request_key,payload_hash,text,created_at,updated_at,internal) VALUES
          (1,'one','hash','One',1,1,0),(1,'internal','hash','Internal',1,1,1),(1,'two','hash','Two',1,1,0);`);
      if (fail) {
        db.exec("ALTER TABLE chat_sessions ADD COLUMN active_turn_id INTEGER");
        assert.throws(() => migrateChatBranches(db));
        assert.equal(db.prepare("PRAGMA table_info(chat_turns)").all().some((r) => r.name === "parent_turn_id"), false);
        assert.equal(db.prepare("SELECT 1 FROM wiki_schema WHERE version=19").get(), undefined);
      } else {
        migrateChatBranches(db); migrateChatBranches(db);
        assert.deepEqual(db.prepare("SELECT parent_turn_id FROM chat_turns ORDER BY id").all().map((r) => r.parent_turn_id), [null, 1, 1]);
        assert.deepEqual(db.prepare("SELECT active_turn_id FROM chat_sessions ORDER BY id").all().map((r) => r.active_turn_id), [3, null]);
        assert.equal(db.prepare("SELECT selected_child_id FROM chat_turns WHERE id=1").get().selected_child_id, 3);
        assert.equal(db.prepare("SELECT count(*) n FROM wiki_schema WHERE version=19").get().n, 1);
        assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      }
    } finally { db.close(); }
  }
});
