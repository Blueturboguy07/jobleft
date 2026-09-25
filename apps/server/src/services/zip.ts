// A small ZIP writer and a strict ZIP reader (no dependency: node:zlib does deflate and CRC-32).
//
// Writer: entries are streamed (data descriptors), deflated or stored, UTF-8 names, fixed times. When `seal` is set,
// the end-of-archive comment is "jobleft-backup v1 sha256=<hex>", the SHA-256 of every byte before the comment,
// so any changed, missing or added byte anywhere in the file is detected (server O7).
//
// Reader: refuses anything unusual before a byte is extracted: a missing or wrong seal, encryption, methods other
// than store and deflate, ZIP64, duplicate names, names that are absolute, contain "..", backslashes or control
// characters, symlinks, entries whose local header disagrees with the central directory, sizes over the limits,
// and data that inflates past its declared size (zip bombs).

import { createHash, type Hash } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import { createDeflateRaw, createInflateRaw, crc32, deflateRawSync } from 'node:zlib';

export const SEAL_PREFIX = 'jobleft-backup v1 sha256=';
const SEAL_LENGTH = SEAL_PREFIX.length + 64;
const MAX_ENTRIES = 50_000;

function dosTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

interface Central { name: Buffer; method: number; crc: number; csize: number; usize: number; offset: number }

export class ZipWriter {
  private readonly fd: number;
  private readonly hash: Hash = createHash('sha256');
  private pos = 0;
  private readonly entries: Central[] = [];
  private readonly when: { time: number; date: number };

  constructor(path: string, when: Date = new Date()) {
    this.fd = openSync(path, 'wx', 0o600);
    this.when = dosTime(when);
  }

  private write(b: Buffer): void {
    let off = 0;
    while (off < b.length) off += writeSync(this.fd, b, off, b.length - off);
    this.hash.update(b);
    this.pos += b.length;
  }

  private header(name: Buffer, method: number): number {
    const at = this.pos;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0808, 6); // bit 3: sizes follow the data; bit 11: UTF-8 names
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(this.when.time, 10);
    h.writeUInt16LE(this.when.date, 12);
    h.writeUInt16LE(name.length, 26);
    this.write(h);
    this.write(name);
    return at;
  }

  private trailer(name: Buffer, method: number, crc: number, csize: number, usize: number, offset: number): void {
    if (csize > 0xfffffffe || usize > 0xfffffffe || offset > 0xfffffffe) throw new Error('an entry is too large for this backup format');
    const d = Buffer.alloc(16);
    d.writeUInt32LE(0x08074b50, 0);
    d.writeUInt32LE(crc >>> 0, 4);
    d.writeUInt32LE(csize, 8);
    d.writeUInt32LE(usize, 12);
    this.write(d);
    this.entries.push({ name, method, crc: crc >>> 0, csize, usize, offset });
  }

  addBuffer(nameText: string, data: Buffer, compress = true): { sha256: string; bytes: number } {
    const name = Buffer.from(nameText, 'utf8');
    const method = compress ? 8 : 0;
    const offset = this.header(name, method);
    const body = compress ? deflateSync(data) : data;
    this.write(body);
    this.trailer(name, method, crc32(data), body.length, data.length, offset);
    return { sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length };
  }

  async addFile(nameText: string, path: string, compress = true): Promise<{ sha256: string; bytes: number }> {
    const name = Buffer.from(nameText, 'utf8');
    const method = compress ? 8 : 0;
    const offset = this.header(name, method);
    const sha = createHash('sha256');
    let crc = 0, usize = 0, csize = 0;
    const input = createReadStream(path, { highWaterMark: 1 << 20 });
    if (!compress) {
      for await (const chunk of input) {
        const b = chunk as Buffer;
        crc = crc32(b, crc); usize += b.length; sha.update(b);
        this.write(b); csize += b.length;
      }
    } else {
      const def = createDeflateRaw({ level: 6 });
      const done = (async () => {
        for await (const out of def) { this.write(out as Buffer); csize += (out as Buffer).length; }
      })();
      for await (const chunk of input) {
        const b = chunk as Buffer;
        crc = crc32(b, crc); usize += b.length; sha.update(b);
        if (!def.write(b)) await new Promise<void>((r) => def.once('drain', () => r()));
      }
      def.end();
      await done;
    }
    this.trailer(name, method, crc, csize, usize, offset);
    return { sha256: sha.digest('hex'), bytes: usize };
  }

  /** Writes the central directory and the end record, then closes the file. */
  finish(seal: boolean): void {
    try {
      const cdStart = this.pos;
      for (const e of this.entries) {
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0);
        c.writeUInt16LE(0x031e, 4); // made by: Unix, 3.0
        c.writeUInt16LE(20, 6);
        c.writeUInt16LE(0x0808, 8);
        c.writeUInt16LE(e.method, 10);
        c.writeUInt16LE(this.when.time, 12);
        c.writeUInt16LE(this.when.date, 14);
        c.writeUInt32LE(e.crc, 16);
        c.writeUInt32LE(e.csize, 20);
        c.writeUInt32LE(e.usize, 24);
        c.writeUInt16LE(e.name.length, 28);
        c.writeUInt32LE((0o100600 << 16) >>> 0, 38); // a regular file, mode 0600
        c.writeUInt32LE(e.offset, 42);
        this.write(c);
        this.write(e.name);
      }
      const cdSize = this.pos - cdStart;
      if (this.entries.length > 0xfffe) throw new Error('too many entries for this backup format');
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(this.entries.length, 8);
      end.writeUInt16LE(this.entries.length, 10);
      end.writeUInt32LE(cdSize, 12);
      end.writeUInt32LE(cdStart, 16);
      end.writeUInt16LE(seal ? SEAL_LENGTH : 0, 20);
      this.write(end);
      if (seal) {
        const comment = Buffer.from(SEAL_PREFIX + this.hash.copy().digest('hex'), 'ascii');
        writeSync(this.fd, comment);
      }
    } finally {
      closeSync(this.fd);
    }
  }

  abort(): void { try { closeSync(this.fd); } catch { /* closed */ } }
}

