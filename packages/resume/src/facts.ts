// Finds facts in text: skills and tools, certifications, degrees, numbers, dates, durations, job titles,
// organisations, contact details, places and other proper names. The truth gate compares what it finds in a draft
// with what it finds in the profile. Pure and deterministic.

import {
  CERT_PATTERNS, CERTS, DEGREE_LEVELS, MONTHS, ORDINARY_CAPITALISED, ORG_WORDS, ROLE_NOUNS, SENIORITY_WORDS, SKILLS,
  type LexEntry,
} from './lexicon.ts';
import { escapeRegExp, foldKey, orgKey } from './text.ts';

export type FactKind =
  | 'skill' | 'certification' | 'degree' | 'number' | 'date' | 'duration' | 'title' | 'employer' | 'school' | 'location'
  | 'contact' | 'other';

export interface Mention {
  kind: FactKind;
  /** As written. */
  text: string;
  /** Comparison key (canonical skill, normalised number, folded phrase...). */
  key: string;
  start: number;
  end: number;
  value?: number;
  unit?: 'money' | 'percent' | 'mult' | 'plain' | 'vague';
  year?: number;
  month?: number | null;
  years?: number;
  level?: string;
  field?: string | null;
  /** For titles: the seniority word in the phrase, if any. */
  seniority?: string | null;
  /** For organisations: found by a name ending ("Labs", "University") or after "at/for/with". */
  via?: 'suffix' | 'at';
}

// ------------------------------------------------------------------------------------------------ term matching

interface TermIndex {
  ci: RegExp | null;
  cs: RegExp | null;
  byLower: Map<string, LexEntry>;
  byExact: Map<string, LexEntry>;
}

const PRE = '(?<![A-Za-z0-9_+#@/.])';
const POST = '(?![A-Za-z0-9_]|[+#]|\\.[A-Za-z0-9]|-(?:to|based|level|suite)\\b)';

function buildIndex(entries: readonly LexEntry[]): TermIndex {
  const ciForms: string[] = [];
  const csForms: string[] = [];
  const byLower = new Map<string, LexEntry>();
  const byExact = new Map<string, LexEntry>();
  for (const e of entries) {
    for (const f of e.forms) {
      if (e.caseSensitive.has(f)) {
        csForms.push(f);
        byExact.set(f.replace(/\s+/g, ' '), e);
      } else {
        ciForms.push(f);
        byLower.set(f.toLowerCase().replace(/\s+/g, ' '), e);
      }
    }
  }
  const alt = (forms: string[]) => forms
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map((f) => escapeRegExp(f).replace(/\\ | /g, '\\s+'))
    .join('|');
  return {
    ci: ciForms.length ? new RegExp(`${PRE}(?:${alt(ciForms)})${POST}`, 'gi') : null,
    cs: csForms.length ? new RegExp(`${PRE}(?:${alt(csForms)})${POST}`, 'g') : null,
    byLower,
    byExact,
  };
}

const SKILL_INDEX = buildIndex(SKILLS);
const CERT_INDEX = buildIndex(CERTS);

function findTerms(text: string, idx: TermIndex, kind: 'skill' | 'certification'): Mention[] {
  const out: Mention[] = [];
  const take = (re: RegExp | null, lookup: (s: string) => LexEntry | undefined) => {
    if (!re) return;
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const surface = m[0].replace(/\s+/g, ' ');
      const e = lookup(surface);
      if (!e) continue;
      out.push({ kind, text: m[0], key: e.canonical.toLowerCase(), start: m.index!, end: m.index! + m[0].length });
    }
  };
  take(idx.ci, (s) => idx.byLower.get(s.toLowerCase()));
  take(idx.cs, (s) => idx.byExact.get(s));
  return dropOverlaps(out);
}

/** Keeps the longest mention where two overlap (so "C++" wins over "C", "React Native" over "React"). */
export function dropOverlaps(ms: Mention[]): Mention[] {
  const sorted = [...ms].sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out: Mention[] = [];
  let lastEnd = -1;
  for (const m of sorted) {
    if (m.start >= lastEnd) {
      out.push(m);
      lastEnd = m.end;
    } else if (out.length && m.end - m.start > out[out.length - 1]!.end - out[out.length - 1]!.start && m.start === out[out.length - 1]!.start) {
      out[out.length - 1] = m;
      lastEnd = m.end;
    }
  }
  return out;
}

