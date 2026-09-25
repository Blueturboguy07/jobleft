// RawJob (what an adapter read) -> Job (what the store keeps). No IT-only gate anywhere in this file.
// Rule: a fact the board does not state stays unknown (null or []). Nothing is filled by default.
//
// Facts that the parsers lane will own (years required, sponsorship and clearance statements, extra levels) are read
// through optional hooks: when @jobleft/parsers exports parseYearsRequired, parseStatements, parsePlaces or levelsOf,
// their results are used (after a contract check); until then the fact stays unknown.

import * as parsers from '@jobleft/parsers';
import {
  annualize, htmlToText, isRemoteText, isUsLocation, levelFromDescription, levelFromTitle, parsePayFromText,
} from '@jobleft/parsers';
import {
  EXPERIENCE_LEVELS, ExperienceLevelSchema, PlaceSchema, PostingStatementsSchema, experienceLevelOf, isValid,
} from '@jobleft/contracts';
import type { EmploymentType, ExperienceLevel, FactEvidence, JobEvidence, Place, PostingStatements } from '@jobleft/contracts';
import { canonicalizeUrl, cleanText, contentHash, dedupHash, normalizeCompany, normalizeTitle } from './normalize.ts';
import { isGenericPlace, parsePlace, splitPlaces, workModelOf } from './places.ts';
import type { BoardRef, Job, RawJob } from './types.ts';
import { createHash } from 'node:crypto';

type Hook = (...args: unknown[]) => unknown;
function hook(name: string): Hook | null {
  const f = (parsers as unknown as Record<string, unknown>)[name];
  return typeof f === 'function' ? (f as Hook) : null;
}
function tryHook<T>(name: string, args: unknown[], check: (v: unknown) => v is T): T | null {
  const f = hook(name);
  if (!f) return null;
  try {
    const v = f(...args);
    return check(v) ? v : null;
  } catch {
    return null; // a stub that throws "not implemented yet" leaves the fact unknown
  }
}

/** Only absolute http(s) links survive; anything else (javascript:, file:, custom schemes, relative) is dropped. */
export function httpUrl(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch { return null; }
}

/** Why a raw posting cannot be stored, or null when it can. */
export function skipReason(raw: RawJob): string | null {
  if (!String(raw.externalId ?? '').trim()) return 'the board gave the posting no id';
  if (!cleanText(raw.title)) return 'the board gave the posting no title';
  if (!httpUrl(raw.url) && !httpUrl(raw.applyUrl)) return 'the board gave the posting no web (http or https) link';
  return null;
}

// Money in a line about something other than wages (a bonus, a 401(k) match, a stipend) must never become pay.
const NON_WAGE = /\b(sign[- ]?on|signing|relocation|referral|retention|bonus(es)?|401\s*\(?k\)?|stipend|tuition|reimburse\w*|allowance|equity|stock|rsus?|commission|match(ing)?|per diem|gift card|donation|funding|raised|revenue|valuation|budget)\b/i;
const WAGE_CUE = /\b(salary|base pay|base salary|pay range|pay rate|rate of pay|hourly|wage|compensation|pay scale|pay band|pay:|starting pay|annual)\b/i;

/** The description without lines whose money is clearly not a wage. */
function wageLines(description: string): string[] {
  return description.split('\n').filter((line) => {
    const firstMoney = line.search(/[$€£]|\b(USD|CAD|EUR|GBP)\b/);
    if (firstMoney < 0) return true;
    const before = line.slice(0, firstMoney);
    const after = line.slice(firstMoney, firstMoney + 60);
    if (WAGE_CUE.test(before)) return true;
    return !(NON_WAGE.test(before) || NON_WAGE.test(after));
  });
}

function payFromText(description: string): { pay: NonNullable<ReturnType<typeof parsePayFromText>>; evidence: string } | null {
  const lines = wageLines(description);
  const p = parsePayFromText(lines.join('\n'));
  if (!p) return null;
  // Evidence: the first kept line that alone gives the same figures.
  const line = lines.find((l) => {
    const q = parsePayFromText(l);
    return q !== null && q.min === p.min && q.max === p.max && q.period === p.period;
  });
  return { pay: p, evidence: (line ?? '').trim().slice(0, 500) };
}

function ev(source: FactEvidence['source'], text: string | null | undefined): FactEvidence | null {
  const t = (text ?? '').trim();
  return t ? { source, text: t.slice(0, 500) } : null;
}

