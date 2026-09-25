// Must-haves a posting states, read from its own words: sponsorship, work authorization, citizenship, security
// clearance, licences and certifications, degrees and years of experience. Each one carries a quote that is an
// exact substring of the posting, and whether it is required, preferred, or something to obtain after hire.
// A statement the posting does not make is never assumed.

import type { AnalyzedText, Sentence, SectionKind } from './text.ts';
import { quoteAround } from './text.ts';
import { SKILLS, scanSkills } from './taxonomy.ts';

export type Importance = 'required' | 'preferred' | 'obtainable';

export interface PostedRequirement {
  kind: 'sponsorship' | 'work_authorization' | 'citizenship' | 'clearance' | 'licence' | 'degree' | 'years';
  importance: Importance;
  /** The requirement in plain words ("Active Secret clearance", "RN licence", "5+ years of experience"). */
  label: string;
  /** Exact words from the posting. */
  quote: string;
  start: number;
  /** kind-specific detail */
  detail: {
    country?: string;
    sponsorship?: 'no' | 'yes';
    citizenship?: 'citizen' | 'citizen_or_pr';
    clearanceLevel?: string;
    credIds?: string[];
    degreeRank?: number;
    degreeLabel?: string;
    orEquivalent?: boolean;
    pursuing?: boolean;
    minYears?: number | null;
    maxYears?: number | null;
    general?: boolean;
    /** Several years statements in one sentence joined by "or" ("a degree and 2 years, or 6 years"). */
    alternative?: boolean;
  };
}

const REQUIRED_CUE = /\b(required|requires?|requirements?|qualifications?|must|mandatory|need(ed|s)?|necessary|essential|minimum|at least|only|active|current(ly)?|valid|unrestricted|licensed|certified|in good standing)\b/i;
const PREFERRED_CUE = /\b(preferred|preferably|prefer|a plus|is a plus|are a plus|plus\b|desired|desirable|nice[- ]to[- ]have|bonus|advantage(ous)?|ideally|ideal|helpful|beneficial|welcome|strongly considered|not required|a big plus|highly valued)\b/i;
const OBTAIN_CUE = /\b(within\s+(\d+|one|two|three|six|twelve|thirty|sixty|ninety)\s*(\(\d+\)\s*)?(days?|weeks?|months?|years?)|ability to (obtain|get|acquire|earn)|able to (obtain|get|acquire|earn)|willing(ness)? to (obtain|get|acquire|earn|pursue)|eligible (for|to (obtain|receive|get))|eligibility (for|to)|must (obtain|acquire|get|earn)|obtain (and|&) maintain|(upon|after|following) (hire|hiring|employment|start)|prior to (start|hire)|or eligible|in progress|working towards?|candidates? (for|in)|sit for|will (be )?(provide|provided|train|trained)|we (will )?(provide|pay for|cover|sponsor)|company[- ]paid|paid training|or be able to)\b/i;
const NEGATED = /\b(no|not|never|without)\b[^.;]{0,25}\b(required|needed|necessary)\b|\bnot (a )?requirement\b/i;

function importanceOf(sentence: string, section: SectionKind): Importance | null {
  if (OBTAIN_CUE.test(sentence)) return 'obtainable';
  const pref = PREFERRED_CUE.test(sentence);
  const req = REQUIRED_CUE.test(sentence);
  if (pref && !(req && /\b(required|must)\b/i.test(sentence) && !/\bnot required\b/i.test(sentence))) return 'preferred';
  if (req) return 'required';
  if (section === 'required') return 'required';
  if (section === 'preferred') return 'preferred';
  return null;
}

/** Importance of one item inside a sentence that may list several ("BLS required; ACLS preferred"). */
function importanceNear(text: string, sentence: Sentence, at: number, section: SectionKind): Importance | null {
  // Clause: the part of the sentence between commas, semicolons or "and/or" boundaries around the item.
  const rel = at - sentence.start;
  const s = sentence.text;
  const left = Math.max(s.lastIndexOf(',', rel - 1), s.lastIndexOf(';', rel - 1), s.lastIndexOf('(', rel - 1));
  let right = s.length;
  for (const ch of [',', ';', ')']) { const k = s.indexOf(ch, rel); if (k >= 0 && k < right) right = k; }
  const clause = s.slice(left + 1, right);
  const own = importanceOf(clause, 'other');
  if (own) return own;
  // "RN, BLS and ACLS required": the cue sits after the list, in a later clause of the same sentence.
  const after = s.slice(rel);
  const lastCue = importanceOf(after, 'other');
  if (lastCue) return lastCue;
  return importanceOf(s, section);
}

