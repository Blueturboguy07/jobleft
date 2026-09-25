// A small streaming reader for the first worksheet of an .xlsx file (Office Open XML), written for the
// US Department of Labor LCA disclosure files (about 250 MB zipped, 1.6 GB of sheet XML, 440K rows x 98 columns).
// No dependency: the zip central directory is read with fs, entries are inflated with node:zlib, and the XML is
// scanned with small regular expressions. It reads cells, shared strings and inline strings; it ignores formulas,
// styles and every other sheet. Entry sizes and CRC-32 values are checked, so a cut-short or damaged file fails.

import { closeSync, createReadStream, fstatSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { crc32, createInflateRaw } from 'node:zlib';
import type { Readable } from 'node:stream';

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  crc: number;
  localHeaderOffset: number;
}

/** Reads the central directory of a zip file (zip64 aware). */
export function readZipDirectory(path: string): ZipEntry[] {
  const fd = openSync(path, 'r');
  try {
    const fileSize = fstatSync(fd).size;
    const tailLen = Math.min(fileSize, 65_535 + 22 + 20);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, fileSize - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error(`${path}: not a zip file (no end-of-central-directory record)`);
    let entries = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    const loc = eocd - 20;
    if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
      const z64Offset = Number(tail.readBigUInt64LE(loc + 8));
      const rec = Buffer.alloc(56);
      readSync(fd, rec, 0, 56, z64Offset);
      if (rec.readUInt32LE(0) !== 0x06064b50) throw new Error(`${path}: bad zip64 record`);
      entries = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }
    if (cdOffset + cdSize > fileSize) throw new Error(`${path}: the zip directory points past the end of the file (cut short?)`);
    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOffset);
    const out: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < entries; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error(`${path}: bad zip directory entry ${i}`);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compressedSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localHeaderOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff) { size = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (localHeaderOffset === 0xffffffff) { localHeaderOffset = Number(cd.readBigUInt64LE(q)); q += 8; }
        }
        e += 4 + len;
      }
      out.push({ name, method, compressedSize, size, crc, localHeaderOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

function dataOffset(path: string, entry: ZipEntry): number {
  const fd = openSync(path, 'r');
  try {
    const h = Buffer.alloc(30);
    readSync(fd, h, 0, 30, entry.localHeaderOffset);
    if (h.readUInt32LE(0) !== 0x04034b50) throw new Error(`${path}: bad local header for ${entry.name}`);
    return entry.localHeaderOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  } finally {
    closeSync(fd);
  }
}

/**
 * Streams the uncompressed bytes of one entry. The stream fails when the inflated size or the CRC-32 differs from
 * the directory (a damaged file), instead of ending quietly with part of the data.
 */
export async function* entryChunks(path: string, entry: ZipEntry): AsyncGenerator<Buffer> {
  const start = dataOffset(path, entry);
  if (entry.compressedSize === 0) {
    if (entry.size !== 0) throw new Error(`${path}: ${entry.name} is empty but should hold ${entry.size} bytes`);
    return;
  }
  const raw: Readable = createReadStream(path, { start, end: start + entry.compressedSize - 1, highWaterMark: 1 << 20 });
  let source: Readable = raw;
  if (entry.method === 8) {
    const inflate = createInflateRaw({ chunkSize: 1 << 20 });
    raw.on('error', (err) => inflate.destroy(err));
    source = raw.pipe(inflate);
  } else if (entry.method !== 0) {
    raw.destroy();
    throw new Error(`${path}: ${entry.name} uses zip method ${entry.method}, which this reader does not support`);
  }
  let total = 0;
  let crc = 0;
  for await (const chunk of source as AsyncIterable<Buffer>) {
    total += chunk.length;
    crc = crc32(chunk, crc);
    yield chunk;
  }
  if (total !== entry.size) throw new Error(`${path}: ${entry.name} inflated to ${total} bytes, the directory says ${entry.size} (damaged file)`);
  if ((crc >>> 0) !== (entry.crc >>> 0)) throw new Error(`${path}: ${entry.name} fails its CRC-32 check (damaged file)`);
}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decodes XML entities and Excel's _xHHHH_ escapes. */
export function decodeXml(s: string): string {
  let out = s;
  if (out.includes('&')) {
    out = out.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : '';
      }
      return ENTITY[e] ?? '';
    });
  }
  if (out.includes('_x')) out = out.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  return out;
}

const T_RE = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;

function textOf(inner: string): string {
  const noPhonetic = inner.includes('<rPh') ? inner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '') : inner;
  let out = '';
  T_RE.lastIndex = 0;
  for (let m = T_RE.exec(noPhonetic); m; m = T_RE.exec(noPhonetic)) out += m[1];
  return decodeXml(out);
}