/** The canonical skill name for a term ("k8s" -> "Kubernetes"), or null. */
export function canonicalSkill(term: string): string | null {
  const t = term.trim().replace(/\s+/g, ' ');
  const e = SKILL_INDEX.byExact.get(t) ?? SKILL_INDEX.byLower.get(t.toLowerCase()) ?? CERT_INDEX.byExact.get(t) ?? CERT_INDEX.byLower.get(t.toLowerCase());
  return e ? e.canonical : null;
}

/** Every surface form of a canonical skill or certification. */
export function skillForms(canonical: string): string[] {
  const lower = canonical.toLowerCase();
  for (const e of [...SKILLS, ...CERTS]) if (e.canonical.toLowerCase() === lower) return [...e.forms];
  return [canonical];
}

export function isCaseSensitiveForm(canonical: string, form: string): boolean {
  const lower = canonical.toLowerCase();
  for (const e of [...SKILLS, ...CERTS]) if (e.canonical.toLowerCase() === lower) return e.caseSensitive.has(form);
  return false;
}

export function findSkills(text: string): Mention[] {
  return findTerms(text, SKILL_INDEX, 'skill');
}

export function findCertifications(text: string): Mention[] {
  const out = findTerms(text, CERT_INDEX, 'certification');
  // Any claim of being certified or licensed, even without a known certificate name.
  for (const m of text.matchAll(/\b(?:[Cc]ertified|[Cc]ertifications?|[Cc]ertificate|[Ll]icensed|[Ll]icensure|[Aa]ccredited)\b(?:\s+(?:in|as|for)\s+[A-Z][\w+#.-]*(?:\s+[A-Z][\w+#.-]*){0,3})?/g)) {
    out.push({ kind: 'certification', text: m[0], key: foldKey(m[0]), start: m.index!, end: m.index! + m[0].length });
  }
  for (const re of CERT_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const t = m[0].trim();
      out.push({ kind: 'certification', text: t, key: foldKey(t), start: m.index!, end: m.index! + t.length });
    }
  }
  return dropOverlaps(out);
}

// ------------------------------------------------------------------------------------------------ degrees

const HONOURS_RE = /\b(?:summa cum laude|magna cum laude|cum laude|with (?:high(?:est)? )?honou?rs|dean'?s list|valedictorian|salutatorian|phi beta kappa)\b/gi;

export function findDegrees(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(HONOURS_RE)) out.push({ kind: 'degree', text: m[0], key: `honours:${foldKey(m[0])}`, level: `honours:${foldKey(m[0])}`, field: null, start: m.index!, end: m.index! + m[0].length });
  for (const d of DEGREE_LEVELS) {
    for (const re of d.patterns) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const start = m.index!;
        const end = start + m[0].length;
        // The field: "in Computer Science", "of Science in X", ", Computer Science".
        const rest = text.slice(end, end + 80);
        const fm = /^(?:\s+of\s+[A-Z][a-z]+)?(?:\s+in|\s*,)\s+((?:[A-Z][\p{L}&]*|and|of)(?:\s+(?:[A-Z][\p{L}&]*|and|of)){0,5})/u.exec(rest);
        let field: string | null = null;
        if (fm) {
          field = fm[1]!.replace(/\s+(?:and|of)$/, '').trim();
          if (/^(?:University|College|Institute|School)\b/.test(field)) field = null;
        }
        const ofm = /^bachelor of |^master of |^associate of |^doctor of /i.exec(m[0]);
        if (ofm && !field) field = m[0].slice(ofm[0].length);
        out.push({ kind: 'degree', text: m[0], key: d.level, level: d.level, field, start, end });
      }
    }
  }
  return dropOverlaps(out);
}