function sectionOf(a: AnalyzedText, line: number): SectionKind {
  return a.lines[line]?.section ?? 'other';
}

function liveSentences(a: AnalyzedText): Sentence[] {
  // Questions to the applicant ("Are you authorized to work in the US?") are not statements.
  return a.sentences.filter((s) => !s.ignored && !/\?\s*$/.test(s.text));
}

// ---------------------------------------------------------------- authorization, sponsorship, citizenship

const WORK_CONTEXT = /\b(visas?|h-?1-?b|h1b|immigration|work (authori[sz]ation|permits?|visas?)|employment (authori[sz]ation|visas?|based)|authori[sz]ed to work|legally (authori[sz]ed|eligible|able)|eligible to work|right to work|green card|opt\b|cpt\b|stem opt|tn visa|e-?3|sponsor(ship)? (for|of) (employment|work|a visa|visas)|(now|currently) or in the future|require (visa )?sponsorship|need (visa )?sponsorship|immigration sponsorship|employment sponsorship|work sponsorship)\b/i;
const SPONSOR_WORD = /\b(sponsor(s|ed|ing|ship)?|h-?1-?b|h1b|visas?)\b/i;
const SPONSOR_NO = /^\s*[-•*]?\s*((visa|h-?1-?b|immigration)\s+)?sponsorship( available)?\s*[:?-]\s*(no|none|not available|n\/a|unavailable)\b|\b(no|not|cannot|can ?not|can'?t|unable|won'?t|will not|do not|don'?t|does not|doesn'?t|are not|is not|without|never|n'?t)\b[^.;]{0,60}\b(sponsor\w*|h-?1-?b|h1b|visas?)\b|\b(sponsor\w*|h-?1-?b|h1b|visas?)\b[^.;]{0,40}\b(is not|are not|not (be )?(available|offered|provided|possible)|unavailable|cannot|will not|won'?t)\b/i;
const SPONSOR_YES = /\b((will|can|may|able to|happy to|glad to|do|does|we)\s+(provide\s+|offer\s+)?sponsor\w*|sponsorship (is |will be )?(available|offered|provided|possible)|(visa|h-?1-?b|h1b) sponsorship (is )?(available|offered|provided)|(offer|offers|provide|provides|support|supports) (visa |h-?1-?b |h1b |immigration )?sponsorship|sponsor(s|ing)? (h-?1-?b|h1b|visas?|work visas?))\b/i;

const COUNTRY_WORDS: Array<[RegExp, string, string]> = [
  [/\b(u\.?s\.?a?\.?|united states( of america)?|america|the us)\b/i, 'US', 'the US'],
  [/\bcanada\b/i, 'CA', 'Canada'],
  [/\b(u\.?k\.?|united kingdom|great britain|britain)\b/i, 'GB', 'the UK'],
  [/\b(eu|european union|e\.u\.|eea)\b/i, 'EU', 'the EU'],
  [/\baustralia\b/i, 'AU', 'Australia'],
  [/\bgermany\b/i, 'DE', 'Germany'],
  [/\bireland\b/i, 'IE', 'Ireland'],
  [/\bindia\b/i, 'IN', 'India'],
  [/\bmexico\b/i, 'MX', 'Mexico'],
  [/\bnew zealand\b/i, 'NZ', 'New Zealand'],
  [/\bsingapore\b/i, 'SG', 'Singapore'],
];

function countryIn(text: string): { code: string; name: string } | null {
  for (const [re, code, name] of COUNTRY_WORDS) if (re.test(text)) return { code, name };
  return null;
}

const AUTH_REQ = /\b(must|required|requires?|need|should|only|all|candidates|applicants)\b[^.;]{0,60}\b(legally |currently |fully |permanently )?(authori[sz]ed|eligible|permitted|able|allowed|entitled|right)\b[^.;]{0,15}\bto work\b|\b(proof of|valid) (work|employment) (authori[sz]ation|eligibility)\b|\bwork authori[sz]ation (is )?required\b|\bmust have (the )?right to work\b/i;
const CITIZEN = /\b(u\.?s\.?a?|united states|american)\s+(citizens?(hip)?|nationals?)\b|\bcitizens? of the (u\.?s\.?a?|united states)\b|\bu\.?s\.? persons?\b/i;
const CITIZEN_OR_PR = /\b(permanent residents?|green card( holders?)?|lawful permanent|u\.?s\.? persons?|itar|ear\b|export control)/i;

