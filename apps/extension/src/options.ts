// Strict option matching. A dropdown, radio group or checkbox group gets a choice only when one option means
// exactly the profile value (the same fact under another spelling). A near match is never picked:
// "Austin, MN" is not Austin, TX; "Bachelor of Arts" is not a B.S.; "United States Minor Outlying Islands" is not
// the United States; "Two or More Races" is not "Asian"; "Norfolk Island" is not "No".
// Used by the app (answer engine) and by the content script (custom dropdowns, whose options appear only when open).

import { countryNames, pn, regionNames } from './places.ts';
import { isPlaceholderOption, norm } from './text.ts';

export interface Opt {
  value: string;
  label: string;
}

/** How to compare a wanted value with option texts. */
export type MatchKind =
  | 'exact' | 'country' | 'region' | 'location' | 'degree' | 'month' | 'year' | 'yes' | 'no' | 'decline' | 'gender'
  | 'race' | 'orientation' | 'pronouns' | 'range';

export interface Pick {
  index: number;
  confidence: 'exact' | 'likely';
}

/** The option label as a person reads it, for comparisons: no placeholder, no trailing description. */
function head(label: string): string {
  return norm(label).replace(/\s*[(:].*$/, '').replace(/\s+-\s+.*$/, '').trim();
}

function usable(options: readonly Opt[]): number[] {
  const out: number[] = [];
  options.forEach((o, i) => { if (!isPlaceholderOption(o.label, o.value)) out.push(i); });
  return out;
}

/** One index, or null when none or several different options qualify. */
function only(options: readonly Opt[], hits: number[]): number | null {
  const uniq = [...new Set(hits)];
  if (uniq.length === 1) return uniq[0] ?? null;
  if (uniq.length > 1) {
    // Several options with the very same text (a list that repeats "United States" at the top) are one answer.
    const texts = new Set(uniq.map((i) => norm(options[i]?.label)));
    if (texts.size === 1) return uniq[0] ?? null;
  }
  return null;
}

// ------------------------------------------------------------------ yes / no / decline

const DECLINE = [
  'decline', 'prefer not', 'do not wish', "don't wish", 'dont wish', 'choose not', 'rather not', 'not to answer',
  'not to disclose', 'not to say', 'not to self identify', 'not to self-identify', 'i do not want to answer',
  "i don't want to answer", 'no answer', 'wish to not', 'not specified', 'decline to state',
];

export function isDeclineOption(label: string): boolean {
  const t = norm(label);
  return DECLINE.some((d) => t.includes(d));
}

function yesNoClass(label: string): 'yes' | 'no' | 'decline' | null {
  const t = norm(label);
  if (!t) return null;
  if (isDeclineOption(t)) return 'decline';
  if (/^(yes|y|true)\b/.test(t)) return 'yes';
  if (/^(no|n|false)\b/.test(t)) return 'no';
  // Long-form answers used on self-identification forms.
  if (/^i am not\b|^i'm not\b|^i do not\b|^i don't\b|^not\b/.test(t)) return 'no';
  if (/^i am\b|^i'm\b|^i have\b|^i identify\b/.test(t)) return 'yes';
  return null;
}

// ------------------------------------------------------------------ EEO groups

const GENDER_GROUPS: readonly (readonly string[])[] = [
  ['female', 'woman', 'f', 'female/woman', 'woman/female'],
  ['male', 'man', 'm', 'male/man', 'man/male'],
  ['non-binary', 'nonbinary', 'non binary', 'non-binary/non-conforming', 'genderqueer or non-binary', 'non-binary / genderqueer'],
];

const RACE_GROUPS: readonly (readonly string[])[] = [
  ['american indian or alaska native', 'american indian or alaskan native', 'american indian/alaska native', 'american indian/alaskan native', 'native american or alaska native', 'native american or alaskan native', 'american indian or alaska native (not hispanic or latino)'],
  ['asian'],
  ['black or african american', 'black/african american', 'african american or black', 'black'],
  ['hispanic or latino', 'hispanic/latino', 'hispanic or latinx', 'hispanic, latino or spanish origin', 'hispanic/latinx', 'latino', 'latinx', 'hispanic'],
  ['native hawaiian or other pacific islander', 'native hawaiian or pacific islander', 'native hawaiian/other pacific islander', 'pacific islander'],
  ['white', 'caucasian'],
  ['two or more races', 'two or more', 'multiracial', 'two or more races (not hispanic or latino)'],
  ['middle eastern or north african', 'middle eastern / north african', 'mena'],
];

const ORIENTATION_GROUPS: readonly (readonly string[])[] = [
  ['heterosexual', 'straight', 'heterosexual/straight', 'straight/heterosexual', 'heterosexual or straight'],
  ['gay'], ['lesbian'], ['bisexual'], ['queer'], ['asexual'], ['pansexual'], ['gay or lesbian'],
];

function groupOf(groups: readonly (readonly string[])[], text: string): readonly string[] | null {
  const t = norm(text);
  return groups.find((g) => g.some((x) => norm(x) === t)) ?? null;
}

function inGroup(groups: readonly (readonly string[])[], wanted: string, label: string): boolean {
  const g = groupOf(groups, wanted);
  const h = head(label);
  const full = norm(label);
  if (!g) return h === norm(wanted) || full === norm(wanted);
  return g.some((x) => norm(x) === h || norm(x) === full);
}

// ------------------------------------------------------------------ degrees

type Level = 'high_school' | 'associate' | 'bachelor' | 'master' | 'doctorate' | 'certificate';
interface Degree { level: Level; field: string | null }

/** "B.S." -> bachelor of science; "Bachelor's Degree" -> bachelor (any field); "MBA" -> master of business administration. */
export function parseDegree(text: string): Degree | null {
  const raw = norm(text);
  const t = raw.replace(/\./g, '').replace(/[’']/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const f = (s: string): string => s.replace(/\s+/g, ' ').trim();
  if (/\b(high school|ged|secondary school|diploma \(high school\))\b/.test(t)) return { level: 'high_school', field: null };
  if (/^(mba|master of business administration|masters? in business administration)\b/.test(t)) return { level: 'master', field: 'business administration' };
  if (/^(bba|bachelor of business administration)\b/.test(t)) return { level: 'bachelor', field: 'business administration' };
  if (/^(phd|dphil|doctor of philosophy)\b/.test(t)) return { level: 'doctorate', field: 'philosophy' };
  if (/^(jd|juris doctor)\b/.test(t)) return { level: 'doctorate', field: 'law' };
  if (/^(md|doctor of medicine)\b/.test(t)) return { level: 'doctorate', field: 'medicine' };
  if (/^(doctorate|doctoral|doctors?( degree)?)\b/.test(t)) return { level: 'doctorate', field: null };
  const short: Array<[RegExp, Level, string]> = [
    [/^(bs|bsc|b sc|b s)\b/, 'bachelor', 'science'], [/^(ba|b a|ab)\b/, 'bachelor', 'arts'],
    [/^(be|beng|b eng|b e|btech|b tech)\b/, 'bachelor', 'engineering'], [/^(bfa)\b/, 'bachelor', 'fine arts'],
    [/^(ms|msc|m sc|m s)\b/, 'master', 'science'], [/^(ma|m a)\b/, 'master', 'arts'],
    [/^(meng|m eng|mtech|m tech|me)\b/, 'master', 'engineering'], [/^(mfa)\b/, 'master', 'fine arts'],
    [/^(as|a s)\b/, 'associate', 'science'], [/^(aa|a a)\b/, 'associate', 'arts'],
  ];
  for (const [re, level, field] of short) if (re.test(t)) return { level, field };
  const long = t.match(/^(associate|bachelor|master|doctor)s?(?: degree)?(?:\s+(?:of|in)\s+(.+?))?(?:\s+degree)?(?:\s*\(.*\))?$/);
  if (long) {
    const level = long[1] === 'associate' ? 'associate' : long[1] === 'bachelor' ? 'bachelor' : long[1] === 'master' ? 'master' : 'doctorate';
    return { level, field: long[2] ? f(long[2]) : null };
  }
  if (/\bcertificat/.test(t)) return { level: 'certificate', field: null };
  return null;
}

function degreePick(wanted: string, options: readonly Opt[]): Pick | null {
  const want = parseDegree(wanted);
  const idx = usable(options);
  // The exact text first ("B.S." offered as "B.S.").
  const same = idx.filter((i) => norm(options[i]?.label) === norm(wanted));
  const s = only(options, same);
  if (s !== null) return { index: s, confidence: 'exact' };
  if (!want) return null;
  const parsed = idx.map((i) => ({ i, d: parseDegree(options[i]?.label ?? '') }));
  const exactField = parsed.filter((p) => p.d && p.d.level === want.level && want.field !== null && p.d.field === want.field).map((p) => p.i);
  const e = only(options, exactField);
  if (e !== null) return { index: e, confidence: 'exact' };
  if (exactField.length > 1) return null;
  // A generic option of the same level ("Bachelor's Degree" for a B.S.). Never another field ("Bachelor of Arts").
  const generic = parsed.filter((p) => p.d && p.d.level === want.level && p.d.field === null).map((p) => p.i);
  const g = only(options, generic);
  if (g !== null) return { index: g, confidence: 'likely' };
  return null;
}

// ------------------------------------------------------------------ months, ranges

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function monthOf(label: string): number | null {
  const t = norm(label).replace(/\.$/, '');
  if (/^\d{1,2}$/.test(t)) { const n = Number(t); return n >= 1 && n <= 12 ? n : null; }
  const i = MONTHS.findIndex((m) => m === t || (t.length >= 3 && m.startsWith(t) && t.length <= m.length));
  return i >= 0 ? i + 1 : null;
}

/** A numeric range an option states ("1-3 years", "5+", "Less than 1 year"), inclusive. */
export function rangeOf(label: string): { min: number; max: number } | null {
  const t = norm(label);
  let m = t.match(/^(\d+(?:\.\d+)?)\s*(?:-|to|–)\s*(\d+(?:\.\d+)?)/);
  if (m) return { min: Number(m[1]), max: Number(m[2]) };
  m = t.match(/^(\d+(?:\.\d+)?)\s*(?:\+|or more|and (?:up|above|over)|years? or more|\+ years?)/);
  if (m) return { min: Number(m[1]), max: Infinity };
  m = t.match(/^(?:less than|under|fewer than|<)\s*(\d+(?:\.\d+)?)/);
  if (m) return { min: 0, max: Number(m[1]) - 1e-9 };
  m = t.match(/^(?:more than|over|>)\s*(\d+(?:\.\d+)?)/);
  if (m) return { min: Number(m[1]) + 1e-9, max: Infinity };
  m = t.match(/^(\d+(?:\.\d+)?)(?:\s*years?)?$/);
  if (m) return { min: Number(m[1]), max: Number(m[1]) };
  return null;
}

// ------------------------------------------------------------------ the picker

/**
 * The option that means `wanted`, or null. `wanted` by kind:
 *   exact: the text itself; country: an ISO code or a name; region: "TX|US" (region and country code);
 *   location: "City|Region|CC"; degree: the profile degree; month: "1".."12"; year: "2021";
 *   yes/no/decline: ignored (the class is the kind); gender, race, orientation, pronouns: the saved answer;
 *   range: a number.
 */
export function pickOption(kind: MatchKind, wanted: string, options: readonly Opt[]): Pick | null {
  const idx = usable(options);
  if (idx.length === 0) return null;
  const hit = (pred: (o: Opt) => boolean): number | null => only(options, idx.filter((i) => pred(options[i] as Opt)));
  const as = (i: number | null, confidence: 'exact' | 'likely' = 'exact'): Pick | null => (i === null ? null : { index: i, confidence });

  switch (kind) {
    case 'exact': {
      const w = norm(wanted);
      if (!w) return null;
      return as(hit((o) => norm(o.label) === w)) ?? as(hit((o) => norm(o.value) === w && o.value !== ''));
    }
    case 'country': {
      const code = wanted.length === 2 ? wanted.toUpperCase() : null;
      const names = code ? countryNames(code) : new Set([pn(wanted)]);
      if (names.size === 0) return null;
      const byLabel = idx.filter((i) => names.has(pn(options[i]?.label)));
      const pickL = only(options, byLabel);
      if (pickL !== null) return { index: pickL, confidence: 'exact' };
      if (byLabel.length > 1) {
        // "United States" and "USA" both offered: they are one country; take the first.
        return { index: byLabel[0] as number, confidence: 'exact' };
      }
      return as(hit((o) => o.value !== '' && code !== null && o.value.toUpperCase() === code));
    }
    case 'region': {
      const [region = '', country = ''] = wanted.split('|');
      const names = regionNames(region, country || null);
      if (names.size === 0) return null;
      return as(hit((o) => names.has(pn(o.label)) || (o.value !== '' && names.has(pn(o.value)))));
    }
    case 'location': {
      const [city = '', region = '', country = ''] = wanted.split('|');
      const c = pn(city);
      if (!c) return null;
      const regions = region ? regionNames(region, country || null) : new Set<string>();
      const countries = country ? countryNames(country) : new Set<string>();
      return as(hit((o) => {
        const parts = o.label.split(',').map((p) => pn(p)).filter(Boolean);
        if (parts[0] !== c) return false;
        const rest = parts.slice(1);
        if (rest.length === 0) return regions.size === 0;
        // Every further part must be the person's region or country; nothing else.
        let sawRegion = false;
        for (const p of rest) {
          if (regions.has(p)) { sawRegion = true; continue; }
          if (countries.has(p)) continue;
          return false;
        }
        return regions.size === 0 || sawRegion;
      }));
    }
    case 'degree':
      return degreePick(wanted, options);
    case 'month': {
      const n = Number(wanted);
      return as(hit((o) => monthOf(o.label) === n || (monthOf(o.label) === null && o.value !== '' && monthOf(o.value) === n)));
    }
    case 'year':
      return as(hit((o) => norm(o.label) === norm(wanted) || (o.value !== '' && norm(o.value) === norm(wanted) && !/\d/.test(o.label))));
    case 'yes':
    case 'no':
    case 'decline':
      return as(hit((o) => yesNoClass(o.label) === kind));
    case 'gender':
      if (norm(wanted) === 'decline') return as(hit((o) => isDeclineOption(o.label)));
      return as(hit((o) => !isDeclineOption(o.label) && inGroup(GENDER_GROUPS, wanted, o.label)));
    case 'race':
      if (norm(wanted) === 'decline') return as(hit((o) => isDeclineOption(o.label)));
      return as(hit((o) => !isDeclineOption(o.label) && inGroup(RACE_GROUPS, wanted, o.label)));
    case 'orientation':
      if (norm(wanted) === 'decline') return as(hit((o) => isDeclineOption(o.label)));
      return as(hit((o) => !isDeclineOption(o.label) && inGroup(ORIENTATION_GROUPS, wanted, o.label)));
    case 'pronouns': {
      if (norm(wanted) === 'decline') return as(hit((o) => isDeclineOption(o.label)));
      const w = norm(wanted).replace(/\s/g, '');
      return as(hit((o) => {
        const l = norm(o.label).replace(/\s/g, '');
        return l === w || l.startsWith(`${w}/`) || w.startsWith(`${l}/`);
      }));
    }
    case 'range': {
      const n = Number(wanted);
      if (!Number.isFinite(n)) return null;
      return as(hit((o) => { const r = rangeOf(o.label); return r !== null && n >= r.min && n <= r.max; }));
    }
  }
}

/** Every option that equals one of the wanted texts (a checkbox group of skills or races). Strict, like pickOption. */
export function pickMany(kind: 'exact' | 'race' | 'orientation', wanted: readonly string[], options: readonly Opt[]): number[] {
  const out = new Set<number>();
  for (const w of wanted) {
    const p = pickOption(kind, w, options);
    if (p) out.add(p.index);
  }
  return [...out];
}
