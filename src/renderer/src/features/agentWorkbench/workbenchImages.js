import { clipboardImages } from '../../contentDrafts.js';

export const maxWorkbenchImages = 8;
const maxBytes = 25 * 1024 * 1024;
const allowed = file => file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'image/webp' || /\.(png|jpe?g|webp)$/i.test(file.name || '');

export function workbenchImageFiles(clipboard) {
  return clipboardImages(clipboard);
}

export function workbenchImageError(files, existing = 0) {
  if (!files.length) return '';
  if (files.some(file => !allowed(file))) return '仅支持 PNG、JPEG、WebP';
  if (files.some(file => file.size > maxBytes)) return '每张图片必须在 25 MiB 以内';
  if (existing + files.length > maxWorkbenchImages) return `参考图最多 ${maxWorkbenchImages} 张`;
  return '';
}
