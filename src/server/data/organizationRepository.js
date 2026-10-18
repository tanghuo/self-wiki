import { relationDirection } from "./relationDirection.js";
import { createHash, randomUUID } from "node:crypto";
import { elementError, elementTags, relationName } from "../../shared/domain/elements.js";
import { createElementRepository } from "./elementRepository.js";
import { textSimilarityCandidates } from "./textSimilarityCandidates.js";

const states = ["queued", "running", "succeeded", "failed", "cancelled"];
const fail = (message, status = 409) => { throw elementError(message, status); };
const keyOf = (source, action) => action.kind === "tag" ? `tag:${source}:${action.name.toLowerCase()}`
  : `relation:${Math.min(source, action.targetId)}:${Math.max(source, action.targetId)}:${action.name}`;

export function createOrganizationRepository(db) {
  const wiki = createElementRepository(db);
  let textCandidatesCache;
  function rejected(source, action) {
    const names = action.kind === "tag"
      ? db.prepare("SELECT t.name FROM tags t JOIN resolved_tags c ON c.id=t.id WHERE c.normalized_name=?").all(wiki.vocabulary.tag(action.name)?.normalizedName ?? action.name.toLowerCase()).map((t) => t.name)
      : (() => {
        const term = wiki.vocabulary.relation(action);
        return db.prepare(`SELECT t.name FROM relation_terms t JOIN resolved_relation_terms c ON c.id=t.id
          WHERE c.name=? AND c.reverse_name=? AND c.directed=?`).all(term.name, term.reverseName, Number(term.direction !== "symmetric")).map((t) => t.name);
      })();
    return Boolean(db.prepare("SELECT 1 FROM organization_rejections WHERE action_key IN(SELECT value FROM json_each(?))")
      .get(JSON.stringify([...names, action.name].map((name) => keyOf(source, { ...action, name })))));
  }
  const epoch = () => db.prepare("SELECT epoch FROM organization_state WHERE id=1").get().epoch;
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function job(id) {
    const row = db.prepare("SELECT * FROM organization_jobs WHERE id=?").get(id);
    if (!row) fail("整理任务不存在", 404);
    return row;
  }
  function publicJob(row) {
    return { id: row.id, elementId: row.element_id, state: states[row.state], attempts: row.attempts,
      error: row.error, createdAt: row.created_at, finishedAt: row.finished_at };
  }
  function leased(id, token) {
    const row = job(id);
    if (row.state !== 1 || row.lease_token !== token || row.lease_until <= Date.now()) fail("整理任务租约已失效");
    const element = db.prepare("SELECT content_version,deleted_at,local_only FROM elements WHERE id=?").get(row.element_id);
    if (!element || element.deleted_at || element.local_only || element.content_version !== row.content_version) fail("内容已改变，请重新整理");
    return row;
  }
  function result(id) {
    const row = db.prepare("SELECT r.*,j.element_id FROM organization_results r JOIN organization_jobs j ON j.id=r.job_id WHERE r.id=?").get(id);
    if (!row) fail("整理结果不存在", 404);
    const bindings = db.prepare("SELECT action_index,modified FROM organization_bindings WHERE result_id=?").all(id);
    const actions = JSON.parse(row.actions).map((action, index) => ({ ...action,
      editable: Boolean(row.tracked && bindings.some((b) => b.action_index === index && !b.modified)) }));
    return { ...row, actions, changes: JSON.parse(row.changes),
      context: JSON.parse(row.context), execution: JSON.parse(row.execution), undone: Boolean(row.undone) };
  }
  function applyActions(sourceId, actions, indices, resultId) {
    const changes = [];
    for (const index of indices) {
      const action = actions[index];
      if (!action || action.state !== "suggested") continue;
      if (rejected(sourceId, action)) {
        action.state = "rejected"; action.note = "已被人工否定"; continue;
      }
      if (action.kind === "tag") {
        const added = wiki.addTag(sourceId, action.name);
        if (added.status === "existing") { action.state = "existing"; continue; }
        if (added.status === "limit") {
          action.note = "标签已达上限，请先减少标签"; continue;
        }
        const { tagId } = added;
        changes.push({ kind: "tag", elementId: sourceId, tagId });
        db.prepare("INSERT INTO organization_bindings(result_id,action_index,element_id,tag_id) VALUES(?,?,?,?)").run(resultId, index, sourceId, tagId);
      } else {
        const { created, relation } = wiki.relateWithChange(sourceId, action.targetId, "related", action.name, action);
        if (!created) { action.state = "existing"; continue; }
        changes.push({ kind: "relation", id: relation.id });
        db.prepare("INSERT INTO organization_bindings(result_id,action_index,element_id,relation_id) VALUES(?,?,?,?)").run(resultId, index, sourceId, relation.id);
      }
      action.state = "applied";
    }
    return changes;
  }
  function removeBinding(resultId, index) {
    const binding = db.prepare("SELECT * FROM organization_bindings WHERE result_id=? AND action_index=? AND modified=0").get(resultId, index);
    if (!binding) return false;
    const write = binding.tag_id !== null
      ? db.prepare("DELETE FROM element_tags WHERE element_id=? AND tag_id=?").run(binding.element_id, binding.tag_id)
      : db.prepare("DELETE FROM element_relations WHERE id=?").run(binding.relation_id);
    return Boolean(write.changes);
  }
  return {
    revision() { return { revision: epoch() }; },
    hasPending() {
      return Boolean(db.prepare(`SELECT 1 FROM organization_jobs j,organization_state s
        WHERE j.state IN(0,1) AND (j.manual=1 OR s.enabled=1) LIMIT 1`).get());
    },
    configure(enabled) {
      transaction(() => {
        db.prepare("UPDATE organization_state SET enabled=? WHERE id=1").run(Number(enabled));
        // Backfill videos once, including libraries upgraded with organization disabled.
        // A failed/rejected/cancelled job remains a record; restarting must not resubmit it.
        if (enabled) db.prepare(`INSERT INTO organization_jobs(element_id,content_version,created_at)
          SELECT e.id,e.content_version,? FROM elements e JOIN element_videos v ON v.element_id=e.id
          WHERE e.kind=5 AND e.local_only=0 AND e.deleted_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM organization_jobs j WHERE j.element_id=e.id AND j.content_version=e.content_version)
          ORDER BY e.id`).run(Date.now());
        // Configuration changes invalidate all old executions, including explicit/manual jobs.
        db.prepare("UPDATE organization_jobs SET state=0,lease_token=NULL,lease_until=NULL,context=NULL WHERE state=1").run();
      });
    },
    enqueue(elementId) {
      return transaction(() => {
        const element = wiki.get(elementId);
        if (!["text", "image", "video"].includes(element.kind) || element.localOnly) fail("过程与私有来源保留原始记录，无需自动整理", 400);
        const version = db.prepare("SELECT content_version FROM elements WHERE id=?").get(elementId).content_version;
        const active = db.prepare("SELECT * FROM organization_jobs WHERE element_id=? AND content_version=? AND state IN(0,1) ORDER BY id DESC LIMIT 1").get(elementId, version);
        if (active) { db.prepare("UPDATE organization_jobs SET manual=1 WHERE id=?").run(active.id); return publicJob(active); }
        const generation = db.prepare("SELECT coalesce(max(generation),-1)+1 AS n FROM organization_jobs WHERE element_id=? AND content_version=?").get(elementId, version).n;
        const id = db.prepare("INSERT INTO organization_jobs(element_id,content_version,generation,manual,created_at) VALUES(?,?,?,1,?)")
          .run(elementId, version, generation, Date.now()).lastInsertRowid;
        return publicJob(job(id));
      });
    },
    textBatch(after, throughId) {
      throughId ??= db.prepare("SELECT coalesce(max(id),0) AS id FROM elements WHERE kind=1 AND deleted_at IS NULL AND local_only=0").get().id;
      const ids = db.prepare("SELECT id FROM elements WHERE kind=1 AND deleted_at IS NULL AND local_only=0 AND id>? AND id<=? ORDER BY id LIMIT 100")
        .all(after, throughId).map((row) => row.id);
      return { ids, throughId, nextAfter: ids.length === 100 && ids.at(-1) < throughId ? ids.at(-1) : null };
    },
    claim() {
      return transaction(() => {
        const now = Date.now();
        db.prepare("UPDATE organization_jobs SET state=CASE WHEN attempts>=3 THEN 3 ELSE 0 END,lease_token=NULL,context=NULL,error='上次执行中断，等待重试' WHERE state=1 AND lease_until<=?").run(now);
        const row = db.prepare(`SELECT j.* FROM organization_jobs j JOIN elements e ON e.id=j.element_id,organization_state s
          WHERE j.state=0 AND j.available_at<=? AND (j.manual=1 OR s.enabled=1) AND e.deleted_at IS NULL AND e.local_only=0 AND e.content_version=j.content_version ORDER BY j.id LIMIT 1`).get(now);
        if (!row) return null;
        const token = randomUUID();
        db.prepare("UPDATE organization_jobs SET state=1,attempts=attempts+1,lease_token=?,lease_until=?,error='',context=NULL WHERE id=? AND state=0")
          .run(token, now + 90000, row.id);
        return { ...publicJob(job(row.id)), leaseToken: token };
      });
    },
    heartbeat(id, token) {
      return transaction(() => { leased(id, token); db.prepare("UPDATE organization_jobs SET lease_until=? WHERE id=?").run(Date.now() + 90000, id); return { ok: true }; });
    },
    context(id, token, queries = [], semantic = null, imageIds = [], visual = null) {
      // Candidate scanning happens outside the write transaction. Validate the
      // library clock again before attaching these candidates to a leased snapshot.
      const sourceId = leased(id, token).element_id, candidateEpoch = epoch();
      if (textCandidatesCache?.sourceId !== sourceId || textCandidatesCache.epoch !== candidateEpoch) {
        textCandidatesCache = { sourceId, epoch: candidateEpoch, matches: textSimilarityCandidates(db, sourceId) };
      }
      const textMatches = textCandidatesCache.matches;
      return transaction(() => {
        const row = leased(id, token), current = epoch();
        if (candidateEpoch !== current) fail("资料库已变化，请重新分析");
        const prior = row.context ? JSON.parse(row.context) : null;
        if (prior && prior.epoch !== current) fail("资料库已变化，请重新分析");
        const source = wiki.get(row.element_id);
        visual ??= prior?.visual;
        if (imageIds.some((id) => id !== source.id && !prior?.elements.some((e) => e.id === id && ["image", "video"].includes(e.kind)))) fail("请求的图片不属于已读取候选", 400);
        const ranked = new Map();
        const add = (ids, weight = 1) => ids.forEach((elementId, i) => ranked.set(elementId, (ranked.get(elementId) || 0) + weight / (60 + i + 1)));
        const supportedKinds = source.kind === "text" ? ["text", "image"] : ["text", "image", "video"];
        const candidates = (query = {}) => wiki.list({ ...query, supportedKinds });
        const visualIds = [...new Set((visual?.matches || []).filter((m) => ["image", "video"].includes(m.kind)).map((m) => m.elementId))];
        const availableMedia = new Set(db.prepare("SELECT id FROM elements WHERE kind IN(2,5) AND deleted_at IS NULL AND local_only=0 AND id IN(SELECT value FROM json_each(?))")
          .all(JSON.stringify(visualIds)).map((row) => row.id));
        add(visualIds.filter((id) => availableMedia.has(id)), 2);
        add((semantic?.matches || []).map((m) => m.elementId), 1.5);
        add(textMatches.map((m) => m.elementId), 2);
        for (const q of queries) add(candidates({ q, pageSize: 10 }).elements.map((e) => e.id));
        for (const tag of source.tags.slice(0, 3)) add(candidates({ tag: tag.toLowerCase(), pageSize: 10 }).elements.map((e) => e.id), 0.7);
        add((prior?.elements || []).map((e) => e.id), 0.15);
        if (["image", "video"].includes(source.kind)) {
          add(candidates({ kind: "image", pageSize: 12 }).elements.map((e) => e.id), 0.25);
          add(candidates({ kind: "video", pageSize: 12 }).elements.map((e) => e.id), 0.25);
        }
        add(candidates({ pageSize: 20 }).elements.map((e) => e.id), 0.2);
        const candidateIds = [...new Set([source.id, ...imageIds, ...visualIds.filter((id) => availableMedia.has(id)).slice(0, 4),
          ...[...ranked].filter(([id]) => id !== source.id).sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id]) => id)])];
        const supportedIds = new Map(db.prepare("SELECT id,kind FROM elements WHERE (kind IN(1,2) OR (kind=5 AND ?)) AND deleted_at IS NULL AND local_only=0 AND id IN(SELECT value FROM json_each(?))")
          .all(Number(source.kind !== "text"), JSON.stringify(candidateIds)).map((row) => [row.id, row.kind]));
        let textCount = 0;
        const selected = candidateIds.filter((id) => {
          if (!supportedIds.has(id)) return false;
          if (source.kind === "text" && id !== source.id && supportedIds.get(id) === 1) return ++textCount <= 8;
          return true;
        }).slice(0, 40);
        const elements = selected.map((elementId) => {
          const e = wiki.get(elementId);
          const description = db.prepare("SELECT description FROM semantic_documents WHERE element_id=?").get(elementId)?.description;
          const body = e.body.slice(0, e.id === source.id || source.kind === "text" && e.kind === "text" ? 12000 : 2500);
          const excerpt = semantic?.matches.find((m) => m.elementId === elementId)?.excerpt;
          return { ...e, body, ...(description ? { semanticDescription: description } : {}),
            ...(e.kind === "text" && excerpt && e.body.includes(excerpt) && !body.includes(excerpt) ? { bodyExcerpts: [excerpt] } : {}) };
        });
        const total = candidates({ pageSize: 1 }).pagination.total;
        const snapshot = { epoch: current, sourceId: source.id, elements, tags: wiki.tags({ activeOnly: true }).slice(0, 300),
          tagAliases: wiki.vocabulary.tagAliases({ activeOnly: true }).slice(0, 300),
          relationVocabulary: db.prepare("SELECT DISTINCT name,reverse_name AS reverseName,CASE directed WHEN 1 THEN 'forward' ELSE 'symmetric' END AS direction FROM resolved_relation_terms LIMIT 100").all(),
          relations: db.prepare("SELECT source_id AS sourceId,target_id AS targetId,name,direction,reverse_name FROM visible_element_relations WHERE source_id=? OR target_id=? LIMIT 100").all(source.id, source.id).map((row) => ({ ...row, ...relationDirection(row) })),
          truncated: total > elements.length, total, ...(semantic ? { semantic } : {}), ...(visual ? { visual } : {}) };
        db.prepare("UPDATE organization_jobs SET context=? WHERE id=?").run(JSON.stringify(snapshot), id);
        return snapshot;
      });
    },
    submit(id, token, requestKey, output, execution, auto) {
      const hash = createHash("sha256").update(JSON.stringify({ output, execution })).digest("hex");
      return transaction(() => {
        const saved = db.prepare("SELECT id,request_key,request_hash FROM organization_results WHERE job_id=?").get(id);
        if (saved) {
          if (saved.request_key !== requestKey || saved.request_hash !== hash) fail("该任务已提交其他结果");
          return result(saved.id);
        }
        const row = leased(id, token);
        if (!row.context) fail("请先读取整理上下文");
        const context = JSON.parse(row.context);
        if (context.epoch !== epoch()) fail("资料库已变化，请重新分析");
        const source = context.elements.find((e) => e.id === row.element_id);
        if (source.kind === "video" && output.tagAdds.length) fail("首帧整理仅建立相似关联，不添加整段视频标签", 400);
        const seen = new Set(), actions = [];
        for (const action of [...output.tagAdds.map((a) => ({ ...a, kind: "tag" })), ...output.relationAdds.map((a) => ({ ...a, kind: "relation" }))]) {
          const key = keyOf(source.id, action), evidence = action.evidence;
          const cited = context.elements.find((e) => e.id === evidence.elementId);
          if (!cited || evidence.kind === "text" && (!evidence.quote.trim() || !(cited.body.includes(evidence.quote) || cited.bodyExcerpts?.some((part) => part.includes(evidence.quote)))) ||
              evidence.kind === "visual" && !["image", "video"].includes(cited.kind)) fail("整理依据不属于已读取内容", 400);
          if (Array.isArray(execution.imageIds) && ((evidence.kind === "visual" && !execution.imageIds.includes(cited.id)) ||
              (action.kind === "relation" && action.name === "提示词匹配" && ![source.id, action.targetId].some((id) => execution.imageIds.includes(id))))) fail("图片匹配或视觉依据需要实际查看原图", 400);
          if (action.kind === "relation" && (action.targetId === source.id || !context.elements.some((e) => e.id === action.targetId))) fail("关联目标不属于已读取内容", 400);
          const target = action.kind === "relation" ? context.elements.find((e) => e.id === action.targetId) : null;
          if (action.kind === "relation" && (action.name === "相似" || wiki.vocabulary.relation(action).name === "相似")
              && (source.kind === "text" || target?.kind === "text")) {
            if (source.kind !== "text" || target?.kind !== "text" || action.direction !== "symmetric" || action.reverseName
                || evidence.kind !== "text" || evidence.elementId !== target.id
                || source.body !== wiki.get(source.id).body || target.body !== wiki.get(target.id).body) {
              fail("文字相似关联须核对两份完整正文，引用目标原文，并使用双向同名的相似关系", 400);
            }
          }
          if (action.kind === "relation" && (source.kind === "video" || target?.kind === "video")) {
            const videos = [source, target].filter((e) => e.kind === "video");
            if (!["image", "video"].includes(source.kind) || !["image", "video"].includes(target.kind)
                || wiki.vocabulary.relation(action).name !== "相似" || evidence.kind !== "visual"
                || !Array.isArray(execution.firstFrameIds) || !videos.every((e) => execution.firstFrameIds.includes(e.id))) {
              fail("视频首帧仅支持基于实际首帧画面的相似关联", 400);
            }
          }
          if (action.kind === "relation" && ["image", "video"].includes(source.kind) && ["image", "video"].includes(target?.kind)
              && (action.name === "相似" || wiki.vocabulary.relation(action).name === "相似")) {
            if (action.direction !== "symmetric" || action.reverseName || !Array.isArray(execution.imageIds)
                || ![source.id, action.targetId].every((id) => execution.imageIds.includes(id))) {
              fail("图片相似关联必须为双向同名，并实际查看两张图片", 400);
            }
          }
          if (seen.has(key)) continue;
          seen.add(key);
          action.state = rejected(source.id, action) ? "rejected" : "suggested";
          actions.push(action);
        }
        const resultId = db.prepare(`INSERT INTO organization_results(job_id,request_key,request_hash,summary,actions,context,epoch,execution,created_at,tracked)
          VALUES(?,?,?,?,?,?,?,?,?,1)`).run(id, requestKey, hash, output.summary, JSON.stringify(actions), row.context, epoch(), JSON.stringify(execution), Date.now()).lastInsertRowid;
        const changes = applyActions(source.id, actions, auto ? actions.map((_, i) => i) : [], Number(resultId));
        db.prepare("UPDATE organization_results SET actions=?,changes=?,epoch=?,tracked=1 WHERE id=?")
          .run(JSON.stringify(actions), JSON.stringify(changes), epoch(), resultId);
        db.prepare("UPDATE organization_jobs SET state=2,lease_token=NULL,lease_until=NULL,finished_at=? WHERE id=?").run(Date.now(), id);
        return result(resultId);
      });
    },
    failed(id, token, message, retryable, code) {
      return transaction(() => {
        if (code === "AUTH_REQUIRED") {
          leased(id, token);
          db.prepare("UPDATE organization_jobs SET state=0,attempts=MAX(0,attempts-1),lease_token=NULL,lease_until=NULL,context=NULL,error=?,available_at=?,finished_at=NULL WHERE id=?")
            .run(message.slice(0, 1000), Date.now() + 10000, id);
          return publicJob(job(id));
        }
        const row = leased(id, token), retry = retryable && row.attempts < 3;
        db.prepare("UPDATE organization_jobs SET state=?,lease_token=NULL,lease_until=NULL,context=NULL,error=?,available_at=?,finished_at=? WHERE id=?")
          .run(retry ? 0 : 3, message.slice(0, 1000), Date.now() + row.attempts * 10000, retry ? null : Date.now(), id);
        return publicJob(job(id));
      });
    },
    status(elementId = null, before = null) {
      const jobs = db.prepare("SELECT * FROM organization_jobs WHERE (? IS NULL OR element_id=?) ORDER BY id DESC LIMIT 20").all(elementId, elementId).map(publicJob);
      const counts = db.prepare("SELECT state,count(*) AS count FROM organization_jobs GROUP BY state").all();
      const results = db.prepare("SELECT r.id FROM organization_results r JOIN organization_jobs j ON j.id=r.job_id WHERE (? IS NULL OR j.element_id=?) AND (? IS NULL OR r.id<?) ORDER BY r.id DESC LIMIT 11").all(elementId, elementId, before, before)
        .map(({ id }) => { const r = result(id); return { id: r.id, jobId: r.job_id, elementId: r.element_id, summary: r.summary, actions: r.actions, undone: r.undone, execution: r.execution, createdAt: r.created_at, tracked: Boolean(r.tracked) }; });
      return { jobs, results: results.slice(0, 10), nextBefore: results.length > 10 ? results[9].id : null, counts: Object.fromEntries(counts.map((r) => [states[r.state], r.count])) };
    },
    result,
    accept(id, indices) {
      return transaction(() => {
        const r = result(id);
        if (r.undone) fail("此结果已撤销，请重新整理");
        if (indices.some((i) => !r.actions[i])) fail("请选择有效建议", 400);
        const pending = indices.filter((i) => r.actions[i]?.state === "suggested");
        if (!pending.length) return r;
        if (r.epoch !== epoch()) fail("资料库已变化，请重新整理后再接受建议");
        const changes = applyActions(r.element_id, r.actions, pending, r.id);
        db.prepare("UPDATE organization_results SET actions=?,changes=?,epoch=?,tracked=1 WHERE id=?")
          .run(JSON.stringify(r.actions), JSON.stringify([...r.changes, ...changes]), epoch(), id);
        return result(id);
      });
    },
    reject(id, indices) {
      return transaction(() => {
        const r = result(id);
        if (indices.some((i) => !r.actions[i] || r.actions[i].state === "applied")) fail("已应用的结果请先撤销；请选择有效建议");
        for (const i of indices) {
          db.prepare("INSERT OR IGNORE INTO organization_rejections(element_id,action_key) VALUES(?,?)").run(r.element_id, keyOf(r.element_id, r.actions[i]));
          r.actions[i].state = "rejected";
        }
        db.prepare("UPDATE organization_results SET actions=? WHERE id=?").run(JSON.stringify(r.actions), id);
        return result(id);
      });
    },
    correct(selections, operation, name) {
      return transaction(() => {
        const records = new Map(selections.map(({ resultId }) => [resultId, result(resultId)]));
        const kinds = new Set(selections.map(({ resultId, index }) => records.get(resultId).actions[index]?.kind));
        if (operation === "replace" && kinds.size !== 1) fail("请分别选择标签或关联进行替换", 400);
        const replacement = operation === "replace" ? (kinds.has("tag") ? elementTags([name])[0] : relationName(name)) : null;
        for (const { resultId, index } of selections) {
          const r = records.get(resultId), action = r.actions[index];
          if (r.undone || !action || action.state !== "applied" || !action.editable) fail("所选结果已被修改或移除，请刷新后重试");
          wiki.get(r.element_id);
          if (action.kind === "relation") wiki.get(action.targetId);
          if (operation === "replace" && replacement.toLowerCase() === action.name.toLowerCase()) fail("替换名称与原名称相同", 400);
        }
        for (const { resultId, index } of selections) {
          const r = records.get(resultId), action = r.actions[index];
          removeBinding(resultId, index);
          if (operation === "replace") {
            if (action.kind === "tag") {
              const current = wiki.get(r.element_id);
              wiki.update(r.element_id, { body: current.body, tags: elementTags([...current.tags, replacement]) });
              db.prepare("UPDATE organization_bindings SET modified=1 WHERE element_id=? AND tag_id IN(SELECT id FROM resolved_tags WHERE normalized_name=?)")
                .run(r.element_id, wiki.vocabulary.tag(replacement)?.normalizedName ?? replacement.toLowerCase());
            } else {
              const relation = wiki.relate(r.element_id, action.targetId, "related", replacement, { direction: action.direction, reverseName: action.reverseName });
              db.prepare("UPDATE organization_bindings SET modified=1 WHERE relation_id=?").run(relation.id);
            }
          }
          action.state = operation === "replace" ? "corrected" : "rejected";
          action.correction = operation === "replace" ? replacement : null;
          action.correctedAt = Date.now();
          action.editable = false;
        }
        for (const r of records.values()) db.prepare("UPDATE organization_results SET actions=?,epoch=? WHERE id=?").run(JSON.stringify(r.actions), epoch(), r.id);
        return { changed: selections.length };
      });
    },
    undo(id) {
      return transaction(() => {
        const r = result(id);
        if (r.undone) return r;
        if (r.tracked) {
          let removed = 0, skipped = 0;
          for (const [index, action] of r.actions.entries()) if (action.state === "applied") {
            if (removeBinding(r.id, index)) { action.state = "rejected"; removed++; }
            else { action.note = "已被人工修改或移除，撤销时保留"; skipped++; }
          }
          db.prepare("UPDATE organization_results SET undone=1,actions=?,epoch=? WHERE id=?").run(JSON.stringify(r.actions), epoch(), id);
          return { ...result(id), removed, skipped };
        }
        if (r.changes.length && r.epoch !== epoch()) fail("整理后资料库已有修改，为保留后续编辑，本次未撤销");
        for (const change of r.changes) {
          if (change.kind === "tag") db.prepare("DELETE FROM element_tags WHERE element_id=? AND tag_id=?").run(change.elementId, change.tagId);
          else db.prepare("DELETE FROM element_relations WHERE id=?").run(change.id);
        }
        for (const action of r.actions) if (action.state === "applied") {
          db.prepare("INSERT OR IGNORE INTO organization_rejections(element_id,action_key) VALUES(?,?)").run(r.element_id, keyOf(r.element_id, action));
          action.state = "rejected";
        }
        db.prepare("UPDATE organization_results SET undone=1,actions=?,epoch=? WHERE id=?").run(JSON.stringify(r.actions), epoch(), id);
        return result(id);
      });
    },
  };
}
