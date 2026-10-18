import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

// Rebuild browser and Windows sizes from the original logo without changing it.
const directory = path.resolve(import.meta.dirname, "../src/renderer/public/brand");
const source = await readFile(path.join(directory, "self-wiki.png"));
const sizes = [16, 24, 32, 48, 64, 128, 180, 256];
const images = new Map();
for (const size of sizes) {
  const png = await sharp(source).resize(size, size).png().toBuffer();
  images.set(size, png);
  if ([32, 64, 180].includes(size)) await writeFile(path.join(directory, `self-wiki-${size}.png`), png);
}

// Windows Vista and newer support PNG images in ICO directory entries.
const iconSizes = sizes.filter((size) => size !== 180);
const header = Buffer.alloc(6 + 16 * iconSizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(iconSizes.length, 4);
let offset = header.length;
for (const [index, size] of iconSizes.entries()) {
  const entry = 6 + index * 16;
  const png = images.get(size);
  header[entry] = size === 256 ? 0 : size;
  header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
}
await writeFile(path.join(directory, "self-wiki.ico"), Buffer.concat([header, ...iconSizes.map((size) => images.get(size))]));
console.log("Generated browser icons and Windows ICO from self-wiki.png.");
