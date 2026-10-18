import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

// Keep the original and optional visual guide available when Codex resumes this conversation.
export async function prepareChatImageEdit(bytes, edit, workspace) {
  const directory = await mkdtemp(path.join(workspace, "image-edit-"));
  const original = path.join(directory, "original.png");
  await writeFile(original, bytes, { flag: "wx" });
  const attachments = [{ type: "localImage", path: original }];
  let context = `\n\n用户明确选择了一张已生成的图片进行编辑。第一张附件是待编辑原图，文件路径：${JSON.stringify(original)}。必须以这张原图为基础调用图片生成/编辑工具，不要改用会话里其他图片。只按用户要求修改，保留其他细节，输出新的图片文件，不能覆盖原图。`;
  if (edit.region) {
    const { data, info } = await sharp(bytes, { limitInputPixels: 40_000_000 }).resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    const { x, y, width, height } = edit.region;
    const overlay = Buffer.from(`<svg width="${info.width}" height="${info.height}"><rect x="${x * info.width}" y="${y * info.height}" width="${width * info.width}" height="${height * info.height}" fill="#8b5cf6" fill-opacity="0.25" stroke="#8b5cf6" stroke-width="${Math.max(1, info.width / 300)}"/></svg>`);
    const guide = path.join(directory, "selection.png");
    await sharp(data).composite([{ input: overlay }]).png().toFile(guide);
    attachments.push({ type: "localImage", path: guide });
    context += `第二张附件仅用于指示编辑位置，紫色框是用户选区，不是要出现在成品中的内容。相对于原图左上角的归一化选区为 ${JSON.stringify(edit.region)}。优先修改该区域，尽量保留区域外内容；不要将标记或紫色覆盖层画入结果。编辑工具的原图引用应使用第一张附件。`;
  }
  return { attachments, context };
}