/** Streams complete XML elements named `tag` from an entry, in order. */
async function* elements(path: string, entry: ZipEntry, tag: string): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  const close = `</${tag}>`;
  let buf = '';
  const re = new RegExp(`<${tag}\\b[^>]*?(?:/>|>[\\s\\S]*?</${tag}>)`, 'g');
  for await (const chunk of entryChunks(path, entry)) {
    buf += decoder.write(chunk);
    const last = buf.lastIndexOf(close);
    if (last < 0) continue;
    const upto = last + close.length;
    const part = buf.slice(0, upto);
    buf = buf.slice(upto);
    re.lastIndex = 0;
    for (let m = re.exec(part); m; m = re.exec(part)) yield m[0];
  }
  buf += decoder.end();
  re.lastIndex = 0;
  for (let m = re.exec(buf); m; m = re.exec(buf)) yield m[0];
}

/** Loads the shared-string table. */
export async function readSharedStrings(path: string, entries: ZipEntry[]): Promise<string[]> {
  const entry = entries.find((e) => e.name === 'xl/sharedStrings.xml');
  if (!entry) return [];
  const out: string[] = [];
  for await (const si of elements(path, entry, 'si')) {
    out.push(si.endsWith('/>') && !si.includes('</si>') ? '' : textOf(si));
  }
  return out;
}

/** "A" -> 0, "Z" -> 25, "AA" -> 26. */
export function columnIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

const CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
const REF_RE = /\br="([A-Z]+)(\d+)"/;
const TYPE_RE = /\bt="([a-zA-Z]+)"/;
const ROWNUM_RE = /^<row\b[^>]*?\br="(\d+)"/;

export interface SheetRow {
  /** 1-based row number from the sheet. */
  row: number;
  /** Cell text by 0-based column index; missing cells are undefined. Numbers stay as their text. */
  cells: Array<string | undefined>;
}

/** Finds the first worksheet's entry through workbook.xml and its relationships. */
function firstSheetEntry(entries: ZipEntry[]): ZipEntry {
  const byName = new Map(entries.map((e) => [e.name, e]));
  const direct = byName.get('xl/worksheets/sheet1.xml');
  if (direct) return direct;
  const sheet = entries.find((e) => /^xl\/worksheets\/[^/]+\.xml$/.test(e.name));
  if (!sheet) throw new Error('no worksheet in the file');
  return sheet;
}

/**
 * Yields every row of the first worksheet. `wanted` limits decoding to those 0-based column indexes (all when
 * omitted); other cells are skipped without decoding.
 */
export async function* readSheetRows(path: string, opts: { wanted?: ReadonlySet<number> } = {}): AsyncGenerator<SheetRow> {
  const entries = readZipDirectory(path);
  const sst = await readSharedStrings(path, entries);
  const sheet = firstSheetEntry(entries);
  const wanted = opts.wanted;
  let rowNo = 0;
  for await (const rowXml of elements(path, sheet, 'row')) {
    const rm = ROWNUM_RE.exec(rowXml);
    rowNo = rm ? Number(rm[1]) : rowNo + 1;
    const cells: Array<string | undefined> = [];
    const bodyStart = rowXml.indexOf('>') + 1;
    if (!rowXml.endsWith('/>') || rowXml.includes('</row>')) {
      const body = rowXml.slice(bodyStart, rowXml.length - '</row>'.length);
      CELL_RE.lastIndex = 0;
      let nextCol = 0;
      for (let m = CELL_RE.exec(body); m; m = CELL_RE.exec(body)) {
        const attrs = m[1]!;
        const ref = REF_RE.exec(attrs);
        const col = ref ? columnIndex(ref[1]!) : nextCol;
        nextCol = col + 1;
        if (wanted && !wanted.has(col)) continue;
        const inner = m[2];
        if (inner === undefined) continue;
        const type = TYPE_RE.exec(attrs)?.[1] ?? 'n';
        let value: string | undefined;
        if (type === 'inlineStr') {
          value = textOf(inner);
        } else {
          const v0 = inner.indexOf('<v>');
          if (v0 < 0) {
            const v1 = inner.indexOf('<v ');
            if (v1 < 0) continue;
            const s = inner.indexOf('>', v1) + 1;
            value = decodeXml(inner.slice(s, inner.indexOf('</v>', s)));
          } else {
            value = decodeXml(inner.slice(v0 + 3, inner.indexOf('</v>', v0)));
          }
          if (type === 's') {
            const idx = Number(value);
            value = sst[idx];
            if (value === undefined) throw new Error(`${path}: row ${rowNo} points at shared string ${idx}, which does not exist`);
          }
        }
        cells[col] = value;
      }
    }
    yield { row: rowNo, cells };
  }
}

/** Excel serial day number (1900 date system) to "YYYY-MM-DD". Also accepts text dates. Null when not a date. */
export function excelDate(v: string | undefined): string | null {
  if (v === undefined) return null;
  const s = v.trim();
  if (s === '') return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = Math.floor(Number(s));
    if (serial < 1 || serial > 2_958_465) return null;
    const ms = (serial - 25_569) * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) return `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`;
  return null;
}