const EMPLOYMENT: Record<string, EmploymentType> = {
  full_time: 'full_time', part_time: 'part_time', contract: 'contract', internship: 'internship', temporary: 'temporary',
};

function isPlaceArray(v: unknown): v is Place[] { return Array.isArray(v) && v.every((p) => isValid(PlaceSchema, p)); }
function isStatements(v: unknown): v is PostingStatements & Record<string, unknown> { return isValid(PostingStatementsSchema, v); }
function isYears(v: unknown): v is { min: number | null; max: number | null } {
  if (!v || typeof v !== 'object') return false;
  const o = v as { min?: unknown; max?: unknown };
  const ok = (x: unknown) => x === null || (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 60);
  return ok(o.min) && ok(o.max) && !(o.min === null && o.max === null);
}
function isLevels(v: unknown): v is ExperienceLevel[] {
  return Array.isArray(v) && v.every((x) => (EXPERIENCE_LEVELS as readonly string[]).includes(x as string));
}

/** A key for "the same role": company, title and the places (in any order). */
export function roleKeyOf(company: string, title: string, places: string[]): string {
  const p = places.map((x) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).filter(Boolean).sort().join('|');
  return createHash('sha256').update(`${normalizeCompany(company)}|${normalizeTitle(title)}|${p}`).digest('hex');
}

