import { mkdir, writeFile, readFile, rename, rm, readdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { agentError } from '../../shared/domain/agentWorkbench/contracts.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function createAgentArtifactStore(dataDir) {
  const root = path.join(dataDir, 'agent-artifacts'), staging = path.join(root, 'staging'), objects = path.join(root, 'objects');
  function location(key) { if (!/^[a-f0-9]{64}-[a-f0-9-]{36}\.(png|jpeg|webp|txt)$/.test(key)) throw agentError('INVALID_STORAGE_KEY', '无效的产物存储标识'); return path.join(objects, key); }
  return {
    async saveText(text, metadata = {}) {
      const bytes = Buffer.from(text);
      if (bytes.length > 2 * 1024 * 1024) throw agentError('ARTIFACT_LIMIT', '文字产物超过 2 MiB');
      const digest = hash(bytes), storageKey = `${digest}-${randomUUID()}.txt`;
      await mkdir(staging, { recursive: true }); await mkdir(objects, { recursive: true });
      const temp = path.join(staging, `${randomUUID()}.tmp`);
      try { await writeFile(temp, bytes, { flag: 'wx' }); await rename(temp, location(storageKey)); } finally { await rm(temp, { force: true }); }
      return { type: 'text', storageKey, hash: digest, byteSize: bytes.length, mimeType: 'text/plain', producer: 'application-workflow-task', metadata };
    },
    async saveImage(bytes, metadata = {}) {
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 25 * 1024 * 1024) throw agentError('INVALID_IMAGE', '图片须在 25 MiB 以内');
      const image = sharp(bytes, { limitInputPixels: 40000000, failOn: 'warning' }), info = await image.metadata();
      if (!['png', 'jpeg', 'webp'].includes(info.format) || (info.pages || 1) !== 1) throw agentError('INVALID_IMAGE', '仅支持单张 PNG、JPEG、WebP');
      await image.stats();
      const digest = hash(bytes), storageKey = `${digest}-${randomUUID()}.${info.format}`;
      await mkdir(staging, { recursive: true }); await mkdir(objects, { recursive: true });
      const temp = path.join(staging, `${randomUUID()}.tmp`);
      try { await writeFile(temp, bytes, { flag: 'wx' }); await rename(temp, location(storageKey)); }
      finally { await rm(temp, { force: true }); }
      return { type: 'image', storageKey, hash: digest, byteSize: bytes.length, mimeType: `image/${info.format}`, producer: 'application-image-task', metadata: { ...metadata, width: info.width, height: info.height } };
    },
    async read(artifact) {
      const bytes = await readFile(location(artifact.storageKey));
      if (bytes.length !== artifact.byteSize || hash(bytes) !== artifact.hash) throw agentError('ARTIFACT_CORRUPT', '产物文件缺失或损坏，请核查备份', 410);
      return bytes;
    },
    async modelImage(artifact) {
      return this.previewImage(await this.read(artifact));
    },
    async previewImage(input) {
      const bytes = await sharp(input, { limitInputPixels: 40000000 }).rotate().resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
      if (bytes.length > 2 * 1024 * 1024) throw agentError('IMAGE_LIMIT', '缩略图仍过大，请另选参考图');
      return { type: 'image', mimeType: 'image/jpeg', data: bytes.toString('base64') };
    },
    async attemptDirectory(attemptId) {
      if (!Number.isSafeInteger(attemptId) || attemptId < 1) throw agentError('INVALID_ATTEMPT', '无效尝试标识');
      const dir = path.join(dataDir, 'agent-task-workspaces', String(attemptId)); await mkdir(dir, { recursive: true }); return dir;
    },
    async stageResult(attemptId, bytes) {
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 25 * 1024 * 1024) throw agentError('INVALID_IMAGE', '图片须在 25 MiB 以内');
      const directory = await this.attemptDirectory(attemptId), temp = path.join(directory, `result-${randomUUID()}.tmp`);
      try { await writeFile(temp, bytes, { flag: 'wx' }); await rename(temp, path.join(directory, 'result.bin')); }
      finally { await rm(temp, { force: true }); }
      return { hash: hash(bytes), byteSize: bytes.length };
    },
    async stagedResult(attemptId, expected) {
      const bytes = await readFile(path.join(await this.attemptDirectory(attemptId), 'result.bin'));
      if (bytes.length > 25 * 1024 * 1024 || expected && (hash(bytes) !== expected.hash || bytes.length !== expected.byteSize)) throw agentError('ARTIFACT_CORRUPT', '取回暂存文件已变化', 410);
      return bytes;
    },
    async materialize(artifact, directory) { const file = path.join(directory, artifact.storageKey); await writeFile(file, await this.read(artifact), { flag: 'wx' }); return file; },
    async materializeBytes(bytes, directory) { const info = await sharp(bytes).metadata(); if (!['png', 'jpeg', 'webp'].includes(info.format)) throw agentError('INVALID_IMAGE', '无效参考图片'); const file = path.join(directory, `${randomUUID()}.${info.format}`); await writeFile(file, bytes, { flag: 'wx' }); return file; },
    async unreferenced(known) { const files = await readdir(objects).catch(error => { if (error.code === 'ENOENT') return []; throw error; }); return files.filter(file => !known.has(file)); },
  };
}
