// A small reader for dBase III attribute tables (.dbf), enough for the Natural Earth populated-places file.

export interface DbfField { name: string; type: string; length: number; offset: number }

export function readDbf(buf: Buffer, encoding: BufferEncoding = 'utf8'): { fields: DbfField[]; rows: Array<Record<string, string>> } {
  if (buf.length < 32) throw new Error('not a dBase file (too short)');
  const count = buf.readUInt32LE(4);
  const headerLen = buf.readUInt16LE(8);
  const recordLen = buf.readUInt16LE(10);
  const fields: DbfField[] = [];
  let offset = 1;
  for (let p = 32; p + 32 <= headerLen && buf[p] !== 0x0d; p += 32) {
    const raw = buf.subarray(p, p + 11);
    const end = raw.indexOf(0);
    const name = raw.subarray(0, end < 0 ? 11 : end).toString('latin1');
    const type = String.fromCharCode(buf[p + 11]!);
    const length = buf[p + 16]!;
    fields.push({ name, type, length, offset });
    offset += length;
  }
  if (headerLen + count * recordLen > buf.length) throw new Error('the dBase file is cut short');
  const rows: Array<Record<string, string>> = [];
  for (let i = 0; i < count; i++) {
    const start = headerLen + i * recordLen;
    if (buf[start] === 0x2a) continue; // deleted
    const row: Record<string, string> = {};
    for (const f of fields) row[f.name] = buf.toString(encoding, start + f.offset, start + f.offset + f.length).trim();
    rows.push(row);
  }
  return { fields, rows };
}