// ------------------------------------------------------------------------------------------------ contact details

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'|,;)]+|\b(?:[a-z0-9-]+\.)+(?:com|io|dev|org|net|me|ai|co|app|edu|gov|us|uk|ca|tech|xyz|site|page|link)(?:\/[^\s<>"'|,;)]*)?(?![A-Za-z0-9@])/gi;
const PHONE_RE = /(?<![\w.])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])?\d{3}[\s.-]\d{3,4}(?:[\s.-]\d{2,4})?(?![\w])/g;

export function normUrl(u: string): string {
  return u.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[/.]+$/, '').toLowerCase();
}

export function phoneDigits(p: string): string {
  return p.replace(/\D/g, '');
}

export function findContacts(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(EMAIL_RE)) out.push({ kind: 'contact', text: m[0], key: 'email:' + m[0].toLowerCase(), start: m.index!, end: m.index! + m[0].length });
  for (const m of text.matchAll(URL_RE)) {
    const t = m[0].replace(/[.]+$/, '');
    if (out.some((o) => m.index! >= o.start && m.index! < o.end)) continue; // inside an email
    out.push({ kind: 'contact', text: t, key: 'url:' + normUrl(t), start: m.index!, end: m.index! + t.length });
  }
  for (const m of text.matchAll(PHONE_RE)) {
    const digits = phoneDigits(m[0]);
    if (digits.length < 7 || digits.length > 15) continue;
    if (/^(?:19|20)\d\d\s*[-–—]\s*(?:19|20)\d\d$/.test(m[0].trim())) continue; // a year range
    if (/^\d{4}[.-]\d{2}([.-]\d{2})?$/.test(m[0].trim())) continue; // a date
    if (out.some((o) => m.index! >= o.start && m.index! < o.end)) continue;
    out.push({ kind: 'contact', text: m[0].trim(), key: 'phone:' + digits.slice(-10), start: m.index!, end: m.index! + m[0].length });
  }
  return dropOverlaps(out);
}

// ------------------------------------------------------------------------------------------------ dates and durations

const MONTH_NAMES = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
const MONTH_YEAR_RE = new RegExp(`\\b(${MONTH_NAMES})\\.?,?\\s+(?:'(\\d{2})|(\\d{4}))\\b`, 'gi');
const NUM_MONTH_YEAR_RE = /\b(0?[1-9]|1[0-2])[/.](\d{4})\b|\b(\d{4})[-/.](0[1-9]|1[0-2])\b/g;
const YEAR_RE = /(?<![\d$€£.,])\b(19[5-9]\d|20\d\d)\b(?![\d%]|\.\d|,\d{3})/g;
const SEASON_RE = /\b(?:Spring|Summer|Fall|Autumn|Winter)\s+(19[5-9]\d|20\d\d)\b/g;

export function monthOf(name: string): number | null {
  return MONTHS[name.toLowerCase().replace(/\.$/, '')] ?? null;
}

export function findDates(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(MONTH_YEAR_RE)) {
    const month = monthOf(m[1]!);
    const year = m[2] ? 2000 + Number(m[2]) : Number(m[3]);
    if (!month || year < 1950 || year > 2100) continue;
    out.push({ kind: 'date', text: m[0], key: `${year}-${String(month).padStart(2, '0')}`, year, month, start: m.index!, end: m.index! + m[0].length });
  }
  for (const m of text.matchAll(NUM_MONTH_YEAR_RE)) {
    const month = Number(m[1] ?? m[4]);
    const year = Number(m[2] ?? m[3]);
    if (year < 1950 || year > 2100) continue;
    out.push({ kind: 'date', text: m[0], key: `${year}-${String(month).padStart(2, '0')}`, year, month, start: m.index!, end: m.index! + m[0].length });
  }
  for (const m of text.matchAll(SEASON_RE)) {
    const year = Number(m[1]);
    out.push({ kind: 'date', text: m[0], key: String(year), year, month: null, start: m.index!, end: m.index! + m[0].length });
  }
  const taken = dropOverlaps(out);
  for (const m of text.matchAll(YEAR_RE)) {
    if (taken.some((t) => m.index! >= t.start && m.index! < t.end)) continue;
    const year = Number(m[1]);
    taken.push({ kind: 'date', text: m[0], key: String(year), year, month: null, start: m.index!, end: m.index! + m[0].length });
  }
  return dropOverlaps(taken);
}

