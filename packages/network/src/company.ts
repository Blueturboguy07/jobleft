// Company names: the match key, the "no real company" placeholders, and the explanation of every match.
//
// Rule: a connection counts at a company only when the two names give the SAME key. The key ignores case,
// accents, punctuation, "&" versus "and", a leading "The" and legal suffixes such as "Inc.", "LLC" or "Corp".
// It never drops ordinary words, so "Stripe Partners Ltd" is not "Stripe", "Apple Leisure Group" is not "Apple",
// "Metaview" is not "Meta" and "Blockchain Labs" is not "Block". One more safe variant: a short form in brackets at
// the end ("Amazon Web Services (AWS)") is also matched without the brackets. Near names that are NOT counted are
// listed with the reason, so the person can see why.
//
// The key itself is @jobleft/static-data companyKey (the key jobs use). Until that lane lands, its export throws
// "not implemented yet"; then this file uses an interim key written to the rules in docs/INTERFACES.md.

import { companyKey as staticCompanyKey, loadAliases } from '@jobleft/static-data';
import { createHash } from 'node:crypto';
import { fold } from './text.ts';

export type CompanyKeyFn = (name: string) => string;

// ---------------------------------------------------------------- interim key (docs/INTERFACES.md rules)

const LEGAL = new Set([
  'inc', 'incorporated', 'llc', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'llp', 'lp', 'plc', 'pbc',
  'gmbh', 'ag', 'sa', 'sas', 'srl', 'bv', 'nv', 'pty', 'pte', 'pllc', 'pc',
]);

