import { test } from "node:test";
import assert from "node:assert/strict";
import { initDb } from "../../src/server/data/sqlite.js";
import { createChatRepository } from "../../src/server/data/chatRepository.js";
import { deleteChatHistory } from "../../src/server/data/chatHistoryDeletion.js";
import { migrateChatWebConversations } from "../../src/server/data/chatWebConversationMigration.js";

test("web bindings are isolated, revision guarded, migration safe and invalidated with deleted history", () => {
  const db = initDb(":memory:");
  try {
    const repo = createChatRepository(db), a = repo.create("a"), b = repo.create("b");
    repo.bindWebConversation(a.id, 0, "https://chatgpt.com/c/first");
    assert.equal(repo.webConversation(a.id, 0), "https://chatgpt.com/c/first");
    assert.equal(repo.webConversation(b.id, 0), "");
    migrateChatWebConversations(db);
    assert.equal(repo.webConversation(a.id, 0), "https://chatgpt.com/c/first");
    db.prepare("UPDATE chat_sessions SET branch_revision=1 WHERE id=?").run(a.id);
    assert.equal(repo.webConversation(a.id, 1), "");
    assert.throws(() => repo.bindWebConversation(a.id, 0, "https://chatgpt.com/c/stale"), /版本已改变/);
    repo.bindWebConversation(a.id, 1, "https://chatgpt.com/c/second");
    assert.throws(() => repo.bindWebConversation(a.id, 1, "https://example.com/c/bad"), /无效/);
    db.exec("BEGIN IMMEDIATE");
    deleteChatHistory(db, a.elementId);
    db.exec("COMMIT");
    assert.equal(repo.webConversation(a.id, 1), "");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { db.close(); }
});
