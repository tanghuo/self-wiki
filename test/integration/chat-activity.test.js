import { test } from "node:test";
import assert from "node:assert/strict";
import { initDb } from "../../src/server/data/sqlite.js";
import { createChatRepository } from "../../src/server/data/chatRepository.js";

test("chat activity covers older sessions and tracks user turns independently of internal jobs and version selection", () => {
  const db = initDb(":memory:");
  try {
    const repo = createChatRepository(db), session = repo.create();
    assert.deepEqual(repo.activity(), [{ id: session.id, turnId: null, state: null }]);
    const first = repo.begin(session.id, { text: "first", sourceIds: [], requestKey: "activity-first" }).turn;
    assert.deepEqual(repo.activity()[0], { id: session.id, turnId: first.id, state: "running" });
    repo.updateTurn({ ...first, state: "completed" });
    const internal = repo.begin(session.id, { text: "internal", sourceIds: [], requestKey: "activity-internal" }, true).turn;
    assert.deepEqual(repo.activity()[0], { id: session.id, turnId: first.id, state: "completed" });
    repo.updateTurn({ ...internal, state: "failed" });
    const edited = repo.begin(session.id, { text: "edited", sourceIds: [], requestKey: "activity-edited" }, false, first.id).turn;
    repo.updateTurn({ ...edited, state: "completed" });
    repo.selectVersion(first.id, repo.session(session.id).branchRevision);
    for (let i = 0; i < 31; i++) repo.create();
    assert.equal(repo.list().sessions.some((entry) => entry.id === session.id), false);
    assert.deepEqual(repo.activity().find((entry) => entry.id === session.id), { id: session.id, turnId: edited.id, state: "completed" });
  } finally { db.close(); }
});