function deflateSync(b: Buffer): Buffer {
  // Small buffers only (manifests, JSON exports).
  return deflateRawSync(b, { level: 6 });
}

// ---------------------------------------------------------------- reader

export class ZipRejected extends Error {
  constructor(message: string) { super(message); this.name = 'ZipRejected'; }
}

export interface ZipEntry { name: string; method: number; crc: number; csize: number; usize: number; dataStart: number }

/** A safe relative name: segments of letters, digits, dot, dash, underscore, space, @, +; no "..", no leading "/". */
export function safeEntryName(name: string): boolean {
  if (!name || name.length > 400 || name.startsWith('/') || name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name)) return false;
  const segs = name.split('/');
  return segs.every((s) => s.length > 0 && s !== '.' && s !== '..' && /^[\p{L}\p{N} ._@+()-]+$/u.test(s));
}

export class ZipReader {
  private readonly fd: number;
  readonly size: number;
  readonly entries: ZipEntry[] = [];

  /** Opens and checks the whole archive. `sealed` requires (and verifies) the jobleft seal. */
  static async open(path: string, opts: { sealed: boolean; maxUncompressed: number }): Promise<ZipReader> {
    const z = new ZipReader(path);
    try {
      await z.check(opts);
      return z;
    } catch (e) {
      z.close();
      throw e;
    }
  }

  private constructor(path: string) {
    this.fd = openSync(path, 'r');
    this.size = fstatSync(this.fd).size;
  }

  close(): void { try { closeSync(this.fd); } catch { /* closed */ } }

