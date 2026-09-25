// Reads a PDF with PDF.js (bundled in unpdf, MIT/Apache-2.0): text items with their position, size and font,
// images, and text drawn invisible or white. Used by the importer and by the readability (ATS) check.
// Nothing is fetched: the file comes in as bytes and no font, CMap or wasm URL is given, so PDF.js stays offline.

import { getDocumentProxy, getResolvedPDFJS } from 'unpdf';

export interface PdfItem {
  text: string;
  x: number;
  y: number;
  width: number;
  size: number;
  font: string;
  bold: boolean;
  italic: boolean;
  /** Drawn with render mode 3 (invisible) or in white fill. */
  hidden: 'invisible' | 'white' | null;
}

export interface PdfPageInfo {
  index: number;
  width: number;
  height: number;
  items: PdfItem[];
  images: number;
  /** Text-showing operations drawn invisible or in white. */
  hiddenOps: { invisible: number; white: number };
  fonts: Array<{ name: string; type: string | null }>;
}

export interface PdfRead {
  pages: PdfPageInfo[];
  encrypted: boolean;
  title: string | null;
}

export class PdfReadError extends Error {
  readonly reason: 'password' | 'corrupt';
  constructor(reason: PdfReadError['reason'], message: string) {
    super(message);
    this.name = 'PdfReadError';
    this.reason = reason;
  }
}

interface FontLike { name?: string; loadedName?: string; bold?: boolean; italic?: boolean; black?: boolean; type?: string; subtype?: string; fallbackName?: string }

export async function readPdf(bytes: Uint8Array, opts: { maxPages?: number } = {}): Promise<PdfRead> {
  const pdfjs = await getResolvedPDFJS();
  const OPS = (pdfjs as unknown as { OPS: Record<string, number> }).OPS;
  let doc;
  try {
    doc = await getDocumentProxy(new Uint8Array(bytes), {
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: false,
      verbosity: 0,
      disableAutoFetch: true,
      disableStream: true,
      isOffscreenCanvasSupported: false,
    } as never);
  } catch (e) {
    const name = (e as { name?: string }).name ?? '';
    if (name === 'PasswordException') throw new PdfReadError('password', 'The PDF is protected with a password.');
    throw new PdfReadError('corrupt', 'The file could not be read as a PDF (it is damaged or not a PDF).');
  }
  try {
    let encrypted = false;
    let title: string | null = null;
    try {
      const meta = await doc.getMetadata();
      const info = (meta?.info ?? {}) as { IsEncrypted?: boolean; Title?: string };
      encrypted = !!info.IsEncrypted;
      title = typeof info.Title === 'string' && info.Title.trim() ? info.Title : null;
    } catch { /* metadata is optional */ }
    const pages: PdfPageInfo[] = [];
    const n = Math.min(doc.numPages, opts.maxPages ?? 50);
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const ops = await page.getOperatorList();
      // Walk the operators: text render mode and fill colour at each text-showing operation, and images.
      let mode = 0;
      let white = false;
      const stack: Array<{ mode: number; white: boolean }> = [];
      const hiddenPerShow: Array<'invisible' | 'white' | null> = [];
      let images = 0;
      const hiddenOps = { invisible: 0, white: 0 };
      for (let k = 0; k < ops.fnArray.length; k++) {
        const fn = ops.fnArray[k];
        const args = ops.argsArray[k] as unknown[] | null;
        if (fn === OPS.save) stack.push({ mode, white });
        else if (fn === OPS.restore) { const s = stack.pop(); if (s) { mode = s.mode; white = s.white; } }
        else if (fn === OPS.setTextRenderingMode) mode = Number(args?.[0] ?? 0);
        else if (fn === OPS.setFillRGBColor || fn === OPS.setFillColor || fn === OPS.setFillGray || fn === OPS.setFillColorN || fn === OPS.setFillCMYKColor) {
          white = isWhite(args);
        } else if (fn === OPS.showText || fn === OPS.showSpacedText || fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) {
          const h = mode === 3 || mode === 7 ? 'invisible' : white ? 'white' : null;
          hiddenPerShow.push(h);
          if (h === 'invisible') hiddenOps.invisible++;
          if (h === 'white') hiddenOps.white++;
        } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject || fn === OPS.paintImageXObjectRepeat || fn === OPS.paintInlineImageXObjectGroup) {
          images++;
        }
      }
      const content = await page.getTextContent({ includeMarkedContent: false } as never);
      const fontInfo = new Map<string, FontLike>();
      const fonts: Array<{ name: string; type: string | null }> = [];
      for (const it of content.items as Array<{ fontName?: string }>) {
        const id = it.fontName;
        if (!id || fontInfo.has(id)) continue;
        let f: FontLike = {};
        try { if (page.commonObjs.has(id)) f = page.commonObjs.get(id) as FontLike; } catch { /* not loaded */ }
        fontInfo.set(id, f);
        fonts.push({ name: f.name ?? f.fallbackName ?? id, type: f.type ?? f.subtype ?? null });
      }
      const items: PdfItem[] = [];
      let showIdx = 0;
      for (const raw of content.items as Array<{ str: string; transform: number[]; width: number; height: number; fontName: string; hasEOL: boolean }>) {
        if (typeof raw.str !== 'string') continue;
        const hidden = hiddenPerShow[Math.min(showIdx, hiddenPerShow.length - 1)] ?? null;
        showIdx++;
        if (!raw.str.length) continue;
        const [a, b, c, d, e, f] = raw.transform as [number, number, number, number, number, number];
        const size = Math.hypot(c, d) || Math.hypot(a, b) || raw.height || 0;
        const fi = fontInfo.get(raw.fontName) ?? {};
        const fname = fi.name ?? '';
        items.push({
          text: raw.str,
          x: e,
          y: f,
          width: raw.width,
          size,
          font: fname,
          bold: !!fi.bold || !!fi.black || /bold|black|heavy|semibold|demi/i.test(fname),
          italic: !!fi.italic || /italic|oblique/i.test(fname),
          hidden,
        });
      }
      pages.push({ index: i - 1, width: vp.width, height: vp.height, items, images, hiddenOps, fonts });
      page.cleanup();
    }
    return { pages, encrypted, title };
  } finally {
    await doc.loadingTask.destroy();
  }
}

function isWhite(args: unknown[] | null): boolean {
  if (!args || !args.length) return false;
  const a0 = args[0];
  if (typeof a0 === 'string') return /^#?f{6}$/i.test(a0);
  const nums = args.filter((x): x is number => typeof x === 'number');
  if (nums.length === 1) return nums[0]! >= 0.99;
  if (nums.length === 3) return nums.every((x) => x >= 250 || (x <= 1 && x >= 0.99));
  if (nums.length === 4) return nums.every((x) => x <= 0.01);
  return false;
}

export function pdfPlainText(read: PdfRead): string {
  return read.pages.map((p) => p.items.map((i) => i.text).join(' ')).join('\n');
}
