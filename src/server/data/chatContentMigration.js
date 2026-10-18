import { createElementRepository } from "./elementRepository.js";
import { relationDirection } from "./relationDirection.js";

// Conversations have element identities. Tool calls and message positions belong
// to chat history and output metadata, never to the content library.
export function migrateChatContent(db) {
  if (db.prepare("SELECT 1 FROM wiki_schema WHERE version=16").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`ALTER TABLE chat_element_bindings ADD COLUMN data TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE chat_turns ADD COLUMN internal INTEGER NOT NULL DEFAULT 0 CHECK(internal IN(0,1));
      CREATE TABLE chat_prompt_jobs (
        turn_id INTEGER NOT NULL REFERENCES chat_turns(id), artifact TEXT NOT NULL,
        state INTEGER NOT NULL DEFAULT 0 CHECK(state BETWEEN 0 AND 4),
        extraction_turn_id INTEGER REFERENCES chat_turns(id), element_id INTEGER REFERENCES elements(id) ON DELETE SET NULL,
        error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(turn_id,artifact)
      );`);
    const wiki = createElementRepository(db);
    for (const session of db.prepare(`SELECT s.* FROM chat_sessions s WHERE NOT EXISTS
      (SELECT 1 FROM chat_session_elements c WHERE c.session_id=s.id)`).all()) {
      const e = wiki.createRecord("session", session.title, { kind: "session", sessionId: session.id });
      db.prepare("INSERT INTO chat_session_elements(session_id,element_id) VALUES(?,?)").run(session.id, e.id);
    }
    const old = db.prepare("SELECT e.id,r.session_id,r.turn_id,r.data FROM elements e JOIN element_records r ON r.element_id=e.id WHERE e.kind=4").all();
    const oldIds = new Set(old.map((r) => r.id));
    const sessions = new Map(db.prepare("SELECT session_id,element_id FROM chat_session_elements").all().map((r) => [r.session_id, r.element_id]));
    const live = (id) => id && db.prepare("SELECT 1 FROM elements WHERE id=? AND deleted_at IS NULL").get(id);
    const connect = (a, b, name, reverseName) => {
      if (a === b || !live(a) || !live(b)) return;
      if (db.prepare("SELECT 1 FROM element_relations WHERE source_id=? AND target_id=? AND kind=1 AND name=?").get(Math.min(a,b), Math.max(a,b), name)) return;
      const relation = wiki.relate(a, b, "related", name, { direction: "forward", reverseName });
      db.prepare("INSERT INTO element_provenance(relation_id) VALUES(?)").run(relation.id);
    };
    for (const binding of db.prepare("SELECT * FROM chat_element_bindings WHERE output_key NOT LIKE 'activity:%'").all()) {
      const row = db.prepare("SELECT * FROM chat_turns WHERE id=?").get(binding.turn_id);
      if (!row || !binding.element_id) continue;
      const turn = old.find((r) => r.turn_id === row.id && JSON.parse(r.data).kind === "turn");
      const producer = db.prepare(`SELECT r.data FROM element_records r JOIN element_relations e ON
        (e.source_id=r.element_id AND e.target_id=? OR e.target_id=r.element_id AND e.source_id=?)
        WHERE e.name='产出' AND r.element_id IN (SELECT id FROM elements WHERE kind=4) LIMIT 1`).get(binding.element_id, binding.element_id);
      const data = { ...(turn ? JSON.parse(turn.data) : {}), ...(producer ? JSON.parse(producer.data) : {}), sessionId: row.session_id, turnId: row.id, sources: JSON.parse(row.sources) };
      db.prepare("UPDATE chat_element_bindings SET data=? WHERE turn_id=? AND output_key=?").run(JSON.stringify(data), row.id, binding.output_key);
      connect(sessions.get(row.session_id), binding.element_id, "产出", "来自会话");
      for (const source of JSON.parse(row.sources)) connect(source.id, binding.element_id, "参考资料", "参考自");
      const edit = JSON.parse(row.image_edit || "null");
      if (edit) connect(db.prepare("SELECT element_id FROM chat_element_bindings WHERE turn_id=? AND output_key=?").get(edit.turnId, `image:${edit.artifact}`)?.element_id, binding.element_id, "编辑为", "编辑自");
      if (binding.output_key.startsWith("image:") && db.prepare("SELECT 1 FROM elements WHERE id=? AND local_only=0 AND deleted_at IS NULL").get(binding.element_id)) {
        db.prepare("INSERT OR IGNORE INTO chat_prompt_jobs(turn_id,artifact) VALUES(?,?)").run(row.id, binding.output_key.slice(6));
      }
    }
    // Preserve user-added annotations on the owning conversation when retiring
    // legacy operation elements. Generated process edges are replaced above.
    const replacement = new Map(old.map((r) => [r.id, sessions.get(r.session_id)]));
    for (const relation of db.prepare(`SELECT r.* FROM element_relations r WHERE NOT EXISTS
      (SELECT 1 FROM element_provenance p WHERE p.relation_id=r.id)`).all()) {
      if (!oldIds.has(relation.source_id) && !oldIds.has(relation.target_id)) continue;
      const a = replacement.get(relation.source_id) || relation.source_id, b = replacement.get(relation.target_id) || relation.target_id;
      if (!oldIds.has(a) && !oldIds.has(b) && a !== b && live(a) && live(b)) wiki.relate(a, b, "related", relation.name, relationDirection(relation));
    }
    for (const row of old) {
      const sessionId = sessions.get(row.session_id);
      if (sessionId) {
        db.prepare("INSERT OR IGNORE INTO element_tags(element_id,tag_id) SELECT ?,tag_id FROM element_tags WHERE element_id=?").run(sessionId, row.id);
        db.prepare(`INSERT OR IGNORE INTO tag_relations(source_id,tag_id,name,direction,reverse_name,created_at)
          SELECT ?,tag_id,name,direction,reverse_name,created_at FROM tag_relations WHERE source_id=?`).run(sessionId, row.id);
      }
      db.prepare("DELETE FROM tag_relations WHERE source_id=?").run(row.id);
      db.prepare("DELETE FROM element_relations WHERE source_id=? OR target_id=?").run(row.id, row.id);
      db.prepare("DELETE FROM element_tags WHERE element_id=?").run(row.id);
      db.prepare("DELETE FROM canvas_positions WHERE element_id=?").run(row.id);
      db.prepare("DELETE FROM elements WHERE id=?").run(row.id);
    }
    db.exec(`DELETE FROM chat_element_bindings WHERE output_key LIKE 'activity:%';
      CREATE TRIGGER elements_content_kind_insert BEFORE INSERT ON elements WHEN NEW.kind=4
        BEGIN SELECT RAISE(ABORT,'Operations are chat metadata, not elements'); END;
      CREATE TRIGGER elements_content_kind_update BEFORE UPDATE OF kind ON elements WHEN NEW.kind=4
        BEGIN SELECT RAISE(ABORT,'Operations are chat metadata, not elements'); END;
      INSERT INTO wiki_schema VALUES(16);`);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Chat content migration foreign key check failed");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