/** Returns null when the posting cannot be persisted (no id, no title or no web link); see skipReason(). */
export function normalizeJob(board: BoardRef, raw: RawJob): Job | null {
  if (skipReason(raw)) return null;
  const title = cleanText(raw.title);
  const jobId = String(raw.externalId).trim();
  const pageUrl = (httpUrl(raw.url) ?? httpUrl(raw.applyUrl))!;
  const applyLink = httpUrl(raw.applyUrl);
  const canonicalUrl = canonicalizeUrl(pageUrl);
  if (!canonicalUrl) return null;
  const applyUrl = applyLink ?? pageUrl;
  const company = cleanText(raw.company) || cleanText(board.company) || board.board;

  // Places: the adapter's list when it has one, else the location field split on ";" and "|".
  const placeTexts = (raw.places && raw.places.length > 0 ? raw.places : splitPlaces(raw.location))
    .map((p) => cleanText(p)).filter((p) => p && !isGenericPlace(p));
  const uniqueTexts = [...new Map(placeTexts.map((p) => [p.toLowerCase(), p])).values()];
  const location = uniqueTexts.length > 0 ? uniqueTexts.join('; ') : cleanText(raw.location);
  let places: Place[] = uniqueTexts.map(parsePlace);
  const hooked = uniqueTexts.length > 0 ? uniqueTexts.map((t) => tryHook('parsePlaces', [t], isPlaceArray)) : [];
  if (hooked.length > 0 && hooked.every((h) => h !== null && h.length > 0)) {
    // The parsers lane resolved every place: keep its parts, but always keep the board's own words as the text.
    places = hooked.flatMap((h, i) => h!.map((p) => ({ ...p, text: p.text || uniqueTexts[i]! })));
  }
  const description = htmlToText(raw.descriptionHtml);

  // Level: title first, description second; never a default.
  let level = levelFromTitle(title);
  let levelSource: Job['levelSource'] = level ? 'title' : null;
  if (!level) {
    level = levelFromDescription(description);
    levelSource = level ? 'description' : null;
  }

  // Pay: the board's pay field wins; otherwise the posting text (wage lines only). Never an estimate.
  let payMin: number | null = null, payMax: number | null = null;
  let payCurrency: string | null = null;
  let payPeriod: Job['payPeriod'] = null;
  let paySource: Job['paySource'] = null;
  let payEvidence: FactEvidence | null = null;
  let payRanges: number | null = null;
  if (raw.pay) {
    ({ min: payMin, max: payMax, currency: payCurrency, period: payPeriod } = raw.pay);
    paySource = 'api';
    payRanges = raw.payRanges && raw.payRanges > 0 ? raw.payRanges : 1;
    payEvidence = ev('board_field', raw.payEvidence ?? `${payMin ?? ''}-${payMax ?? ''} ${payCurrency} per ${payPeriod}`);
  } else {
    const t = payFromText(description);
    if (t) {
      payMin = t.pay.min; payMax = t.pay.max; payCurrency = t.pay.currency; payPeriod = t.pay.period;
      paySource = 'text';
      payRanges = 1;
      payEvidence = ev('description', t.evidence);
    }
  }

  const wm = workModelOf(raw.workMode, uniqueTexts, raw.workModeEvidence);
  const remote = raw.remote || raw.workMode === 'remote' || isRemoteText(location) || wm.workModel === 'remote';
  const employment = EMPLOYMENT[raw.employmentType] ?? null;

  const years = tryHook('parseYearsRequired', [description], isYears);
  const statementsHook = tryHook('parseStatements', [description], isStatements);
  const statements: PostingStatements = statementsHook
    ? { sponsorship: statementsHook.sponsorship, clearanceRequired: statementsHook.clearanceRequired, usCitizenOnly: statementsHook.usCitizenOnly }
    : { sponsorship: null, clearanceRequired: null, usCitizenOnly: null };
  let levels: ExperienceLevel[] = level ? [experienceLevelOf(level)] : [];
  const levelsHook = tryHook('levelsOf', [level, years], isLevels);
  if (levelsHook && levelsHook.length > 0) levels = [...new Set(levelsHook)];

  const evidence: JobEvidence = {};
  if (payEvidence) evidence.pay = payEvidence;
  if (level) {
    const e = levelSource === 'title' ? ev('title', title) : ev('description', description.split('\n').find((l) => /years?/i.test(l)) ?? '');
    if (e) evidence.level = e;
  }
  if (places.length > 0) { const e = ev('board_field', raw.location || uniqueTexts.join('; ')); if (e) evidence.places = e; }
  if (wm.workModel && wm.source) { const e = ev(wm.source, wm.evidence); if (e) evidence.workModel = e; }
  if (wm.remoteScope) { const e = ev(wm.source === 'board_field' ? 'board_field' : 'location_text', wm.remoteScope.text); if (e) evidence.remoteScope = e; }
  if (employment) { const e = ev('board_field', raw.employmentType); if (e) evidence.employmentType = e; }
  if (statementsHook) {
    const se = statementsHook as unknown as { evidence?: Record<string, FactEvidence> };
    for (const k of ['sponsorship', 'clearanceRequired', 'usCitizenOnly'] as const) {
      const e = se.evidence?.[k];
      if (statements[k] !== null && e && typeof e.text === 'string') evidence[k] = { source: 'description', text: e.text.slice(0, 500) };
    }
  }
  if (years) { const e = ev('description', description.split('\n').find((l) => /years?/i.test(l)) ?? ''); if (e) evidence.years = e; }

  const job: Job = {
    ats: board.ats,
    board: board.board,
    jobId,
    applyUrl,
    canonicalUrl,
    dedupHash: dedupHash(company, title),
    title,
    company,
    companySlug: normalizeCompany(company),
    location,
    remote,
    workMode: raw.workMode || (wm.workModel ?? ''),
    isUs: isUsLocation(location, raw.countries),
    level,
    levelSource,
    payMin, payMax, payCurrency, payPeriod,
    payMinAnnual: payPeriod ? annualize(payMin, payPeriod) : null,
    payMaxAnnual: payPeriod ? annualize(payMax, payPeriod) : null,
    paySource,
    postedAt: raw.postedAt,
    employmentType: raw.employmentType,
    department: cleanText(raw.department),
    description,
    contentHash: '',
    pageUrl,
    applyLink: applyLink && applyLink !== pageUrl ? applyLink : null,
    places,
    workModel: wm.workModel,
    remoteScope: wm.remoteScope,
    employment,
    levels,
    yearsRequired: years,
    statements,
    evidence,
    payRanges,
    boardUpdatedAt: raw.boardUpdatedAt ?? null,
    roleKey: roleKeyOf(company, title, uniqueTexts),
  };
  job.contentHash = contentHash([
    job.title, job.company, job.location, job.remote, job.workMode, job.level, job.payMin, job.payMax,
    job.payCurrency, job.payPeriod, job.postedAt, job.employmentType, job.department, job.applyUrl, job.description,
    job.pageUrl, JSON.stringify(job.places), job.workModel, JSON.stringify(job.remoteScope), JSON.stringify(job.levels),
    JSON.stringify(job.yearsRequired), JSON.stringify(job.statements), job.payRanges,
  ]);
  return job;
}
