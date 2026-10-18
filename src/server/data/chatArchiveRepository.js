import { createHash } from "node:crypto";
import { elementError } from "../../shared/domain/elements.js";
import { createElementRepository } from "./elementRepository.js";
import { createChatRepository } from "./chatRepository.js";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const outputKey = (value) => value.artifact ? `image:${value.artifact}` : `text:${digest({ body: value.body, excerpts: value.excerpts || [] })}`;
const promptStates = ["queued", "running", "completed", "failed", "deleted"];

export function createChatArchiveRepository(db) {
  const wiki = createElementRepository(db), chat = createChatRepository(db);
  const binding = (turnId, key) => db.prepare("SELECT element_id FROM chat_element_bindings WHERE turn_id=? AND output_key=?").get(turnId, key);
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function live(id) { return id && db.prepare("SELECT id FROM elements WHERE id=? AND deleted_at IS NULL").get(id); }
  function saved(id) {
    if (!id) throw elementError("已保存的元素已永久删除，不会自动重新创建", 410);
    if (!live(id)) throw elementError("已保存的元素在回收站，请先恢复", 409);
    return wiki.get(id);
  }
  function link(a, b, name, reverseName) {
    if (a === b || !live(a) || !live(b)) return;
    if (wiki.findRelation(a, b, "related", name, { direction: "forward", reverseName })) return;
    const relation = wiki.relate(a, b, "related", name, { direction: "forward", reverseName });
    // Archival backreferences must not make the source content appear edited.
    // This marker records origin only; the relation is still normally editable.
    db.prepare("INSERT INTO element_provenance(relation_id) VALUES(?)").run(relation.id);
  }
  function sessionNode(turn) {
    return db.prepare("SELECT element_id FROM chat_session_elements WHERE session_id=?").get(turn.sessionId)?.element_id || null;
  }
  function bind(turn, key, elementId, extra = {}) {
    const data = { sessionId: turn.sessionId, turnId: turn.id, createdAt: turn.createdAt, model: turn.model,
      text: turn.text, originalAnswer: turn.answer, sources: turn.sources, imageEdit: turn.imageEdit, ...extra };
    db.prepare("INSERT INTO chat_element_bindings(turn_id,output_key,element_id,data) VALUES(?,?,?,?)").run(turn.id, key, elementId, JSON.stringify(data));
    link(sessionNode(turn), elementId, "产出", "来自会话");
    for (const source of turn.sources) link(elementId, source.id, "参考了", "被参考");
  }
  function imageNode(turn, artifact, files) {
    const key = `image:${artifact}`, prior = binding(turn.id, key);
    if (prior) return prior.element_id;
    const event = turn.events.find((e) => e.artifact === artifact && e.state === "completed");
    if (!event) throw elementError("图片产物已失效，请刷新后重试", 409);
    const original = turn.imageEdit ? imageNode(chat.turn(turn.imageEdit.turnId), turn.imageEdit.artifact, files) : null;
    const file = files.get(artifact);
    if (!file) throw elementError("图片文件未准备完成", 409);
    const { element } = wiki.importImage({ body: "", tags: [], localOnly: true, creationSource: "chat" }, file, file.missingStorageKey);
    bind(turn, key, element.id, { kind: "image", eventId: event.id, parameters: event.parameters || {}, state: event.state });
    link(original, element.id, "编辑为", "编辑自");
    return element.id;
  }
  function attach(turn, value, files, existingId) {
    const key = `${outputKey(value)}${existingId ? `:proposal:${existingId}` : ""}`, prior = binding(turn.id, key);
    let id;
    if (prior) id = saved(prior.element_id).id;
    else if (value.artifact) id = imageNode(turn, value.artifact, files);
    else {
      id = existingId || wiki.createText({ body: value.body, tags: value.tags || [], creationSource: "chat" }).id;
      bind(turn, key, id, { kind: "text", excerpts: value.excerpts || [], savedBody: value.body });
      for (const excerpt of value.excerpts || []) {
        const source = chat.turn(excerpt.turnId);
        const event = excerpt.role === "tool" && source.events.find((e) => e.id === excerpt.eventId);
        if (event?.artifact) link(id, binding(source.id, `image:${event.artifact}`)?.element_id, "提示词", "使用提示词");
      }
    }
    db.prepare("UPDATE elements SET local_only=0 WHERE id=?").run(id);
    if (value.artifact) db.prepare(`INSERT INTO chat_prompt_jobs(turn_id,artifact) VALUES(?,?)
      ON CONFLICT(turn_id,artifact) DO UPDATE SET state=0,error='' WHERE chat_prompt_jobs.state=3`).run(turn.id, value.artifact);
    return { element: saved(id), sessionElementId: sessionNode(turn), reused: Boolean(prior) };
  }
  return {
    turn: chat.turn,
    plan(turnId, value) {
      const turn = chat.turn(turnId), images = new Map();
      if (turn.state === "running") throw elementError("请等待本轮结束后保存", 409);
      const prior = value && binding(turnId, outputKey(value));
      if (prior) { saved(prior.element_id); return { turn, images }; }
      function visit(t, name, depth = 0) {
        if (depth > 60) throw elementError("来源链超过本次保存上限，请先保存较早的版本", 409);
        if (images.has(name) || binding(t.id, `image:${name}`)) return;
        if (!t.events.some((e) => e.artifact === name && e.state === "completed")) throw elementError("图片不存在或已删除", 404);
        images.set(name, { turnId: t.id, needed: true });
        if (t.imageEdit) visit(chat.turn(t.imageEdit.turnId), t.imageEdit.artifact, depth + 1);
      }
      if (value?.artifact) visit(turn, value.artifact);
      return { turn, images };
    },
    fileUsed(key) { return Boolean(db.prepare("SELECT 1 FROM element_images WHERE storage_key=?").get(key)); },
    existingImage: (hash) => wiki.findImageByHash(hash),
    save(turnId, value, files) { return transaction(() => { const turn = chat.turn(turnId); if (turn.state === "running") throw elementError("请等待本轮结束后保存", 409); return attach(turn, value, files); }); },
    accept(proposalId, edit, files) {
      return chat.accept(proposalId, edit, (turn, payload, createdId) => {
        const job = db.prepare("SELECT * FROM chat_prompt_jobs WHERE extraction_turn_id=?").get(turn.id);
        const origin = job ? chat.turn(job.turn_id) : turn;
        if (job) saved(binding(job.turn_id, `image:${job.artifact}`)?.element_id);
        attach(origin, { body: payload.body, tags: payload.tags, excerpts: payload.excerpts }, files, createdId);
        if (job) {
          const imageId = binding(job.turn_id, `image:${job.artifact}`).element_id;
          link(createdId, imageId, "提示词", "使用提示词");
          for (const sourceId of payload.sourceIds) {
            link(imageId, sourceId, "参考了", "被参考");
          }
          if (!db.prepare("UPDATE chat_prompt_jobs SET state=2,element_id=?,error='' WHERE extraction_turn_id=? AND state=1").run(createdId, turn.id).changes) throw elementError("提示词提炼已结束", 409);
        }
      });
    },
    recoverPrompts() { db.prepare("UPDATE chat_prompt_jobs SET state=3,error='上次提炼已中断，可以重试' WHERE state=1").run(); },
    nextPrompt() { return db.prepare(`SELECT j.* FROM chat_prompt_jobs j JOIN chat_element_bindings b
      ON b.turn_id=j.turn_id AND b.output_key='image:'||j.artifact JOIN elements e ON e.id=b.element_id
      JOIN chat_turns origin ON origin.id=j.turn_id
      WHERE j.state=0 AND e.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM chat_turns busy WHERE busy.session_id=origin.session_id AND busy.state=0)
      ORDER BY j.turn_id LIMIT 1`).get(); },
    startPrompt(job) {
      return transaction(() => {
        const origin = chat.turn(job.turn_id);
        const input = { text: "整理图片的独立提示词", sourceIds: [], requestKey: `image-prompt-${job.turn_id}-${job.artifact}-${job.attempts}`, model: origin.model, contextTurnId: origin.id };
        const { turn } = chat.begin(origin.sessionId, input, true);
        if (!db.prepare("UPDATE chat_prompt_jobs SET state=1,extraction_turn_id=?,attempts=attempts+1 WHERE turn_id=? AND artifact=? AND state=0").run(turn.id, job.turn_id, job.artifact).changes) throw elementError("提示词任务已开始", 409);
        return { turn, input };
      });
    },
    finishPrompt(turnId, error, retry = false) {
      // A completed or deleted job must never be requeued by a late turn completion.
      return Boolean(db.prepare("UPDATE chat_prompt_jobs SET state=?,error=? WHERE extraction_turn_id=? AND state=1")
        .run(retry ? 0 : 3, error || "未能整理出独立提示词，可以重试", turnId).changes);
    },
    failQueuedPrompt(job, error) { db.prepare("UPDATE chat_prompt_jobs SET state=3,error=? WHERE turn_id=? AND artifact=? AND state=0").run(error, job.turn_id, job.artifact); },
    proposal: chat.proposal,
    trackCopy(artifact, relative) { db.prepare("INSERT OR IGNORE INTO chat_file_copies(artifact,path) VALUES(?,?)").run(artifact, relative); },
    cleanupFiles: () => db.prepare("SELECT name FROM chat_file_cleanup").all().map((r) => r.name),
    queueFile(name) { db.prepare("INSERT OR IGNORE INTO chat_file_cleanup(name) VALUES(?)").run(name); },
    fileRemoved(name) { db.prepare("DELETE FROM chat_file_cleanup WHERE name=?").run(name); },
    saved(turnId) {
      return db.prepare("SELECT output_key AS key,element_id AS elementId FROM chat_element_bindings WHERE turn_id=? AND (output_key LIKE 'image:%' OR output_key LIKE 'text:%')").all(turnId).map((b) => {
        const job = b.key.startsWith("image:") && db.prepare("SELECT state,element_id,error FROM chat_prompt_jobs WHERE turn_id=? AND artifact=?").get(turnId, b.key.slice(6));
        return { ...b, ...(job ? { prompt: { state: promptStates[job.state], elementId: job.element_id, error: job.error } } : {}) };
      });
    },
  };
}
