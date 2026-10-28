import { createHash } from "node:crypto";
import { elementContent, elementError, elementTags } from "../../shared/domain/elements.js";
import { createElementRepository } from "./elementRepository.js";
import { chatPathIds } from "./chatHistory.js";
import { checkChatImageCount } from "../../shared/domain/chat.js";

const states = ["running", "completed", "interrupted", "failed"];
const proposalStates = ["pending", "accepted", "rejected", "undone"];
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function createChatRepository(db) {
  const wiki = createElementRepository(db);
  function transaction(fn) {
    if (db.isTransaction) return fn();
    db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function session(id) {
    const row = db.prepare("SELECT * FROM chat_sessions WHERE id=?").get(id);
    if (!row) throw elementError("会话不存在", 404);
    return { id: row.id, title: row.title, model: row.model, effort: row.effort, threadId: row.codex_thread_id, createdAt: row.created_at, updatedAt: row.updated_at,
      activeTurnId: row.active_turn_id, branchRevision: row.branch_revision,
      imageOptions: JSON.parse(row.image_options || "null"), imageOptionsRevision: row.image_options_revision,
      forkedFrom: db.prepare("SELECT source_turn_id AS turnId FROM chat_forks WHERE session_id=?").get(id) || null,
      draft: { text: row.draft_text, revision: row.draft_revision },
      imageDraft: { attachments: JSON.parse(row.draft_attachments), revision: row.draft_attachments_revision },
      elementId: db.prepare("SELECT element_id FROM chat_session_elements WHERE session_id=?").get(id)?.element_id || null };
  }
  function snapshot(id) {
    const e = wiki.get(id);
    if (e.kind === "video") throw elementError("视频暂不支持作为 Agent 参考，请使用关联文字或截图");
    const version = db.prepare("SELECT content_version FROM elements WHERE id=?").get(id).content_version;
    // Adding an archive's factual reference does not edit the referenced content.
    const relations = db.prepare(`SELECT id,source_id,target_id,kind,name,direction,reverse_name FROM canonical_element_relations r
      WHERE (source_id=? OR target_id=?) AND NOT EXISTS (SELECT 1 FROM element_provenance p WHERE p.relation_id=r.id) ORDER BY id`).all(id, id)
      .map(({ direction, reverse_name, ...row }) => Math.abs(direction) === 1 ? { ...row, direction, reverse_name } : row);
    return { id, kind: e.kind, label: e.kind === "image" ? e.image.originalName : e.body.slice(0, 70), body: e.body, tags: e.tags,
      ...(e.record ? { record: { kind: e.record.kind, sessionId: e.record.sessionId, turnId: e.record.turnId, model: e.record.model, text: e.record.text, parameters: e.record.parameters } } : {}),
      fingerprint: hash({ version, body: e.body, tags: e.tags, relations, ...(e.record ? { record: e.record } : {}) }) };
  }
  function unchanged(snapshots) {
    for (const source of snapshots) {
      let current; try { current = snapshot(source.id); } catch { throw elementError("引用内容已删除或移入回收站，请重新读取后生成建议", 409); }
      if (current.fingerprint !== source.fingerprint) throw Object.assign(elementError(`引用内容 wiki:${source.id} 已有修改，请重新读取后生成建议`, 409), { code: "CHAT_SOURCE_CHANGED" });
    }
  }
  function excerptText(source, excerpt) {
    if (excerpt.role === "tool") {
      const text = source.events.find((e) => e.id === excerpt.eventId)?.parameters?.[excerpt.field];
      return typeof text === "string" ? text : "";
    }
    return excerpt.role === "user" ? source.text : source.answer;
  }
  const turnSelect = `SELECT t.*, (SELECT json_group_object(record_key,version) FROM chat_trace_records WHERE turn_id=t.id) AS trace_versions FROM chat_turns t`;
  function turn(id) {
    const row = db.prepare(`${turnSelect} WHERE id=?`).get(id);
    if (!row) throw elementError("消息不存在", 404);
    return turnFromRow(row);
  }
  // One query for a page of turns instead of one per turn.
  function turns(ids) {
    if (!ids.length) return [];
    const rows = new Map(db.prepare(`${turnSelect} WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)).map((row) => [row.id, row]));
    return ids.map((id) => { if (!rows.has(id)) throw elementError("消息不存在", 404); return turnFromRow(rows.get(id)); });
  }
  function turnFromRow(row) {
    const traceVersions = JSON.parse(row.trace_versions || "{}");
    return { id: row.id, sessionId: row.session_id, requestKey: row.request_key, turnId: row.codex_turn_id, model: row.model, effort: row.effort, text: row.text, answer: row.answer, internal: Boolean(row.internal),
      parentTurnId: row.parent_turn_id, updatedAt: row.updated_at, requestTraceVersion: traceVersions.request || 0, directImage: Boolean(row.direct_image),
      imageOptions: JSON.parse(row.image_options || "null"),
      state: states[row.state], inputSources: JSON.parse(row.input_sources), inputAttachments: JSON.parse(row.input_attachments || "[]"), imageEdit: JSON.parse(row.image_edit || "null"), sources: JSON.parse(row.sources),
      events: JSON.parse(row.events).map((event) => traceVersions[`tool:${event.id}`] ? { ...event, detailVersion: traceVersions[`tool:${event.id}`] } : event), error: row.error, createdAt: row.created_at };
  }
  function proposal(id) {
    const row = db.prepare("SELECT * FROM chat_proposals WHERE id=?").get(id);
    if (!row) throw elementError("建议不存在", 404);
    return proposalFromRow(row);
  }
  function proposalFromRow(row) {
    return { id: row.id, turnId: row.turn_id, state: proposalStates[row.state], payload: JSON.parse(row.payload), snapshots: JSON.parse(row.snapshots), changes: JSON.parse(row.changes), after: JSON.parse(row.after_snapshots) };
  }
  function checkBranch(info, revision) {
    if (revision !== undefined && info.branchRevision !== revision) throw elementError("会话已切换版本，请查看当前消息后重试", 409);
  }
  function path(id, head = session(id).activeTurnId) { return chatPathIds(db, id, head); }
  function visibleTurn(id) {
    const value = turn(id);
    if (value.internal || !path(value.sessionId).includes(id)) throw elementError("消息不在当前会话版本中", 409);
    return value;
  }
  return {
    session, turn, snapshot, unchanged, proposal, visibleTurn,
    imagePreference() { return JSON.parse(db.prepare("SELECT data FROM chat_image_preferences WHERE id=1").get()?.data || "null"); },
    setImagePreference(options) {
      return transaction(() => {
        db.prepare("INSERT INTO chat_image_preferences(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(JSON.stringify(options));
        if (options.executor === "comfyui" && options.workflowId) db.prepare("UPDATE chat_image_workflows SET options=? WHERE id=?").run(JSON.stringify(options), options.workflowId);
        return options;
      });
    },
    setImageOptions(id, options, revision) {
      return transaction(() => {
        const info = session(id);
        if (info.imageOptionsRevision !== revision) throw elementError("生图选项已在其他窗口修改，请重新打开会话", 409);
        if (db.prepare("SELECT 1 FROM chat_turns WHERE session_id=? AND state=0").get(id)) throw elementError("请等待当前生成结束后调整生图选项", 409);
        const result = db.prepare("UPDATE chat_sessions SET image_options=?,image_options_revision=image_options_revision+1 WHERE id=? AND image_options_revision=?").run(JSON.stringify(options), id, revision);
        if (!result.changes) throw elementError("生图选项已改变，请重试", 409);
        this.setImagePreference(options);
        return session(id);
      });
    },
    cacheImageWorkflow(value) {
      const digest = hash(value);
      db.prepare("INSERT INTO chat_image_workflows(digest,data) VALUES(?,?) ON CONFLICT(digest) DO NOTHING").run(digest, JSON.stringify(value));
      return this.imageWorkflow(db.prepare("SELECT id FROM chat_image_workflows WHERE digest=?").get(digest).id);
    },
    imageWorkflow(id) {
      const row = db.prepare("SELECT data,options FROM chat_image_workflows WHERE id=?").get(id);
      if (!row) throw elementError("工作流记录不存在，请重新选择", 404);
      return { id, ...JSON.parse(row.data), options: JSON.parse(row.options || "null") };
    },
    attachment(id) {
      const value = db.prepare("SELECT id,artifact,label FROM chat_attachments WHERE id=?").get(id);
      if (!value) throw elementError("聊天附件不存在，请重新粘贴图片", 404);
      return value;
    },
    addAttachment(artifact, label) {
      const id = Number(db.prepare("INSERT INTO chat_attachments(artifact,label) VALUES(?,?)").run(artifact, label).lastInsertRowid);
      return { id, artifact, label };
    },
    removeAttachment(id) {
      return transaction(() => {
        const value = db.prepare("SELECT artifact FROM chat_attachments WHERE id=?").get(id);
        if (!value) return true;
        if (db.prepare("SELECT 1 FROM chat_turns,json_each(input_attachments) WHERE json_extract(value,'$.id')=? LIMIT 1").get(id)) return false;
        db.prepare("INSERT OR IGNORE INTO chat_file_cleanup(name) VALUES(?)").run(value.artifact);
        db.prepare("DELETE FROM chat_attachments WHERE id=?").run(id);
        return true;
      });
    },
    trace(turnId, key) {
      const row = db.prepare("SELECT data,version FROM chat_trace_records WHERE turn_id=? AND record_key=?").get(turnId, key);
      return row ? { version: row.version, status: row.data === null ? "deleted" : "recorded", record: row.data === null ? null : JSON.parse(row.data) } : null;
    },
    writeTrace(turnId, key, data, sourceIds = [], historyTurnIds = []) {
      const row = db.prepare(`INSERT INTO chat_trace_records(turn_id,record_key,data,source_ids,history_turn_ids) VALUES(?,?,?,?,?)
        ON CONFLICT(turn_id,record_key) DO UPDATE SET data=excluded.data,source_ids=excluded.source_ids,history_turn_ids=excluded.history_turn_ids,version=chat_trace_records.version+1
        WHERE chat_trace_records.data IS NOT NULL RETURNING version`).get(turnId, key, JSON.stringify(data), JSON.stringify(sourceIds), JSON.stringify(historyTurnIds));
      if (!row) throw elementError("本轮调用记录已随来源内容清理，不能重新写入", 409);
      return row.version;
    },
    webConversation(id, revision) {
      return db.prepare("SELECT conversation_url AS url FROM chat_web_conversations WHERE session_id=? AND branch_revision=?").get(id, revision)?.url || "";
    },
    bindWebConversation(id, revision, url) {
      if (!/^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(url)) throw elementError("无效的网页会话地址");
      const result = db.prepare(`INSERT INTO chat_web_conversations(session_id,branch_revision,conversation_url)
        SELECT id,branch_revision,? FROM chat_sessions WHERE id=? AND branch_revision=?
        ON CONFLICT(session_id) DO UPDATE SET branch_revision=excluded.branch_revision,conversation_url=excluded.conversation_url`).run(url, id, revision);
      if (result.changes !== 1) throw elementError("会话版本已改变，无法绑定网页会话", 409);
    },
    history(id, head = session(id).activeTurnId) { return path(id, head).map(turn); },
    recover() { db.prepare("UPDATE chat_turns SET state=2,error='应用已重启，上次生成中断；可继续发送消息',updated_at=? WHERE state=0").run(Date.now()); },
    list(before = Number.MAX_SAFE_INTEGER) {
      const rows = db.prepare("SELECT id FROM chat_sessions WHERE id<? ORDER BY id DESC LIMIT 31").all(before);
      return { sessions: rows.slice(0, 30).map(({ id }) => session(id)), hasMore: rows.length > 30 };
    },
    activity() {
      return db.prepare(`SELECT s.id,t.id AS turnId,t.state FROM chat_sessions s LEFT JOIN chat_turns t
        ON t.id=(SELECT id FROM chat_turns WHERE session_id=s.id AND internal=0 ORDER BY id DESC LIMIT 1)`)
        .all().map((row) => ({ id: row.id, turnId: row.turnId, state: states[row.state] || null }));
    },
    modelPreference() {
      return db.prepare("SELECT model,effort FROM chat_model_preferences WHERE id=1").get() || { model: "", effort: "" };
    },
    setModelPreference(model, effort) {
      db.prepare(`INSERT INTO chat_model_preferences(id,model,effort) VALUES(1,?,?)
        ON CONFLICT(id) DO UPDATE SET model=excluded.model,effort=excluded.effort`).run(model, effort);
      return { model, effort };
    },
    create(title) {
      return transaction(() => {
        const now = Date.now(), name = title || "新会话";
        const preference = db.prepare("SELECT model,effort FROM chat_model_preferences WHERE id=1").get();
        const id = Number(db.prepare("INSERT INTO chat_sessions(title,model,effort,created_at,updated_at) VALUES(?,?,?,?,?)").run(name, preference?.model ?? "", preference?.effort ?? "", now, now).lastInsertRowid);
        db.prepare("UPDATE chat_sessions SET image_options=(SELECT data FROM chat_image_preferences WHERE id=1) WHERE id=?").run(id);
        const element = wiki.createRecord("session", name, { kind: "session", sessionId: id });
        db.prepare("INSERT INTO chat_session_elements(session_id,element_id) VALUES(?,?)").run(id, element.id);
        return session(id);
      });
    },
    setThread(id, threadId) { db.prepare("UPDATE chat_sessions SET codex_thread_id=? WHERE id=?").run(threadId, id); },
    start(input) {
      return transaction(() => {
        const previous = db.prepare("SELECT session_id FROM chat_session_starts WHERE request_key=?").get(input.requestKey);
        if (previous) return this.begin(previous.session_id, input);
        const created = this.create();
        const result = this.begin(created.id, input);
        db.prepare("INSERT INTO chat_session_starts(request_key,session_id) VALUES(?,?)").run(input.requestKey, created.id);
        return result;
      });
    },
    setDraft(id, draft) {
      const result = db.prepare("UPDATE chat_sessions SET draft_text=?,draft_revision=? WHERE id=? AND draft_revision<?")
        .run(draft.text, draft.revision, id, draft.revision);
      if (result.changes) return draft;
      const current = session(id).draft;
      if (current.revision === draft.revision && current.text !== draft.text) throw elementError("草稿已在其他窗口修改，请重新打开会话", 409);
      return current;
    },
    newDraft() {
      return JSON.parse(db.prepare("SELECT data FROM chat_new_draft WHERE id=1").get()?.data || '{"text":"","revision":1,"sources":[],"attachments":[]}');
    },
    setNewDraft(value) {
      const data = JSON.stringify(value);
      const result = db.prepare(`INSERT INTO chat_new_draft(id,data,revision) VALUES(1,?,?)
        ON CONFLICT(id) DO UPDATE SET data=excluded.data,revision=excluded.revision WHERE chat_new_draft.revision<excluded.revision`).run(data, value.revision);
      if (result.changes) return value;
      const current = this.newDraft();
      if (current.revision === value.revision && JSON.stringify(current) !== data) throw elementError("草稿已在其他窗口修改，请重新打开会话", 409);
      return current;
    },
    setImageDraft(id, value) {
      const attachments = JSON.stringify(value.attachments);
      const result = db.prepare("UPDATE chat_sessions SET draft_attachments=?,draft_attachments_revision=? WHERE id=? AND draft_attachments_revision<?")
        .run(attachments, value.revision, id, value.revision);
      if (result.changes) return value;
      const current = session(id).imageDraft;
      if (current.revision === value.revision && JSON.stringify(current.attachments) !== attachments) throw elementError("图片草稿已在其他窗口修改，请重新打开会话", 409);
      return current;
    },
    setModel(id, model, effort) {
      return transaction(() => {
        const info = session(id);
        if (db.prepare("SELECT 1 FROM chat_turns WHERE session_id=? AND state=0").get(id)) throw elementError("请等待当前生成结束后切换模型", 409);
        const nextEffort = effort ?? (model === info.model ? info.effort : "");
        db.prepare("UPDATE chat_sessions SET model=?,effort=?,updated_at=? WHERE id=?").run(model, nextEffort, Date.now(), id);
        // Remember explicit picker changes, independently of activity in older sessions.
        this.setModelPreference(model, nextEffort);
      });
    },
    detail(id, before = Number.MAX_SAFE_INTEGER, head = session(id).activeTurnId) {
      const info = session(id);
      const ids = path(id, head).filter((turnId) => turnId < before);
      const page = turns(ids.slice(-20));
      // Sibling versions for every turn on the page in a single query.
      const siblings = new Map();
      if (page.length) {
        for (const row of db.prepare(`SELECT id,parent_turn_id FROM chat_turns WHERE session_id=? AND internal=0
          AND (parent_turn_id IN (SELECT value FROM json_each(?)) OR (parent_turn_id IS NULL AND ?)) ORDER BY id`)
          .all(id, JSON.stringify(page.map((t) => t.parentTurnId).filter((value) => value !== null)), Number(page.some((t) => t.parentTurnId === null)))) {
          const key = row.parent_turn_id ?? "root";
          if (!siblings.has(key)) siblings.set(key, []);
          siblings.get(key).push(row.id);
        }
      }
      const pageTurns = page.map((value) => ({ ...value, versions: siblings.get(value.parentTurnId ?? "root") || [] }));
      const proposals = pageTurns.length ? db.prepare("SELECT * FROM chat_proposals WHERE turn_id IN (SELECT value FROM json_each(?)) ORDER BY id DESC")
        .all(JSON.stringify(pageTurns.map((t) => t.id))).map(proposalFromRow) : [];
      return { session: info, turns: pageTurns, proposals, hasOlder: ids.length > 20 };
    },
    promptContext(turnId) {
      const target = turn(turnId);
      const ids = path(target.sessionId, turnId);
      const earlier = ids.slice(0, -20).map(turn).filter((t) => t.sources.length).slice(-12);
      return { history: ids.slice(-20).map(turn), earlierSources: earlier.flatMap((t) => t.sources) };
    },
    begin(id, input, internal = false, editTurnId = null) {
      return transaction(() => {
        const info = session(id);
        const digest = hash(editTurnId ? { ...input, editTurnId } : input), previous = db.prepare("SELECT id,payload_hash FROM chat_turns WHERE session_id=? AND request_key=?").get(id, input.requestKey);
        if (previous) { if (previous.payload_hash !== digest) throw elementError("消息标识已用于不同内容", 409); return { turn: turn(previous.id), existing: true }; }
        checkBranch(info, input.branchRevision);
        if (db.prepare("SELECT 1 FROM chat_turns WHERE session_id=? AND state=0").get(id)) throw elementError("当前会话正在生成，请先停止或等待完成", 409);
        const edited = editTurnId ? visibleTurn(editTurnId) : null;
        if (edited && edited.sessionId !== id) throw elementError("消息不属于当前会话", 400);
        const parentId = edited ? edited.parentTurnId : internal && input.contextTurnId ? input.contextTurnId : info.activeTurnId;
        if (parentId && turn(parentId).sessionId !== id) throw elementError("前文不属于当前会话", 400);
        if (input.imageEdit) {
          const source = turn(input.imageEdit.turnId);
          if (source.sessionId !== id || !path(id, parentId).includes(source.id) || !source.events.some((event) => event.artifact === input.imageEdit.artifact)) throw elementError("待编辑图片不属于当前会话前文", 400);
        }
        const now = Date.now();
        const model = input.model ?? info.model;
        const effort = input.effort ?? (model === info.model ? info.effort : "");
        const attachments = (input.attachmentIds || []).map((attachmentId) => this.attachment(attachmentId));
        const inputSources = input.sourceIds.map((sourceId) => wiki.get(sourceId));
        if (inputSources.some((source) => source.kind === "video")) throw elementError("视频暂不支持作为 Agent 参考，请使用关联文字或截图");
        checkChatImageCount(inputSources, attachments, input.imageEdit);
        if (!input.text.trim() && !attachments.length && !input.imageEdit && !input.sourceIds.some((sourceId) => { const source = wiki.get(sourceId); return source.kind === "image" || input.directImage && source.body.trim(); })) throw elementError("请输入文字或添加图片");
        const turnId = Number(db.prepare("INSERT INTO chat_turns(session_id,request_key,payload_hash,text,input_sources,image_edit,model,created_at,updated_at,internal,parent_turn_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
          .run(id, input.requestKey, digest, input.text, JSON.stringify(input.sourceIds), input.imageEdit ? JSON.stringify(input.imageEdit) : null, model, now, now, Number(internal), parentId).lastInsertRowid);
        db.prepare("UPDATE chat_turns SET effort=? WHERE id=?").run(effort, turnId);
        if (input.imageOptions) db.prepare("UPDATE chat_turns SET image_options=? WHERE id=?").run(JSON.stringify(input.imageOptions), turnId);
        if (input.directImage) db.prepare("UPDATE chat_turns SET direct_image=1 WHERE id=?").run(turnId);
        if (attachments.length) db.prepare("UPDATE chat_turns SET input_attachments=? WHERE id=?").run(JSON.stringify(attachments), turnId);
        if (!internal) {
          if (input.imageOptions && !edited) {
            db.prepare("UPDATE chat_sessions SET image_options=?,image_options_revision=image_options_revision+1 WHERE id=?").run(JSON.stringify(input.imageOptions), id);
            this.setImagePreference(input.imageOptions);
          }
          db.prepare("UPDATE chat_sessions SET effort=? WHERE id=?").run(effort, id);
          if (parentId) db.prepare("UPDATE chat_turns SET selected_child_id=? WHERE id=?").run(turnId, parentId);
          db.prepare("UPDATE chat_sessions SET active_turn_id=? WHERE id=?").run(turnId, id);
          if (edited) db.prepare("UPDATE chat_sessions SET codex_thread_id=NULL,branch_revision=branch_revision+1 WHERE id=?").run(id);
          db.prepare("UPDATE chat_sessions SET title=CASE WHEN title='新会话' THEN ? ELSE title END,model=?,updated_at=? WHERE id=?").run(input.text.slice(0, 40) || "图片会话", model, now, id);
          // Clear only the submitted text, atomically with the new turn. Delayed saves cannot restore it.
          if (!edited && !input.imageEdit && info.draft.text && info.draft.text.trim() === input.text.trim()) {
            db.prepare("UPDATE chat_sessions SET draft_text='',draft_revision=draft_revision+1 WHERE id=?").run(id);
          }
          if (!edited && attachments.length) {
            const remaining = info.imageDraft.attachments.filter((image) => !input.attachmentIds.includes(image.id));
            db.prepare("UPDATE chat_sessions SET draft_attachments=?,draft_attachments_revision=draft_attachments_revision+1 WHERE id=?")
              .run(JSON.stringify(remaining), id);
          }
          db.prepare("UPDATE elements SET body=? WHERE id=?").run(session(id).title, info.elementId);
        }
        return { turn: turn(turnId), existing: false };
      });
    },
    selectVersion(turnId, revision) {
      return transaction(() => {
        const target = turn(turnId), info = session(target.sessionId);
        checkBranch(info, revision);
        if (target.internal) throw elementError("不能切换到内部消息", 400);
        if (db.prepare("SELECT 1 FROM chat_turns WHERE session_id=? AND state=0").get(info.id)) throw elementError("请等待当前生成结束后切换版本", 409);
        // Restore the remembered continuation beneath this version, including
        // nested edits, and remember all choices leading to the selected turn.
        const ancestors = path(info.id, target.id);
        for (let i = 1; i < ancestors.length; i++) db.prepare("UPDATE chat_turns SET selected_child_id=? WHERE id=?").run(ancestors[i], ancestors[i - 1]);
        let head = target.id;
        while (true) {
          const child = db.prepare(`SELECT c.id FROM chat_turns p JOIN chat_turns c ON c.id=p.selected_child_id
            WHERE p.id=? AND c.parent_turn_id=p.id AND c.session_id=? AND c.internal=0 AND c.id>p.id`).get(head, info.id);
          if (!child) break;
          head = child.id;
        }
        if (head !== info.activeTurnId) db.prepare("UPDATE chat_sessions SET active_turn_id=?,codex_thread_id=NULL,branch_revision=branch_revision+1,updated_at=? WHERE id=?").run(head, Date.now(), info.id);
        return session(info.id);
      });
    },
    fork(turnId, requestKey, revision) {
      return transaction(() => {
        const previous = db.prepare("SELECT source_turn_id,session_id FROM chat_forks WHERE request_key=?").get(requestKey);
        if (previous) {
          if (previous.source_turn_id !== turnId) throw elementError("请求标识已用于其他分支", 409);
          return session(previous.session_id);
        }
        const target = visibleTurn(turnId), info = session(target.sessionId);
        checkBranch(info, revision);
        if (db.prepare("SELECT 1 FROM chat_turns WHERE session_id=? AND state=0").get(info.id)) throw elementError("请等待当前生成结束后创建分支", 409);
        const created = this.create(`${info.title.slice(0, 70)} · 分支`), ids = path(info.id, turnId), copies = new Map();
        let parentId = null;
        // The prefix and its new IDs are one atomic snapshot. Proposals are
        // actions belonging to the original chat and must not be duplicated.
        for (const sourceId of ids) {
          const source = turn(sourceId);
          const imageEdit = source.imageEdit && { ...source.imageEdit, turnId: copies.get(source.imageEdit.turnId) || source.imageEdit.turnId };
          const copyId = Number(db.prepare(`INSERT INTO chat_turns(session_id,request_key,payload_hash,text,answer,state,input_sources,sources,events,error,model,image_edit,created_at,updated_at,parent_turn_id)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(created.id, `fork-${sourceId}`, hash({ sourceId, sessionId: created.id }), source.text, source.answer, states.indexOf(source.state),
            JSON.stringify(source.inputSources), JSON.stringify(source.sources), JSON.stringify(source.events), source.error, source.model, imageEdit ? JSON.stringify(imageEdit) : null, source.createdAt, source.updatedAt, parentId).lastInsertRowid);
          db.prepare("UPDATE chat_turns SET effort=? WHERE id=?").run(source.effort, copyId);
          if (source.imageOptions) db.prepare("UPDATE chat_turns SET image_options=? WHERE id=?").run(JSON.stringify(source.imageOptions), copyId);
          if (source.directImage) db.prepare("UPDATE chat_turns SET direct_image=1 WHERE id=?").run(copyId);
          if (source.inputAttachments.length) db.prepare("UPDATE chat_turns SET input_attachments=? WHERE id=?").run(JSON.stringify(source.inputAttachments), copyId);
          copies.set(sourceId, copyId);
          db.prepare(`INSERT INTO chat_trace_records(turn_id,record_key,data,version,source_ids,history_turn_ids)
            SELECT ?,record_key,data,version,source_ids,
              (SELECT json_group_array(coalesce(json_extract(?, '$."' || value || '"'),value)) FROM json_each(history_turn_ids))
            FROM chat_trace_records WHERE turn_id=?`).run(copyId, JSON.stringify(Object.fromEntries(copies)), sourceId);
          if (parentId) db.prepare("UPDATE chat_turns SET selected_child_id=? WHERE id=?").run(copyId, parentId);
          parentId = copyId;
        }
        db.prepare("UPDATE chat_sessions SET active_turn_id=?,model=?,effort=? WHERE id=?").run(parentId, info.model, info.effort, created.id);
        db.prepare("UPDATE chat_sessions SET image_options=? WHERE id=?").run(JSON.stringify(target.imageOptions || info.imageOptions), created.id);
        db.prepare("INSERT INTO chat_forks(request_key,source_turn_id,session_id) VALUES(?,?,?)").run(requestKey, turnId, created.id);
        return session(created.id);
      });
    },
    updateTurn(value) {
      const result = db.prepare("UPDATE chat_turns SET codex_turn_id=?,model=?,effort=?,answer=?,state=?,sources=?,events=?,error=?,updated_at=? WHERE id=? AND state=0")
        .run(value.turnId || null, value.model, value.effort || "", value.answer, states.indexOf(value.state), JSON.stringify(value.sources), JSON.stringify(value.events), value.error || "", Date.now(), value.id);
      if (!result.changes) throw elementError("此轮已结束", 409);
    },
    propose(turnId, requestKey, payload, snapshots, limit = 20) {
      return transaction(() => {
        const current = turn(turnId);
        if (payload.excerpts) payload = { ...payload, excerpts: payload.excerpts.map((excerpt) => {
          const source = turn(excerpt.turnId);
          if (source.sessionId !== current.sessionId || source.id >= current.id || source.state === "running" || !path(current.sessionId, current.id).includes(source.id)) throw elementError("提取依据必须来自当前会话已结束的前文", 400);
          const text = excerptText(source, excerpt);
          const start = excerpt.start ?? text.indexOf(excerpt.quote);
          if (start < 0 || text.slice(start, start + excerpt.quote.length) !== excerpt.quote || excerpt.start === undefined && text.indexOf(excerpt.quote, start + 1) !== -1) throw elementError("无法唯一定位提取原文，请重新读取或明确片段位置", 400);
          return { ...excerpt, start, end: start + excerpt.quote.length, version: hash(text) };
        }) };
        const prior = db.prepare("SELECT id,payload FROM chat_proposals WHERE turn_id=? AND request_key=?").get(turnId, requestKey);
        if (prior) { if (prior.payload !== JSON.stringify(payload)) throw elementError("建议标识已用于不同内容", 409); return proposal(prior.id); }
        unchanged(snapshots);
        if (db.prepare("SELECT count(*) n FROM chat_proposals WHERE turn_id=?").get(turnId).n >= limit) throw elementError(`本轮建议已达 ${limit} 个上限`);
        return proposal(Number(db.prepare("INSERT INTO chat_proposals(turn_id,request_key,payload,snapshots,created_at) VALUES(?,?,?,?,?)")
          .run(turnId, requestKey, JSON.stringify(payload), JSON.stringify(snapshots), Date.now()).lastInsertRowid));
      });
    },
    accept(id, edit, onCreate) {
      return transaction(() => {
        const p = proposal(id);
        if (p.state === "accepted") return p;
        if (p.state !== "pending") throw elementError("此建议已处理", 409);
        unchanged(p.snapshots);
        for (const excerpt of p.payload.excerpts || []) {
          if (hash(excerptText(turn(excerpt.turnId), excerpt)) !== excerpt.version) throw elementError("提取原文已删除或变化，请重新提取", 409);
        }
        const payload = p.payload, changes = { relationIds: [], addedTags: [] }, affected = new Set(p.snapshots.map((s) => s.id));
        if (payload.kind === "create_text") {
          const content = elementContent({ body: edit?.body ?? payload.body, tags: edit?.tags ?? payload.tags });
          const created = wiki.createText({ ...content, creationSource: "chat" }); changes.createdId = created.id; affected.add(created.id);
          payload.body = content.body; payload.tags = content.tags;
          for (const sourceId of payload.sourceIds) {
            const relation = wiki.relate(created.id, sourceId, "related", "参考了", { direction: "forward", reverseName: "被参考" });
            changes.relationIds.push(relation.id);
            db.prepare("INSERT INTO element_provenance(relation_id) VALUES(?)").run(relation.id);
          }
          onCreate?.(turn(p.turnId), payload, created.id);
        } else if (payload.kind === "add_tags") {
          const e = wiki.get(payload.elementId), old = new Set(e.tags.map((t) => t.toLowerCase()));
          changes.elementId = e.id; changes.addedTags = wiki.vocabulary.tags(payload.tags).filter((t) => !old.has(t));
          wiki.update(e.id, { body: e.body, tags: elementTags([...e.tags, ...payload.tags]) });
        } else {
          const old = wiki.findRelation(payload.sourceId, payload.targetId, "related", payload.name, payload);
          const relation = wiki.relate(payload.sourceId, payload.targetId, "related", payload.name, payload);
          if (!old) changes.relationIds.push(relation.id);
        }
        const after = [...affected].map(snapshot);
        if (!db.prepare("UPDATE chat_proposals SET state=1,payload=?,changes=?,after_snapshots=? WHERE id=? AND state=0")
          .run(JSON.stringify(payload), JSON.stringify(changes), JSON.stringify(after), id).changes) throw elementError("建议已被处理", 409);
        // Earlier accepted suggestions from this same turn may add a source relation/tag.
        // Advance only matching baselines; intervening edits by other actors remain conflicts.
        for (const row of db.prepare("SELECT id,snapshots FROM chat_proposals WHERE turn_id=? AND state=0").all(p.turnId)) {
          const sources = JSON.parse(row.snapshots).map((s) => p.snapshots.some((old) => old.id === s.id && old.fingerprint === s.fingerprint) ? after.find((current) => current.id === s.id) || s : s);
          db.prepare("UPDATE chat_proposals SET snapshots=? WHERE id=?").run(JSON.stringify(sources), row.id);
        }
        return proposal(id);
      });
    },
    reject(id) {
      const p = proposal(id);
      if (p.state === "rejected") return p;
      if (p.state !== "pending") throw elementError("此建议已处理", 409);
      if (!db.prepare("UPDATE chat_proposals SET state=2 WHERE id=? AND state=0").run(id).changes) throw elementError("建议已被处理", 409);
      return proposal(id);
    },
    undo(id) {
      return transaction(() => {
        const p = proposal(id); if (p.state === "undone") return p;
        if (p.state !== "accepted") throw elementError("只有已采纳建议可以撤销", 409);
        unchanged(p.after);
        for (const relationId of p.changes.relationIds) db.prepare("DELETE FROM element_relations WHERE id=?").run(relationId);
        if (p.changes.addedTags.length) {
          const e = wiki.get(p.changes.elementId), remove = new Set(p.changes.addedTags.map((t) => t.toLowerCase()));
          wiki.update(e.id, { body: e.body, tags: e.tags.filter((t) => !remove.has(t.toLowerCase())) });
        }
        if (p.changes.createdId) wiki.trash(p.changes.createdId);
        if (!db.prepare("UPDATE chat_proposals SET state=3 WHERE id=? AND state=1").run(id).changes) throw elementError("建议已被处理", 409);
        return proposal(id);
      });
    },
  };
}
