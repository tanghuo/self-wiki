import { mkdir, readFile, writeFile, unlink, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { elementError, maxImageBytes } from "../../../shared/domain/elements.js";

/** Attachment + generated-image artifact helpers for chatService. */
export function createChatAttachments({ artifactsDir, repo, archive, isClosed }) {
  let uploadingAttachments = 0;

  async function saveGeneratedImage(run, event, bytes, sourceFile, { alive, appearance }) {
    if (!bytes?.length || bytes.length > 25 * 1024 * 1024) throw new Error("图片结果为空或超过 25 MiB");
    if (sourceFile) {
      const root = await realpath(run.workspace), file = await realpath(sourceFile), relative = path.relative(root, file);
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("生成图片未保存在聊天工作目录");
      sourceFile = path.join(run.workspace, relative);
    }
    const png = await sharp(bytes, { limitInputPixels: 40_000_000 }).png().toBuffer();
    alive(run);
    await mkdir(artifactsDir, { recursive: true });
    const name = `${randomUUID()}.png`, file = path.join(artifactsDir, name);
    await writeFile(file, png, { flag: "wx" });
    try { alive(run); if (sourceFile) archive.trackCopy(name, sourceFile); }
    catch (error) { await unlink(file); throw error; }
    event.answerOffset = run.value.answer.length;
    event.artifact = name; event.imageAppearance = appearance(run);
    return png;
  }

  async function imageReference(run, image, artifact, { alive }) {
    const file = path.join(run.workspace, `image-reference-${randomUUID()}.png`);
    await writeFile(file, Buffer.from(image.url.slice(image.url.indexOf(",") + 1), "base64"), { flag: "wx" });
    try { alive(run); if (artifact) archive.trackCopy(artifact, file); }
    catch (error) { await unlink(file); throw error; }
    return { type: "localImage", path: file };
  }

  async function imageContent(run, id, original, { wiki, alive, schedule, maxChatImages }) {
    if (run.imageIds.has(id)) return null;
    if (run.imageCount >= maxChatImages) throw elementError(`本轮最多读取 ${maxChatImages} 张图片`);
    const image = await (original ? wiki.image(id) : wiki.thumbnail(id, 800)); alive(run); repo.unchanged([run.sources.get(id)]);
    const png = await sharp(image.bytes, { limitInputPixels: 40_000_000 }).rotate().png().toBuffer(); alive(run);
    const source = run.sources.get(id);
    if (!source.imageArtifact) {
      const name = `${randomUUID()}.png`;
      await mkdir(artifactsDir, { recursive: true });
      await writeFile(path.join(artifactsDir, name), png, { flag: "wx" }); alive(run);
      source.imageArtifact = name; schedule(run);
    }
    run.imageCount++; run.imageIds.add(id);
    return `data:image/png;base64,${png.toString("base64")}`;
  }

  return {
    saveGeneratedImage,
    imageReference,
    imageContent,
    async addAttachment(bytes, name) {
      if (isClosed()) throw elementError("应用正在退出", 503);
      if (!bytes.length || bytes.length > maxImageBytes) throw elementError("图片必须在 25 MiB 以内", 413);
      if (uploadingAttachments >= 2) throw elementError("正在处理图片，请稍后重试", 503);
      uploadingAttachments++;
      try {
        let png;
        try {
          const decoder = sharp(bytes, { limitInputPixels: 40_000_000, failOn: "warning" });
          const metadata = await decoder.metadata();
          if (!["png", "jpeg", "webp", "gif"].includes(metadata.format)) throw new Error("Unsupported image");
          png = await decoder.rotate().png().toBuffer();
        } catch { throw elementError("请选择有效的 PNG、JPEG、WebP 或 GIF 图片"); }
        if (png.length > maxImageBytes) throw elementError("图片展开后超过 25 MiB，请缩小后重新粘贴", 413);
        const artifact = `${randomUUID()}.png`, file = path.join(artifactsDir, artifact);
        await mkdir(artifactsDir, { recursive: true });
        await writeFile(file, png, { flag: "wx" });
        try { return repo.addAttachment(artifact, name.replace(/[\x00-\x1f]/g, "").slice(0, 240) || "粘贴图片.png"); }
        catch (error) { await unlink(file); throw error; }
      } finally { uploadingAttachments--; }
    },
    async attachmentImage(id) { return readFile(path.join(artifactsDir, repo.attachment(id).artifact)); },
    async removeAttachment(id) { const removed = repo.removeAttachment(id); await archive.cleanup(); return { removed }; },
    async readArtifact(name) { return readFile(path.join(artifactsDir, name)); },
  };
}
