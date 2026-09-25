// Small text helpers shared by the parsers. Pure functions, no dependencies.

/** Unicode and spacing clean-up that every parser wants: odd spaces, dashes, quotes, zero-width marks. */
const ZERO_WIDTH = new RegExp('[\\u{200b}-\\u{200d}\\u{2060}\\u{feff}\\u{ad}]', 'gu');
const ODD_SPACE = new RegExp('[\\u{a0}\\u{2000}-\\u{200a}\\u{202f}\\u{205f}\\u{3000}]', 'gu');
const DASHES = new RegExp('[\\u{2010}-\\u{2015}\\u{2212}\\u{fe58}\\u{fe63}\\u{ff0d}]', 'gu');
const LONG_DASH = new RegExp('[\\u{2014}\\u{2015}]', 'u');
const SINGLE_QUOTES = new RegExp('[\\u{2018}-\\u{201b}\\u{2032}\\u{b4}]', 'gu');
const DOUBLE_QUOTES = new RegExp('[\\u{201c}-\\u{201f}\\u{2033}]', 'gu');
const LINE_SEPS = new RegExp('[\\u{2028}\\u{2029}\\u{85}]', 'gu');

export function normalizeText(s: string): string {
  if (!s) return '';
  return s
    .replace(ZERO_WIDTH, '')
    .replace(ODD_SPACE, ' ')
    .replace(DASHES, (d) => (LONG_DASH.test(d) ? ' - ' : '-'))
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(/\r\n?/g, '\n')
    .replace(LINE_SEPS, '\n')
    .replace(/[\t\f\v]+/g, ' ');
}

const COMBINING = new RegExp('[\\u{300}-\\u{36f}]', 'gu');

/** Folds accents: "São Paulo" -> "Sao Paulo", "Zürich" -> "Zurich". */
export function foldAccents(s: string): string {
  return s.normalize('NFD').replace(COMBINING, '').replace(/ß/g, 'ss').replace(/ł/g, 'l').replace(/Ł/g, 'L')
    .replace(/ø/g, 'o').replace(/Ø/g, 'O').replace(/æ/g, 'ae').replace(/Æ/g, 'AE').replace(/đ/g, 'd').replace(/ı/g, 'i');
}

