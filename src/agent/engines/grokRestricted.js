import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { openGrokWorkbench } from './grokWorkbench.js';

export async function callRestrictedGrok(snapshot, { prompt, images, workspace, signal, onRequest, onProgress }) {
  const startedAt = Date.now();
  let engine, text = '', violation, lastProgress = 0, lastPhase;
  const report = (phase, force = false) => {
    const now = Date.now();
    if (!force && phase === lastPhase && now - lastProgress < 500) return;
    lastProgress = now; lastPhase = phase;
    onProgress?.({ type: 'metadata', metadata: { progress: { phase, startedAt, updatedAt: now, text: text.slice(0, 16000), textLength: text.length } } });
  };
  report('preparing', true);
  const root = await realpath(workspace), neutralCwd = path.join(root, '.neutral'); await mkdir(neutralCwd, { recursive: true });
  const attachments = [];
  for (const file of images) {
    const source = await realpath(file), relative = path.relative(root, source);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || (await stat(source)).size > 25 * 1024 * 1024) throw new Error('参考图不属于工作流尝试目录或超过限制');
    const image = sharp(await readFile(source), { limitInputPixels: 40000000 }), info = await image.metadata();
    if (!['png', 'jpeg', 'webp'].includes(info.format) || (info.pages || 1) !== 1) throw new Error('参考图须为单张 PNG、JPEG、WebP');
    const bytes = await image.resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true }).toBuffer();
    if (bytes.length > 10 * 1024 * 1024) throw new Error('工作流参考图预览超过 10 MiB');
    attachments.push({ type: 'image', mimeType: `image/${info.format}`, data: bytes.toString('base64') });
  }
  try {
    engine = await openGrokWorkbench(snapshot.settings, { cwd: root, neutralCwd, restricted: true, signal,
      onPolicyViolation() { violation = new Error('受限模型节点拒绝工具调用'); },
      onRequest() { violation = new Error('受限模型节点拒绝工具调用'); throw violation; }, onExit() {},
      onEvent(type, value) {
        if (type === 'tool.updated') violation = new Error('受限模型节点拒绝工具调用');
        if (type === 'resource.queued') report('queued', true);
        if (type === 'resource.acquired') report('waiting', true);
        if (type === 'engine.extension' && value.type === 'agent_thought_chunk' && !text) report('thinking');
        if (type === 'message.delta') { text += value.text; if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('模型输出超过 2 MiB'); report('generating'); }
      },
    });
    onProgress?.({ type: 'metadata', metadata: { remoteThreadId: engine.sessionId, restrictedProfile: engine.capabilities.profile, model: engine.capabilities.model, effort: engine.capabilities.effort } });
    const result = await engine.prompt(prompt, delivery => { if (delivery === 'attempted') onRequest({ method: 'session/prompt', params: { threadId: engine.sessionId }, delivery }); }, attachments);
    if (violation) throw violation;
    if (result.stopReason !== 'end_turn') throw Object.assign(new Error('受限模型被中断，结果可能未知'), { unknown: true });
    report('completed', true);
    return { text };
  } catch (error) { throw violation || error; }
  finally { await engine?.close(); }
}
