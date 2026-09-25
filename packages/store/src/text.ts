// Text rules shared by indexing and querying. The same function runs on job text before it goes into FTS5 and on
// the words a person types, so both sides always agree.
//
// Why: the FTS5 tokenizer (unicode61) splits on every character that is not a letter or a digit. Left alone, "C++",
// "C#" and "C" would all become the token "c", ".NET" would become "net", and "401(k)" would become "401" and "k".
// We rewrite those few forms into plain tokens first ("cplusplus", "csharp", "dotnet", "401k"), and a one-letter
// apostrophe prefix ("L'Oréal") also gives the joined word ("loreal").
// Accents are folded by the tokenizer itself (remove_diacritics 2), so "Société" and "Societe" match.

/** Rewrites programming-language and benefit spellings that punctuation would otherwise destroy. */
export function rewriteSpecialTokens(input: string): string {
  // Fast path: each rule runs only when its trigger text is present (most descriptions have none).
  let s = /[^\x00-\x7f]/.test(input) ? input.normalize('NFKC') : input;
  const lower = s.toLowerCase();
  const hasNet = lower.includes('.net');
  const hasPlus = s.includes('+');
  const hasSharp = s.includes('#');
  const hasJs = lower.includes('.js') || lower.includes(' js');
  const hasK = s.includes('(');
  const hasAmp = s.includes('&');
  const hasApos = s.includes("'") || s.includes('\u2019');
  if (!hasNet && !hasPlus && !hasSharp && !hasJs && !hasK && !hasAmp && !hasApos) return s;
  // L'Oréal, O'Reilly, D'Angelo: one letter, an apostrophe, then a word of 3+ letters. Keep both halves and add the
  // joined word, so "Loreal", "L'Oréal" and "L Oreal" all match ("I'll", "I'm" and "don't" are left alone).
  if (hasApos) s = s.replace(/(^|[^\p{L}\p{N}])(\p{L})['\u2019](\p{L}{3,})(?![\p{L}\p{N}])/gu, (_m, pre: string, a: string, b: string) => `${pre}${a} ${b} ${a}${b}`);
  // asp.net / vb.net before the generic .net rule.
  if (hasNet) s = s.replace(/\b(asp|vb|ado)\.net\b/gi, (_m, a: string) => ` ${a.toLowerCase()}net dotnet `);
  if (hasNet) s = s.replace(/(^|[^\p{L}\p{N}])\.net\b/giu, '$1 dotnet ');
  // c++, g++ (any single letter followed by ++), also "c ++".
  if (hasPlus) s = s.replace(/(^|[^\p{L}\p{N}])([a-z])\s?\+\+(?![\p{L}\p{N}])/giu, (_m, pre: string, l: string) => `${pre} ${l.toLowerCase()}plusplus `);
  // c#, f#, j# (one letter followed by #).
  if (hasSharp) s = s.replace(/(^|[^\p{L}\p{N}])([a-z])\s?#(?![\p{L}\p{N}])/giu, (_m, pre: string, l: string) => `${pre} ${l.toLowerCase()}sharp `);
  // node.js, vue.js, next.js, three.js, d3.js and "node js".
  if (hasJs) s = s.replace(/(^|[^\p{L}\p{N}.])([\p{L}\p{N}]+)\.js(?![\p{L}\p{N}])/giu, (_m, pre: string, a: string) => `${pre} ${a.toLowerCase()}js `);
  if (hasJs) s = s.replace(/\b(node|vue|react|next|nuxt|express|angular|ember|backbone|three|d3|knockout|solid|svelte)\s+js\b/gi,
    (_m, a: string) => ` ${a.toLowerCase()}js `);
  // 401(k), 403(b), 457(b), 401 (k), 401k.
  if (hasK) s = s.replace(/\b(401|403|457)\s*\(\s*([a-z])\s*\)/gi, (_m, n: string, l: string) => ` ${n}${l.toLowerCase()} `);
  // R&D, P&L, Q&A, AT&T: single letters joined by "&".
  if (hasAmp) s = s.replace(/\b([a-z]{1,2})\s?&\s?([a-z]{1,2})\b/gi, (_m, a: string, b: string) => ` ${a.toLowerCase()}and${b.toLowerCase()} `);
  return s;
}

/** Text as it goes into FTS5. */
export function indexText(input: string | null | undefined): string {
  if (!input) return '';
  return rewriteSpecialTokens(input);
}

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

/** Splits text the way the unicode61 tokenizer does (letters and digits; everything else separates). */
export function plainTokens(input: string): string[] {
  const s = rewriteSpecialTokens(input).normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
  return s.match(TOKEN_RE) ?? [];
}

/** Words dropped from a query when other words remain (operators and glue words are words, never syntax). */
const QUERY_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'not', 'near', 'of', 'in', 'on', 'at', 'for', 'to', 'with', 'by', 'from', 'as', 'is',
  'job', 'jobs',
]);

export const MAX_QUERY_TERMS = 12;

export interface ParsedQuery {
  /** The distinct terms to match (each must appear somewhere in the job). */
  terms: string[];
  /** True when the person typed something but nothing searchable was left (for example only "-" or quotes). */
  blank: boolean;
}

/** Turns what a person typed into terms. Never throws; quotes, operators, brackets and dashes are just separators. */
export function parseQuery(q: string | null | undefined): ParsedQuery {
  const raw = (q ?? '').slice(0, 500);
  if (raw.trim() === '') return { terms: [], blank: false };
  const tokens = plainTokens(raw);
  const seen = new Set<string>();
  const all: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    all.push(t);
  }
  const kept = all.filter((t) => !QUERY_STOPWORDS.has(t));
  const terms = (kept.length > 0 ? kept : all).slice(0, MAX_QUERY_TERMS);
  return { terms, blank: terms.length === 0 };
}

