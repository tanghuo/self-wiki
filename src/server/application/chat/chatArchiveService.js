import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { elementContent, elementError } from "../../../shared/domain/elements.js";

export function createChatArchiveService({ repo, imageStore, dataDir }) {
  let saving = false;
  async function prepared(turnId, value, action) {
    if (saving) throw elementError("正在保存来源链，请稍后重试", 409);
    saving = true;
    const files = new Map();
    try {
      const plan = repo.plan(turnId, value);
      for (const [name, info] of plan.images) {
        if (!info.needed) continue;
        if (!/^[\da-f-]{36}\.png$/.test(name)) throw elementError("无效的图片产物", 400);
        const bytes = await readFile(path.join(dataDir, "chat-artifacts", name)).catch(() => { throw elementError("来源图片文件缺失，请恢复文件后重试", 404); });
        const file = await imageStore.save(bytes, `生成图片-${info.turnId}.png`);
        files.set(name, file);
        file.contentHash = createHash("sha256").update(bytes).digest("hex");
        const existing = repo.existingImage(file.contentHash);
        if (existing && !existing.deleted_at && !await imageStore.exists(existing.storage_key)) file.missingStorageKey = existing.storage_key;
      }
      return action(files);
    } finally {
      try {
        for (const file of files.values()) if (!repo.fileUsed(file.storageKey)) {
          try { await imageStore.remove(file.storageKey); }
          catch { repo.queueFile(`asset:${file.storageKey}`); }
        }
      }
      finally { saving = false; }
    }
  }
  return {
    saved: repo.saved,
    recoverPrompts: repo.recoverPrompts,
    nextPrompt: repo.nextPrompt,
    startPrompt: repo.startPrompt,
    finishPrompt: repo.finishPrompt,
    failQueuedPrompt: repo.failQueuedPrompt,
    trackCopy(artifact, file) {
      const relative = path.relative(path.join(dataDir, "chat-workspace"), file);
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw elementError("图片副本超出聊天工作目录");
      repo.trackCopy(artifact, relative);
    },
    async cleanup() {
      const failed = [];
      for (const name of repo.cleanupFiles()) {
        try {
          if (name.startsWith("asset:")) {
            if (!repo.fileUsed(name.slice(6))) await imageStore.remove(name.slice(6));
            repo.fileRemoved(name); continue;
          }
          const workspace = name.startsWith("workspace:"), root = path.resolve(dataDir, workspace ? "chat-workspace" : "chat-artifacts");
          const target = path.resolve(root, workspace ? name.slice(10) : name), relative = path.relative(root, target);
          if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("Invalid cleanup path");
          await rm(target, { force: true }); repo.fileRemoved(name);
        } catch { failed.push(name); }
      }
      return failed;
    },
    save(turnId, value = {}) {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["artifact", "body", "tags"].includes(key)) || value.artifact !== undefined && (value.body !== undefined || value.tags !== undefined)) throw elementError("请选择一个图片产物或一份文字内容");
      if (value.artifact !== undefined && (typeof value.artifact !== "string" || !/^[\da-f-]{36}\.png$/.test(value.artifact))) throw elementError("请选择有效图片");
      const turn = repo.turn(turnId);
      const content = value.artifact ? { artifact: value.artifact } : elementContent({ body: value.body ?? turn.answer, tags: value.tags || [] });
      return prepared(turnId, content, (files) => repo.save(turnId, content, files));
    },
    accept(id, edit) {
      const proposal = repo.proposal(id);
      if (proposal.state !== "pending" || proposal.payload.kind !== "create_text" || repo.turn(proposal.turnId).internal) return repo.accept(id, edit, new Map());
      return prepared(proposal.turnId, undefined, (files) => repo.accept(id, edit, files));
    },
  };
}
