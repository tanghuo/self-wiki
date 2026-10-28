import { mkdir, writeFile, rename, readFile, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { workflowError } from '../../shared/domain/workflow/contracts.js';

export function createWorkflowStore(dataDir) {
  const root = path.join(dataDir, 'workflow-artifacts'), workspace = path.join(dataDir, 'workflow-workspace'), inputs = path.join(dataDir, 'workflow-input-images');
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  function location(key) {
    if (!/^[a-f0-9]{64}\.(png|jpeg|webp)$/.test(key)) throw workflowError('非法工作流存储键');
    return path.join(root, key);
  }
  async function read(artifact) {
    let bytes;
    try { bytes = await readFile(location(artifact.storageKey)); } catch (e) { if (e.code === 'ENOENT') throw workflowError('工作流产物文件缺失，请从备份恢复', 410); throw e; }
    if (bytes.length !== artifact.byteSize || hash(bytes) !== artifact.hash) throw workflowError('工作流产物损坏', 410);
    return bytes;
  }
  const store = {
    async saveInputImage(bytes, originalName) {
      const artifact = await store.saveImage(bytes, { originalName });
      await mkdir(inputs, { recursive: true });
      await writeFile(path.join(inputs, `${artifact.id}.json`), JSON.stringify(artifact), { flag: 'wx' });
      return { attachmentId: artifact.id };
    },
    async inputImage(id) {
      if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw workflowError('无效的工作流附件 ID');
      let artifact;
      try { artifact = JSON.parse(await readFile(path.join(inputs, `${id}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') throw workflowError('工作流附件不存在', 404); throw error; }
      return { artifact, bytes: await read(artifact) };
    },
    async saveImage(bytes, metadata = {}) {
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 25 * 1024 * 1024) throw workflowError('图片须在 25 MiB 以内');
      let info;
      try { info = await sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' }).metadata(); }
      catch { throw workflowError('无法读取图片'); }
      if (!['png', 'jpeg', 'webp'].includes(info.format) || (info.pages || 1) !== 1) throw workflowError('仅支持单张 PNG、JPEG、WebP 图片');
      // Decode fully before publishing a file that downstream nodes may trust.
      await sharp(bytes, { limitInputPixels: 40_000_000 }).stats();
      const digest = hash(bytes), key = `${digest}.${info.format}`;
      await mkdir(root, { recursive: true });
      const temp = path.join(root, `${randomUUID()}.tmp`);
      try { await writeFile(temp, bytes, { flag: 'wx' }); await rename(temp, location(key)); }
      catch (e) { if (!['EEXIST', 'EPERM'].includes(e.code)) throw e; const existing = await readFile(location(key)); if (hash(existing) !== digest) throw e; }
      finally { await rm(temp, { force: true }); }
      return { id: randomUUID(), type: 'image', storageKey: key, hash: digest, byteSize: bytes.length, metadata: { ...metadata, mime: `image/${info.format}`, width: info.width, height: info.height } };
    },
    read,
    async attemptDirectory(attemptId) {
      if (!Number.isSafeInteger(attemptId) || attemptId < 1) throw workflowError('无效尝试 ID');
      const dir = path.join(workspace, String(attemptId)); await mkdir(dir, { recursive: true }); return dir;
    },
    async materialize(artifact, directory) {
      const target = path.join(directory, artifact.storageKey);
      await writeFile(target, await read(artifact)); return target;
    },
  };
  return store;
}