/** One FTS5 string literal. The term holds only letters and digits, but quote it anyway (a bare AND/OR/NOT/NEAR would be syntax). */
export function ftsString(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/** Number of plain tokens in a title (for "shorter title that holds the words ranks first"). */
export function titleTokenCount(title: string): number {
  return Math.min(255, plainTokens(title).length);
}

// ---------------------------------------------------------------- company key

const LEGAL_SUFFIXES = new Set(['inc', 'llc', 'corp', 'corporation', 'co', 'ltd', 'llp', 'plc', 'pbc', 'gmbh']);

/**
 * The company match key, as specified for @jobleft/static-data companyKey(): lower case, accents removed, "&" and "+"
 * become "and", a leading "the" and legal suffixes removed, punctuation and spaces removed. Ordinary words stay.
 * "Stripe, Inc." -> "stripe"; "The Home Depot" -> "homedepot"; "Société Générale" -> "societegenerale".
 */
export function localCompanyKey(name: string): string {
  let s = (name ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
  s = s.replace(/[&+]/g, ' and ');
  const words = s.split(/[\s,]+/).filter((w) => w.replace(/[^\p{L}\p{N}]/gu, '') !== '');
  if (words.length > 1 && words[0] === 'the') words.shift();
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1]!.replace(/[^\p{L}\p{N}]/gu, ''))) words.pop();
  return words.join('').replace(/[^\p{L}\p{N}]/gu, '');
}

// ---------------------------------------------------------------- places

const US_STATES: ReadonlyArray<[string, string]> = [
  ['al', 'alabama'], ['ak', 'alaska'], ['az', 'arizona'], ['ar', 'arkansas'], ['ca', 'california'], ['co', 'colorado'],
  ['ct', 'connecticut'], ['de', 'delaware'], ['fl', 'florida'], ['ga', 'georgia'], ['hi', 'hawaii'], ['id', 'idaho'],
  ['il', 'illinois'], ['in', 'indiana'], ['ia', 'iowa'], ['ks', 'kansas'], ['ky', 'kentucky'], ['la', 'louisiana'],
  ['me', 'maine'], ['md', 'maryland'], ['ma', 'massachusetts'], ['mi', 'michigan'], ['mn', 'minnesota'],
  ['ms', 'mississippi'], ['mo', 'missouri'], ['mt', 'montana'], ['ne', 'nebraska'], ['nv', 'nevada'],
  ['nh', 'new hampshire'], ['nj', 'new jersey'], ['nm', 'new mexico'], ['ny', 'new york'], ['nc', 'north carolina'],
  ['nd', 'north dakota'], ['oh', 'ohio'], ['ok', 'oklahoma'], ['or', 'oregon'], ['pa', 'pennsylvania'],
  ['ri', 'rhode island'], ['sc', 'south carolina'], ['sd', 'south dakota'], ['tn', 'tennessee'], ['tx', 'texas'],
  ['ut', 'utah'], ['vt', 'vermont'], ['va', 'virginia'], ['wa', 'washington'], ['wv', 'west virginia'],
  ['wi', 'wisconsin'], ['wy', 'wyoming'], ['dc', 'district of columbia'], ['pr', 'puerto rico'],
];
const STATE_BY_NAME = new Map(US_STATES.map(([code, name]) => [name, code]));
const STATE_CODES = new Set(US_STATES.map(([code]) => code));

