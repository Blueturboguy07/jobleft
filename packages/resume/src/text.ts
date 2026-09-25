// Text helpers shared by import, the truth gate, gaps, tailoring and rendering. Pure functions, no I/O.

const LIGATURES: Readonly<Record<string, string>> = {
  '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl', '\uFB03': 'ffi', '\uFB04': 'ffl', '\uFB05': 'st', '\uFB06': 'st',
};

/** Bullet glyphs seen at the start of resume lines (including Wingdings/Symbol private-use code points). */
export const BULLET_CHARS = '•●○◦▪▫■□‣⁃∙·➢➤►▶✓✔❖◆◇★☆-–—*';
const BULLET_RE = new RegExp(`^\\s*(?:[${BULLET_CHARS.replace(/[-\\\]^]/g, '\\$&')}]|[\\uE000-\\uF8FF])\\s*`);

/** NFC, ligatures expanded, odd spaces made plain, zero-width marks removed. Never changes letters. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[\uFB00-\uFB06]/g, (c) => LIGATURES[c] ?? c)
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
    .replace(/\r\n?/g, '\n');
}

/** Collapses runs of spaces and trims. */
export function squash(s: string): string {
  return s.replace(/[ \t]+/g, ' ').trim();
}

export function isBulletLine(line: string): boolean {
  const t = line.trimStart();
  if (!t) return false;
  // "- " and "* " need a space after them; a dash inside a date range is not a bullet.
  if (/^[-–—*]\S/.test(t)) return false;
  return BULLET_RE.test(t);
}

export function stripBullet(line: string): string {
  return line.replace(BULLET_RE, '').trim();
}

/** Lower case, accents removed, punctuation folded to spaces, spaces collapsed. For matching, never for display. */
export function foldKey(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+#.\s/]/g, ' ')
    .replace(/(?<![a-z0-9])\.|\.(?![a-z0-9])/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Organisation key: foldKey without legal suffixes or a leading "the". */
export function orgKey(s: string): string {
  let k = foldKey(s).replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  k = k.replace(/^the /, '');
  for (let i = 0; i < 2; i++) {
    k = k.replace(/(?:^| )(inc|incorporated|llc|l l c|ltd|limited|corp|corporation|co|company|plc|llp|lp|gmbh|pbc|sa|ag|bv|pty)$/, '').trim();
  }
  return k;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A regular expression that finds `term` as a whole term: "Java" never matches inside "JavaScript", "C" never
 * matches "C++" or "C#", and "Node.js" matches before a full stop.
 */
export function termRegExp(term: string, caseSensitive: boolean, flags = 'g'): RegExp {
  const body = escapeRegExp(term).replace(/\\ /g, '\\s+').replace(/ /g, '\\s+');
  const endsWord = /[A-Za-z0-9]$/.test(term);
  const startsWord = /^[A-Za-z0-9]/.test(term);
  const pre = startsWord ? '(?<![A-Za-z0-9_+#@/])' : '(?<![A-Za-z0-9_])';
  // After the term: no letter/digit, and no "+"/"#" that would make it another language (C -> C++).
  const post = endsWord ? '(?![A-Za-z0-9_]|[+#]|\\.[A-Za-z0-9])' : '(?![A-Za-z0-9_])';
  return new RegExp(`${pre}${body}${post}`, caseSensitive ? flags.replace('i', '') : flags.includes('i') ? flags : flags + 'i');
}

/** Sentence split that keeps "Node.js", "e.g.", "U.S." and decimals together. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n+/)) {
    const p = para.trim();
    if (!p) continue;
    const parts = p.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/);
    for (const s of parts) if (s.trim()) out.push(s.trim());
  }
  return out;
}

export function words(text: string): string[] {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’+#.\-]*/gu) ?? [];
}

/** Content-word Jaccard similarity (for "does this rewrite say the same thing"). */
export function similarity(a: string, b: string): number {
  const stop = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'at', 'from', 'as', 'into', 'using', 'via', 'that', 'which', 'our', 'their', 'its']);
  const toks = (s: string) => new Set(words(foldKey(s)).map((w) => w.replace(/(ing|ed|es|s)$/, '')).filter((w) => w.length > 1 && !stop.has(w)));
  const A = toks(a);
  const B = toks(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export function uniq<T>(xs: Iterable<T>): T[] {
  return [...new Set(xs)];
}

/** Stable short id from text (not a secret; for ids that must not change between runs). */
export function stableId(prefix: string, ...parts: string[]): string {
  let h = 2166136261;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) {
      h ^= p.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 0x1f;
    h = Math.imul(h, 16777619);
  }
  return `${prefix}${(h >>> 0).toString(36)}`;
}
