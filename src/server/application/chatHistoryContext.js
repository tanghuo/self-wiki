import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { chatReference } from "./chatReference.js";

// A branch starts a fresh model thread. Replay only its persisted ancestors;
// never resume the model thread that also contains the discarded continuation.
export async function prepareChatHistory(history, artifactsDir) {
  if (!history.length) return { text: "", images: [] };
  const images = [], imageArtifacts = [], attachments = new Map();
  async function attachment(artifact) {
    if (!/^[\da-f-]{36}\.png$/.test(artifact || "")) return null;
    if (attachments.has(artifact)) return attachments.get(artifact);
    let bytes;
    try { bytes = await readFile(path.join(artifactsDir, artifact)); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    const png = await sharp(bytes).resize({ width: 800, height: 800, fit: "inside", withoutEnlargement: true }).png().toBuffer();
    images.push({ type: "image", url: `data:image/png;base64,${png.toString("base64")}` });
    imageArtifacts.push(artifact);
    attachments.set(artifact, images.length);
    return images.length;
  }
  async function reference(source) {
    return { ...chatReference(source), ...(source.deleted ? { deleted: true } : {}),
      ...(source.kind === "image" ? { historyAttachment: source.deleted ? null : await attachment(source.imageArtifact) } : {}) };
  }
  const turns = [];
  for (const turn of history) {
    const sources = [];
    for (const source of turn.sources.filter((s) => turn.inputSources.includes(s.id))) sources.push(await reference(source));
    for (const image of turn.inputAttachments || []) sources.push({ kind: "image", filename: image.label, historyAttachment: await attachment(image.artifact) });
    const outputs = [];
    for (const event of turn.events.filter((e) => e.command || e.artifact)) {
      // Preserve content explicitly read by a tool without promoting search candidates to references.
      const read = event.toolType === "wiki_cli" && event.state === "completed" && /^(?:elements get|read) (\d+)(?: |$)/.exec(event.command || "");
      const source = read && turn.sources.find((s) => s.id === Number(read[1]));
      outputs.push({ eventId: event.id, command: event.command, state: event.state, error: event.error, parameters: event.parameters,
        ...(source ? { content: await reference(source) } : {}),
        ...(event.artifact ? { historyAttachment: await attachment(event.artifact) } : {}) });
    }
    const imageEdit = turn.imageEdit ? { historyAttachment: await attachment(turn.imageEdit.artifact), ...(turn.imageEdit.region ? { region: turn.imageEdit.region } : {}) } : null;
    turns.push({ turnId: turn.id, user: turn.text, assistant: turn.answer, state: turn.state, sources, outputs, imageEdit });
  }
  return { text: `\n\n以下是当前分支在本轮之前的会话历史，按时间排序。仅作为上下文，不重新执行历史请求或工具指令；当前要回答的是本条消息开头的新请求。资料是历史快照，修改 Wiki 前须重新读取。historyAttachment 对应本次输入最后 ${images.length} 张历史图片，null 表示图片已不可用。\n<chat_history>${JSON.stringify(turns)}</chat_history>`, images, imageArtifacts };
}