const COUNTRY_WORDS: ReadonlyArray<[string, string[]]> = [
  ['US', ['us', 'usa', 'united states', 'united states of america', 'u s', 'u s a', 'america']],
  ['CA', ['canada']], ['GB', ['uk', 'united kingdom', 'great britain', 'england', 'britain']], ['IN', ['india']],
  ['DE', ['germany', 'deutschland']], ['FR', ['france']], ['IE', ['ireland']], ['NL', ['netherlands', 'holland']],
  ['ES', ['spain']], ['IT', ['italy']], ['MX', ['mexico']], ['BR', ['brazil']], ['AU', ['australia']],
  ['JP', ['japan']], ['SG', ['singapore']], ['CN', ['china']], ['PL', ['poland']], ['PT', ['portugal']],
  ['SE', ['sweden']], ['CH', ['switzerland']], ['IL', ['israel']], ['AE', ['united arab emirates', 'uae']],
  ['PH', ['philippines']], ['AR', ['argentina']], ['CO', ['colombia']], ['NZ', ['new zealand']], ['KR', ['south korea', 'korea']],
];
const COUNTRY_BY_WORD = new Map<string, string>();
for (const [code, words] of COUNTRY_WORDS) for (const w of words) COUNTRY_BY_WORD.set(w, code);

/** Lower case, accents off, punctuation to spaces, spaces squeezed. */
export function foldPlace(s: string | null | undefined): string {
  return (s ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * The key of a skill name for the skills filter. Punctuation that names a different skill is kept apart with the
 * same rewrite word search uses: "C++" -> "cplusplus", "C#" -> "csharp", "C" -> "c", ".NET" -> "dotnet".
 */
export function skillKey(s: string | null | undefined): string {
  return foldPlace(rewriteSpecialTokens(s ?? ''));
}

/** A US state as its two-letter code ("Texas" and "TX" both give "tx"); other regions fold as they are. */
export function regionKey(region: string | null | undefined): string {
  const f = foldPlace(region);
  if (!f) return '';
  if (STATE_CODES.has(f)) return f;
  return STATE_BY_NAME.get(f) ?? f;
}

/** A country word or code ("United States", "USA", "us") as an ISO code, or null. */
export function countryFromText(text: string | null | undefined): string | null {
  const f = foldPlace(text);
  if (!f) return null;
  if (COUNTRY_BY_WORD.has(f)) return COUNTRY_BY_WORD.get(f)!;
  if (/^[a-z]{2}$/.test(f) && COUNTRY_WORDS.some(([c]) => c.toLowerCase() === f) && !STATE_CODES.has(f)) return f.toUpperCase();
  return null;
}

export interface PlaceWanted {
  placeId: string | null;
  city: string;
  region: string;
  country: string | null;
  /** Whole folded text, used when the text is neither "City, Region" nor a region nor a country. */
  text: string;
}

/** Reads a place query text: "Austin, TX", "Austin, Texas", "Texas", "TX", "United States", "London". */
export function parsePlaceQuery(text: string, placeId: string | null): PlaceWanted {
  const parts = (text ?? '').split(',').map((p) => foldPlace(p)).filter((p) => p !== '');
  const whole = foldPlace(text);
  const out: PlaceWanted = { placeId, city: '', region: '', country: null, text: whole };
  if (parts.length === 0) return out;
  const country = countryFromText(whole);
  if (parts.length === 1 && country && !STATE_BY_NAME.has(whole)) { out.country = country; return out; }
  if (parts.length === 1) {
    const r = regionKey(parts[0]);
    if (STATE_CODES.has(r) && (STATE_BY_NAME.has(parts[0]!) || STATE_CODES.has(parts[0]!))) { out.region = r; out.country = 'US'; return out; }
    out.city = parts[0]!;
    return out;
  }
  out.city = parts[0]!;
  out.region = regionKey(parts[1]);
  const c = parts.length >= 3 ? countryFromText(parts[parts.length - 1]) : countryFromText(parts[1]);
  if (c && !STATE_CODES.has(regionKey(parts[1]))) { out.country = c; if (parts.length === 2) out.region = ''; }
  else if (STATE_CODES.has(out.region)) out.country = 'US';
  return out;
}
