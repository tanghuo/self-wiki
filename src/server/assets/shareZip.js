import { createReadStream } from "node:fs";
import { crc32 } from "node:zlib";

// ZIP STORE with data descriptors: bounded memory, UTF-8 names, no compression.
// ZIP64 is deliberately excluded; reject rather than produce a corrupt archive.
export async function* shareZip(entries, signal) {
  let offset = 0;
  const central = [];
  for (const entry of entries) {
    signal.throwIfAborted();
    // Backslashes are legal POSIX filename characters but separators on Windows.
    if (entry.name.includes('\\') || entry.name.startsWith('/') || entry.name.split('/').some((part) => part === '..' || part === '.' || part.includes(':'))) throw new Error('目录包含不安全的 ZIP 文件名，请重命名后再分享');
    const name = Buffer.from(entry.name);
    if (name.length > 65535 || central.length >= 65535) throw new Error("目录文件数量或文件名超出 ZIP 限制");
    const start = offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x808, 6); header.writeUInt16LE(0x21, 12);
    header.writeUInt16LE(name.length, 26);
    yield header; yield name; offset += header.length + name.length;
    let crc = 0, size = 0;
    if (!entry.directory) {
      for await (const chunk of createReadStream(entry.path, { signal })) {
        crc = crc32(chunk, crc); size += chunk.length; offset += chunk.length;
        if (size >= 0xffffffff || offset >= 0xffffffff) throw new Error("目录打包暂时仅支持小于 4 GiB 的 ZIP");
        yield chunk;
      }
    }
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size, 8); descriptor.writeUInt32LE(size, 12);
    yield descriptor; offset += descriptor.length;
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x808, 8); record.writeUInt16LE(0x21, 14);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(size, 20); record.writeUInt32LE(size, 24);
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE(start, 42);
    central.push(Buffer.concat([record, name]));
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  if (offset + centralSize + 22 >= 0xffffffff) throw new Error("目录打包暂时仅支持小于 4 GiB 的 ZIP");
  yield* central;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  yield end;
}
