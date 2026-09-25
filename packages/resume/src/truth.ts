// The truth gate (plan T1, resume O3/O4/O5/O8/O14). Every fact in a draft must trace to the profile:
//   skills and tools (a known short form is fine), certifications, degrees, numbers, dates, durations (only up to
//   what the profile dates show), job titles, employers and schools, places, contact details, and other names.
// The job posting is never a source of facts: its company, title, places and skills are allowed in a cover letter
// only where the letter talks about the job itself, never as the person's history.

import type { Job, Profile, ResumeDocument, ResumeItem, TruthViolation } from '@jobleft/contracts';
import { nowMs } from '@jobleft/contracts';
import {
  canonicalSkill, findContacts, findDates, findDurations, findNumbers, findOrgs, findSkills, findTitles, normUrl, phoneDigits,
  scanFacts, type FactScan, type Mention,
} from './facts.ts';
import { ROLE_NOUNS } from './lexicon.ts';
import { foldKey, orgKey, splitSentences, squash } from './text.ts';

// ------------------------------------------------------------------------------------------------ profile facts

export interface ProfileFacts {
  /** Folded profile text, one piece per line, for literal checks. */
  corpus: string;
  words: Set<string>;
  skillKeys: Set<string>;
  certKeys: Set<string>;
  numberKeys: Map<string, number>;
  numberValues: Set<number>;
  years: Set<number>;
  yearMonths: Set<string>;
  /** The longest duration the profile shows, in years (work dates, stated skill years, stated durations). */
  maxYears: number;
  degreeLevels: Map<string, string[]>;
  titles: string[];
  titleSeniority: Set<string>;
  orgKeys: Set<string>;
  emails: Set<string>;
  phones: Set<string>;
  urls: Set<string>;
  locationKeys: Set<string>;
  headerName: string;
}

/** Every text field of the profile that holds the person's facts (never preferences, EEO or work authorization). */
export function profileTexts(p: Profile): string[] {
  const t: string[] = [];
  const push = (s: string | null | undefined) => { if (s && s.trim()) t.push(s); };
  push(p.summary);
  for (const w of p.work) {
    push(w.company); push(w.title); push(w.location); push(w.summary);
    for (const b of w.bullets) push(b);
  }
  for (const e of p.education) {
    push(e.school); push(e.degree); push(e.major); push(e.gpa ? `GPA ${e.gpa}` : null);
    for (const a of e.achievements) push(a);
    for (const c of e.coursework) push(c);
  }
  for (const pr of p.projects) {
    push(pr.name); push(pr.description); push(pr.url);
    for (const b of pr.bullets) push(b);
  }
  for (const c of p.certifications) { push(c.name); push(c.issuer); }
  for (const s of p.skills) push(s.name);
  for (const x of p.extraSections ?? []) { push(x.title); for (const l of x.lines) push(l); }
  push(p.personal.city); push(p.personal.region);
  return t;
}

function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by! - ay!) * 12 + ((bm ?? 1) - (am ?? 1));
}