const WORD_NUMBERS: Readonly<Record<string, number>> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, dozen: 12, several: 3, 'a few': 2, few: 2,
};
const DURATION_RE = /\b(?:(over|more than|nearly|almost|about|around|approximately|at least|close to|roughly)\s+)?(\d+(?:\.\d+)?|a few|an|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|several|few)\s*(\+|plus)?\s*(?:-\s*)?(years?|yrs?\.?|months?|mos?\.?|decades?)\b(?:\s*(\+))?/gi;

export function findDurations(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(DURATION_RE)) {
    const qty = m[2]!.toLowerCase();
    const n = /^\d/.test(qty) ? Number(qty) : WORD_NUMBERS[qty];
    if (n === undefined || !Number.isFinite(n)) continue;
    const unit = m[4]!.toLowerCase();
    // "a year" or "one month" inside ordinary prose ("once a year") is not a claim; keep numbers and "N years".
    if ((qty === 'a' || qty === 'an') && !/decade/.test(unit) && !m[1]) continue;
    const years = unit.startsWith('decade') ? n * 10 : unit.startsWith('y') ? n : n / 12;
    const plus = !!(m[3] || m[5] || (m[1] && /over|more than|at least/i.test(m[1])));
    out.push({ kind: 'duration', text: m[0].trim(), key: `${years}${plus ? '+' : ''}`, years, value: n, start: m.index!, end: m.index! + m[0].trimEnd().length, unit: 'plain' });
  }
  const decade = /\ba decade\b/gi;
  for (const m of text.matchAll(decade)) out.push({ kind: 'duration', text: m[0], key: '10', years: 10, start: m.index!, end: m.index! + m[0].length });
  return dropOverlaps(out);
}

// ------------------------------------------------------------------------------------------------ numbers

const SCALE: Readonly<Record<string, number>> = {
  k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, trillion: 1e12,
};
const NUMBER_RE = /(?<![\w.])([$€£¥])?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s?(k|K|mm|MM|m|M|bn|b|B|thousand|million|billion|trillion)\b)?(\+)?(?:\s?(%|percent\b|x\b|X\b|times\b))?/g;
const SPELLED_RE = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|a dozen|dozens|hundreds|thousands|millions|billions)\b(?:\s+(percent)\b)?/gi;
const MULT_WORDS: Readonly<Record<string, number>> = { doubled: 2, doubling: 2, tripled: 3, tripling: 3, quadrupled: 4, halved: 0.5, halving: 0.5 };

function numKey(unit: Mention['unit'], v: number): string {
  return `${unit}:${Number(v.toPrecision(12))}`;
}

/** Numbers (percent, money, counts, multipliers). Call on text whose dates, durations and terms are masked. */
export function findNumbers(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const raw = m[0];
    if (!/\d/.test(raw)) continue;
    const cur = m[1];
    let v = Number(m[2]!.replace(/,/g, '') + (m[3] ? '.' + m[3] : ''));
    const scaleWord = m[4]?.toLowerCase();
    if (scaleWord) v *= SCALE[scaleWord] ?? 1;
    const suffix = m[6]?.toLowerCase();
    let unit: Mention['unit'] = 'plain';
    if (cur) unit = 'money';
    else if (suffix === '%' || suffix === 'percent') unit = 'percent';
    else if (suffix === 'x' || suffix === 'times') unit = 'mult';
    // Ordinals "1st", "2nd" come through as plain numbers; version-like "v2" never reaches here (word boundary).
    const text2 = raw.trimEnd();
    out.push({ kind: 'number', text: text2, key: numKey(unit, v), value: v, unit, start: m.index!, end: m.index! + text2.length });
  }
  for (const m of text.matchAll(SPELLED_RE)) {
    const w = m[1]!.toLowerCase();
    if (['dozens', 'hundreds', 'thousands', 'millions', 'billions'].includes(w)) {
      out.push({ kind: 'number', text: m[0], key: `vague:${w}`, unit: 'vague', start: m.index!, end: m.index! + m[0].length });
      continue;
    }
    const v = w === 'a dozen' ? 12 : WORD_NUMBERS[w]!;
    const unit = m[2] ? 'percent' : 'plain';
    out.push({ kind: 'number', text: m[0], key: numKey(unit, v), value: v, unit, start: m.index!, end: m.index! + m[0].length });
  }
  for (const m of text.matchAll(/\b(?:cut|reduced|dropped|lowered|decreased|slashed|trimmed)?\s*(?:by\s+)?(?:nearly\s+|almost\s+|about\s+)?in half\b/gi)) {
    out.push({ kind: 'number', text: m[0].trim(), key: numKey('mult', 0.5), value: 0.5, unit: 'mult', start: m.index!, end: m.index! + m[0].length });
  }
  for (const m of text.matchAll(/\b(doubled|doubling|tripled|tripling|quadrupled|halved|halving)\b/gi)) {
    const v = MULT_WORDS[m[1]!.toLowerCase()]!;
    out.push({ kind: 'number', text: m[0], key: numKey('mult', v), value: v, unit: 'mult', start: m.index!, end: m.index! + m[0].length });
  }
  return dropOverlaps(out);
}

