import { createHash } from "node:crypto";
import { elementContent, elementError, elementId, elementTags, imagePreviewWidths, relationBatch, relationBatchUpdate, relationUpdate, relationSemantics } from "../../shared/domain/elements.js";
import { canvasPositions } from "../../shared/domain/canvas.js";
import { vocabularyAlias, vocabularyKind } from "../../shared/domain/vocabulary.js";
import { videoMarkerInput, markerRevision } from "../../shared/domain/videoMarkers.js";

export function createElementService(repo, imageStore, cleanupHistory, videoStore) {
  let warming, stopWarming = false;
  let importing = 0;
  let importingVideos = 0;
  return {
    startPreviews() {
      warming ||= (async () => {
        let before = Number.MAX_SAFE_INTEGER;
        while (!stopWarming) {
          const files = repo.previewImages(before);
          if (!files.length) break;
          for (const file of files) {
            if (stopWarming) return;
            before = file.element_id;
            try {
              if (!file.width || !file.height) repo.setImageDimensions(file.element_id, file.storage_key, await imageStore.dimensions(file.storage_key));
              for (const width of [400, 800]) {
                if (stopWarming) return;
                await imageStore.thumbnail(file.storage_key, width);
              }
            } catch { /* Missing/broken originals remain accessible through normal error handling. */ }
          }
        }
      })();
      return warming;
    },
    async closePreviews() { stopWarming = true; await warming?.catch(() => {}); },
    async prepareImages() {
      for (const file of repo.unhashedImages()) {
        try {
          const bytes = await imageStore.read(file.storage_key);
          repo.setImageHash(file.element_id, createHash("sha256").update(bytes).digest("hex"));
        } catch (error) { if (error.statusCode !== 404) throw error; }
      }
    },
    list: (query) => repo.list(query),
    tags: (options) => repo.tags(options),
    tagAliases: () => repo.tagAliases(),
    vocabulary: () => repo.vocabulary.read(),
    setAlias: (payload) => repo.vocabulary.setAlias(vocabularyAlias(payload)),
    removeAlias: (kind, id) => repo.vocabulary.removeAlias(vocabularyKind(kind), elementId(id)),
    get: (id) => repo.get(id),
    setMaterial(payload) {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)
        || Object.keys(payload).some((key) => !["ids", "material"].includes(key))
        || typeof payload.material !== "boolean" || !Array.isArray(payload.ids)
        || !payload.ids.length || payload.ids.length > 100) throw elementError("请选择 1–100 个内容并指定素材标记");
      return repo.setMaterial([...new Set(payload.ids.map(elementId))], payload.material);
    },
    recordUsage: (id, payload) => repo.recordUsage(id, payload?.action),
    usage(query) {
      const from = query.get("from") === null ? 0 : Number(query.get("from"));
      const to = query.get("to") === null ? Date.now() + 1 : Number(query.get("to"));
      const sort = query.get("sort") || "total";
      if (![from, to].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000)
        || from >= to || !["total", "copy", "reference"].includes(sort)) throw elementError("无效的统计时间范围或排序");
      return repo.usage({ from, to, sort });
    },
    lifecycle: (id) => repo.lifecycle(id),
    conversation: (id, from) => repo.conversation(id, from),
    markers: (id, query) => repo.markers.list(id, query),
    marker: (id) => repo.markers.get(id),
    createMarker: (id, payload) => repo.markers.create(id, videoMarkerInput(payload)),
    updateMarker: (id, payload) => repo.markers.update(id, videoMarkerInput(payload, { update: true, existingTags: repo.markers.get(id).tags })),
    deleteMarker: (id, payload) => repo.markers.remove(id, markerRevision(payload.revision)),
    videoReferences: (id, query) => repo.markers.references(id, query),
    create(payload) {
      const { material = false, ...content } = payload;
      if (typeof material !== "boolean") throw elementError("无效的素材标记");
      return repo.createText({ ...elementContent(content), material, creationSource: "manual" });
    },
    update: (id, payload) => repo.update(id, elementContent(payload, repo.get(id))),
    trash: (id) => repo.trash(id),
    restore: (id) => repo.restore(id),
    async purgeTrash(payload) {
      if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
          Object.keys(payload).some((key) => !["all", "ids"].includes(key)) ||
          (payload.all === true ? payload.ids !== undefined : payload.all !== undefined || !Array.isArray(payload.ids) || !payload.ids.length || payload.ids.length > 100)) {
        throw elementError("请指定要删除的内容或明确清空全部回收站");
      }
      const ids = payload.all === true ? repo.trashIds() : [...new Set(payload.ids.map(elementId))];
      const deleted = [], failed = [], cleanupFailed = [];
      for (const id of ids) {
        let key;
        try { key = repo.purge(id); deleted.push(id); }
        catch (error) { failed.push({ id, message: error.statusCode ? error.message : "删除失败，请重试" }); continue; }
        // Commit references first: a file failure must never leave a restorable record without its original.
        if (key) {
          try { if (key.kind === "video") await videoStore.remove(key.storageKey); else await imageStore.remove(key); }
          catch { cleanupFailed.push(id); }
        }
      }
      const historyCleanupFailed = await cleanupHistory?.();
      return { deleted, failed, cleanupFailed, ...(historyCleanupFailed?.length ? { historyCleanupFailed } : {}) };
    },
    relate: (a, b, type, name, semantics = {}) => repo.relate(a, b, type, name, relationSemantics({ ...semantics, name })),
    relateBatch: (payload) => repo.relateBatch(relationBatch(payload)),
    renameRelations: (payload) => repo.renameRelations(relationBatchUpdate(payload)),
    renameRelation: (id, payload) => repo.renameRelation(id, relationUpdate(payload)),
    renameTagRelation: (id, payload) => repo.renameTagRelation(id, relationUpdate(payload)),
    unrelatedTag: (id) => repo.unrelatedTag(id),
    unrelated: (id) => repo.unrelated(id),
    relations: (id, query) => repo.relations(id, query),
    tagRelationMembers: (id, query) => repo.tagRelationMembers(id, query),
    tagRelations: (id) => repo.tagRelations(id),
    canvas: (query) => repo.canvas.read(query),
    saveCanvas: (payload) => repo.canvas.save(canvasPositions(payload)),
    async thumbnail(id, width = null, { trash = false, foreground = false, regenerate = false } = {}) {
      if (width !== null && !imagePreviewWidths.includes(Number(width))) throw elementError("无效的预览宽度");
      const file = repo.image(id, { trash });
      return { bytes: await imageStore.thumbnail(file.storageKey, width === null ? undefined : Number(width), { foreground, regenerate }), contentType: "image/webp" };
    },
    async importImage(bytes, name, inputTags = [], material = false) {
      if (importing >= 2) throw elementError("正在保存图片，请稍后重试", 503);
      const tags = elementTags(inputTags);
      const originalName = name.split(/[\\/]/).pop().slice(0, 240) || "图片";
      importing++;
      try {
        const file = await imageStore.save(bytes, originalName);
        let result;
        try {
          file.contentHash = createHash("sha256").update(bytes).digest("hex");
          const existing = repo.findImageByHash(file.contentHash);
          const missingStorageKey = existing && !existing.deleted_at && !await imageStore.exists(existing.storage_key) ? existing.storage_key : undefined;
          result = repo.importImage({ tags, material, creationSource: "manual" }, file, missingStorageKey);
        }
        catch (error) { await imageStore.remove(file.storageKey).catch(() => {}); throw error; }
        // The import is committed: a failed cleanup of the duplicate copy must not report failure.
        if (!result.keepFile) await imageStore.remove(file.storageKey).catch((error) => console.error("[self-wiki] duplicate image cleanup failed:", error.message));
        else for (const width of [400, 800]) await imageStore.thumbnail(file.storageKey, width).catch(() => {});
        return result.element;
      } finally { importing--; }
    },
    async image(id) {
      const file = repo.image(id);
      return { bytes: await imageStore.read(file.storageKey), contentType: file.mimeType };
    },
    async importVideo(stream, name, inputTags = [], material = false) {
      if (importingVideos >= 2) throw elementError("正在保存视频，请稍后重试", 503);
      const tags = elementTags(inputTags);
      const filename = name.split(/[\\/]/).pop();
      const parts = filename.match(/^(.*)(\.(?:mp4|m4v|webm|mov))$/i);
      const originalName = parts ? Array.from(parts[1]).slice(0, 240 - parts[2].length).join("") + parts[2]
        : Array.from(filename).slice(0, 240).join("") || "视频";
      importingVideos++;
      try {
        const file = await videoStore.save(stream, originalName);
        let result;
        try {
          const existing = repo.findVideoByHash(file.contentHash);
          const missingStorageKey = existing && !existing.deleted_at && !await videoStore.exists(existing.storage_key) ? existing.storage_key : undefined;
          result = repo.importVideo({ tags, material, creationSource: "manual" }, file, missingStorageKey);
        } catch (error) { await videoStore.remove(file.storageKey).catch(() => {}); throw error; }
        // Committed: a failed cleanup of the duplicate upload must not turn success into an error.
        if (!result.keepFile) await videoStore.remove(file.storageKey).catch((error) => console.error("[self-wiki] duplicate video cleanup failed:", error.message));
        return result.element;
      } finally { importingVideos--; }
    },
    async video(id) {
      const file = repo.video(id);
      return { handle: await videoStore.open(file.storageKey), contentType: file.mimeType, byteSize: file.byteSize, contentHash: file.contentHash };
    },
    videoStorage: (id) => repo.video(id),
    videoCover: (id) => videoStore.cover(repo.video(id).storageKey),
    async videoFirstFrame(id, options) {
      const { storageKey } = repo.video(id);
      const bytes = await videoStore.firstFrame(storageKey, options);
      try {
        if (repo.video(id).storageKey !== storageKey) throw elementError("视频已变化，请重试", 409);
      } catch (error) { await videoStore.removeFirstFrame(storageKey); throw error; }
      return { bytes, contentType: "image/png" };
    },
    async saveVideoCover(id, payload) {
      const { storageKey } = repo.video(id);
      const cover = await videoStore.saveCover(storageKey, payload);
      // A purge or repaired import may have completed while the cache was written.
      try {
        if (repo.video(id).storageKey !== storageKey) throw elementError("视频已变化，请重试", 409);
      } catch (error) { await videoStore.removeCover(storageKey); throw error; }
      return cover;
    },
  };
}
