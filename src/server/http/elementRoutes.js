import { createHash } from "node:crypto";
import { elementId, elementQuery, elementTags } from "../../shared/domain/elements.js";
import { canvasQuery } from "../../shared/domain/canvas.js";
import { httpError, json, readJson, readImage } from "./http.js";
import { serveVideo } from "./videoResponse.js";

export async function handleElementRoute(wiki, req, res, url, semantic, { allowTrashPreview = false, allowUsageStats = false, allowMaterialWrite = false } = {}) {
  const method = req.method;
  const route = url.pathname;
  if (route === "/api/elements/material") {
    if (!allowMaterialWrite) throw httpError(403, "素材标记仅限本机修改");
    if (method !== "PATCH") throw httpError(405, "Method not allowed");
    json(res, 200, wiki.setMaterial(await readJson(req)));
    return true;
  }
  if (route === "/api/element-usage") {
    if (!allowUsageStats) throw httpError(403, "使用统计仅限本机查看");
    if (method !== "GET") throw httpError(405, "Method not allowed");
    json(res, 200, wiki.usage(url.searchParams));
    return true;
  }
  const cover = route.match(/^\/api\/elements\/([1-9]\d*)\/video-cover$/);
  if (cover) {
    const id = elementId(cover[1]);
    res.setHeader("cache-control", "no-store");
    if (method === "GET") json(res, 200, { cover: await wiki.videoCover(id) });
    else if (method === "PUT") json(res, 200, { cover: await wiki.saveVideoCover(id, await readJson(req, { maxBytes: 512 * 1024 })) });
    else throw httpError(405, "Method not allowed");
    return true;
  }
  const markers = route.match(/^\/api\/elements\/([1-9]\d*)\/(markers|video-references)$/);
  if (markers) {
    const id = elementId(markers[1]);
    if (method === "GET") json(res, 200, markers[2] === "markers" ? wiki.markers(id, elementQuery(url.searchParams)) : wiki.videoReferences(id, elementQuery(url.searchParams)));
    else if (method === "POST" && markers[2] === "markers") {
      const result = wiki.createMarker(id, await readJson(req)); json(res, result.reused ? 200 : 201, result);
    } else throw httpError(405, "Method not allowed");
    return true;
  }
  const marker = route.match(/^\/api\/video-markers\/([1-9]\d*)$/);
  if (marker) {
    const id = elementId(marker[1]);
    if (method === "GET") json(res, 200, wiki.marker(id));
    else if (method === "PUT") json(res, 200, wiki.updateMarker(id, await readJson(req)));
    else if (method === "DELETE") json(res, 200, wiki.deleteMarker(id, await readJson(req)));
    else throw httpError(405, "Method not allowed");
    return true;
  }
  const description = route.match(/^\/api\/elements\/([1-9]\d*)\/description(?:\/(regenerate))?$/);
  if (description && semantic) {
    const id = elementId(description[1]);
    wiki.get(id);
    if (!description[2] && method === "GET") json(res, 200, semantic.description(id));
    else if (!description[2] && method === "PATCH") json(res, 200, semantic.updateDescription(id, await readJson(req)));
    else if (description[2] && method === "POST") json(res, 202, semantic.regenerateDescription(id, await readJson(req)));
    else throw httpError(405, "Method not allowed");
    return true;
  }
  if (route === "/api/vocabulary") {
    if (method !== "GET") throw httpError(405, "Method not allowed");
    json(res, 200, wiki.vocabulary());
    return true;
  }
  if (route === "/api/vocabulary/aliases") {
    if (method !== "POST") throw httpError(405, "Method not allowed");
    json(res, 200, wiki.setAlias(await readJson(req)));
    return true;
  }
  const alias = route.match(/^\/api\/vocabulary\/aliases\/([^/]+)\/([^/]+)$/);
  if (alias) {
    if (method !== "DELETE") throw httpError(405, "Method not allowed");
    json(res, 200, wiki.removeAlias(alias[1], alias[2]));
    return true;
  }
  if (route === "/api/trash/purge") {
    if (method !== "POST") throw httpError(405, "Method not allowed");
    json(res, 200, await wiki.purgeTrash(await readJson(req)));
    return true;
  }
  if (route === "/api/canvas") {
    if (method !== "GET") throw httpError(405, "Method not allowed");
    json(res, 200, wiki.canvas(canvasQuery(url.searchParams)));
    return true;
  }
  if (route === "/api/canvas/layout") {
    if (method !== "PUT") throw httpError(405, "Method not allowed");
    json(res, 200, wiki.saveCanvas(await readJson(req)));
    return true;
  }
  if (route === "/api/tags") {
    if (method !== "GET") throw httpError(405, "Method not allowed");
    json(res, 200, { tags: wiki.tags(), aliases: wiki.tagAliases() });
    return true;
  }
  if (route === "/api/elements") {
    if (method === "GET") {
      const query = elementQuery(url.searchParams);
      if (query.sort === "usage" && !allowUsageStats) throw httpError(403, "使用统计仅限本机查看");
      const includeDescription = Boolean(semantic && url.searchParams.get("semantic") === "1" && query.scope !== "trash");
      // Calibrated on local qwen3-embedding:0.6b queries; see docs/search-relevance.md.
      // Agent candidate retrieval keeps its broad top-K behavior.
      const retrieval = includeDescription && query.q.trim()
        ? await semantic.search({ query: query.q, signal: AbortSignal.timeout(5000) }) : null;
      const matches = retrieval?.matches || [];
      const result = wiki.list({ ...query, includeDescription, semanticIds: matches.filter((hit) => hit.score >= 0.48).map((hit) => hit.elementId) });
      if (allowTrashPreview && query.scope === "trash") {
        for (const element of result.elements) if (element.image) element.image.thumbnailUrl = `/api/elements/${element.id}/thumbnail?scope=trash`;
      }
      const possible = result.pagination.total === 0 && matches.length
        ? wiki.list({ ...query, includeDescription, page: 1, pageSize: 100, semanticIds: matches.map((hit) => hit.elementId) }).elements : [];
      json(res, 200, { ...result, possible,
        ...(retrieval?.reason ? { searchNotice: `当前仅匹配文字、文件名和已有图片描述：${retrieval.reason}` } : {}) });
    }
    else if (method === "POST") json(res, 201, wiki.create(await readJson(req)));
    else throw httpError(405, "Method not allowed");
    return true;
  }
  if (route === "/api/videos") {
    try {
      if (method !== "POST") throw httpError(405, "Method not allowed");
      let name, tags;
      try { name = decodeURIComponent(req.headers["x-file-name"] || "视频"); }
      catch { throw httpError(400, "无效的文件名"); }
      try { tags = req.headers["x-video-tags"] ? JSON.parse(Buffer.from(req.headers["x-video-tags"], "base64").toString("utf8")) : []; }
      catch { throw httpError(400, "无效的标签格式"); }
      const material = req.headers["x-element-material"];
      if (material !== undefined && !["0", "1"].includes(material)) throw httpError(400, "无效的素材标记");
      const result = await wiki.importVideo(req, name, tags, material === "1");
      json(res, result.importStatus === "reused" ? 200 : 201, result);
    } catch (error) { req.resume(); throw error; }
    return true;
  }
  if (route === "/api/images") {
    if (method !== "POST") throw httpError(405, "Method not allowed");
    let name;
    try { name = decodeURIComponent(req.headers["x-file-name"] || "图片"); }
    catch { throw httpError(400, "无效的文件名"); }
    let tags;
    try { tags = req.headers["x-image-tags"] ? JSON.parse(Buffer.from(req.headers["x-image-tags"], "base64").toString("utf8")) : []; }
    catch { throw httpError(400, "无效的标签格式"); }
    tags = elementTags(tags);
    const material = req.headers["x-element-material"];
    if (material !== undefined && !["0", "1"].includes(material)) throw httpError(400, "无效的素材标记");
    const result = await wiki.importImage(await readImage(req), name, tags, material === "1");
    json(res, result.importStatus === "reused" ? 200 : 201, result);
    return true;
  }
  if (route === "/api/relations/batch") {
    if (method === "POST") json(res, 200, wiki.relateBatch(await readJson(req)));
    else if (method === "PATCH") json(res, 200, wiki.renameRelations(await readJson(req)));
    else throw httpError(405, "Method not allowed");
    return true;
  }
  const tagRelation = route.match(/^\/api\/tag-relations\/([^/]+)$/);
  if (tagRelation) {
    const id = elementId(tagRelation[1]);
    if (method === "PATCH") json(res, 200, wiki.renameTagRelation(id, await readJson(req)));
    else if (method === "DELETE") json(res, 200, wiki.unrelatedTag(id));
    else throw httpError(405, "Method not allowed");
    return true;
  }
  const tagMembers = route.match(/^\/api\/tag-relations\/([^/]+)\/members$/);
  if (tagMembers) {
    if (method !== "GET") throw httpError(405, "Method not allowed");
    json(res, 200, wiki.tagRelationMembers(elementId(tagMembers[1]), elementQuery(url.searchParams)));
    return true;
  }
  if (route === "/api/relations") {
    if (method !== "POST") throw httpError(405, "Method not allowed");
    const payload = await readJson(req);
    json(res, 200, wiki.relate(elementId(payload.sourceId ?? payload.leftId), elementId(payload.targetId ?? payload.rightId), payload.type, payload.name, { direction: payload.direction, reverseName: payload.reverseName }));
    return true;
  }
  const relation = route.match(/^\/api\/relations\/([^/]+)$/);
  if (relation) {
    const id = elementId(relation[1]);
    if (method === "PATCH") json(res, 200, wiki.renameRelation(id, await readJson(req)));
    else if (method === "DELETE") json(res, 200, wiki.unrelated(id));
    else throw httpError(405, "Method not allowed");
    return true;
  }
  const match = route.match(/^\/api\/elements\/([^/]+)(?:\/(relations|tag-relations|restore|image|video|thumbnail|download|lifecycle|conversation|usage))?$/);
  if (!match) return false;
  const id = elementId(match[1]);
  const action = match[2];
  if (action === "usage") {
    if (method !== "POST") throw httpError(405, "Method not allowed");
    json(res, 200, wiki.recordUsage(id, await readJson(req)));
    return true;
  }
  if ((action === "video" || action === "download" && wiki.get(id).kind === "video") && ["GET", "HEAD"].includes(method)) {
    const name = action === "download" ? wiki.get(id).video.originalName.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, "_") : undefined;
    await serveVideo(req, res, await wiki.video(id), name);
    return true;
  }
  if (action === "download" && method === "GET") {
    const element = wiki.get(id);
    const name = (element.kind === "image" ? element.image.originalName : `${element.body.slice(0, 60) || `wiki-${id}`}.txt`)
      .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, "_");
    const result = element.kind === "image" ? await wiki.image(id) : { bytes: element.body, contentType: "text/plain; charset=utf-8" };
    res.writeHead(200, {
      "content-type": result.contentType, "cache-control": "no-store", "x-content-type-options": "nosniff",
      "content-disposition": `attachment; filename="wiki-${id}${element.kind === "text" ? ".txt" : ""}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}`,
    });
    res.end(result.bytes);
  } else if (action === "lifecycle" && method === "GET") json(res, 200, wiki.lifecycle(id));
  else if (action === "conversation" && method === "GET") json(res, 200, wiki.conversation(id, url.searchParams.has("from") ? elementId(url.searchParams.get("from")) : undefined));
  else if (action === "thumbnail" && method === "GET") {
    const trash = url.searchParams.get("scope") === "trash";
    if (trash && !allowTrashPreview) throw httpError(404, "Not found");
    const result = await wiki.thumbnail(id, url.searchParams.get("width"), { trash, foreground: true, regenerate: url.searchParams.has("retry") });
    // Always revalidate permissions/lifecycle before allowing browser cache reuse.
    const etag = `"${createHash("sha256").update(result.bytes).digest("hex")}"`;
    const unchanged = req.headers["if-none-match"] === etag;
    res.writeHead(unchanged ? 304 : 200, { "content-type": result.contentType, "cache-control": "private, no-cache", etag, "x-content-type-options": "nosniff" });
    res.end(unchanged ? undefined : result.bytes);
  } else if (action === "relations" && method === "GET") json(res, 200, wiki.relations(id, elementQuery(url.searchParams)));
  else if (action === "tag-relations" && method === "GET") json(res, 200, wiki.tagRelations(id));
  else if (action === "restore" && method === "POST") json(res, 200, wiki.restore(id));
  else if (action === "image" && method === "GET") {
    const result = await wiki.image(id);
    res.writeHead(200, { "content-type": result.contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(result.bytes);
  } else if (!action && method === "GET") json(res, 200, wiki.get(id));
  else if (!action && method === "PATCH") json(res, 200, wiki.update(id, await readJson(req)));
  else if (!action && method === "DELETE") json(res, 200, wiki.trash(id));
  else throw httpError(405, "Method not allowed");
  return true;
}