// ------------------------------------------------------------------------------------------------ titles, orgs, places

const ROLE_ALT = ROLE_NOUNS.map(escapeRegExp).join('|');
const SENIOR_ALT = SENIORITY_WORDS.map((w) => escapeRegExp(w).replace(/\\\.$/, '\\.?')).join('|');
/** "Senior Software Engineer", "senior engineer", "Lead Data Scientist", "VP of Engineering". */
const SENIOR_TITLE_RE = new RegExp(`\\b(${SENIOR_ALT})\\s+(?:[A-Za-z+#./&-]+\\s+){0,3}?(?:${ROLE_ALT})s?\\b|\\b(?:VP|Vice President|Head|Director) of [A-Z][a-z]+(?: [A-Z][a-z]+)?`, 'gi');
/** Capitalised role phrases: "Backend Engineer", "Registered Nurse", "Data Scientist". */
const CAP_TITLE_RE = new RegExp(`\\b((?:[A-Z][A-Za-z+#./&-]*|of)\\s+){0,3}(?:${ROLE_NOUNS.map((w) => escapeRegExp(w[0]!.toUpperCase() + w.slice(1))).join('|')}|Intern|Nurse|VP|CEO|CTO|CFO|COO|CIO|CMO|SRE)s?\\b(?:\\s+(?:I{1,3}|IV|V|[1-5]))?`, 'g');
/** "as a lead", "as team lead", "as the manager". */
const AS_ROLE_RE = new RegExp(`\\bas\\s+(?:a|an|the)?\\s*((?:team|tech|technical|project|engineering|product|program)?\\s*(?:${ROLE_ALT}))\\b`, 'gi');

function seniorityIn(phrase: string): string | null {
  const m = new RegExp(`\\b(${SENIOR_ALT})\\b`, 'i').exec(phrase);
  return m ? m[1]!.toLowerCase().replace(/\.$/, '') : null;
}

export function findTitles(text: string): Mention[] {
  const out: Mention[] = [];
  const push = (t: string, start: number) => {
    const clean = t.replace(/^(?:of|and)\s+/i, '').trim();
    if (!clean) return;
    // Salutations name no one's title ("Dear Hiring Manager").
    if (/^(?:dear\s+)?(?:hiring|recruiting)\s+(?:manager|team|lead)s?$/i.test(clean)) return;
    const offset = t.indexOf(clean);
    out.push({ kind: 'title', text: clean, key: foldKey(clean), start: start + offset, end: start + offset + clean.length, seniority: seniorityIn(clean) });
  };
  for (const m of text.matchAll(SENIOR_TITLE_RE)) push(m[0], m.index!);
  for (const m of text.matchAll(CAP_TITLE_RE)) {
    // Leading function words are not part of a title ("As Junior Developer" -> "Junior Developer").
    let t = m[0];
    let start = m.index!;
    const lead = /^(?:(?:As|At|In|For|With|The|A|An|My|Our|Your|And|Or|Of|To|From|By|On|Dear)\s+)+/.exec(t);
    if (lead) { t = t.slice(lead[0].length); start += lead[0].length; }
    if (!t.trim()) continue;
    if (!/\s/.test(t.trim()) && !/^(?:Intern|Nurse|CEO|CTO|CFO|COO|CIO|CMO|VP|SRE)s?$/.test(t.trim())) continue;
    push(t, start);
  }
  for (const m of text.matchAll(AS_ROLE_RE)) push(m[1]!, m.index! + m[0].indexOf(m[1]!));
  // "senior-level", "staff level": a level claim even without a role noun.
  for (const m of text.matchAll(/\b(senior|lead|principal|staff|executive|director|mid)[- ]level\b/gi)) push(m[0], m.index!);
  // "tech lead", "team lead", "engineering manager" without "as".
  for (const m of text.matchAll(/\b(?:tech|technical|team|engineering|project|product|program|squad|pod)\s+(?:lead|leader|manager|owner)\b/gi)) push(m[0], m.index!);
  return dropOverlaps(out);
}

