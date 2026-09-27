// The small part of Markdown that model answers use: paragraphs, "- " and "1. " lists, "#" headings, **bold**,
// *italic* and `code` (JL-network-20). It builds plain data that React renders as text elements: nothing is ever
// injected as HTML, and a marker without its pair stays as written.

export interface Span { text: string; bold?: boolean; italic?: boolean; code?: boolean }
export type MdBlock =
  | { kind: 'p'; lines: Span[][] }
  | { kind: 'ul'; items: Span[][] }
  | { kind: 'ol'; items: Span[][] }
  | { kind: 'h'; spans: Span[] };

const INLINE = /(\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|`([^`\n]+?)`|(?<![\p{L}\p{N}*])\*([^*\s][^*\n]*?)\*(?![\p{L}\p{N}*]))/gu;

/** **bold**, *italic* and `code` inside one line. */
export function inlineSpans(line: string): Span[] {
  const out: Span[] = [];
  let at = 0;
  for (const m of line.matchAll(INLINE)) {
    if (m.index! > at) out.push({ text: line.slice(at, m.index) });
    if (m[2] !== undefined || m[3] !== undefined) out.push({ text: (m[2] ?? m[3])!, bold: true });
    else if (m[4] !== undefined) out.push({ text: m[4], code: true });
    else out.push({ text: m[5]!, italic: true });
    at = m.index! + m[0].length;
  }
  if (at < line.length) out.push({ text: line.slice(at) });
  return out;
}

const UL = /^\s*[-*•]\s+(.*)$/;
const OL = /^\s*\d{1,3}[.)]\s+(.*)$/;
const H = /^\s*#{1,6}\s+(.*)$/;

export function parseMarkdown(src: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  for (const raw of src.replace(/\r\n?/g, '\n').split('\n')) {
    const last = blocks.at(-1);
    let m: RegExpExecArray | null;
    if (!raw.trim()) { if (last && last.kind === 'p') blocks.push({ kind: 'p', lines: [] }); continue; }
    if ((m = UL.exec(raw))) { if (last?.kind === 'ul') last.items.push(inlineSpans(m[1]!)); else blocks.push({ kind: 'ul', items: [inlineSpans(m[1]!)] }); continue; }
    if ((m = OL.exec(raw))) { if (last?.kind === 'ol') last.items.push(inlineSpans(m[1]!)); else blocks.push({ kind: 'ol', items: [inlineSpans(m[1]!)] }); continue; }
    if ((m = H.exec(raw))) { blocks.push({ kind: 'h', spans: inlineSpans(m[1]!) }); continue; }
    if (last?.kind === 'p') last.lines.push(inlineSpans(raw));
    else blocks.push({ kind: 'p', lines: [inlineSpans(raw)] });
  }
  return blocks.filter((b) => b.kind !== 'p' || b.lines.length > 0);
}