/** Lower case, accents folded, punctuation turned into single spaces. For dictionary keys. */
export function keyOf(s: string): string {
  return foldAccents(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Cuts a pasted page at a block of other jobs ("Similar jobs", "People also viewed", ...), so that
 * those jobs' pay, places and levels never become this job's facts (parsers O4 angle 4).
 * The cut happens only at a short heading-like line after this job's own first line.
 */
const OTHER_JOBS_HEADING = new RegExp(
  '^\\s*(?:#+\\s*)?(?:' + [
    '(?:similar|related|recommended|suggested|other|more|nearby|featured|trending|popular|recent(?:ly viewed)?|latest|new)\\s+(?:jobs?|positions?|openings?|roles?|opportunities|vacancies|listings?|postings?)(?:\\s+(?:at|from|near|like|for|in)\\b.*)?',
    'jobs?\\s+(?:you\\s+(?:may|might)\\s+(?:also\\s+)?(?:like|be\\s+interested\\s+in)|like\\s+this|similar\\s+to\\s+this.*|near\\s+you|for\\s+you)',
    'people\\s+(?:also\\s+)?(?:viewed|searched|applied).*',
    'recommended\\s+for\\s+you', 'related\\s+searches', 'more\\s+from\\s+this\\s+(?:employer|company)', 'other\\s+roles\\s+you\\s+might\\s+like',
    'you\\s+(?:may|might)\\s+(?:also\\s+)?(?:like|be\\s+interested\\s+in).*',
    '(?:explore|browse|see|view)\\s+(?:all\\s+|more\\s+|other\\s+|similar\\s+)?(?:jobs?|openings|positions|roles)(?:\\s+(?:at|from|like|in)\\b.*)?',
    'more\\s+(?:from|at)\\s+.{1,60}',
    'other\\s+(?:jobs|openings|positions|roles)\\s+(?:at|from)\\s+.{1,60}',
    'empleos\\s+similares', 'ofertas\\s+similares', 'offres\\s+similaires', 'ähnliche\\s+jobs', 'vagas\\s+semelhantes',
  ].join('|') + ')\\s*:?\\s*$',
  'i',
);
/** "Similar jobs: Shift Lead - $22/hr": the block can start on the heading's own line. */
const OTHER_JOBS_INLINE = /^\s*(?:similar|related|recommended|suggested|other|more)\s+(?:jobs?|positions?|openings?|roles?|opportunities|vacancies|listings?|postings?)\s*:\s*\S/i;

export function cutOtherJobs(text: string): string {
  if (!text) return '';
  const lines = text.split('\n');
  let pos = 0;
  let seen = 0;
  for (const line of lines) {
    // Never the first line of the page: a block of other jobs comes after this job's own text.
    if (seen >= 1 && ((line.length <= 90 && OTHER_JOBS_HEADING.test(line)) || OTHER_JOBS_INLINE.test(line))) return text.slice(0, pos).trimEnd();
    if (line.trim()) seen++;
    pos += line.length + 1;
  }
  return text;
}

/** A short quote around [start, end) for evidence: whole words, at most `max` characters. */
export function snippet(text: string, start: number, end: number, max = 240): string {
  const s = Math.max(0, start), e = Math.min(text.length, Math.max(end, s));
  const core = text.slice(s, e);
  if (core.length >= max) return clean(core.slice(0, max));
  const room = max - core.length;
  let a = s - Math.floor(room / 2), b = e + Math.ceil(room / 2);
  // Stay inside the line or sentence where possible.
  const lineStart = text.lastIndexOf('\n', s - 1) + 1;
  let lineEnd = text.indexOf('\n', e);
  if (lineEnd < 0) lineEnd = text.length;
  if (a < lineStart) { b += lineStart - a; a = lineStart; }
  if (b > lineEnd) { a -= b - lineEnd; b = lineEnd; }
  a = Math.max(a, lineStart, 0);
  b = Math.min(b, lineEnd, text.length);
  // Snap to word edges.
  if (a > lineStart) { const sp = text.indexOf(' ', a); if (sp > 0 && sp < s) a = sp + 1; }
  if (b < lineEnd) { const sp = text.lastIndexOf(' ', b); if (sp > e) b = sp; }
  return clean(text.slice(a, b));
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** Clips evidence text to the contract limit (500 characters). */
export function clip(s: string, max = 500): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…';
}

/** Index of the start of the sentence or line that holds `i`. */
export function clauseStart(text: string, i: number, stops = /[.!?;\n•|]/, maxBack = 400): number {
  const floor = Math.max(0, i - maxBack);
  for (let k = i - 1; k >= floor; k--) {
    const c = text[k];
    if (stops.test(c)) {
      // "U.S." and decimals are not sentence ends.
      if (c === '.' && k > 0 && /[A-Za-z0-9]/.test(text[k - 1]) && k + 1 < text.length && /[A-Za-z0-9]/.test(text[k + 1])) continue;
      if (c === '.' && k > 1 && /\b[A-Z]$/.test(text.slice(Math.max(0, k - 2), k))) continue;
      return k + 1;
    }
  }
  return floor;
}

/** Index just past the end of the sentence or line that holds `i`. */
export function clauseEnd(text: string, i: number, stops = /[.!?;\n•|]/, maxAhead = 400): number {
  const ceil = Math.min(text.length, i + maxAhead);
  for (let k = i; k < ceil; k++) {
    const c = text[k];
    if (stops.test(c)) {
      if (c === '.' && k > 0 && /[A-Za-z0-9]/.test(text[k - 1]) && k + 1 < text.length && /[A-Za-z0-9]/.test(text[k + 1])) continue;
      if (c === '.' && k > 1 && /\b[A-Z]$/.test(text.slice(Math.max(0, k - 2), k))) continue;
      return k;
    }
  }
  return ceil;
}

/** Word numbers used in requirements ("three years"). */
export const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, a: 1, an: 1,
  // Spanish, French, German, Portuguese (the common ones in US postings).
  uno: 1, un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, diez: 10,
  deux: 2, trois: 3, quatre: 4, cinq: 5, sept: 7, huit: 8, dix: 10,
  ein: 1, eine: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, zehn: 10,
  um: 1, uma: 1, dois: 2, duas: 2, quatro_pt: 4,
};