const ORG_ALT = ORG_WORDS.map((w) => escapeRegExp(w[0]!.toUpperCase() + w.slice(1))).join('|');
const ORG_SUFFIX_RE = new RegExp(`\\b((?:[A-Z][\\p{L}0-9&'’.-]*\\s+){0,4}(?:${ORG_ALT}|Inc\\.?|LLC|Ltd\\.?|Corp\\.?|Co\\.|PLC|LLP|GmbH|AG|SA))(?![\\p{L}])`, 'gu');
const SCHOOL_RE = /\b(?:University|College|Institute|School|Academy) of (?:[A-Z][\p{L}&.'-]*)(?:\s+(?:[A-Z][\p{L}&.'-]*|at|and|of))*|\b(?:[A-Z][\p{L}&.'-]*\s+){1,4}(?:University|College|Institute|Polytechnic|Academy)\b/gu;
const AT_ORG_RE = /\b(?:at|with|for|joined|from|by)\s+((?:[A-Z][\p{L}0-9&'’.-]*|of|and|&)(?:\s+(?:[A-Z][\p{L}0-9&'’.-]*|of|&)){0,4})/gu;

export function findOrgs(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(SCHOOL_RE)) {
    const t = m[0].replace(/\s+(?:at|and|of)$/, '').trim();
    out.push({ kind: 'school', text: t, key: orgKey(t), start: m.index!, end: m.index! + t.length, via: 'suffix' });
  }
  for (const m of text.matchAll(ORG_SUFFIX_RE)) {
    const t = m[1]!.trim();
    if (!/\s/.test(t) && /^(?:Health|Group|Software|Services|Media|Global|International|Analytics|Solutions|Systems|Technology|Technologies|Capital|Lab|Labs|Center|Centre|Department|School|College|Company|Consulting|Insurance)$/.test(t)) continue;
    if (!orgKey(t)) continue; // a bare legal ending ("Inc.") after a name that is matched on its own
    out.push({ kind: 'employer', text: t, key: orgKey(t), start: m.index!, end: m.index! + t.length, via: 'suffix' });
  }
  for (const m of text.matchAll(AT_ORG_RE)) {
    const name = m[1]!.replace(/[.,;:]+$/, '').replace(/\s+(?:of|and|&)$/, '').trim();
    if (!name || ORDINARY_CAPITALISED.has(name.toLowerCase())) continue;
    const start = m.index! + m[0].indexOf(name);
    const kind = /\b(?:University|College|Institute|School|Academy|Polytechnic)\b/.test(name) ? 'school' : 'employer';
    out.push({ kind, text: name, key: orgKey(name), start, end: start + name.length, via: 'at' });
  }
  return dropOverlaps(out);
}

const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA',
  'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN',
  'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC', 'PR',
]);
const CITY_STATE_RE = /\b([A-Z][\p{L}.'-]+(?: [A-Z][\p{L}.'-]+){0,2}),[ \t]*([A-Z]{2})\b/gu;

export function isUsState(code: string): boolean {
  return US_STATES.has(code);
}

