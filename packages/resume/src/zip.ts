// A small ZIP reader and writer for Word files. The reader is defensive (resume O2): it refuses archives with too
// many entries, entries that expand past a size cap, and anything it cannot read, with a plain reason.

import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export interface ZipEntryIn { name: string; data: Uint8Array }

/** Writes a ZIP with fixed timestamps, so the same entries always give the same bytes. */
export function writeZip(entries: ZipEntryIn[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.from(e.data);
    const comp = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

export class ZipError extends Error {
  readonly reason: 'corrupt' | 'too_large' | 'encrypted';
  constructor(reason: ZipError['reason'], message: string) {
    super(message);
    this.name = 'ZipError';
    this.reason = reason;
  }
}

export interface ZipLimits { maxEntries: number; maxEntryBytes: number; maxTotalBytes: number }
export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 4000, maxEntryBytes: 40 * 1024 * 1024, maxTotalBytes: 120 * 1024 * 1024 };

export interface ZipReader {
  names: string[];
  has(name: string): boolean;
  read(name: string): Uint8Array;
  text(name: string): string;
}

export function readZip(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipReader {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('corrupt', 'The file is not a complete Word document (its archive directory is missing).');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('corrupt', 'The Word file uses a ZIP format jobleft does not read (ZIP64).');
  if (count > limits.maxEntries) throw new ZipError('too_large', `The Word file holds ${count} parts; jobleft reads at most ${limits.maxEntries}.`);
  if (cdOffset + cdSize > buf.length) throw new ZipError('corrupt', 'The Word file is cut short or damaged.');
  const entries = new Map<string, { method: number; comp: number; size: number; local: number; flags: number }>();
  let p = cdOffset;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('corrupt', 'The Word file is damaged (bad archive directory).');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const comp = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (flags & 1) throw new ZipError('encrypted', 'The Word file is password-protected.');
    if (size > limits.maxEntryBytes) throw new ZipError('too_large', `A part of the Word file expands to ${Math.round(size / 1048576)} MB; jobleft reads at most ${Math.round(limits.maxEntryBytes / 1048576)} MB.`);
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipError('too_large', 'The Word file expands to more than jobleft reads.');
    entries.set(name, { method, comp, size, local, flags });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const read = (name: string): Uint8Array => {
    const e = entries.get(name);
    if (!e) throw new ZipError('corrupt', `The Word file has no part named ${name}.`);
    if (e.local + 30 > buf.length || buf.readUInt32LE(e.local) !== 0x04034b50) throw new ZipError('corrupt', 'The Word file is damaged (bad part header).');
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const data = buf.subarray(start, start + e.comp);
    if (data.length < e.comp) throw new ZipError('corrupt', 'The Word file is cut short.');
    if (e.method === 0) return new Uint8Array(data);
    if (e.method !== 8) throw new ZipError('corrupt', 'The Word file uses a compression jobleft does not read.');
    try {
      return new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(1, Math.min(limits.maxEntryBytes, e.size + 1024)) }));
    } catch {
      throw new ZipError('corrupt', 'A part of the Word file could not be unpacked (damaged, or larger than it claims).');
    }
  };
  return {
    names: [...entries.keys()],
    has: (n) => entries.has(n),
    read,
    text: (n) => Buffer.from(read(n)).toString('utf8'),
  };
}