/** Words of a name: lower case, accents removed, "&" and "+" as "and", dotted initials joined ("L.L.C." -> "llc"). */
export function nameWords(name: string): string[] {
  let s = fold(String(name ?? ''));
  s = s.replace(/[&+]/g, ' and ');
  s = s.replace(/\b([a-z])\.(?=[a-z]\b\.?)/g, '$1');
  s = s.replace(/['’`]/g, '');
  return s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Where the core words start and end in `words`: legal suffixes at the end and a leading "the" dropped. */
function coreRange(w: string[]): { start: number; end: number } {
  let start = 0;
  let end = w.length;
  if (end - start >= 2 && w[end - 1] === 'the') end--;
  while (end - start >= 2 && LEGAL.has(w[end - 1]!)) {
    end--;
    if (end - start >= 2 && w[end - 1] === 'and') end--;
  }
  if (end - start >= 2 && w[start] === 'the') start++;
  return { start, end };
}

/** Core words: legal suffixes at the end and a leading "the" removed, only while another word is left. */
export function coreWords(name: string): string[] {
  const w = nameWords(name);
  const { start, end } = coreRange(w);
  return w.slice(start, end);
}

/** The interim key: the core words joined. Replaced by @jobleft/static-data companyKey once it is built. */
export function interimCompanyKey(name: string): string {
  return coreWords(name).join('');
}

let resolved: { fn: CompanyKeyFn; source: 'static-data' | 'interim' } | null = null;

/** The key function jobs use: @jobleft/static-data companyKey when it is built, else the interim key. */
export function resolveCompanyKey(): { fn: CompanyKeyFn; source: 'static-data' | 'interim' } {
  if (resolved) return resolved;
  try {
    const probe = staticCompanyKey('Stripe, Inc.');
    if (typeof probe === 'string') resolved = { fn: staticCompanyKey, source: 'static-data' };
  } catch {
    // "not implemented yet": the static-data lane has not landed in this build.
  }
  resolved ??= { fn: interimCompanyKey, source: 'interim' };
  return resolved;
}

// ---------------------------------------------------------------- the same company under another name (JL-network-2)
//
// Two more safe variants, for the Network only (a person's file often holds the legal name, the job the brand):
//   * a web ending glued to a name of 3 or more letters: "Gong.io", "Amazon.com, Inc." ("X.AI" is left alone);
//   * a trailing "Global" or "Platforms" after the legal suffix: "Coinbase Global, Inc.", "Meta Platforms, Inc."
//     ("Apollo Global Management" keeps "Global": it is not at the end).
// And the reviewed alias table of @jobleft/static-data (brand to legal name, "EY" is "Ernst & Young LLP", "Palantir"
// is "Palantir Technologies"): names in one family share one key. It is a reviewed list, never a similarity score,
// so "Stripe Press", "Metabase", "H&R Block" and "Gong Cha" stay different companies.

const WEB_ENDING = /([\p{L}\p{N}][\p{L}\p{N}-]{2,})\.(io|com|ai|co|net|org|app)(?=$|[\s,()])/giu;
const DESCRIPTOR_TAIL = new Set(['global', 'platforms']);
/** Bumped when the Network's own variants change, so stored keys are rebuilt. */
const NETWORK_RULES_VERSION = 2;

/** The name without a web ending ("Gong.io" -> "Gong"). */
export function withoutWebEnding(name: string): string {
  return name.replace(WEB_ENDING, '$1');
}

/** The name without a trailing "Global" or "Platforms" (only after the legal suffix, and only while a word is left). */
export function withoutDescriptorTail(name: string): { name: string; dropped: string | null } {
  const core = coreWords(name);
  const last = core.at(-1);
  if (core.length < 2 || !last || !DESCRIPTOR_TAIL.has(last)) return { name, dropped: null };
  const re = new RegExp(`\\b${last}\\b(?![\\s\\S]*\\b${last}\\b)`, 'i');
  return { name: name.replace(re, ' ').replace(/\s+/g, ' ').trim(), dropped: last };
}

let aliasMap: Map<string, string> | null = null;

/** Key -> the one key of its reviewed alias family (the family's first name). Empty when the table cannot load. */
function aliasFamilies(): Map<string, string> {
  if (aliasMap) return aliasMap;
  const m = new Map<string, string>();
  try {
    const idx = loadAliases({} as never) as ReturnType<typeof loadAliases> & { table?: { entries: Array<{ group: string; names: string[]; filers: string[] }> } };
    const entries = idx.table?.entries ?? [];
    const rep = new Map<string, string>();
    const clash = new Set<string>();
    for (const e of entries) {
      if (!rep.has(e.group)) rep.set(e.group, staticCompanyKey(e.names[0]!) || e.group);
      const r = rep.get(e.group)!;
      for (const n of [...e.names, ...e.filers]) {
        const k = staticCompanyKey(n);
        if (!k) continue;
        if (m.has(k) && m.get(k) !== r) clash.add(k);
        else m.set(k, r);
      }
    }
    for (const k of clash) m.delete(k); // a filer name shared by two families names neither
  } catch {
    // no alias table in this build: names match by their key only
  }
  aliasMap = m;
  return m;
}

/** The key of a company's reviewed alias family, or the key itself. Keys that are the same company give one key. */
export function familyKey(key: string): string {
  if (!key) return key;
  return aliasFamilies().get(key) ?? key;
}

/** true when the reviewed alias table puts these two keys in one family (and they are not the same key). */
export function sameFamily(a: string, b: string): boolean {
  return !!a && !!b && a !== b && familyKey(a) === familyKey(b);
}

/** The Network's key for a name: the key jobs use, with the web ending and a trailing "Global"/"Platforms" left out, in its alias family. */
export function networkKey(name: string, keyFn: CompanyKeyFn): string {
  const loose = withoutDescriptorTail(withoutWebEnding(name)).name;
  return familyKey(safeKey(keyFn, loose) || safeKey(keyFn, name));
}

/** Names used to notice that the key function changed, so stored keys are rebuilt (never a silent mismatch). */
const FINGERPRINT_NAMES = [
  'Stripe, Inc.', 'stripe', 'Stripe Partners Ltd', 'The Home Depot', 'Bain & Co.', 'AT&T', 'J.P. Morgan Chase & Co.',
  'L\'Oréal USA, Inc.', 'Acme L.L.C.', 'Apple Leisure Group', 'Société Générale', 'Meta Platforms, Inc.', 'Inc.',
];

export function keyFingerprint(fn: CompanyKeyFn): string {
  const out = FINGERPRINT_NAMES.map((n) => { try { return fn(n); } catch { return '!'; } });
  // The Network's own variants and the alias families change the stored keys too.
  const fam = [...aliasFamilies().entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return createHash('sha256').update(JSON.stringify([out, NETWORK_RULES_VERSION, fam])).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- placeholders

/** Company fields that name no real employer. They never match a job and are grouped apart. */
const PLACEHOLDERS = new Set([
  'selfemployed', 'self', 'freelance', 'freelancer', 'freelancing', 'independent', 'independentconsultant',
  'independentcontractor', 'contractor', 'consultant', 'stealth', 'stealthmode', 'stealthstartup', 'stealthmodestartup',
  'stealthaistartup', 'stealthcompany', 'stealthstartupcompany', 'confidential', 'confidentialcompany', 'undisclosed',
  'retired', 'unemployed', 'opentowork', 'openforwork', 'lookingfornewopportunities', 'lookingforopportunities',
  'lookingforwork', 'seekingnewopportunities', 'seekingopportunities', 'jobseeker', 'jobsearch', 'careerbreak',
  'sabbatical', 'na', 'none', 'nil', 'null', 'notapplicable', 'various', 'multiple', 'private', 'privatecompany',
  'student', 'homemaker', 'myself', 'personal', 'unknown', 'tbd', 'xxx', 'x',
]);

/** true for "Self-employed", "Freelance", "Stealth Startup", "N/A", "-" and similar non-employers. */
export function isPlaceholderCompany(name: string): boolean {
  const k = fold(name).replace(/[^\p{L}\p{N}]+/gu, '');
  return k === '' || PLACEHOLDERS.has(k);
}

// ---------------------------------------------------------------- the keys stored per connection

/** A short form in brackets at the end: "(AWS)", "(IBM)", "(J&J)". Only letters, digits and "&", 2 to 6 long. */
const ACRONYM_TAIL = /\s*\(\s*[A-Z0-9&]{2,6}\s*\)\s*$/;

export interface CompanyKeys {
  /** The key of the name without a trailing "(ABC)"; null for a blank or placeholder company. */
  key: string | null;
  /** The key of the name exactly as written (differs from `key` only when there is a trailing "(ABC)"). */
  rawKey: string | null;
}

export function keysForCompany(company: string | null, keyFn: CompanyKeyFn): CompanyKeys {
  if (!company || isPlaceholderCompany(company)) return { key: null, rawKey: null };
  const raw = familyKey(safeKey(keyFn, company));
  const key = networkKey(ACRONYM_TAIL.test(company) ? company.replace(ACRONYM_TAIL, '') : company, keyFn) || raw;
  if (!key) return { key: null, rawKey: null };
  return { key, rawKey: raw || key };
}

function safeKey(fn: CompanyKeyFn, name: string): string {
  try { return fn(name) ?? ''; } catch { return ''; }
}

/** The key to look up for a job's company name (the same variants as for connections). */
export function lookupKeysForName(name: string, keyFn: CompanyKeyFn): string[] {
  const k = keysForCompany(name, keyFn);
  return [...new Set([k.key, k.rawKey].filter((x): x is string => !!x))];
}

// ---------------------------------------------------------------- explanations

/** How a connection's company name matched the job's company (true, short, checkable against the file). */
export function howMatched(contactCompany: string, targetName: string | null, keyFn: CompanyKeyFn): string {
  const target = targetName ?? '';
  if (target && contactCompany === target) return 'Same name as written.';
  if (target && fold(contactCompany).trim() === fold(target).trim()) return 'Same name; only upper and lower case differ.';
  const bits: string[] = [];
  let name = contactCompany;
  if (ACRONYM_TAIL.test(name) && (!target || !ACRONYM_TAIL.test(target))) {
    bits.push(`the short form "${name.match(ACRONYM_TAIL)![0].trim()}" is left out`);
    name = name.replace(ACRONYM_TAIL, '');
  }
  const web = [...name.matchAll(WEB_ENDING)].map((m) => `.${m[2]!.toLowerCase()}`);
  if (web.length) { bits.push(`the web ending "${web.join('", "')}" is ignored`); name = withoutWebEnding(name); }
  const w = nameWords(name);
  const { start, end } = coreRange(w);
  const tail = w.slice(end).filter((x) => x !== 'and' && x !== 'the');
  if (tail.length) bits.push(`the legal suffix "${tail.join(' ')}" is ignored`);
  const d = withoutDescriptorTail(name);
  if (d.dropped) { bits.push(`the word "${d.dropped}" at the end of the legal name is ignored`); name = d.name; }
  if (start > 0) bits.push('a leading "The" is ignored');
  // Different names of one company in jobleft's reviewed list (brand and legal name).
  const mine = safeKey(keyFn, name);
  const theirs = target ? safeKey(keyFn, withoutDescriptorTail(withoutWebEnding(target)).name) : '';
  if (sameFamily(mine, theirs)) {
    return `jobleft's reviewed list of company names lists "${contactCompany}" and "${target}" as the same company${bits.length ? ` (also: ${bits.join(', ')})` : ''}.`;
  }
  if (!bits.length) bits.push('case, spaces, accents and punctuation are ignored');
  return `Same company name once ${bits.join(' and ')}.`;
}

/** Why a near name is not counted (it shares a word or a prefix but has a different key). */
export function whyNotCounted(otherName: string, targetName: string): string {
  const a = coreWords(targetName);
  const b = coreWords(otherName);
  const extra = b.filter((x) => !a.includes(x));
  const missing = a.filter((x) => !b.includes(x));
  if (extra.length && !missing.length) return `Not counted: "${otherName}" has the extra word${extra.length > 1 ? 's' : ''} "${extra.join(' ')}", so it can be a different company.`;
  if (missing.length && !extra.length) return `Not counted: "${otherName}" lacks the word${missing.length > 1 ? 's' : ''} "${missing.join(' ')}", so it can be a different company.`;
  if (a.length === 1 && b.length === 1) return `Not counted: "${otherName}" is a different word from "${targetName}" (they only start the same).`;
  return `Not counted: "${otherName}" is a different name from "${targetName}".`;
}

/** true when two keys are near enough to show as "not counted" (never counted): a shared first word or prefix. */
export function isNearName(otherName: string, targetName: string, otherKey: string, targetKey: string): boolean {
  if (!otherKey || !targetKey || otherKey === targetKey) return false;
  const a = coreWords(withoutWebEnding(targetName));
  const b = coreWords(withoutWebEnding(otherName));
  if (a[0] && b[0] && a[0] === b[0] && a[0].length >= 3) return true;
  const short = otherKey.length < targetKey.length ? otherKey : targetKey;
  const long = otherKey.length < targetKey.length ? targetKey : otherKey;
  return short.length >= 3 && long.startsWith(short);
}