export function findLocations(text: string, extraCities: readonly string[] = []): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(CITY_STATE_RE)) {
    if (!US_STATES.has(m[2]!)) continue;
    out.push({ kind: 'location', text: m[0], key: foldKey(m[1]!), start: m.index!, end: m.index! + m[0].length });
  }
  for (const c of extraCities) {
    if (!c || c.length < 3) continue;
    const re = new RegExp(`(?<![\\p{L}])${escapeRegExp(c)}(?![\\p{L}])`, 'gu');
    for (const m of text.matchAll(re)) out.push({ kind: 'location', text: m[0], key: foldKey(c), start: m.index!, end: m.index! + m[0].length });
  }
  return dropOverlaps(out);
}

// ------------------------------------------------------------------------------------------------ other proper names

/**
 * Capitalised or specially shaped words in the middle of a sentence (names of things). Words at the start of a
 * sentence are included only when their shape marks them as names (CamelCase, capitals, digits inside).
 */
export function findProperWords(text: string): Mention[] {
  const out: Mention[] = [];
  const re = /[\p{L}\p{N}][\p{L}\p{N}'’+#&.-]*[\p{L}\p{N}+#]|[\p{L}]/gu;
  let prevEnd = 0;
  for (const m of text.matchAll(re)) {
    const w = m[0];
    const start = m.index!;
    const between = text.slice(prevEnd, start);
    prevEnd = start + w.length;
    const sentenceStart = start === 0 || /(?:^|[.!?:;•\n(\[“"]|\s[-–—]\s)\s*$/.test(text.slice(0, start)) || /[\n•]/.test(between);
    const hasUpper = /\p{Lu}/u.test(w);
    if (!hasUpper) continue;
    const shaped = /\p{Ll}\p{Lu}/u.test(w) || /^\p{Lu}{2,}s?$/u.test(w) || (/\d/.test(w) && /\p{L}/u.test(w));
    if (sentenceStart && !shaped) continue;
    if (!/^\p{Lu}/u.test(w) && !shaped) continue;
    const bare = w.replace(/['’]s$/, '').replace(/\.$/, '');
    if (ORDINARY_CAPITALISED.has(bare.toLowerCase())) continue;
    if (/^[IVX]+$/.test(bare) && bare.length <= 3) continue; // roman numerals in titles ("Engineer II")
    out.push({ kind: 'other', text: bare, key: foldKey(bare), start, end: start + bare.length });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ all at once

export interface FactScan {
  contacts: Mention[];
  certifications: Mention[];
  skills: Mention[];
  degrees: Mention[];
  dates: Mention[];
  durations: Mention[];
  numbers: Mention[];
  titles: Mention[];
  orgs: Mention[];
  locations: Mention[];
  proper: Mention[];
}

function mask(text: string, ms: Mention[]): string {
  if (!ms.length) return text;
  // Mentions carry UTF-16 indexes; each one is replaced by the same number of spaces, so later indexes still line up.
  let out = '';
  let i = 0;
  const sorted = [...ms].sort((a, b) => a.start - b.start);
  for (const m of sorted) {
    if (m.start < i) continue;
    out += text.slice(i, m.start) + ' '.repeat(m.end - m.start);
    i = m.end;
  }
  out += text.slice(i);
  return out;
}

/** Finds every fact in a text. Each character belongs to at most one fact. */
export function scanFacts(text: string, opts: { extraCities?: readonly string[] } = {}): FactScan {
  const contacts = findContacts(text);
  let t = mask(text, contacts);
  const certifications = findCertifications(t);
  t = mask(t, certifications);
  const skills = findSkills(t);
  t = mask(t, skills);
  const degrees = findDegrees(t);
  t = mask(t, degrees);
  const locations = findLocations(t, opts.extraCities ?? []);
  t = mask(t, locations);
  const dates = findDates(t);
  t = mask(t, dates);
  const durations = findDurations(t);
  t = mask(t, durations);
  const numbers = findNumbers(t);
  t = mask(t, numbers);
  const titles = findTitles(t);
  const orgs = findOrgs(t);
  const t2 = mask(t, [...titles, ...orgs]);
  const proper = findProperWords(t2);
  return { contacts, certifications, skills, degrees, dates, durations, numbers, titles, orgs, locations, proper };
}
