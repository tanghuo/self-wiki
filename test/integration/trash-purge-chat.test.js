import { test } from "node:test";
import assert from "node:assert/strict";
import { initDb } from "../../src/server/data/sqlite.js";
import { createElementRepository } from "../../src/server/data/elementRepository.js";
import { createChatRepository } from "../../src/server/data/chatRepository.js";

test("permanent deletion is blocked only by running chats that can write the element back", (t) => {
  const db = initDb(":memory:"); t.after(() => db.close());
  const wiki = createElementRepository(db), chat = createChatRepository(db);
  const cited = wiki.createText({ body: "被引用", tags: [] }), unrelated = wiki.createText({ body: "无关", tags: [] });
  const session = chat.create();
  const { turn } = chat.begin(session.id, { text: "进行中", sourceIds: [], requestKey: "running-turn" });
  db.prepare("UPDATE chat_turns SET sources=? WHERE id=?").run(JSON.stringify([{ id: cited.id, kind: "text", label: "被引用" }]), turn.id);
  wiki.trash(cited.id); wiki.trash(unrelated.id);
  assert.throws(() => wiki.purge(cited.id), (error) => error.statusCode === 409 && /进行中的会话/.test(error.message));
  wiki.purge(unrelated.id);
  assert.equal(db.prepare("SELECT count(*) AS n FROM elements WHERE id=?").get(unrelated.id).n, 0);
  db.prepare("UPDATE chat_turns SET state=1 WHERE id=?").run(turn.id);
  wiki.purge(cited.id);
  assert.equal(db.prepare("SELECT count(*) AS n FROM elements WHERE id=?").get(cited.id).n, 0);
});