function citizenshipRequired(s: string): boolean {
  if (!CITIZEN.test(s)) return false;
  if (/\b(not required|is not a requirement|not necessary|regardless of citizenship)\b/i.test(s)) return false;
  return /\b(only|required|requires?|must|mandatory|need|eligib\w*|restricted to|limited to|citizenship)\b/i.test(s);
}

// ---------------------------------------------------------------- clearance

const CLEARANCE_WORD = /\b(security clearance|clearance|ts\/sci|ts-sci|top secret|public trust|polygraph|full[- ]scope poly|ci poly)\b/i;
const CLEARANCE_SECURITY = /\b(security clearance|ts\/sci|ts-sci|top secret|secret clearance|secret level|active secret|public trust|polygraph|poly\b|dod|doe|government clearance|federal clearance|clearance (level|required|is required)|(active|current|existing|interim|final) (\w+ )?clearance|q clearance|l clearance|sci\b|clearance eligibility|obtain (and maintain )?(a |an )?(\w+ )?clearance|clearable)\b/i;
const CLEARANCE_NONE = /\b(no|not|without)\b[^.;]{0,20}\bclearance\b[^.;]{0,20}\b(required|needed|necessary)\b|\bclearance (is )?not required\b|\bno clearance\b/i;

function clearanceLevel(s: string): string {
  if (/ts\/sci|ts-sci|top secret\s*\/\s*sci/i.test(s)) return /poly/i.test(s) ? 'TS/SCI with polygraph' : 'TS/SCI';
  if (/top secret/i.test(s)) return 'Top Secret';
  if (/\bsecret\b/i.test(s)) return 'Secret';
  if (/public trust/i.test(s)) return 'Public Trust';
  if (/\bq clearance\b/i.test(s)) return 'DOE Q';
  if (/\bl clearance\b/i.test(s)) return 'DOE L';
  return 'security';
}

// ---------------------------------------------------------------- degrees