function ymNow(): string {
  const d = new Date(nowMs());
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Years of work the profile dates show (overlaps counted once), rounded down to whole months. */
export function workYears(p: Profile): number {
  const spans: Array<[number, number]> = [];
  const idx = (ym: string) => { const [y, m] = ym.split('-').map(Number); return y! * 12 + ((m ?? 1) - 1); };
  for (const w of p.work) {
    if (!w.startDate) continue;
    const end = w.current || !w.endDate ? (w.current ? ymNow() : null) : w.endDate;
    if (!end) continue;
    // A year-only end counts to the start of that year (never more than the dates prove).
    spans.push([idx(w.startDate.length === 4 ? `${w.startDate}-12` : w.startDate), idx(end)]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const s of spans) {
    if (!cur || s[0] > cur[1]) { if (cur) total += Math.max(0, cur[1] - cur[0]); cur = [s[0], s[1]]; } else cur[1] = Math.max(cur[1], s[1]);
  }
  if (cur) total += Math.max(0, cur[1] - cur[0]);
  return total / 12;
}

export function headerName(p: Profile): string {
  return [p.personal.firstName, p.personal.middleName, p.personal.lastName].filter((x) => x && x.trim()).join(' ');
}

export function buildProfileFacts(p: Profile): ProfileFacts {
  const texts = profileTexts(p);
  const corpus = texts.map(foldKey).join(' | ');
  const words = new Set<string>();
  for (const t of texts) for (const w of foldKey(t).split(/[\s/]+/)) if (w) { words.add(w); words.add(w.replace(/s$/, '')); }
  for (const w of foldKey(headerName(p)).split(' ')) if (w) words.add(w);

  const skillKeys = new Set<string>();
  const certKeys = new Set<string>();
  const numberKeys = new Map<string, number>();
  const numberValues = new Set<number>();
  const years = new Set<number>();
  const yearMonths = new Set<string>();
  const degreeLevels = new Map<string, string[]>();
  const locationKeys = new Set<string>();
  let maxYears = workYears(p);

  for (const s of p.skills) {
    const c = canonicalSkill(s.name);
    skillKeys.add((c ?? s.name).toLowerCase());
    skillKeys.add(foldKey(s.name));
    if (s.years !== null) maxYears = Math.max(maxYears, s.years);
  }
  for (const c of p.certifications) certKeys.add(foldKey(c.name));
  if (p.workAuthorization.hasSecurityClearance === 'yes') certKeys.add('security clearance');

  const addScan = (scan: FactScan) => {
    for (const m of scan.skills) skillKeys.add(m.key);
    for (const m of scan.certifications) { certKeys.add(m.key); certKeys.add(foldKey(m.text)); }
    for (const m of scan.numbers) { numberKeys.set(m.key, (numberKeys.get(m.key) ?? 0) + 1); if (m.value !== undefined) numberValues.add(m.value); }
    for (const m of scan.dates) { years.add(m.year!); if (m.month) yearMonths.add(m.key); }
    for (const m of scan.durations) maxYears = Math.max(maxYears, m.years!);
    for (const m of scan.degrees) degreeLevels.set(m.level!, [...(degreeLevels.get(m.level!) ?? []), ...(m.field ? [foldKey(m.field)] : [])]);
    for (const m of scan.locations) locationKeys.add(m.key);
  };
  for (const t of texts) addScan(scanFacts(t));

  const dateFields: Array<string | null> = [];
  for (const w of p.work) dateFields.push(w.startDate, w.endDate);
  for (const e of p.education) dateFields.push(e.startDate, e.endDate);
  for (const pr of p.projects) dateFields.push(pr.startDate, pr.endDate);
  for (const c of p.certifications) dateFields.push(c.date);
  for (const d of dateFields) {
    if (!d) continue;
    years.add(Number(d.slice(0, 4)));
    if (d.length === 7) yearMonths.add(d);
  }
  for (const w of p.work) if (w.current) { years.add(Number(ymNow().slice(0, 4))); }

  for (const e of p.education) {
    const scan = scanFacts([e.degree, e.major].filter(Boolean).join(' in '));
    const fields = e.major ? [foldKey(e.major)] : [];
    for (const m of scan.degrees) degreeLevels.set(m.level!, [...(degreeLevels.get(m.level!) ?? []), ...fields, ...(m.field ? [foldKey(m.field)] : [])]);
  }

  const titles = p.work.map((w) => foldKey(w.title)).filter(Boolean);
  const titleSeniority = new Set<string>();
  for (const t of texts) for (const m of findTitles(t)) if (m.seniority) titleSeniority.add(m.seniority);

  const orgKeys = new Set<string>();
  for (const w of p.work) orgKeys.add(orgKey(w.company));
  for (const e of p.education) orgKeys.add(orgKey(e.school));
  for (const pr of p.projects) orgKeys.add(orgKey(pr.name));
  for (const c of p.certifications) if (c.issuer) orgKeys.add(orgKey(c.issuer));
  for (const t of texts) for (const m of findOrgs(t)) orgKeys.add(m.key);

  const emails = new Set<string>();
  const phones = new Set<string>();
  const urls = new Set<string>();
  if (p.personal.email) emails.add(p.personal.email.toLowerCase());
  if (p.personal.phone) phones.add(phoneDigits(p.personal.phone).slice(-10));
  for (const l of p.personal.links) urls.add(normUrl(l.url));
  for (const pr of p.projects) if (pr.url) urls.add(normUrl(pr.url));
  for (const t of texts) for (const m of findContacts(t)) {
    if (m.key.startsWith('email:')) emails.add(m.key.slice(6));
    else if (m.key.startsWith('url:')) urls.add(m.key.slice(4));
    else if (m.key.startsWith('phone:')) phones.add(m.key.slice(6));
  }

  for (const w of p.work) if (w.location) for (const part of w.location.split(',')) if (part.trim()) locationKeys.add(foldKey(part));
  if (p.personal.city) locationKeys.add(foldKey(p.personal.city));
  if (p.personal.region) locationKeys.add(foldKey(p.personal.region));

  return {
    corpus, words, skillKeys, certKeys, numberKeys, numberValues, years, yearMonths, maxYears, degreeLevels, titles, titleSeniority,
    orgKeys, emails, phones, urls, locationKeys, headerName: headerName(p),
  };
}

// ------------------------------------------------------------------------------------------------ job facts

export interface JobContext {
  company: string;
  companyKey: string;
  title: string;
  titleKey: string;
  cities: string[];
  /** Skills and certifications the posting names (canonical keys). */
  terms: Set<string>;
  /** Folded words of the company and title (a letter may name them). */
  words: Set<string>;
}

export function jobContext(job: Job | null): JobContext | null {
  if (!job) return null;
  const text = `${job.title}\n${job.description}\n${job.skills.join(', ')}`;
  const scan = scanFacts(text);
  const terms = new Set<string>();
  for (const m of [...scan.skills, ...scan.certifications]) terms.add(m.key);
  for (const s of job.skills) { const c = canonicalSkill(s); terms.add((c ?? s).toLowerCase()); }
  const w = new Set<string>();
  for (const x of foldKey(`${job.company} ${job.title}`).split(' ')) if (x) w.add(x);
  return {
    company: job.company,
    companyKey: orgKey(job.company),
    title: job.title,
    titleKey: foldKey(job.title),
    cities: job.places.map((p) => p.city).filter((c): c is string => !!c),
    terms,
    words: w,
  };
}

// ------------------------------------------------------------------------------------------------ checks

type Mode = 'resume' | 'letter';

interface Ctx {
  pf: ProfileFacts;
  job: JobContext | null;
  mode: Mode;
}

function inCorpus(pf: ProfileFacts, phrase: string): boolean {
  const k = foldKey(phrase);
  if (!k) return true;
  const re = new RegExp(`(?:^|[^a-z0-9+#])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9+#])`);
  return re.test(pf.corpus);
}

function v(kind: TruthViolation['kind'], fact: string, where: string, reason: string): TruthViolation {
  return { fact, kind, where, reason };
}

/** Sentences that talk about the person's own history with an employer ("worked at X", "as a Y at X"). */
const HISTORY_RE = /\b(?:worked|work(?:ing)?|served|serving|interned|interning|employed|was|were|have been|had been|spent|my time|my role|my years|my tenure|during my|while at|while working|as an?|i am an?|i'm an?|i was an?|i led|i built|i managed)\b/i;

function traceSkill(m: Mention, ctx: Ctx): boolean {
  if (ctx.pf.skillKeys.has(m.key)) return true;
  if (ctx.pf.skillKeys.has(foldKey(m.text))) return true;
  return inCorpus(ctx.pf, m.text);
}

function checkMentions(text: string, where: string, ctx: Ctx, opts: { sentence?: string } = {}): TruthViolation[] {
  const out: TruthViolation[] = [];
  const pf = ctx.pf;
  const scan = scanFacts(text, { extraCities: ctx.job?.cities ?? [] });
  const sentence = opts.sentence ?? text;
  const aboutJob = (s: string) => ctx.mode === 'letter' && ctx.job !== null && !HISTORY_RE.test(s);

  for (const m of scan.contacts) {
    if (m.key.startsWith('email:') && !pf.emails.has(m.key.slice(6))) out.push(v('contact', m.text, where, 'This email address is not in your profile.'));
    if (m.key.startsWith('url:') && !pf.urls.has(m.key.slice(4))) out.push(v('contact', m.text, where, 'This link is not in your profile.'));
    if (m.key.startsWith('phone:') && !pf.phones.has(m.key.slice(6))) out.push(v('contact', m.text, where, 'This phone number is not in your profile.'));
  }
  for (const m of scan.certifications) {
    if (pf.certKeys.has(m.key) || pf.certKeys.has(foldKey(m.text)) || inCorpus(pf, m.text)) continue;
    out.push(v('certification', m.text, where, 'This certification or licence is not in your profile.'));
  }
  for (const m of scan.skills) {
    if (traceSkill(m, ctx)) continue;
    const fromJob = ctx.job?.terms.has(m.key);
    out.push(v('skill', m.text, where, fromJob ? 'The job asks for this skill, but your profile does not have it.' : 'This skill is not in your profile.'));
  }
  for (const m of scan.degrees) {
    if (m.level!.startsWith('honours:')) {
      if (!inCorpus(pf, m.text)) out.push(v('degree', m.text, where, 'This honour is not in your profile.'));
      continue;
    }
    const fields = pf.degreeLevels.get(m.level!);
    if (!fields) {
      out.push(v('degree', m.text, where, 'Your profile has no degree at this level.'));
      continue;
    }
    if (m.field && fields.length && !fields.some((f) => f === foldKey(m.field!) || f.includes(foldKey(m.field!)) || foldKey(m.field!).includes(f)) && !inCorpus(pf, m.field)) {
      out.push(v('degree', `${m.text} in ${m.field}`, where, 'Your profile has no degree in this field.'));
    }
  }
  for (const m of scan.locations) {
    if (pf.locationKeys.has(m.key) || inCorpus(pf, m.text)) continue;
    if (aboutJob(sentence) && ctx.job?.cities.some((c) => foldKey(c) === m.key)) continue;
    out.push(v('location', m.text, where, 'This place is not in your profile.'));
  }
  for (const m of scan.dates) {
    if (m.month) {
      if (pf.yearMonths.has(m.key)) continue;
      out.push(v('date', m.text, where, pf.years.has(m.year!) ? 'Your profile does not give this month.' : 'This date is not in your profile.'));
    } else if (!pf.years.has(m.year!)) {
      out.push(v('date', m.text, where, 'This year is not in your profile.'));
    }
  }
  for (const m of scan.durations) {
    // "N years", "N+ years" and "over N years" all need profile dates that cover at least N whole years.
    if (m.years! <= Math.floor(pf.maxYears + 1e-9) || inCorpus(pf, m.text)) continue;
    out.push(v('duration', m.text, where, `Your profile dates show about ${Math.floor(pf.maxYears)} year${Math.floor(pf.maxYears) === 1 ? '' : 's'}.`));
  }
  for (const m of scan.numbers) {
    if (pf.numberKeys.has(m.key)) continue;
    if (m.unit === 'plain' && m.value !== undefined && pf.numberValues.has(m.value)) continue;
    if (m.unit === 'vague' && inCorpus(pf, m.text)) continue;
    if (m.unit === 'mult' && inCorpus(pf, m.text)) continue;
    out.push(v('number', m.text, where, 'This number is not in your profile.'));
  }
  for (const m of scan.titles) {
    if (pf.titles.some((t) => t === m.key || t.includes(m.key)) || inCorpus(pf, m.text)) {
      if (!m.seniority || pf.titleSeniority.has(m.seniority) || pf.titles.some((t) => t.includes(m.seniority!))) continue;
    }
    if (ctx.job && (m.key === ctx.job.titleKey || ctx.job.titleKey.includes(m.key))) {
      if (aboutJob(sentence)) continue;
      out.push(v('title', m.text, where, 'This is the job\'s title, not a title you have held.'));
      continue;
    }
    // Generic role words that are not titles you claim ("with engineers") are fine when the words are yours.
    const onlyRole = m.key.split(' ').every((w) => ROLE_NOUNS.includes(w) || ROLE_NOUNS.includes(w.replace(/s$/, '')));
    if (onlyRole && !m.seniority) continue;
    out.push(v('title', m.text, where, m.seniority && !pf.titleSeniority.has(m.seniority) ? `Your profile has no "${m.seniority}" title.` : 'This job title is not in your profile.'));
  }
  for (const m of scan.orgs) {
    if (pf.orgKeys.has(m.key) || inCorpus(pf, m.text) || [...pf.orgKeys].some((k) => k && (k.includes(m.key) || m.key.includes(k)) && m.key.length >= 3)) continue;
    if (ctx.job && m.key && (m.key === ctx.job.companyKey || ctx.job.companyKey.includes(m.key) || m.key.includes(ctx.job.companyKey))) {
      if (aboutJob(sentence)) continue;
      out.push(v('employer', m.text, where, 'This is the hiring company, not a place you have worked.'));
      continue;
    }
    // "at scale", "for Engineering" and similar are words, not organisations; only flag capitalised names.
    const tokens = m.text.split(/\s+/).filter((w) => /^\p{Lu}/u.test(w));
    // A name with an organisation ending ("Northwind Labs") must be one of yours; words after "at"/"with" that are
    // all your own words ("with Python") are not an organisation.
    if (!tokens.length || (m.via !== 'suffix' && tokens.every((w) => pf.words.has(foldKey(w)) || ctx.job?.words.has(foldKey(w)) && ctx.mode === 'letter'))) continue;
    out.push(v(m.kind === 'school' ? 'school' : 'employer', m.text, where, m.kind === 'school' ? 'This school is not in your profile.' : 'This organisation is not in your profile.'));
  }
  for (const m of scan.proper) {
    const k = m.key;
    if (!k || pf.words.has(k) || pf.words.has(k.replace(/s$/, '')) || inCorpus(pf, m.text)) continue;
    if (ctx.mode === 'letter' && ctx.job && ctx.job.words.has(k) && aboutJob(sentence)) continue;
    out.push(v('other', m.text, where, 'This name is not in your profile.'));
  }
  return out;
}

/** Checks one piece of free text (a bullet, a summary, a letter paragraph), sentence by sentence. */
export function checkText(text: string, where: string, pf: ProfileFacts, job: JobContext | null, mode: Mode): TruthViolation[] {
  const ctx: Ctx = { pf, job, mode };
  if (mode === 'resume') return checkMentions(text, where, ctx);
  const out: TruthViolation[] = [];
  for (const s of splitSentences(text)) out.push(...checkMentions(s, where, ctx, { sentence: s }));
  return out;
}

// ------------------------------------------------------------------------------------------------ documents

function sameYm(docDate: string | null, profDate: string | null): boolean {
  if (docDate === null) return true; // leaving a date out is not a new fact
  if (profDate === null) return false;
  if (docDate === profDate) return true;
  return docDate.length === 4 && profDate.startsWith(docDate);
}

export function headerFromProfile(p: Profile): ResumeDocument['header'] {
  const city = [p.personal.city, p.personal.region].filter((x) => x && x.trim()).join(', ');
  return {
    name: headerName(p),
    email: p.personal.email,
    phone: p.personal.phone,
    city: city || null,
    links: p.personal.links.map((l) => ({ label: l.label, url: l.url })),
  };
}

function checkHeader(doc: ResumeDocument, p: Profile): TruthViolation[] {
  const want = headerFromProfile(p);
  const out: TruthViolation[] = [];
  const h = doc.header;
  if (h.name !== want.name) out.push(v('contact', h.name, 'Header: name', `The name must be "${want.name}" exactly as your profile holds it.`));
  if (h.email !== want.email) out.push(v('contact', h.email ?? '(none)', 'Header: email', 'The email must match your profile exactly.'));
  if (h.phone !== want.phone) out.push(v('contact', h.phone ?? '(none)', 'Header: phone', 'The phone number must match your profile exactly.'));
  if (h.city !== want.city) out.push(v('contact', h.city ?? '(none)', 'Header: city', 'The city must match your profile exactly.'));
  const got = h.links.map((l) => l.url);
  const exp = want.links.map((l) => l.url);
  if (got.length !== exp.length || got.some((u, i) => u !== exp[i])) {
    for (const u of got) if (!exp.includes(u)) out.push(v('contact', u, 'Header: links', 'This link is not in your profile.'));
    for (const u of exp) if (!got.includes(u)) out.push(v('contact', u, 'Header: links', 'A link from your profile is missing or changed.'));
  }
  return out;
}

function checkExperienceItem(item: ResumeItem, where: string, p: Profile, ctx: Ctx): TruthViolation[] {
  const out: TruthViolation[] = [];
  const w = p.work.find((x) => x.id === item.id) ?? p.work.find((x) => item.heading !== null && orgKey(x.company) === orgKey(item.heading) && (item.subheading === null || foldKey(x.title) === foldKey(item.subheading)))
    ?? p.work.find((x) => item.heading !== null && orgKey(x.company) === orgKey(item.heading));
  if (!w) {
    out.push(v('employer', item.heading ?? item.subheading ?? '(no name)', where, 'This employer is not in your profile.'));
  } else {
    if (item.heading !== null && orgKey(item.heading) !== orgKey(w.company)) out.push(v('employer', item.heading, where, `Your profile has "${w.company}" here.`));
    if (item.subheading !== null && foldKey(item.subheading) !== foldKey(w.title)) out.push(v('title', item.subheading, where, `Your profile title here is "${w.title}".`));
    if (!sameYm(item.startDate, w.startDate)) out.push(v('date', item.startDate ?? '', where, `Your profile start date here is ${w.startDate ?? 'not set'}.`));
    if (!w.current && !sameYm(item.endDate, w.endDate)) out.push(v('date', item.endDate ?? '', where, `Your profile end date here is ${w.endDate ?? 'not set'}.`));
    if (item.current && !w.current) out.push(v('date', 'Present', where, 'Your profile does not say you still work here.'));
    if (!item.current && w.current && item.endDate) out.push(v('date', item.endDate, where, 'Your profile says you still work here.'));
    if (item.location && !(w.location && foldKey(w.location) === foldKey(item.location))) out.push(...checkText(item.location, where, ctx.pf, ctx.job, 'resume'));
  }
  item.bullets.forEach((b, i) => out.push(...checkText(b, `${where}, bullet ${i + 1}`, ctx.pf, ctx.job, 'resume')));
  for (const t of item.tags) out.push(...checkText(t, `${where}, tag`, ctx.pf, ctx.job, 'resume'));
  return out;
}

function checkEducationItem(item: ResumeItem, where: string, p: Profile, ctx: Ctx): TruthViolation[] {
  const out: TruthViolation[] = [];
  const e = p.education.find((x) => x.id === item.id) ?? p.education.find((x) => item.heading !== null && orgKey(x.school) === orgKey(item.heading));
  if (!e) out.push(v('school', item.heading ?? '(no name)', where, 'This school is not in your profile.'));
  else {
    if (item.heading !== null && orgKey(item.heading) !== orgKey(e.school)) out.push(v('school', item.heading, where, `Your profile has "${e.school}" here.`));
    if (!sameYm(item.startDate, e.startDate)) out.push(v('date', item.startDate ?? '', where, `Your profile start date here is ${e.startDate ?? 'not set'}.`));
    if (!e.current && !sameYm(item.endDate, e.endDate)) out.push(v('date', item.endDate ?? '', where, `Your profile end date here is ${e.endDate ?? 'not set'}.`));
    if (item.subheading) {
      const allowed = foldKey([e.degree, e.major].filter(Boolean).join(' '));
      const words = foldKey(item.subheading).split(' ').filter((w) => !['in', 'of', 'and', 'the', 'degree'].includes(w));
      const extra = words.filter((w) => !allowed.split(' ').includes(w) && !ctx.pf.words.has(w));
      if (extra.length) out.push(v('degree', item.subheading, where, `Your profile degree here is "${[e.degree, e.major].filter(Boolean).join(', ')}".`));
    }
  }
  item.bullets.forEach((b, i) => out.push(...checkText(b, `${where}, bullet ${i + 1}`, ctx.pf, ctx.job, 'resume')));
  return out;
}

function checkSkillList(values: string[], where: string, ctx: Ctx): TruthViolation[] {
  const out: TruthViolation[] = [];
  for (const raw of values) {
    const s = squash(raw.replace(/^[^:]{1,40}:\s*/, ''));
    for (const part of s.split(/\s*[,;|•·]\s*/)) {
      const t = part.trim();
      if (!t) continue;
      const c = canonicalSkill(t);
      if (c && ctx.pf.skillKeys.has(c.toLowerCase())) continue;
      if (ctx.pf.skillKeys.has(foldKey(t)) || inCorpus(ctx.pf, t)) continue;
      // A phrase can still hold known skills: check them one by one ("AWS (EC2, S3)").
      const inner = findSkills(t);
      if (inner.length && inner.every((m) => traceSkill(m, ctx)) && foldKey(t).split(' ').every((w) => ctx.pf.words.has(w) || inner.some((m) => foldKey(m.text).includes(w)))) continue;
      const fromJob = ctx.job?.terms.has((c ?? t).toLowerCase());
      out.push(v('skill', t, where, fromJob ? 'The job asks for this skill, but your profile does not have it.' : 'This skill is not in your profile.'));
    }
  }
  return out;
}

function dedupe(vs: TruthViolation[]): TruthViolation[] {
  const seen = new Set<string>();
  return vs.filter((x) => {
    const k = `${x.kind}|${x.fact.toLowerCase()}|${x.where}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function checkDocument(doc: ResumeDocument, p: Profile, job: Job | null, pf: ProfileFacts = buildProfileFacts(p)): TruthViolation[] {
  const ctx: Ctx = { pf, job: jobContext(job), mode: 'resume' };
  const out: TruthViolation[] = [...checkHeader(doc, p)];
  for (const s of doc.sections) {
    const base = s.title || s.kind;
    if (s.text) out.push(...checkText(s.text, base, pf, ctx.job, 'resume'));
    for (const item of s.items) {
      const where = `${base} › ${item.heading ?? item.subheading ?? 'item'}`;
      switch (s.kind) {
        case 'experience':
          out.push(...checkExperienceItem(item, where, p, ctx));
          break;
        case 'education':
          out.push(...checkEducationItem(item, where, p, ctx));
          break;
        case 'skills':
          out.push(...checkSkillList([...(item.heading ? [item.heading] : []), ...item.tags, ...item.bullets], base, ctx));
          if (item.subheading) out.push(...checkSkillList([item.subheading], base, ctx));
          break;
        case 'projects': {
          const pr = p.projects.find((x) => x.id === item.id) ?? p.projects.find((x) => item.heading !== null && foldKey(x.name) === foldKey(item.heading));
          if (!pr) out.push(v('other', item.heading ?? '(no name)', where, 'This project is not in your profile.'));
          if (item.subheading) out.push(...checkText(item.subheading, where, pf, ctx.job, 'resume'));
          if (pr && (!sameYm(item.startDate, pr.startDate) || !sameYm(item.endDate, pr.endDate))) out.push(v('date', `${item.startDate ?? ''} – ${item.endDate ?? ''}`, where, 'The project dates differ from your profile.'));
          item.bullets.forEach((b, i) => out.push(...checkText(b, `${where}, bullet ${i + 1}`, pf, ctx.job, 'resume')));
          for (const t of item.tags) out.push(...checkText(t, `${where}, link`, pf, ctx.job, 'resume'));
          break;
        }
        case 'certifications': {
          const name = item.heading ?? '';
          const cert = p.certifications.find((c) => foldKey(c.name) === foldKey(name));
          if (!cert && name && !inCorpus(pf, name)) out.push(v('certification', name, where, 'This certification is not in your profile.'));
          if (item.subheading && !(cert?.issuer && foldKey(cert.issuer) === foldKey(item.subheading))) out.push(...checkText(item.subheading, where, pf, ctx.job, 'resume'));
          if (cert && !sameYm(item.startDate ?? item.endDate, cert.date)) out.push(v('date', item.startDate ?? item.endDate ?? '', where, 'The certification date differs from your profile.'));
          item.bullets.forEach((b, i) => out.push(...checkText(b, `${where}, line ${i + 1}`, pf, ctx.job, 'resume')));
          break;
        }
        default: {
          for (const f of [item.heading, item.subheading, item.location]) if (f) out.push(...checkText(f, where, pf, ctx.job, 'resume'));
          if (item.startDate && !pf.years.has(Number(item.startDate.slice(0, 4)))) out.push(v('date', item.startDate, where, 'This date is not in your profile.'));
          item.bullets.forEach((b, i) => out.push(...checkText(b, `${where}, line ${i + 1}`, pf, ctx.job, 'resume')));
        }
      }
    }
  }
  return dedupe(out);
}

/** Checks a cover letter: every fact traces to the profile; the job's own company, title and places may be named. */
export function checkLetter(text: string, p: Profile, job: Job | null, pf: ProfileFacts = buildProfileFacts(p)): TruthViolation[] {
  const jc = jobContext(job);
  const out: TruthViolation[] = [];
  const lines = text.split('\n');
  const first = lines.find((l) => l.trim())?.trim() ?? '';
  const name = headerName(p);
  if (name && first !== name) out.push(v('contact', first || '(empty)', 'Letter header', `The letter must start with your name "${name}" exactly as your profile holds it.`));
  const paras = text.split(/\n\s*\n/);
  paras.forEach((para, i) => {
    const body = para.trim();
    if (!body) return;
    // The header block (name and contact line) is checked as contact details only.
    if (i === 0 && body.startsWith(name)) {
      for (const m of findContacts(body)) {
        if (m.key.startsWith('email:') && !pf.emails.has(m.key.slice(6))) out.push(v('contact', m.text, 'Letter header', 'This email address is not in your profile.'));
        if (m.key.startsWith('url:') && !pf.urls.has(m.key.slice(4))) out.push(v('contact', m.text, 'Letter header', 'This link is not in your profile.'));
        if (m.key.startsWith('phone:') && !pf.phones.has(m.key.slice(6))) out.push(v('contact', m.text, 'Letter header', 'This phone number is not in your profile.'));
      }
      const hdr = headerFromProfile(p);
      for (const want of [hdr.email, hdr.phone, hdr.city, ...hdr.links.map((l) => l.url)]) {
        if (want && !body.includes(want)) out.push(v('contact', want, 'Letter header', 'A contact detail from your profile is missing or changed.'));
      }
      return;
    }
    out.push(...checkText(body, `Letter, paragraph ${i + 1}`, pf, jc, 'letter'));
  });
  return dedupe(out);
}

/** The truth gate. A string is checked as a cover letter; a document as a resume. Empty = passes. */
export function truthGate(draft: ResumeDocument | string, profile: Profile, job: Job | null): TruthViolation[] {
  return typeof draft === 'string' ? checkLetter(draft, profile, job) : checkDocument(draft, profile, job);
}

// ------------------------------------------------------------------------------------------------ requests

/**
 * Facts a request asks to add that the profile does not have ("add Kubernetes and a PhD"). The product refuses
 * them and shows them as gaps; a new fact enters only through the person's own profile.
 */
export function refusedFacts(instruction: string, profile: Profile, pf: ProfileFacts = buildProfileFacts(profile)): string[] {
  const out: string[] = [];
  const scan = scanFacts(instruction);
  for (const m of scan.skills) if (!pf.skillKeys.has(m.key) && !inCorpus(pf, m.text)) out.push(canonicalSkill(m.text) ?? m.text);
  for (const m of scan.certifications) if (!pf.certKeys.has(m.key) && !inCorpus(pf, m.text)) out.push(m.text);
  for (const m of scan.degrees) if (!pf.degreeLevels.has(m.level!)) out.push(m.text);
  for (const m of scan.durations) if (m.years! > Math.floor(pf.maxYears + 1e-9)) out.push(m.text);
  for (const m of scan.numbers) if (!pf.numberKeys.has(m.key) && !(m.value !== undefined && pf.numberValues.has(m.value))) out.push(m.text);
  for (const m of scan.titles) if (m.seniority && !pf.titleSeniority.has(m.seniority)) out.push(m.text);
  for (const m of scan.orgs) if (!pf.orgKeys.has(m.key) && !inCorpus(pf, m.text) && /^\p{Lu}/u.test(m.text)) out.push(m.text);
  for (const m of scan.proper) if (!pf.words.has(m.key) && !inCorpus(pf, m.text)) out.push(m.text);
  for (const m of findDates(instruction)) if (!pf.years.has(m.year!)) out.push(m.text);
  return [...new Set(out)];
}

export { findDurations, findNumbers };
