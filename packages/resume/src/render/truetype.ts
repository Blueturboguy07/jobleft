// TrueType fonts for PDFs whose text has letters the standard fonts cannot show ("Łukasz", "Nguyễn", "Дмитрий").
// jobleft never replaces or drops a letter: when the text needs it, the PDF embeds a font from this computer
// (Arial, Liberation Sans or DejaVu Sans; or the files named in JOBLEFT_PDF_FONT and JOBLEFT_PDF_FONT_BOLD) as a
// CID font with a ToUnicode map, so the text stays real, selectable and extractable. Written for jobleft.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

export interface TtFont {
  name: string;
  unitsPerEm: number;
  ascent: number;
  descent: number;
  capHeight: number;
  bbox: [number, number, number, number];
  italicAngle: number;
  bytes: Buffer;
  glyph(cp: number): number;
  advance(gid: number): number;
}

function tables(b: Buffer): Map<string, { off: number; len: number }> {
  const n = b.readUInt16BE(4);
  const out = new Map<string, { off: number; len: number }>();
  for (let i = 0; i < n; i++) {
    const p = 12 + i * 16;
    out.set(b.toString('latin1', p, p + 4), { off: b.readUInt32BE(p + 8), len: b.readUInt32BE(p + 12) });
  }
  return out;
}

export function parseTrueType(bytes: Buffer): TtFont {
  const sig = bytes.readUInt32BE(0);
  if (sig !== 0x00010000 && sig !== 0x74727565) throw new Error('not a TrueType font');
  const t = tables(bytes);
  const need = (tag: string) => { const x = t.get(tag); if (!x) throw new Error(`font has no ${tag} table`); return x; };
  const head = need('head').off;
  const unitsPerEm = bytes.readUInt16BE(head + 18);
  const bbox: [number, number, number, number] = [bytes.readInt16BE(head + 36), bytes.readInt16BE(head + 38), bytes.readInt16BE(head + 40), bytes.readInt16BE(head + 42)];
  const hhea = need('hhea').off;
  const ascent = bytes.readInt16BE(hhea + 4);
  const descent = bytes.readInt16BE(hhea + 6);
  const numH = bytes.readUInt16BE(hhea + 34);
  const hmtx = need('hmtx').off;
  const advance = (gid: number) => bytes.readUInt16BE(hmtx + Math.min(gid, numH - 1) * 4);
  let capHeight = ascent;
  const os2 = t.get('OS/2');
  if (os2) {
    const fsType = bytes.readUInt16BE(os2.off + 8);
    if ((fsType & 0x000f) === 0x0002) throw new Error('the font does not allow embedding');
    if (bytes.readUInt16BE(os2.off) >= 2 && os2.len >= 90) capHeight = bytes.readInt16BE(os2.off + 88);
  }
  let italicAngle = 0;
  const post = t.get('post');
  if (post) italicAngle = bytes.readInt16BE(post.off + 4);
  let name = 'EmbeddedSans';
  const nm = t.get('name');
  if (nm) {
    const count = bytes.readUInt16BE(nm.off + 2);
    const strOff = nm.off + bytes.readUInt16BE(nm.off + 4);
    for (let i = 0; i < count; i++) {
      const r = nm.off + 6 + i * 12;
      if (bytes.readUInt16BE(r + 6) !== 6) continue; // PostScript name
      const len = bytes.readUInt16BE(r + 8);
      const off = strOff + bytes.readUInt16BE(r + 10);
      const plat = bytes.readUInt16BE(r);
      const raw = bytes.subarray(off, off + len);
      const s = plat === 3 || plat === 0 ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1');
      if (s) { name = s.replace(/[^A-Za-z0-9-]/g, ''); break; }
    }
  }
  // cmap: Windows Unicode full (format 12) or BMP (format 4).
  const cmap = need('cmap').off;
  const nsub = bytes.readUInt16BE(cmap + 2);
  let f12 = -1;
  let f4 = -1;
  for (let i = 0; i < nsub; i++) {
    const r = cmap + 4 + i * 8;
    const plat = bytes.readUInt16BE(r);
    const enc = bytes.readUInt16BE(r + 2);
    const off = cmap + bytes.readUInt32BE(r + 4);
    const fmt = bytes.readUInt16BE(off);
    if (fmt === 12 && (plat === 3 && enc === 10 || plat === 0)) f12 = off;
    if (fmt === 4 && (plat === 3 && enc === 1 || plat === 0)) f4 = off;
  }
  const cache = new Map<number, number>();
  const glyph = (cp: number): number => {
    const c = cache.get(cp);
    if (c !== undefined) return c;
    let g = 0;
    if (f12 >= 0) {
      const groups = bytes.readUInt32BE(f12 + 12);
      for (let i = 0; i < groups; i++) {
        const p = f12 + 16 + i * 12;
        const s = bytes.readUInt32BE(p);
        const e = bytes.readUInt32BE(p + 4);
        if (cp >= s && cp <= e) { g = bytes.readUInt32BE(p + 8) + (cp - s); break; }
      }
    } else if (f4 >= 0 && cp <= 0xffff) {
      const segX2 = bytes.readUInt16BE(f4 + 6);
      const ends = f4 + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let i = 0; i < segX2 / 2; i++) {
        const end = bytes.readUInt16BE(ends + i * 2);
        if (cp > end) continue;
        const start = bytes.readUInt16BE(starts + i * 2);
        if (cp < start) break;
        const delta = bytes.readInt16BE(deltas + i * 2);
        const ro = bytes.readUInt16BE(ranges + i * 2);
        if (ro === 0) g = (cp + delta) & 0xffff;
        else {
          const gp = ranges + i * 2 + ro + (cp - start) * 2;
          const raw = bytes.readUInt16BE(gp);
          g = raw === 0 ? 0 : (raw + delta) & 0xffff;
        }
        break;
      }
    }
    cache.set(cp, g);
    return g;
  };
  return { name, unitsPerEm, ascent, descent, capHeight, bbox, italicAngle, bytes, glyph, advance };
}