const DEGREE_SENTENCE = /\b(degree|diploma|ged|bachelor'?s?|baccalaureate|master'?s|ph\.? ?d|doctorate|bsn|msn|mba|associate'?s? degree|b\.s\.|b\.a\.|m\.s\.|m\.a\.|bs\/ba|ba\/bs|bs\/ms|b\.?sc|graduate of|high school)\b/i;
const DEGREE_LEVELS: Array<[number, string, RegExp]> = [
  [1, 'high school diploma or GED', /\b(high school( diploma| degree| education| graduate| equivalent)?|ged|hs diploma|secondary school)\b/i],
  [2, "associate's degree", /\b(associate'?s?( degree| of)|\baas\b|a\.a\.s\.?|\badn\b|two[- ]year degree|2[- ]year degree)\b/i],
  [3, "bachelor's degree", /\b(bachelor'?s?|baccalaureate|b\.s\.?|b\.a\.?|\bbs\b|\bba\b|bsn|bba|b\.?sc|four[- ]year degree|4[- ]year degree|undergraduate degree|college degree|university degree)\b/i],
  [4, "master's degree", /\b(master'?s?|m\.s\.?|m\.a\.?|\bms\b|mba|msn|mph|msw|m\.?ed\b|graduate degree|advanced degree)\b/i],
  [5, 'doctorate', /\b(ph\.? ?d|doctorate|doctoral|\bmd\b|m\.d\.|\bjd\b|j\.d\.|juris doctor|pharm\.? ?d|dnp|psy\.? ?d|ed\.? ?d)\b/i],
];
const OR_EQUIVALENT = /\b(or|and\/or)\s+(an?\s+)?(equivalent|comparable|relevant|related|commensurate|combination|practical)\b[^.;]{0,50}\b(experience|combination|education|training|work)\b|\bequivalent (combination|experience|work experience|practical experience)\b|\bin lieu of\b|\bor equivalent\b|\bequivalent\b[^.;]{0,20}\bexperience\b/i;
const PURSUING = /\b(pursuing|currently enrolled|enrolled in|working towards?|candidate for|expected graduation|graduating|rising (junior|senior)|current(ly)? (a )?student|in progress)\b/i;

// ---------------------------------------------------------------- years

const NUM_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20,
};
const NUM = '(\\d{1,2}|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty)';
const PAREN = '(?:\\s*\\(\\d{1,2}\\+?\\))?';
const YRS = '(?:years?|yrs?\\.?)';
const RE_RANGE = new RegExp(`\\b${NUM}${PAREN}\\s*(?:-|–|—|to)\\s*${NUM}${PAREN}\\s*\\+?\\s*${YRS}`, 'i');
const RE_PLUS = new RegExp(`\\b${NUM}${PAREN}\\s*(?:\\+|\\s+or more|\\s+plus|\\s+or greater)\\s*${YRS}|\\b${NUM}\\+${YRS}|\\b${NUM}${PAREN}\\s*${YRS}\\s*\\+`, 'i');
const RE_MIN = new RegExp(`\\b(?:at least|minimum of|a minimum of|min\\.?|minimum|no less than|not less than|more than|over|in excess of)\\s*(?:of\\s*)?${NUM}${PAREN}\\s*\\+?\\s*${YRS}`, 'i');
const RE_PLAIN = new RegExp(`\\b${NUM}${PAREN}\\s*${YRS}`, 'i');
const RE_MONTHS = new RegExp(`\\b${NUM}${PAREN}\\s*\\+?\\s*(?:or more\\s+)?months?`, 'i');
const RE_UPTO = new RegExp(`\\b(?:up to|less than|under|no more than)\\s*${NUM}${PAREN}\\s*${YRS}`, 'i');
const YEARS_CONTEXT = /\b(experience|exp\b|experienced|working (as|in|with|on)|worked|work history|background|in (a|an|the) [\w\s/&-]{0,40}(role|position|setting|environment|capacity|field|industry|function)|as an? [a-z]|professional|track record|tenure|hands-on)\b/i;
const YEARS_NOT = /\b(years? old|of age|age of|years? of age|in business|anniversary|founded|since (19|20)\d\d|warranty|guarantee|years? of (service|operation|history|growth|success|excellence)|serving (our|the)|we'?ve been|for over \d+ years|legacy|years? (ago|later|from now|away)|per year|a year\b|each year|every year|year[- ]round|retention|term of|lease|vesting|vest\w* over|cliff|contract (term|length)|probation|after \d+ years? (of service|with)|tuition|reimbursement)\b/i;
const NO_EXPERIENCE = /\b(no (prior |previous |professional |work |industry )?experience (is )?(necessary|needed|required)|experience (is )?not (necessary|needed|required)|no experience\b|will train|willing to train|we will train|we'?ll train|entry[- ]level,? no experience)\b/i;

function num(s: string): number | null {
  const k = s.toLowerCase();
  if (k in NUM_WORDS) return NUM_WORDS[k];
  const n = Number(k);
  return Number.isFinite(n) ? n : null;
}

interface YearsHit { min: number | null; max: number | null; start: number; end: number }

/** Every years statement in a sentence ("3+ years of Python and 5+ years of software experience" gives two). */
function yearsIn(s: string): YearsHit[] {
  const hits: YearsHit[] = [];
  const take = (re: RegExp, read: (m: RegExpExecArray) => { min: number | null; max: number | null } | null) => {
    const g = new RegExp(re.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = g.exec(s))) {
      const start = m.index, end = m.index + m[0].length;
      if (hits.some((h) => start < h.end && end > h.start)) continue;
      // "1 year of ICU experience within the last 3 years": the second number is a time window, not a requirement.
      if (/\b(within|in|during|over|from)\s+(the\s+)?(last|past|previous|prior)\s*$/i.test(s.slice(Math.max(0, start - 30), start))) continue;
      const v = read(m);
      if (v) hits.push({ ...v, start, end });
    }
  };
  take(RE_RANGE, (m) => { const a = num(m[1]), b = num(m[2]); return a !== null && b !== null && a <= 30 && b <= 40 ? { min: Math.min(a, b), max: Math.max(a, b) } : null; });
  take(RE_MIN, (m) => { const a = num(m[1]); return a !== null && a <= 30 ? { min: a, max: null } : null; });
  take(RE_PLUS, (m) => { const a = num(m[1] ?? m[2] ?? m[3]); return a !== null && a <= 30 ? { min: a, max: null } : null; });
  take(RE_UPTO, (m) => { const a = num(m[1]); return a !== null && a <= 30 ? { min: 0, max: a } : null; });
  take(RE_PLAIN, (m) => { const a = num(m[1]); return a !== null && a <= 30 ? { min: a, max: null } : null; });
  take(RE_MONTHS, (m) => { const a = num(m[1]); return a !== null && a > 0 && a <= 24 ? { min: Math.round((a / 12) * 100) / 100, max: null } : null; });
  return hits.sort((x, y) => x.start - y.start);
}

export function yearsLabel(min: number | null, max: number | null): string {
  if (min === 0 && (max === null || max === 0)) return 'no experience needed';
  if (min !== null && min > 0 && min < 1 && max === null) return `${Math.round(min * 12)}+ months`;
  if (min !== null && max !== null) return min === 0 ? `up to ${max} years` : `${min} to ${max} years`;
  if (min !== null) return `${min}+ years`;
  if (max !== null) return `up to ${max} years`;
  return 'not stated';
}

// ---------------------------------------------------------------- the reader

export function readRequirements(a: AnalyzedText): PostedRequirement[] {
  const out: PostedRequirement[] = [];
  const text = a.text;
  const q = (s: Sentence, at = s.start, end = s.end) => quoteAround(text, at, end, 200);

  for (const s of liveSentences(a)) {
    const section = sectionOf(a, s.line);
    const t = s.text;
    const skipSection = section === 'benefits' && !WORK_CONTEXT.test(t);

    // Sponsorship and work authorization can sit anywhere, including the last paragraph. The visa context may sit
    // earlier on the same line ("Work Authorization: must be eligible to work in the US; we cannot sponsor").
    const lineText = a.lines[s.line]?.text ?? t;
    const sponsorLabel = /^\s*[-•*]?\s*((visa|h-?1-?b|immigration|work visa)\s+)?sponsorship( available)?\s*[:?-]/i.test(t) || /\bno (visa |h-?1-?b |immigration )?sponsorship\b|\bsponsorship (is |will )?not (be )?(available|offered|provided|possible)\b/i.test(t);
    if (SPONSOR_WORD.test(t) && (WORK_CONTEXT.test(t) || WORK_CONTEXT.test(lineText) || sponsorLabel)) {
      if (SPONSOR_NO.test(t)) {
        out.push({ kind: 'sponsorship', importance: 'required', label: 'No visa sponsorship', quote: q(s), start: s.start, detail: { sponsorship: 'no', country: countryIn(t)?.code ?? 'US' } });
      } else if (SPONSOR_YES.test(t) || /^\s*[-•*]?\s*((visa|h-?1-?b)\s+)?sponsorship( available)?\s*[:?-]\s*(yes|available)\b/i.test(t)) {
        out.push({ kind: 'sponsorship', importance: 'preferred', label: 'Visa sponsorship offered', quote: q(s), start: s.start, detail: { sponsorship: 'yes' } });
      }
    }
    if (AUTH_REQ.test(t) && !CITIZEN.test(t)) {
      const c = countryIn(t) ?? { code: 'US', name: 'the US' };
      out.push({ kind: 'work_authorization', importance: 'required', label: `Authorized to work in ${c.name}`, quote: q(s), start: s.start, detail: { country: c.code } });
    }
    if (citizenshipRequired(t)) {
      const pr = CITIZEN_OR_PR.test(t);
      const pref = PREFERRED_CUE.test(t) && !/\b(required|must|only)\b/i.test(t);
      out.push({
        kind: 'citizenship', importance: pref ? 'preferred' : 'required',
        label: pr ? 'US citizen or permanent resident (US person)' : 'US citizenship', quote: q(s), start: s.start,
        detail: { citizenship: pr ? 'citizen_or_pr' : 'citizen' },
      });
    }
    if (CLEARANCE_WORD.test(t) && CLEARANCE_SECURITY.test(t) && !CLEARANCE_NONE.test(t) && !skipSection) {
      const level = clearanceLevel(t);
      const imp = importanceOf(t, section) ?? (/\b(requires?|required)\b/i.test(t) ? 'required' : null);
      if (imp) {
        const label = imp === 'obtainable' ? `Able to obtain a ${level} clearance` : `${/active|current/i.test(t) ? 'Active ' : ''}${level} clearance`;
        out.push({ kind: 'clearance', importance: imp, label: label.replace('security clearance clearance', 'security clearance'), quote: q(s), start: s.start, detail: { clearanceLevel: level } });
      }
    }
    if (skipSection || section === 'about' || section === 'eeo') continue;

    // Degrees.
    if (DEGREE_SENTENCE.test(t) && !/\btuition\b|\breimburse/i.test(t)) {
      // Clauses split at ";" keep "Bachelor's required; Master's preferred" apart.
      let found: { rank: number; label: string } | null = null;
      for (const [rank, label, re] of DEGREE_LEVELS) {
        if (!re.test(t)) continue;
        // "Graduate of an accredited school of nursing" is not a degree level; "high school" only with diploma words.
        if (rank === 1 && !/\b(diploma|ged|equivalent|graduate|education)\b/i.test(t)) continue;
        if (!found || rank < found.rank) found = { rank, label };
      }
      if (found) {
        const imp = importanceOf(t, section);
        if (imp && imp !== 'obtainable') {
          out.push({
            kind: 'degree', importance: imp, label: found.label[0].toUpperCase() + found.label.slice(1), quote: q(s), start: s.start,
            detail: { degreeRank: found.rank, degreeLabel: found.label, orEquivalent: OR_EQUIVALENT.test(t), pursuing: PURSUING.test(t) },
          });
        } else if (imp === 'obtainable' && PURSUING.test(t)) {
          out.push({
            kind: 'degree', importance: 'required', label: `Pursuing a ${found.label}`, quote: q(s), start: s.start,
            detail: { degreeRank: found.rank, degreeLabel: found.label, orEquivalent: false, pursuing: true },
          });
        }
      }
    }

    // Years of experience.
    if (NO_EXPERIENCE.test(t)) {
      const m = NO_EXPERIENCE.exec(t)!;
      out.push({ kind: 'years', importance: 'required', label: 'No experience needed', quote: quoteAround(text, s.start + m.index, s.start + m.index + m[0].length, 200), start: s.start, detail: { minYears: 0, maxYears: 0, general: true } });
    } else if ((YEARS_CONTEXT.test(t) || section === 'required' || section === 'preferred') && !YEARS_NOT.test(t)) {
      const imp = importanceOf(t, section) ?? (section === 'duties' || section === 'intro' || section === 'other' ? 'required' : null);
      if (imp && imp !== 'obtainable') {
        const found = yearsIn(t);
        const alternative = found.length > 1 && found.slice(1).some((y, i) => /\bor\b/i.test(t.slice(found[i].end, y.start)));
        for (const y of found) {
          // "3+ years of Python" or "2+ years with Salesforce" is about one skill; "5+ years of accounting experience"
          // is general.
          const after = t.slice(y.end, y.end + 60).replace(/^\s*(of|in|with|using|working with|programming in|hands-on|professional|direct|practical|relevant|recent|progressive|experience|\s)+/i, '');
          const offset = s.start + y.end + (t.slice(y.end, y.end + 60).length - after.length);
          const next = a.live.filter((k) => k.start >= offset && k.start < offset + 40);
          const first = scanSkills(next)[0];
          const specific = !!first && first.start === next[0]?.start && SKILLS.get(first.id)?.kind !== 'cred';
          out.push({
            kind: 'years', importance: imp, label: yearsLabel(y.min, y.max) + ' of experience',
            quote: quoteAround(text, s.start + y.start, s.start + y.end, 200), start: s.start,
            detail: { minYears: y.min, maxYears: y.max, general: !specific, alternative },
          });
        }
      }
    }
  }

  // Licences and certifications: the dictionary names them; the sentence around them says required or not.
  const credMatches = scanSkills(a.live).filter((m) => SKILLS.get(m.id)?.kind === 'cred');
  const byStart = new Map(a.live.map((t) => [t.start, t]));
  for (const run of credentialRuns(text, credMatches)) {
    const tok = byStart.get(run.start);
    if (!tok) continue;
    const s = a.sentences[tok.sentence];
    if (!s || s.ignored || /\?\s*$/.test(s.text)) continue;
    const section = sectionOf(a, s.line);
    if (section === 'benefits' || section === 'about' || section === 'eeo') continue;
    const groups = run.alternative ? [run.ids] : run.ids.map((id) => [id]);
    let at = run.start;
    for (const ids of groups) {
      const m = credMatches.find((x) => x.id === ids[0] && x.start >= at) ?? credMatches.find((x) => x.id === ids[0])!;
      at = m.end;
      if (NEGATED.test(s.text) && new RegExp(`${escapeRe(text.slice(m.start, m.end))}[^.;]{0,30}\\b(not|no)\\b`, 'i').test(s.text)) continue;
      // "RN, BLS and ACLS required": the cue after the list applies to every item in it.
      const imp = importanceNear(text, s, run.alternative ? run.start : m.start, section) ?? importanceNear(text, s, run.end - 1, section);
      if (!imp) continue;
      const label = ids.map((id) => SKILLS.get(id)!.name).join(' or ');
      const qs = run.alternative ? run.start : m.start;
      const qe = run.alternative ? run.end : m.end;
      out.push({ kind: 'licence', importance: imp, label, quote: quoteAround(text, qs, qe, 200), start: qs, detail: { credIds: ids } });
    }
  }

  // The same credential named twice: keep one (the strongest importance wins).
  const merged: PostedRequirement[] = [];
  for (const r of out) {
    if (r.kind === 'licence') {
      const dup = merged.find((x) => x.kind === 'licence' && x.detail.credIds?.join() === r.detail.credIds?.join());
      if (dup) { if (rankImp(r.importance) < rankImp(dup.importance)) { dup.importance = r.importance; dup.quote = r.quote; } continue; }
    }
    merged.push(r);
  }
  return merged;
}

function rankImp(i: Importance): number {
  return i === 'required' ? 0 : i === 'obtainable' ? 1 : 2;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface CredentialRun { ids: string[]; start: number; end: number; alternative: boolean }

/**
 * Groups licence mentions that form one list: "LCSW, LPC or LMFT" is one requirement met by any of them (alternative);
 * "BLS and ACLS" and "RN, BLS, ACLS" are separate requirements.
 */
export function credentialRuns(text: string, matches: Array<{ id: string; start: number; end: number }>): CredentialRun[] {
  const runs: Array<CredentialRun & { seps: string[] }> = [];
  for (const m of matches) {
    const prev = runs[runs.length - 1];
    const between = prev ? text.slice(prev.end, m.start) : '';
    if (prev && between.length <= 12 && /^[\s,/()]*(or|and\/or|and|&)?[\s,/()]*$/i.test(between) && !/[.;\n]/.test(between)) {
      prev.ids.push(m.id);
      prev.end = m.end;
      prev.seps.push(between);
    } else runs.push({ ids: [m.id], start: m.start, end: m.end, alternative: false, seps: [] });
  }
  return runs.map(({ seps, ...r }) => ({ ...r, alternative: seps.some((x) => /\bor\b|\//i.test(x)) }));
}

/**
 * The years requirement the score uses: required statements first, then preferred ones. Within a sentence that
 * offers alternatives ("a degree and 2 years, or 6 years"), the smaller number; across sentences, the larger.
 */
export function primaryYears(reqs: PostedRequirement[]): PostedRequirement | null {
  const years = reqs.filter((r) => r.kind === 'years');
  for (const imp of ['required', 'preferred'] as const) {
    const pool = years.filter((r) => r.importance === imp);
    if (!pool.length) continue;
    const general = pool.filter((r) => r.detail.general);
    const use = general.length ? general : pool;
    const bySentence = new Map<number, PostedRequirement[]>();
    for (const r of use) { const k = r.start; bySentence.set(k, [...(bySentence.get(k) ?? []), r]); }
    let best: PostedRequirement | null = null;
    for (const group of bySentence.values()) {
      // "a degree and 2 years, or 6 years" offers alternatives (the smaller one is enough);
      // "7+ years including 3+ years in leadership" does not (the larger one is the requirement).
      const alternatives = group.length > 1 && group.some((g) => g.detail.alternative);
      const pick = group.reduce((x, y) => (alternatives
        ? ((y.detail.minYears ?? 0) < (x.detail.minYears ?? 0) ? y : x)
        : ((y.detail.minYears ?? 0) > (x.detail.minYears ?? 0) ? y : x)));
      if (!best || (pick.detail.minYears ?? 0) > (best.detail.minYears ?? 0)) best = pick;
    }
    return best;
  }
  return null;
}
