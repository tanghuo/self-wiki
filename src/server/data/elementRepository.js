import { relationDirection, storedDirection } from "./relationDirection.js";
import { elementError, maxElementTags, relationName } from "../../shared/domain/elements.js";
import { createCanvasRepository } from "./canvasRepository.js";
import { deleteChatHistory } from "./chatHistoryDeletion.js";
import { chatPathIds } from "./chatHistory.js";
import { createVocabularyRepository } from "./vocabularyRepository.js";
import { createVideoMarkerRepository } from "./videoMarkerRepository.js";
import { relationRole } from "../../shared/domain/relationRoles.js";
import { similarStacks } from "./similarStacks.js";

const kinds = { text: 1, image: 2, session: 3, video: 5 };
const kindNames = { 1: "text", 2: "image", 3: "session", 5: "video" };
const creationSources = { unknown: 0, manual: 1, chat: 2 };

function present(row) {
  if (!row) throw elementError("内容不存在或已移入回收站", 404);
  return {
    id: row.id, kind: kindNames[row.kind], body: row.body,
    material: Boolean(row.is_material),
    creationSource: Object.keys(creationSources).find((key) => creationSources[key] === row.creation_source) || "unknown",
    ...(row.local_only ? { localOnly: true } : {}), ...(row.record_data ? { record: JSON.parse(row.record_data) } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at,
    tags: JSON.parse(row.tags), aiTags: JSON.parse(row.ai_tags),
    ...(row.video_reference_count ? { videoReferenceCount: row.video_reference_count } : {}),
    ...(row.kind === 2 ? { image: { url: `/api/elements/${row.id}/image`, mimeType: row.mime_type, byteSize: row.byte_size, originalName: row.original_name, width: row.image_width || null, height: row.image_height || null } } : {}),
    ...(row.kind === 5 ? { video: { url: `/api/elements/${row.id}/video`, mimeType: row.mime_type, byteSize: row.byte_size, originalName: row.original_name } } : {}),
  };
}

function pagination(total, page, pageSize) {
  return { total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export function createElementRepository(db, { publicOnly = false } = {}) {
  // Historical chat migrations use this repository before video metadata exists.
  const hasVideos = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='element_videos'").get());
  const hasMarkers = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='video_markers'").get());
  const hasDimensions = db.prepare("PRAGMA table_info(element_images)").all().some((column) => column.name === "width");
  let listStamp, stackCache;
  const groupedLists = new Map();
  function cachedStacks() {
    // Includes changes through other repositories/connections and rolled-back writes.
    const stamp = `${db.prepare("SELECT total_changes() AS n").get().n}:${db.prepare("PRAGMA data_version").get().data_version}`;
    if (stamp !== listStamp || db.isTransaction) {
      listStamp = db.isTransaction ? null : stamp; stackCache = null; groupedLists.clear();
    }
    return stackCache ||= similarStacks(db, { publicOnly });
  }
  const selectElement = `SELECT e.*, ${hasDimensions ? "i.width AS image_width,i.height AS image_height," : ""} ${hasVideos ? "coalesce(i.mime_type,v.mime_type) AS mime_type, coalesce(i.byte_size,v.byte_size) AS byte_size, coalesce(i.original_name,v.original_name) AS original_name" : "i.mime_type, i.byte_size, i.original_name"}, rec.data AS record_data,
    ${hasMarkers ? `(SELECT count(*) FROM video_marker_links ml JOIN video_markers m ON m.id=ml.marker_id JOIN elements owner ON owner.id=m.video_id WHERE ml.target_id=e.id AND owner.deleted_at IS NULL${publicOnly ? " AND owner.local_only=0" : ""}) AS video_reference_count,` : ""}
    (SELECT json_group_array(name) FROM (
      SELECT t.name FROM canonical_element_tags et JOIN tags t ON t.id=et.tag_id
      WHERE et.element_id=e.id ORDER BY t.id
    )) AS tags,
    (SELECT json_group_array(json_object('name',t.name,'resultId',b.result_id))
      FROM organization_bindings b JOIN resolved_tags t ON t.id=b.tag_id WHERE b.element_id=e.id) AS ai_tags
    FROM elements e LEFT JOIN element_images i ON i.element_id=e.id
    ${hasVideos ? "LEFT JOIN element_videos v ON v.element_id=e.id" : ""}
    LEFT JOIN element_records rec ON rec.element_id=e.id`;
  const visibility = publicOnly ? " AND e.local_only=0" : "";
  const vocabulary = createVocabularyRepository(db);
  function transaction(fn) {
    // Chat acceptance owns the outer transaction so content and its receipt commit together.
    if (db.isTransaction) return fn();
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  function get(id) {
    return present(db.prepare(`${selectElement} WHERE e.id = ? AND e.deleted_at IS NULL${visibility}`).get(id));
  }

  function tagMembers(tagId, sourceId, { page = 1, pageSize = 36 } = {}) {
    const where = `e.deleted_at IS NULL${visibility} AND e.id != ? AND EXISTS (
      SELECT 1 FROM canonical_element_tags et WHERE et.element_id = e.id AND et.tag_id = ?)`;
    const total = db.prepare(`SELECT count(*) AS total FROM elements e WHERE ${where}`).get(sourceId, tagId).total;
    const rows = db.prepare(`${selectElement} WHERE ${where} ORDER BY e.kind DESC, e.updated_at DESC, e.id DESC LIMIT ? OFFSET ?`)
      .all(sourceId, tagId, pageSize, (page - 1) * pageSize);
    return { elements: rows.map(present), pagination: pagination(total, page, pageSize) };
  }

  function insert(kind, content) {
    const now = new Date().toISOString();
    const id = Number(db.prepare("INSERT INTO elements (kind, body, created_at, updated_at,local_only) VALUES (?, ?, ?, ?,?)")
      .run(kinds[kind], content.body || "", now, now, Number(Boolean(content.localOnly))).lastInsertRowid);
    // Older migrations also create session elements before this column exists.
    if (content.creationSource) db.prepare("UPDATE elements SET creation_source=? WHERE id=?").run(creationSources[content.creationSource], id);
    if (content.material) db.prepare("UPDATE elements SET is_material=1 WHERE id=?").run(id);
    return id;
  }

  function addTag(id, name) {
    const canonical = vocabulary.tag(name);
    if (canonical && db.prepare("SELECT 1 FROM canonical_element_tags WHERE element_id=? AND tag_id=?").get(id, canonical.id)) {
      return { status: "existing" };
    }
    if (db.prepare("SELECT count(*) AS total FROM canonical_element_tags WHERE element_id=?").get(id).total >= maxElementTags) {
      return { status: "limit" };
    }
    const normalized = name.toLowerCase();
    db.prepare("INSERT INTO tags (name, normalized_name) VALUES (?, ?) ON CONFLICT (normalized_name) DO NOTHING").run(name, normalized);
    const tagId = db.prepare("SELECT id FROM tags WHERE normalized_name=?").get(normalized).id;
    db.prepare("INSERT INTO element_tags (element_id, tag_id) VALUES (?, ?)").run(id, tagId);
    return { status: "added", tagId };
  }

  function addTags(id, tags) {
    for (const name of tags) {
      if (addTag(id, name).status === "limit") throw elementError("合并后超过 30 个标签，请减少本次标签后重试");
    }
  }

  function findImageByHash(hash) {
    return db.prepare(`SELECT e.id, e.deleted_at, i.storage_key FROM element_images i JOIN elements e ON e.id = i.element_id
      WHERE i.content_hash = ? ORDER BY e.deleted_at IS NOT NULL, e.id LIMIT 1`).get(hash);
  }

  function findVideoByHash(hash) {
    return db.prepare(`SELECT e.id, e.deleted_at, v.storage_key FROM element_videos v JOIN elements e ON e.id=v.element_id
      WHERE v.content_hash=? ORDER BY e.deleted_at IS NOT NULL, e.id LIMIT 1`).get(hash);
  }

  function findRelation(a, b, type = "related", name = "", semantics = {}) {
    const [sourceId, targetId] = type === "related" && a > b ? [b, a] : [a, b];
    const resolved = type === "title" ? { name, ...semantics } : vocabulary.relation({ name, ...semantics });
    const direction = storedDirection(resolved.direction, type === "related" && a > b);
    const rows = db.prepare("SELECT * FROM visible_element_relations WHERE source_id=? AND target_id=? AND kind=? AND name=?")
      .all(sourceId, targetId, type === "title" ? 2 : 1, resolved.name);
    const exact = rows.find((r) => r.direction === direction && r.reverse_name === (resolved.reverseName || ""));
    if (rows.length && !exact) throw elementError("已存在同名关联，请编辑现有关联的方向", 409);
    return exact;
  }

  function relateWithChange(a, b, type = "related", inputName, semantics = {}) {
    const name = relationName(inputName);
    if (a === b) throw elementError("不能关联内容自身");
    if (!["related", "title"].includes(type)) throw elementError("不支持此关联类型");
    return transaction(() => {
      const source = get(a); get(b);
      if (type === "title" && source.kind !== "text") throw elementError("只有文字可以作为标题");
      const [sourceId, targetId] = type === "related" && a > b ? [b, a] : [a, b];
      const kind = type === "title" ? 2 : 1;
      if (kind === 2 && semantics.direction && semantics.direction !== "symmetric") throw elementError("标题关联已有固定方向");
      const direction = storedDirection(semantics.direction, type === "related" && a > b), reverseName = semantics.reverseName || "";
      const existing = findRelation(a, b, type, name, semantics);
      if (existing) return { created: false, relation: { id: existing.id, ...relationDirection(existing), type, name: existing.name, sourceId, targetId, elementIds: [sourceId, targetId], createdAt: existing.created_at } };
      const write = db.prepare("INSERT INTO element_relations (source_id, target_id, kind, name, created_at, direction, reverse_name) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source_id, target_id, kind, name) DO NOTHING")
        .run(sourceId, targetId, kind, name, new Date().toISOString(), direction, reverseName);
      const row = db.prepare("SELECT * FROM element_relations WHERE source_id = ? AND target_id = ? AND kind = ? AND name = ?").get(sourceId, targetId, kind, name);
      if (row.direction !== direction || row.reverse_name !== reverseName) throw elementError("已存在同名关联，请编辑现有关联的方向", 409);
      const display = type === "title" ? { name, ...relationDirection(row) } : vocabulary.relation({ name, ...relationDirection(row) });
      return { created: Boolean(write.changes), relation: { id: row.id, ...display, type, sourceId, targetId, elementIds: [sourceId, targetId], createdAt: row.created_at } };
    });
  }

  function relationGroup(id, isTag = false) {
    const view = isTag ? "canonical_tag_relations" : "canonical_element_relations";
    return db.prepare(`SELECT r.id FROM ${view} r JOIN ${view} selected ON selected.id=?
      WHERE r.source_id=selected.source_id AND ${isTag ? "r.tag_id=selected.tag_id" : "r.target_id=selected.target_id AND r.kind=selected.kind"}
        AND r.name=selected.name AND r.direction=selected.direction AND r.reverse_name=selected.reverse_name`).all(id).map((r) => r.id);
  }

  function renameGroup(id, isTag, input, conflictMessage) {
    const table = isTag ? "tag_relations" : "element_relations", view = isTag ? "canonical_tag_relations" : "canonical_element_relations";
    const current = db.prepare(`SELECT * FROM ${view} WHERE id=?`).get(id);
    if (!current) throw elementError("关联不存在，请刷新后重试", 404);
    get(current.source_id);
    if (!isTag) get(current.target_id);
    const desired = { ...relationDirection(current), ...input };
    const resolved = !isTag && current.kind === 2 ? desired : vocabulary.relation(desired);
    const direction = storedDirection(resolved.direction);
    if (current.name === resolved.name && current.direction === direction && current.reverse_name === resolved.reverseName) return;
    const ids = relationGroup(id, isTag);
    const collision = db.prepare(`SELECT 1 FROM ${view} WHERE source_id=? AND ${isTag ? "tag_id=?" : "target_id=? AND kind=?"}
      AND name=? AND id NOT IN(SELECT value FROM json_each(?))`).get(current.source_id, ...(isTag ? [current.tag_id] : [current.target_id, current.kind]), resolved.name, JSON.stringify(ids));
    if (collision) throw elementError(conflictMessage || (isTag ? "当前内容与该标签已存在同名关联，请使用其他名称" : "这两份内容之间已存在同名关联，请使用其他名称"), 409);
    // Keep each original tag target so removing a tag alias later cannot narrow
    // this rule's scope. Direct edges share the same immutable endpoints.
    const retained = isTag ? db.prepare(`SELECT CASE WHEN max(id=?) THEN ? ELSE min(id) END AS id
      FROM tag_relations WHERE id IN(SELECT value FROM json_each(?)) GROUP BY tag_id`).all(id, id, JSON.stringify(ids)).map((r) => r.id) : [id];
    db.prepare(`DELETE FROM ${table} WHERE id IN(SELECT value FROM json_each(?)) AND id NOT IN(SELECT value FROM json_each(?))`)
      .run(JSON.stringify(ids), JSON.stringify(retained));
    db.prepare(`UPDATE ${table} SET name=?,direction=?,reverse_name=? WHERE id IN(SELECT value FROM json_each(?))`)
      .run(resolved.name, direction, resolved.reverseName, JSON.stringify(retained));
    if (!isTag) {
      db.prepare("DELETE FROM element_provenance WHERE relation_id=?").run(id);
      db.prepare("UPDATE organization_bindings SET modified=1 WHERE relation_id=?").run(id);
    }
  }

  return {
    get, vocabulary, findRelation, relateWithChange,
    recordUsage(id, action) {
      if (!["copy", "reference"].includes(action)) throw elementError("无效的使用指标");
      const result = db.prepare(`INSERT INTO element_usage_events(element_id,action,occurred_at)
        SELECT e.id,?,? FROM elements e
        WHERE e.id=? AND e.deleted_at IS NULL AND e.kind IN (1,2,3)${visibility}`)
        .run(action === "copy" ? 1 : 2, Date.now(), id);
      if (!result.changes) {
        get(id);
        throw elementError("此内容不支持复制或引用计数");
      }
      return { ok: true };
    },
    usage({ from, to, sort }) {
      const where = `u.occurred_at>=? AND u.occurred_at<?${visibility}`;
      const summary = db.prepare(`SELECT count(*) AS total,coalesce(sum(u.action=1),0) AS copies,
        coalesce(sum(u.action=2),0) AS "references",count(DISTINCT u.element_id) AS elements
        FROM element_usage_events u JOIN elements e ON e.id=u.element_id WHERE ${where}`).get(from, to);
      const order = sort === "copy" ? "copies" : sort === "reference" ? "references" : "total";
      const rows = db.prepare(`SELECT e.id,e.kind,e.deleted_at AS deletedAt,
        coalesce(nullif(substr(e.body,1,100),''),i.original_name,'内容 #'||e.id) AS label,
        count(*) AS total,sum(u.action=1) AS copies,sum(u.action=2) AS "references",max(u.occurred_at) AS lastUsedAt
        FROM element_usage_events u JOIN elements e ON e.id=u.element_id
        LEFT JOIN element_images i ON i.element_id=e.id WHERE ${where}
        GROUP BY e.id HAVING "${order}">0 ORDER BY "${order}" DESC,lastUsedAt DESC,e.id DESC LIMIT 50`).all(from, to);
      return { summary, elements: rows.map((row) => ({ ...row, kind: kindNames[row.kind] })) };
    },
    markers: createVideoMarkerRepository(db, { getElement: get, vocabulary, publicOnly }),
    addTag(id, name) { return transaction(() => { get(id); return addTag(id, name); }); },
    tagAliases: () => vocabulary.tagAliases({ publicOnly }),
    conversation(id, from) {
      const element = get(id);
      if (element.kind !== "session") throw elementError("此元素不是会话");
      const sessionId = element.record.sessionId;
      const session = db.prepare("SELECT title,active_turn_id FROM chat_sessions WHERE id=?").get(sessionId);
      const anchor = from && db.prepare(`SELECT t.id FROM chat_element_bindings b JOIN chat_turns t ON t.id=b.turn_id
        WHERE b.element_id=? AND t.session_id=? AND t.internal=0 ORDER BY t.id DESC LIMIT 1`).get(from, sessionId);
      const target = anchor?.id || session?.active_turn_id;
      const before = chatPathIds(db, sessionId, target).slice(-2).map((id) => db.prepare("SELECT * FROM chat_turns WHERE id=?").get(id));
      const after = target ? db.prepare("SELECT c.* FROM chat_turns p JOIN chat_turns c ON c.id=p.selected_child_id WHERE p.id=? AND c.session_id=? AND c.internal=0").all(target, sessionId) : [];
      const rows = [...before, ...after];
      return { sessionId, title: session?.title || element.body, turnId: target, turns: rows.map((t) => ({ id: t.id,
        text: t.text.slice(0, 700), answer: t.answer.slice(0, 1000), truncated: t.text.length > 700 || t.answer.length > 1000,
        images: JSON.parse(t.events).filter((e) => e.artifact).slice(0, 2).map((e) => `/api/chat/turns/${t.id}/artifacts/${e.artifact}`) })) };
    },
    lifecycle(id) {
      get(id);
      const nodes = new Map(), relations = new Map(), pending = [id];
      while (pending.length && nodes.size < 100) {
        const current = pending.shift();
        if (nodes.has(current)) continue;
        let element;
        try { element = get(current); } catch { continue; }
        nodes.set(current, element);
        if (element.kind === "session" && current !== id) continue;
        const edges = db.prepare(`SELECT r.* FROM visible_element_relations r
          WHERE (r.source_id=? OR r.target_id=?) ORDER BY r.id LIMIT 201`).all(current, current);
        for (const edge of edges) {
          const other = edge.source_id === current ? edge.target_id : edge.source_id;
          try { get(other); } catch { continue; }
          if (relations.size >= 200 && !relations.has(edge.id)) break;
          relations.set(edge.id, { id: edge.id, sourceId: edge.source_id, targetId: edge.target_id, name: edge.name, ...relationDirection(edge) });
          if (!nodes.has(other) && !pending.includes(other)) pending.push(other);
        }
      }
      return { elements: [...nodes.values()], relations: [...relations.values()].filter((r) => nodes.has(r.sourceId) && nodes.has(r.targetId)),
        truncated: pending.length > 0 || relations.size >= 200 };
    },
    canvas: createCanvasRepository(db, { publicOnly }),
    tags({ activeOnly = false } = {}) {
      return db.prepare(`SELECT t.name FROM tags t WHERE EXISTS (
        SELECT 1 FROM ${hasMarkers ? "canonical_content_tag_usage" : "canonical_element_tags"} et JOIN elements e ON e.id = et.element_id
        WHERE et.tag_id = t.id AND (? = 0 OR e.deleted_at IS NULL)${visibility}
      ) ORDER BY t.normalized_name`).all(Number(activeOnly)).map((row) => row.name);
    },
    previewImages(before = Number.MAX_SAFE_INTEGER) {
      return db.prepare("SELECT i.element_id,i.storage_key,i.width,i.height FROM element_images i JOIN elements e ON e.id=i.element_id WHERE i.element_id<? AND e.deleted_at IS NULL ORDER BY i.element_id DESC LIMIT 32").all(before);
    },
    setImageDimensions(id, storageKey, { width, height }) {
      db.prepare("UPDATE element_images SET width=?,height=? WHERE element_id=? AND storage_key=? AND (width IS NULL OR height IS NULL)").run(width, height, id, storageKey);
    },
    unhashedImages() { return db.prepare("SELECT element_id, storage_key FROM element_images WHERE content_hash IS NULL").all(); },
    setImageHash(id, hash) {
      const result = db.prepare("UPDATE element_images SET content_hash = ? WHERE element_id = ? AND content_hash IS NULL").run(hash, id);
      if (!result.changes && db.prepare("SELECT content_hash FROM element_images WHERE element_id = ?").get(id)?.content_hash !== hash) {
        throw new Error("Image changed while preparing its content hash");
      }
    },
    findImageByHash, findVideoByHash,
    setMaterial(ids, material) {
      if (publicOnly) throw elementError("素材标记仅限本机修改", 403);
      return transaction(() => {
        const encoded = JSON.stringify(ids);
        const eligible = db.prepare("SELECT count(*) AS n FROM elements WHERE id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL AND kind IN(1,2,5) AND local_only=0").get(encoded).n;
        if (eligible !== ids.length) throw elementError("部分内容不存在、已移入回收站或不能设为素材", 409);
        const result = db.prepare("UPDATE elements SET is_material=? WHERE id IN(SELECT value FROM json_each(?))").run(Number(material), encoded);
        if (result.changes !== ids.length) throw elementError("内容已变化，请重试", 409);
        return { ids, material };
      });
    },
    list({ q = "", kind = "", scope = "library", material, sort = "updated", tag = "", tags = tag ? [tag] : [], tagMatch = "any", page = 1, pageSize = 36, semanticIds = [], includeDescription = false, supportedKinds = [], stackSimilar = false, stackOf = null, throughPage = page } = {}) {
      if (sort === "usage" && publicOnly) throw elementError("使用统计仅限本机查看", 403);
      if (!["updated", "usage"].includes(sort) || (sort === "usage" && kind !== "text")) throw elementError("无效的排序条件");
      const clauses = [scope === "trash" ? "e.deleted_at IS NOT NULL" : "e.deleted_at IS NULL"];
      if (material !== undefined) clauses.push(material ? "e.is_material=1" : "e.is_material=0");
      if (scope === "library" && !kind) clauses.push("e.kind IN(1,2,5)");
      if (publicOnly) clauses.push("e.local_only=0");
      const values = [];
      const stacks = scope !== "trash" && (stackSimilar || stackOf) ? cachedStacks() : null;
      let stackKind;
      if (stackOf) {
        const source = get(stackOf);
        if (scope === "trash" || !["text", "image", "video"].includes(source.kind)) throw elementError("只能查看在用文字、图片或视频的相似堆叠");
        stackKind = source.kind;
        clauses.push("e.id IN(SELECT value FROM json_each(?))");
        values.push(JSON.stringify(stacks.get(stackOf) || [stackOf]));
      }
      if (kind) { clauses.push("e.kind = ?"); values.push(kinds[kind]); }
      if (supportedKinds.length) {
        clauses.push("e.kind IN(SELECT value FROM json_each(?))");
        values.push(JSON.stringify(supportedKinds.map((kind) => kinds[kind])));
      }
      if (tagMatch === "all") {
        for (const tag of tags) {
          clauses.push(`EXISTS (SELECT 1 FROM ${hasMarkers && !supportedKinds.length ? "canonical_content_tag_usage" : "canonical_element_tags"} et JOIN tags t ON t.id = et.tag_id WHERE et.element_id = e.id AND t.normalized_name = ?)`);
          values.push(vocabulary.tag(tag)?.normalizedName ?? tag);
        }
      } else if (tags.length) {
        clauses.push(`EXISTS (SELECT 1 FROM ${hasMarkers && !supportedKinds.length ? "canonical_content_tag_usage" : "canonical_element_tags"} et JOIN tags t ON t.id = et.tag_id WHERE et.element_id = e.id AND t.normalized_name IN (SELECT value FROM json_each(?)))`);
        values.push(JSON.stringify(tags.map((tag) => vocabulary.tag(tag)?.normalizedName ?? tag)));
      }
      let literal = "";
      const literalValues = [];
      if (q) {
        literal = "(e.body LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM element_images image WHERE image.element_id = e.id AND image.original_name LIKE ? ESCAPE '\\')";
        const search = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
        literalValues.push(search, search);
        if (hasVideos) {
          literal += " OR EXISTS (SELECT 1 FROM element_videos video WHERE video.element_id=e.id AND video.original_name LIKE ? ESCAPE '\\')";
          literalValues.push(search);
        }
        literal += " OR EXISTS (SELECT 1 FROM canonical_element_tags et JOIN resolved_tags c ON c.canonical_id=et.tag_id JOIN tags t ON t.id=c.id WHERE et.element_id=e.id AND t.name LIKE ? ESCAPE '\\')";
        literalValues.push(search);
        if (hasMarkers && !supportedKinds.length) {
          literal += " OR EXISTS(SELECT 1 FROM video_markers m WHERE m.video_id=e.id AND (m.body LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM video_marker_tags mt JOIN resolved_tags c ON c.id=mt.tag_id JOIN resolved_tags alias ON alias.canonical_id=c.canonical_id JOIN tags t ON t.id=alias.id WHERE mt.marker_id=m.id AND t.name LIKE ? ESCAPE '\\')))";
          literalValues.push(search, search);
        }
        if (includeDescription) {
          literal += " OR (e.kind=2 AND EXISTS (SELECT 1 FROM semantic_documents d WHERE d.element_id=e.id AND d.description LIKE ? ESCAPE '\\'))";
          literalValues.push(search);
        }
        literal += ")";
        clauses.push(`(${literal} OR e.id IN (SELECT value FROM json_each(?)))`);
        values.push(...literalValues, JSON.stringify(semanticIds));
      }
      const where = clauses.join(" AND ");
      // Both recorded actions count as one use; sort the entire match set before pagination.
      const order = sort === "usage"
        ? `(SELECT count(*) FROM element_usage_events u WHERE u.element_id=e.id) DESC, e.updated_at DESC, e.id DESC`
        : `${q ? `CASE WHEN ${literal} THEN 0 ELSE 1 END,` : ""}
        coalesce((SELECT CAST(key AS INTEGER) FROM json_each(?) WHERE value=e.id), 2147483647), e.updated_at DESC, e.id DESC`;
      const orderValues = sort === "usage" ? [] : [...literalValues, JSON.stringify(q ? semanticIds : [])];
      if (stacks?.size && !stackOf) {
        // Fetch only IDs/timestamps for the matching set; hydrate one page of covers.
        const cacheKey = JSON.stringify([where, values, order, orderValues]);
        let grouped = groupedLists.get(cacheKey);
        if (!grouped) {
          const matches = db.prepare(`SELECT e.id,e.created_at,e.updated_at,e.kind,
            ${publicOnly ? "0" : "CASE WHEN e.kind=1 THEN (SELECT count(*) FROM element_usage_events u WHERE u.element_id=e.id) ELSE 0 END"} AS usage_count
            FROM elements e WHERE ${where} ORDER BY ${order}`).all(...values, ...orderValues);
          const groups = new Map();
          for (const row of matches) {
            const members = stacks.get(row.id), key = members?.[0] ?? row.id;
            const previous = groups.get(key);
            if (!previous) groups.set(key, { row, count: members?.length || 1 });
            else {
              const text = row.kind === 1;
              const time = text ? "updated_at" : "created_at";
              const usageOrder = text ? row.usage_count - previous.row.usage_count : 0;
              if (usageOrder > 0 || usageOrder === 0 && (row[time] > previous.row[time] || row[time] === previous.row[time] && row.id > previous.row.id)) previous.row = row;
            }
          }
          grouped = { groups: [...groups.values()], total: matches.length };
          // Keep only a bounded number of query results, including their ID arrays.
          if (grouped.groups.length <= 50000) groupedLists.set(cacheKey, grouped);
          let retained = [...groupedLists.values()].reduce((count, entry) => count + entry.groups.length, 0);
          while (groupedLists.size > 8 || retained > 50000) {
            const oldest = groupedLists.keys().next().value;
            retained -= groupedLists.get(oldest).groups.length; groupedLists.delete(oldest);
          }
        }
        const lastPage = Math.min(throughPage, Math.max(page, Math.ceil(grouped.groups.length / pageSize)));
        const pageGroups = grouped.groups.slice((page - 1) * pageSize, lastPage * pageSize);
        const rows = db.prepare(`${selectElement} WHERE e.id IN(SELECT value FROM json_each(?))`).all(JSON.stringify(pageGroups.map(({ row }) => row.id)));
        const elements = new Map(rows.map((row) => [row.id, present(row)]));
        return {
          elements: pageGroups.map(({ row, count }) => ({ ...elements.get(row.id), ...(count > 1 ? { similarStack: { count } } : {}) })),
          pagination: pagination(grouped.groups.length, lastPage, pageSize), totalElements: grouped.total,
        };
      }
      const total = db.prepare(`SELECT count(*) AS total FROM elements e WHERE ${where}`).get(...values).total;
      const lastPage = Math.min(throughPage, Math.max(page, Math.ceil(total / pageSize)));
      const stackOrder = stackKind === "text"
        ? `${publicOnly ? "" : "(SELECT count(*) FROM element_usage_events u WHERE u.element_id=e.id) DESC,"} e.updated_at DESC, e.id DESC`
        : "e.created_at DESC, e.id DESC";
      const rows = db.prepare(`${selectElement} WHERE ${where}
        ORDER BY ${stackOf ? stackOrder : order} LIMIT ? OFFSET ?`)
        .all(...values, ...(stackOf ? [] : orderValues), (lastPage - page + 1) * pageSize, (page - 1) * pageSize);
      return { elements: rows.map(present), pagination: pagination(total, lastPage, pageSize) };
    },
    createText(content) {
      return transaction(() => { const id = insert("text", content); addTags(id, content.tags); return get(id); });
    },
    createRecord(kind, body, data) {
      if (kind !== "session") throw elementError("只有会话具有独立元素身份");
      return transaction(() => {
        const id = insert(kind, { body, localOnly: true });
        db.prepare("INSERT INTO element_records(element_id,session_id,turn_id,data) VALUES(?,?,?,?)").run(id, data.sessionId, data.turnId || null, JSON.stringify(data));
        return get(id);
      });
    },
    importImage(content, file, missingStorageKey) {
      return transaction(() => {
        const existing = findImageByHash(file.contentHash);
        if (existing?.deleted_at) throw elementError("相同图片已在回收站，请恢复后再导入以补充标签", 409);
        if (existing) {
          addTags(existing.id, content.tags);
          if (content.material) db.prepare("UPDATE elements SET is_material=1 WHERE id=?").run(existing.id);
          const keepFile = existing.storage_key === missingStorageKey;
          if (keepFile) db.prepare("UPDATE element_images SET storage_key = ? WHERE element_id = ?").run(file.storageKey, existing.id);
          if (hasDimensions && file.width && file.height) db.prepare("UPDATE element_images SET width=?,height=? WHERE element_id=?").run(file.width, file.height, existing.id);
          db.prepare("UPDATE elements SET updated_at = ?, local_only=CASE WHEN ? THEN local_only ELSE 0 END WHERE id = ?")
            .run(new Date().toISOString(), Number(Boolean(content.localOnly)), existing.id);
          db.prepare(`INSERT OR IGNORE INTO organization_jobs(element_id,content_version,created_at)
            SELECT e.id,e.content_version,? FROM elements e,organization_state s WHERE e.id=? AND s.enabled=1 AND e.local_only=0`)
            .run(Date.now(), existing.id);
          return { element: { ...get(existing.id), importStatus: "reused" }, keepFile };
        }
        const sameName = db.prepare(`SELECT 1 FROM element_images i JOIN elements e ON e.id = i.element_id
          WHERE i.original_name = ? AND e.deleted_at IS NULL LIMIT 1`).get(file.originalName);
        const id = insert("image", content);
        db.prepare("INSERT INTO element_images (element_id, storage_key, mime_type, byte_size, original_name, content_hash) VALUES (?, ?, ?, ?, ?, ?)")
          .run(id, file.storageKey, file.mimeType, file.byteSize, file.originalName, file.contentHash);
        if (hasDimensions && file.width && file.height) db.prepare("UPDATE element_images SET width=?,height=? WHERE element_id=?").run(file.width, file.height, id);
        addTags(id, content.tags);
        return { element: { ...get(id), importStatus: sameName ? "same-name" : "created" }, keepFile: true };
      });
    },
    importVideo(content, file, missingStorageKey) {
      return transaction(() => {
        const existing = findVideoByHash(file.contentHash);
        if (existing?.deleted_at) throw elementError("相同视频已在回收站，请恢复后再导入以补充标签", 409);
        if (existing) {
          addTags(existing.id, content.tags);
          if (content.material) db.prepare("UPDATE elements SET is_material=1 WHERE id=?").run(existing.id);
          const keepFile = existing.storage_key === missingStorageKey;
          if (keepFile) db.prepare("UPDATE element_videos SET storage_key=? WHERE element_id=?").run(file.storageKey, existing.id);
          db.prepare("UPDATE elements SET updated_at=?, local_only=CASE WHEN ? THEN local_only ELSE 0 END WHERE id=?")
            .run(new Date().toISOString(), Number(Boolean(content.localOnly)), existing.id);
          return { element: { ...get(existing.id), importStatus: "reused" }, keepFile };
        }
        const sameName = db.prepare(`SELECT 1 FROM element_videos v JOIN elements e ON e.id=v.element_id
          WHERE v.original_name=? AND e.deleted_at IS NULL LIMIT 1`).get(file.originalName);
        const id = insert("video", content);
        db.prepare("INSERT INTO element_videos(element_id,storage_key,mime_type,byte_size,original_name,content_hash) VALUES(?,?,?,?,?,?)")
          .run(id, file.storageKey, file.mimeType, file.byteSize, file.originalName, file.contentHash);
        addTags(id, content.tags);
        return { element: { ...get(id), importStatus: sameName ? "same-name" : "created" }, keepFile: true };
      });
    },
    update(id, content) {
      return transaction(() => {
        // A changed text no longer supports an untouched AI similarity judgment.
        // Detach its binding first so invalidation is not recorded as human rejection.
        const stale = db.prepare(`SELECT DISTINCT b.relation_id AS id FROM organization_bindings b
          JOIN canonical_element_relations r ON r.id=b.relation_id
          JOIN elements a ON a.id=r.source_id JOIN elements z ON z.id=r.target_id
          JOIN elements changed ON changed.id=?
          WHERE b.modified=0 AND r.kind=1 AND r.name='相似' AND r.direction=0 AND a.kind=1 AND z.kind=1
            AND (r.source_id=changed.id OR r.target_id=changed.id) AND changed.deleted_at IS NULL AND changed.body<>?`)
          .all(id, content.body).map((row) => row.id);
        if (stale.length) {
          const ids = JSON.stringify(stale);
          db.prepare("DELETE FROM organization_bindings WHERE relation_id IN(SELECT value FROM json_each(?))").run(ids);
          db.prepare("DELETE FROM element_relations WHERE id IN(SELECT value FROM json_each(?))").run(ids);
        }
        const result = db.prepare("UPDATE elements SET body = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
          .run(content.body, new Date().toISOString(), id);
        if (!result.changes) throw elementError("内容不存在或已移入回收站", 404);
        db.prepare(`DELETE FROM element_tags WHERE element_id=? AND tag_id NOT IN
          (SELECT id FROM resolved_tags WHERE normalized_name IN (SELECT value FROM json_each(?)))`)
          .run(id, JSON.stringify(vocabulary.tags(content.tags)));
        addTags(id, content.tags);
        return get(id);
      });
    },
    trash(id) {
      const now = new Date().toISOString();
      const result = db.prepare("UPDATE elements SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(now, now, id);
      if (!result.changes) throw elementError("内容不存在或已移入回收站", 404);
      return { ok: true };
    },
    restore(id) {
      const result = db.prepare("UPDATE elements SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL")
        .run(new Date().toISOString(), id);
      if (!result.changes) throw elementError("回收站中没有此内容", 404);
      return get(id);
    },
    trashIds() { return db.prepare("SELECT id FROM elements WHERE deleted_at IS NOT NULL ORDER BY id").all().map((row) => row.id); },
    purge(id) {
      return transaction(() => {
        const row = db.prepare("SELECT deleted_at FROM elements WHERE id = ?").get(id);
        if (!row) return null; // Retrying an already completed deletion is safe.
        if (!row.deleted_at) throw elementError("只能永久删除回收站中的内容", 409);
        if (db.prepare("SELECT 1 FROM chat_turns WHERE state=0").get()) throw elementError("请等待当前会话结束后永久删除，以免历史记录被在途任务重新写入", 409);
        deleteChatHistory(db, id);
        const image = db.prepare("SELECT storage_key FROM element_images WHERE element_id = ?").get(id);
        const video = db.prepare("SELECT storage_key FROM element_videos WHERE element_id=?").get(id);
        db.prepare("DELETE FROM element_relations WHERE source_id = ? OR target_id = ?").run(id, id);
        db.prepare("DELETE FROM tag_relations WHERE source_id = ?").run(id);
        db.prepare("DELETE FROM canvas_positions WHERE element_id = ?").run(id);
        db.prepare("DELETE FROM element_tags WHERE element_id = ?").run(id);
        db.prepare("DELETE FROM element_images WHERE element_id = ?").run(id);
        db.prepare("DELETE FROM element_videos WHERE element_id=?").run(id);
        if (!db.prepare("DELETE FROM elements WHERE id = ? AND deleted_at IS NOT NULL").run(id).changes) {
          throw elementError("回收站内容已变化，请刷新后重试", 409);
        }
        return video ? { kind: "video", storageKey: video.storage_key } : image?.storage_key || null;
      });
    },
    image(id, { trash = false } = {}) {
      if (trash) {
        if (!db.prepare(`SELECT 1 FROM elements e WHERE e.id=? AND e.deleted_at IS NOT NULL${visibility}`).get(id)) {
          throw elementError("回收站中没有此图片", 404);
        }
      } else get(id);
      const row = db.prepare("SELECT storage_key, mime_type FROM element_images WHERE element_id = ?").get(id);
      if (!row) throw elementError("此内容没有图片", 404);
      return { storageKey: row.storage_key, mimeType: row.mime_type };
    },
    video(id) {
      get(id);
      const row = db.prepare("SELECT storage_key,mime_type,byte_size FROM element_videos WHERE element_id=?").get(id);
      if (!row) throw elementError("此内容没有视频", 404);
      return { storageKey: row.storage_key, mimeType: row.mime_type, byteSize: row.byte_size };
    },
    relate(a, b, type = "related", inputName, semantics = {}) {
      return relateWithChange(a, b, type, inputName, semantics).relation;
    },
    relateBatch({ sourceId, name, targetIds, targetTags, direction, reverseName = "" }) {
      return transaction(() => {
        get(sourceId);
        const createdAt = new Date().toISOString();
        if (targetTags) {
          const targets = targetTags.map((name) => {
            const tag = db.prepare("SELECT id FROM tags WHERE normalized_name = ?").get(name.toLowerCase());
            if (!tag) throw elementError(`标签不存在：${name}`, 404);
            return tag.id;
          });
          const insert = db.prepare("INSERT INTO tag_relations(source_id, tag_id, name, created_at, direction, reverse_name) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, tag_id, name) DO NOTHING");
          for (const tagId of targets) {
            const canonicalId = db.prepare("SELECT canonical_id FROM resolved_tags WHERE id=?").get(tagId).canonical_id;
            const resolved = vocabulary.relation({ name, direction, reverseName });
            const existing = db.prepare("SELECT * FROM visible_tag_relations WHERE source_id=? AND tag_id=? AND name=?").all(sourceId, canonicalId, resolved.name);
            if (existing.length) {
              if (existing.some((r) => r.direction === storedDirection(direction) && r.reverse_name === resolved.reverseName)) continue;
              throw elementError("已存在同名标签关联，请编辑现有关联的方向", 409);
            }
            insert.run(sourceId, tagId, name, createdAt, storedDirection(direction), reverseName);
            const row = db.prepare("SELECT direction,reverse_name FROM tag_relations WHERE source_id=? AND tag_id=? AND name=?").get(sourceId, tagId, name);
            if (row.direction !== storedDirection(direction) || row.reverse_name !== reverseName) throw elementError("已存在同名标签关联，请编辑现有关联的方向", 409);
          }
        } else {
          for (const id of targetIds) get(id);
          for (const id of targetIds) this.relate(sourceId, id, "related", name, { direction, reverseName });
        }
        return { ok: true };
      });
    },
    renameRelations({ ids, tagRelationIds, name }) {
      try {
        return transaction(() => {
          const message = "部分内容之间已存在同名关联，本次未修改任何关联，请使用其他名称";
          for (const id of ids) renameGroup(id, false, { name }, message);
          for (const id of tagRelationIds) renameGroup(id, true, { name }, message);
          return { ok: true };
        });
      } catch (error) {
        if (error.errcode === 1811) throw elementError(error.message);
        if (error.errcode === 2067) throw elementError("部分内容之间已存在同名关联，本次未修改任何关联，请使用其他名称", 409);
        throw error;
      }
    },
    renameRelation(id, { name, direction, reverseName }) {
      try {
        transaction(() => renameGroup(id, false, { name, ...(direction === undefined ? {} : { direction }), ...(reverseName === undefined ? {} : { reverseName }) }));
      } catch (error) {
        if (error.errcode === 1811) throw elementError(error.message);
        if (error.errcode === 2067) throw elementError("这两份内容之间已存在同名关联，请使用其他名称", 409);
        throw error;
      }
      return { ok: true };
    },
    renameTagRelation(id, { name, direction, reverseName }) {
      try {
        transaction(() => renameGroup(id, true, { name, ...(direction === undefined ? {} : { direction }), ...(reverseName === undefined ? {} : { reverseName }) }));
      } catch (error) {
        if (error.errcode === 1811) throw elementError(error.message);
        if (error.errcode === 2067) throw elementError("当前内容与该标签已存在同名关联，请使用其他名称", 409);
        throw error;
      }
      return { ok: true };
    },
    unrelatedTag(id) {
      return transaction(() => {
        if (!db.prepare("DELETE FROM tag_relations WHERE id IN(SELECT value FROM json_each(?))").run(JSON.stringify(relationGroup(id, true))).changes) throw elementError("标签关联不存在", 404);
        return { ok: true };
      });
    },
    unrelated(id) {
      return transaction(() => {
        if (!db.prepare("DELETE FROM element_relations WHERE id IN(SELECT value FROM json_each(?))").run(JSON.stringify(relationGroup(id))).changes) throw elementError("关联不存在", 404);
        return { ok: true };
      });
    },
    tagRelations(id) {
      get(id);
      return { tagRelations: db.prepare(`SELECT r.id, r.name, r.source_id AS sourceId, r.direction, r.reverse_name, t.name AS targetTag FROM visible_tag_relations r
        JOIN tags t ON t.id = r.tag_id WHERE r.source_id = ? ORDER BY r.id DESC`).all(id).map((row) => ({ ...row, ...relationDirection(row) })) };
    },
    tagRelationMembers(id, query) {
      const relation = db.prepare(`SELECT r.tag_id, r.source_id FROM canonical_tag_relations r
        JOIN elements e ON e.id = r.source_id WHERE r.id = ? AND e.deleted_at IS NULL${visibility}`).get(id);
      if (!relation) throw elementError("标签关联不存在或来源已移入回收站", 404);
      return tagMembers(relation.tag_id, relation.source_id, query);
    },
    relations(id, { page = 1, pageSize = 36 } = {}) {
      get(id);
      const roles = vocabulary.relationRoles();
      const join = `FROM resolved_element_relations r JOIN elements e
        ON e.id = CASE WHEN r.source_id = ? THEN r.target_id ELSE r.source_id END
        WHERE (r.source_id = ? OR r.target_id = ?) AND e.deleted_at IS NULL${visibility}
        AND (r.tag_relation_id IS NULL OR r.source_id != ?)`;
      const tagTotal = db.prepare("SELECT count(*) AS total FROM visible_tag_relations WHERE source_id = ?").get(id).total;
      const total = tagTotal + db.prepare(`SELECT count(*) AS total ${join}`).get(id, id, id, id).total;
      const offset = (page - 1) * pageSize;
      const tagRows = db.prepare(`SELECT r.id, r.name, r.source_id AS sourceId, r.direction, r.reverse_name, r.tag_id, t.name AS targetTag FROM visible_tag_relations r
        JOIN tags t ON t.id = r.tag_id WHERE r.source_id = ? ORDER BY r.id DESC LIMIT ? OFFSET ?`).all(id, pageSize, offset);
      const tagRelations = tagRows.map(({ tag_id, ...relation }) => {
        const members = tagMembers(tag_id, id, { pageSize: 4 });
        return { ...relation, ...relationDirection(relation), memberCount: members.pagination.total, previews: members.elements };
      });
      const rows = db.prepare(`SELECT r.id AS relation_id, r.kind, r.name, r.direction, r.reverse_name, r.source_id, r.target_id, r.tag_relation_id, r.target_tag, e.id ${join} ORDER BY r.id DESC LIMIT ? OFFSET ?`)
        .all(id, id, id, id, pageSize - tagRows.length, Math.max(0, offset - tagTotal));
      return { tagRelations, relations: rows.map((row) => ({ id: row.relation_id, name: row.name, ...relationDirection(row),
        role: relationRole({ name: row.name, ...relationDirection(row), sourceId: row.source_id, type: row.kind === 2 ? "title" : "related" }, id, roles),
        ...(!row.tag_relation_id && db.prepare("SELECT result_id AS aiResultId,modified AS aiModified FROM organization_bindings WHERE relation_id=?").get(row.relation_id)), type: row.kind === 2 ? "title" : "related", sourceId: row.source_id, targetId: row.target_id,
        ...(row.tag_relation_id ? { tagRelationId: row.tag_relation_id, targetTag: row.target_tag } : {}), element: get(row.id) })), pagination: pagination(total, page, pageSize) };
    },
  };
}