  private read(pos: number, len: number): Buffer {
    const b = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(this.fd, b, got, len - got, pos + got);
      if (n === 0) throw new ZipRejected('The file is cut short.');
      got += n;
    }
    return b;
  }

  private async check(opts: { sealed: boolean; maxUncompressed: number }): Promise<void> {
    if (this.size < 22) throw new ZipRejected('The file is too short to be a jobleft backup.');
    const tailLen = Math.min(this.size, 22 + 0xffff);
    const tail = this.read(this.size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break; }
    }
    if (eocd < 0) throw new ZipRejected('The file is not a complete ZIP archive (it may be cut short).');
    const commentLen = tail.readUInt16LE(eocd + 20);
    const comment = tail.subarray(eocd + 22, eocd + 22 + commentLen).toString('latin1');
    const eocdPos = this.size - tailLen + eocd;
    if (opts.sealed) {
      if (commentLen !== SEAL_LENGTH || !comment.startsWith(SEAL_PREFIX)) throw new ZipRejected('The file is not a jobleft backup.');
      const want = comment.slice(SEAL_PREFIX.length);
      const h = createHash('sha256');
      await new Promise<void>((resolve, reject) => {
        const s = createReadStream('', { fd: this.fd, start: 0, end: this.size - commentLen - 1, autoClose: false });
        s.on('data', (c) => h.update(c as Buffer));
        s.on('end', () => resolve());
        s.on('error', reject);
      });
      if (h.digest('hex') !== want) throw new ZipRejected('The backup file is damaged: its checksum does not match. Nothing was changed.');
    }
    const disk = tail.readUInt16LE(eocd + 4), cdDisk = tail.readUInt16LE(eocd + 6);
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12), cdStart = tail.readUInt32LE(eocd + 16);
    if (disk !== 0 || cdDisk !== 0 || count !== tail.readUInt16LE(eocd + 8)) throw new ZipRejected('Split ZIP archives are not supported.');
    if (count === 0xffff || cdStart === 0xffffffff || cdSize === 0xffffffff) throw new ZipRejected('ZIP64 archives are not supported.');
    if (count > MAX_ENTRIES) throw new ZipRejected('The archive has too many files.');
    if (cdStart + cdSize !== eocdPos) throw new ZipRejected('The archive layout is damaged.');
    const cd = this.read(cdStart, cdSize);
    const names = new Set<string>();
    let p = 0;
    let total = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new ZipRejected('The archive directory is damaged.');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commLen = cd.readUInt16LE(p + 32);
      const madeBy = cd.readUInt16LE(p + 4) >> 8;
      const ext = cd.readUInt32LE(p + 38);
      const offset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      p += 46 + nameLen + extraLen + commLen;
      if (flags & 0x0001) throw new ZipRejected('Encrypted archives are not supported.');
      if (method !== 0 && method !== 8) throw new ZipRejected('The archive uses a compression method jobleft does not read.');
      if (name.endsWith('/')) continue; // a folder entry: nothing to extract
      if (!safeEntryName(name)) throw new ZipRejected('The archive holds a file name that is not allowed (for example one with "..").');
      if (madeBy === 3 && ((ext >>> 16) & 0o170000) === 0o120000) throw new ZipRejected('The archive holds a link, which is not allowed.');
      if (names.has(name)) throw new ZipRejected('The archive holds the same file twice.');
      names.add(name);
      total += usize;
      if (total > opts.maxUncompressed) throw new ZipRejected('The archive unpacks to more data than this computer has room for.');
      if (offset + 30 > cdStart) throw new ZipRejected('The archive layout is damaged.');
      const lh = this.read(offset, 30);
      if (lh.readUInt32LE(0) !== 0x04034b50 || lh.readUInt16LE(8) !== method) throw new ZipRejected('The archive layout is damaged.');
      const lNameLen = lh.readUInt16LE(26), lExtra = lh.readUInt16LE(28);
      if (this.read(offset + 30, lNameLen).toString('utf8') !== name) throw new ZipRejected('The archive layout is damaged.');
      const dataStart = offset + 30 + lNameLen + lExtra;
      if (dataStart + csize > cdStart) throw new ZipRejected('The archive layout is damaged.');
      this.entries.push({ name, method, crc, csize, usize, dataStart });
    }
  }

  /** Extracts one entry to a new file, checking its size, CRC-32 and (when given) SHA-256. */
  async extract(e: ZipEntry, dest: string, sha256?: string): Promise<void> {
    const out = createWriteStream(dest, { flags: 'wx', mode: 0o600 });
    const h = createHash('sha256');
    let crc = 0, n = 0;
    const raw = e.csize === 0 ? null : createReadStream('', { fd: this.fd, start: e.dataStart, end: e.dataStart + e.csize - 1, autoClose: false });
    try {
      if (raw) {
        const src: AsyncIterable<Buffer> = e.method === 8 ? raw.pipe(createInflateRaw()) : raw;
        for await (const chunk of src) {
          const b = chunk as Buffer;
          n += b.length;
          if (n > e.usize) throw new ZipRejected('A file in the archive is larger than it claims.');
          crc = crc32(b, crc);
          h.update(b);
          if (!out.write(b)) await new Promise<void>((r) => out.once('drain', () => r()));
        }
      }
      await new Promise<void>((resolve, reject) => { out.end(() => resolve()); out.on('error', reject); });
    } catch (err) {
      out.destroy();
      if (err instanceof ZipRejected) throw err;
      throw new ZipRejected('A file in the archive is damaged.');
    }
    if (n !== e.usize || (crc >>> 0) !== e.crc) throw new ZipRejected('A file in the archive is damaged.');
    if (sha256 && h.digest('hex') !== sha256) throw new ZipRejected('A file in the archive does not match its checksum.');
  }

  /** Reads a small entry into memory (the manifest). */
  async readSmall(e: ZipEntry, max = 16 * 1024 * 1024): Promise<Buffer> {
    if (e.usize > max) throw new ZipRejected('The backup manifest is too large.');
    const parts: Buffer[] = [];
    let crc = 0;
    if (e.csize > 0) {
      const raw = createReadStream('', { fd: this.fd, start: e.dataStart, end: e.dataStart + e.csize - 1, autoClose: false });
      const src: AsyncIterable<Buffer> = e.method === 8 ? raw.pipe(createInflateRaw()) : raw;
      let n = 0;
      try {
        for await (const c of src) { n += (c as Buffer).length; if (n > e.usize) throw new ZipRejected('The backup manifest is damaged.'); parts.push(c as Buffer); crc = crc32(c as Buffer, crc); }
      } catch (err) { if (err instanceof ZipRejected) throw err; throw new ZipRejected('The backup manifest is damaged.'); }
    }
    const b = Buffer.concat(parts);
    if (b.length !== e.usize || (crc >>> 0) !== e.crc) throw new ZipRejected('The backup manifest is damaged.');
    return b;
  }
}
