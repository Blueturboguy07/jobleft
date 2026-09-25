// companyKey(): the one company-name key every jobleft package uses to match companies.
//
// Rules (static-data O4, O5):
//   * lower case, accents removed (NFKD), "&" and "+" become "and";
//   * dotted initials join: "L.L.C." and "L.L.C" become "llc", "J.P." becomes "jp";
//   * legal-form suffixes at the END are removed, repeatedly ("Foo Holdings Co., Ltd." -> "fooholdings"),
//     and a trailing "and" left by "& Co." goes with them ("Bain & Co." -> "bain");
//   * a leading "the" (or a trailing ", The") is removed;
//   * then every character that is not a letter or a digit is removed.
// It NEVER removes ordinary words such as "technologies", "group", "services", "holdings", "labs", "markets",
// "platforms", "business", "america" or "usa": removing them joins different companies ("Robinhood Group" is not
// "Robinhood Markets"). A suffix is removed only when another word is left, so "Inc." alone stays "inc".
// A "doing business as" tail is not handled here: the H-1B builder indexes both halves (splitDba below).

/** Bumped whenever the rules below change, so stored keys can be rebuilt. */
export const COMPANY_KEY_VERSION = 1;

/**
 * Legal-form words removed from the end of a name. Written without dots. Only legal forms: never a word that also
 * names a line of business or a place.
 */
export const LEGAL_SUFFIXES: ReadonlySet<string> = new Set([
  // United States and common English forms
  'inc', 'incorporated', 'llc', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'llp', 'lllp', 'lp',
  'plc', 'pbc', 'pc', 'pllc', 'pa', 'na',
  // Legal forms seen on US filings of foreign-owned employers
  'gmbh', 'ag', 'kg', 'sa', 'sas', 'sarl', 'srl', 'spa', 'nv', 'bv', 'oy', 'oyj', 'ab', 'asa', 'kk', 'pte', 'pty',
  'bhd', 'se',
]);

/** Two-word legal forms, checked before single words. */
const LEGAL_SUFFIX_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['pvt', 'ltd'], ['private', 'limited'], ['sdn', 'bhd'],
];

function stripAccents(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '');
}

/** Splits a name into lower-case word tokens (accents, dots and other punctuation removed). */
export function nameTokens(name: string): string[] {
  let s = stripAccents(String(name ?? '')).toLowerCase();
  s = s.replace(/[&+]/g, ' and ');
  // Dotted initials: "l.l.c.", "l.l.c", "u.s.a.", "j. p." -> "llc", "usa", "jp".
  s = s.replace(/(?<![\p{L}\p{N}])\p{L}(?:\.\s?\p{L})+\.?(?![\p{L}\p{N}])/gu, (m) => m.replace(/[.\s]/g, ''));
  // Apostrophes join ("Macy's" -> "macys"); every other separator splits.
  s = s.replace(/['’`]/g, '');
  return s.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
}

/** The words that remain after the legal form and a leading "the" are removed (the key is these words joined). */
export function coreTokens(name: string): string[] {
  const tokens = nameTokens(name);
  let end = tokens.length;
  let start = 0;
  if (end - start >= 2 && tokens[end - 1] === 'the') end -= 1;
  for (;;) {
    if (end - start >= 3) {
      const a = tokens[end - 2]!;
      const b = tokens[end - 1]!;
      if (LEGAL_SUFFIX_PAIRS.some(([x, y]) => x === a && y === b)) { end -= 2; continue; }
    }
    if (end - start >= 2 && LEGAL_SUFFIXES.has(tokens[end - 1]!)) {
      end -= 1;
      // "& Co." leaves a trailing "and": it belongs to the legal form.
      if (end - start >= 2 && tokens[end - 1] === 'and') end -= 1;
      continue;
    }
    break;
  }
  if (end - start >= 2 && tokens[start] === 'the') start += 1;
  return tokens.slice(start, end);
}

/**
 * The company match key. Examples: "Stripe, Inc." -> "stripe"; "STRIPE INC" -> "stripe"; "Stripe LLC" -> "stripe";
 * "The Home Depot" -> "homedepot"; "Ramp Business Corporation" -> "rampbusiness"; "L'Oréal USA, Inc." -> "lorealusa".
 */
export function companyKey(name: string): string {
  return coreTokens(name).join('');
}

/** Cuts "Foo Inc dba Bar" into { legal: "Foo Inc", others: ["Bar"] }. Also "d/b/a", "d.b.a.", "aka", "fka". */
export function splitDba(name: string): { legal: string; others: string[] } {
  const parts = String(name ?? '').split(
    /[\s,;(]+(?:d\s*\/\s*b\s*\/\s*a|d\.\s*b\.\s*a\.?|dba|a\s*\/\s*k\s*\/\s*a|a\.k\.a\.?|aka|f\s*\/\s*k\s*\/\s*a|f\.k\.a\.?|fka|formerly(?:\s+known\s+as)?|doing\s+business\s+as)(?=[\s:.,)]|$)[\s:.,)]*/i,
  );
  const cleaned = parts
    .map((p) => p.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[,;:\-\s]+|[,;:\-\s]+$/g, ''))
    .filter((p) => p.length > 0);
  if (cleaned.length === 0) return { legal: '', others: [] };
  return { legal: cleaned[0]!, others: cleaned.slice(1) };
}

/** Trade names that say nothing ("N/A", "None", "-", "Same as above"). */
export function isJunkTradeName(name: string): boolean {
  const k = companyKey(name);
  if (k.length < 2) return true;
  return /^(na|none|null|nil|notapplicable|nonapplicable|same|sameasabove|sameasemployer|no|dba|tbd|unknown|nothing|self|notavailable)$/.test(k);
}
