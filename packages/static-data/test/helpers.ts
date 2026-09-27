// Test helpers: a tiny zip writer (to make synthetic .xlsx files) and temporary folders under the temp folder (/private/tmp on macOS, the system temp folder elsewhere).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
// Scratch folders: /private/tmp on macOS (short paths, no symlink games), the system temp folder elsewhere (Windows).
const TMP = process.platform === 'darwin' ? '/private/tmp' : tmpdir();

export function tempDir(prefix = 'jl-sd-'): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(TMP, prefix));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Writes a zip file with deflated entries. */
export function writeZip(path: string, files: Record<string, string | Buffer>): void {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const comp = deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0, 8); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...locals, cd, end]));
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function col(i: number): string { let s = ''; i += 1; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; }

/** A minimal .xlsx with one sheet. Strings go to the shared-string table; numbers stay numbers; dates are serial days. */
export function writeXlsx(path: string, header: string[], rows: Array<Array<string | number | null>>): void {
  const sst: string[] = [];
  const idx = new Map<string, number>();
  const s = (v: string) => { if (!idx.has(v)) { idx.set(v, sst.length); sst.push(v); } return idx.get(v)!; };
  const cell = (r: number, c: number, v: string | number | null) => {
    if (v === null) return '';
    const ref = `${col(c)}${r}`;
    return typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="s"><v>${s(v)}</v></c>`;
  };
  const allRows = [header, ...rows];
  const body = allRows.map((row, ri) => `<row r="${ri + 1}">${row.map((v, ci) => cell(ri + 1, ci, v)).join('')}</row>`).join('');
  // An empty styled row at the end, like the DOL files have.
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>${body}<row r="${allRows.length + 1}"><c r="A${allRows.length + 1}" s="1"/></row></sheetData></worksheet>`;
  const sstXml = `<?xml version="1.0" encoding="UTF-8"?><sst count="${sst.length}" uniqueCount="${sst.length}">${sst.map((v) => `<si><t>${esc(v)}</t></si>`).join('')}</sst>`;
  writeZip(path, { '[Content_Types].xml': '<Types/>', 'xl/worksheets/sheet1.xml': sheet, 'xl/sharedStrings.xml': sstXml });
}

/** Excel serial day for an ISO date. */
export function serial(iso: string): number {
  return Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000) + 25_569;
}