const CANDIDATES: Array<[string, string]> = [
  ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf'],
  ['/Library/Fonts/Arial.ttf', '/Library/Fonts/Arial Bold.ttf'],
  ['/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'],
  ['/usr/share/fonts/liberation-sans/LiberationSans-Regular.ttf', '/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf'],
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
];

let loaded: { regular: TtFont; bold: TtFont } | null | undefined;

/** The regular and bold fonts to embed, or null when this computer has none jobleft can use. */
export function systemFonts(): { regular: TtFont; bold: TtFont } | null {
  if (loaded !== undefined) return loaded;
  const env = process.env.JOBLEFT_PDF_FONT ? [[process.env.JOBLEFT_PDF_FONT, process.env.JOBLEFT_PDF_FONT_BOLD ?? process.env.JOBLEFT_PDF_FONT] as [string, string]] : [];
  const win = process.env.WINDIR ? [[join(process.env.WINDIR, 'Fonts', 'arial.ttf'), join(process.env.WINDIR, 'Fonts', 'arialbd.ttf')] as [string, string]] : [];
  for (const [r, b] of [...env, ...CANDIDATES, ...win]) {
    try {
      if (!existsSync(r)) continue;
      const regular = parseTrueType(readFileSync(r));
      const bold = existsSync(b) ? parseTrueType(readFileSync(b)) : regular;
      loaded = { regular, bold };
      return loaded;
    } catch { /* try the next one */ }
  }
  loaded = null;
  return null;
}

/** The PDF objects of one embedded font (Type0 / CIDFontType2 / FontFile2 / ToUnicode) for the glyphs used. */
export function truetypeObjects(font: TtFont, used: Map<number, number>, first: number): { ref: number; objs: Buffer[] } {
  const scale = 1000 / font.unitsPerEm;
  const gids = [...used.keys()].sort((a, b) => a - b);
  const w = gids.map((g) => `${g} [${Math.round(font.advance(g) * scale)}]`).join(' ');
  const cmapLines = gids.map((g) => {
    const cp = used.get(g)!;
    const hex = Buffer.from(String.fromCodePoint(cp), 'utf16le').swap16().toString('hex').toUpperCase();
    return `<${g.toString(16).padStart(4, '0').toUpperCase()}> <${hex}>`;
  });
  const chunks: string[] = [];
  for (let i = 0; i < cmapLines.length; i += 100) chunks.push(`${Math.min(100, cmapLines.length - i)} beginbfchar\n${cmapLines.slice(i, i + 100).join('\n')}\nendbfchar`);
  const toUnicode = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chunks.join('\n')}\nendcmap\nCMapName currentdict /CMapResource defineresource pop\nend\nend`;
  const tu = deflateSync(Buffer.from(toUnicode, 'latin1'));
  const ff = deflateSync(font.bytes, { level: 9 });
  const s = (n: number) => Math.round(n * scale);
  const [type0, cid, desc, file, tounicode] = [first, first + 1, first + 2, first + 3, first + 4];
  const objs = [
    Buffer.from(`<< /Type /Font /Subtype /Type0 /BaseFont /${font.name} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${tounicode} 0 R >>`, 'latin1'),
    Buffer.from(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${font.name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /CIDToGIDMap /Identity /DW 1000 /W [${w}] >>`, 'latin1'),
    Buffer.from(`<< /Type /FontDescriptor /FontName /${font.name} /Flags 32 /FontBBox [${font.bbox.map(s).join(' ')}] /ItalicAngle ${font.italicAngle} /Ascent ${s(font.ascent)} /Descent ${s(font.descent)} /CapHeight ${s(font.capHeight)} /StemV 80 /FontFile2 ${file} 0 R >>`, 'latin1'),
    Buffer.concat([Buffer.from(`<< /Length ${ff.length} /Length1 ${font.bytes.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), ff, Buffer.from('\nendstream', 'latin1')]),
    Buffer.concat([Buffer.from(`<< /Length ${tu.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), tu, Buffer.from('\nendstream', 'latin1')]),
  ];
  return { ref: type0, objs };
}
