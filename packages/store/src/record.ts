// From an incoming posting (a contract Job, or the lenient import shape) to the record the store keeps:
// the contract Job itself, its keys for dedupe, its content hash, the text fit indexing embeds, and the packed facets
// the in-memory filter reads. Nothing here invents a fact: a missing fact stays null or [].

import { createHash } from 'node:crypto';
import {
  EXPERIENCE_LEVELS, experienceLevelOf, validate, JobSchema,
  type ExperienceLevel, type Job, type Pay, type Place, type SourceAttribution,
} from '@jobleft/contracts';
import { canonicalizeUrl } from '@jobleft/crawler';
import { companyKey as sharedCompanyKey } from '@jobleft/static-data';
import { countryFromText, foldPlace, localCompanyKey, parsePlaceQuery, regionKey, skillKey, titleTokenCount } from './text.ts';

// ---------------------------------------------------------------- company key (shared when the static-data lane is built)

let useShared: boolean | null = null;
/** The company key: @jobleft/static-data companyKey() once that lane ships it, else the same rules implemented here. */
export function companyKeyOf(name: string): string {
  if (useShared === null) {
    try { sharedCompanyKey('Probe, Inc.'); useShared = true; } catch { useShared = false; }
  }
  if (useShared) {
    try { return sharedCompanyKey(name); } catch { /* fall through */ }
  }
  return localCompanyKey(name);
}

// ---------------------------------------------------------------- hashing

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// ---------------------------------------------------------------- lenient input

const WORK_MODELS = ['onsite', 'hybrid', 'remote'] as const;
const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'internship', 'temporary', 'other'] as const;
const PAY_PERIOD_HOURS: Record<string, number> = { hour: 2080, day: 260, week: 52, month: 12, year: 1 };

type Dict = Record<string, unknown>;

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function isoOrNull(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  // A bare date is the employer's calendar day: keep that day (midnight UTC), never shift it.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : Date.parse(s);
  if (!Number.isFinite(d)) return null;
  return new Date(d).toISOString();
}

function placeFromText(text: string): Place {
  const q = parsePlaceQuery(text, null);
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  const city = q.city ? parts[0] ?? null : null;
  let region: string | null = null;
  if (q.region && parts.length >= 2) region = parts[1] ?? null;
  else if (q.region && parts.length === 1) region = parts[0] ?? null;
  return { text, city, region, country: q.country as Place['country'], placeId: null };
}

function normalizePlaces(input: Dict): Place[] {
  const raw = input.places;
  const out: Place[] = [];
  if (Array.isArray(raw)) {
    for (const p of raw) {
      if (typeof p === 'string') { if (p.trim()) out.push(placeFromText(p.trim())); continue; }
      if (p && typeof p === 'object') {
        const d = p as Dict;
        const text = str(d.text) ?? [str(d.city), str(d.region), str(d.country)].filter(Boolean).join(', ');
        if (!text) continue;
        const place: Place = {
          text,
          city: str(d.city),
          region: str(d.region),
          country: (str(d.country)?.toUpperCase() ?? null) as Place['country'],
          placeId: str(d.placeId),
        };
        if (typeof d.lat === 'number' && typeof d.lon === 'number') { place.lat = d.lat; place.lon = d.lon; }
        out.push(place);
      }
    }
    return out;
  }
  const loc = str(input.location);
  if (loc) for (const part of loc.split(/\s*(?:;|\||\n)\s*/)) if (part) out.push(placeFromText(part));
  return out;
}

function normalizePay(v: unknown): Pay | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as Dict;
  const min = typeof d.min === 'number' && d.min >= 0 ? d.min : null;
  const max = typeof d.max === 'number' && d.max >= 0 ? d.max : null;
  const period = str(d.period);
  const currency = str(d.currency)?.toUpperCase() ?? null;
  if ((min === null && max === null) || !period || !(period in PAY_PERIOD_HOURS) || !currency) return null;
  const mult = PAY_PERIOD_HOURS[period]!;
  const annualMin = typeof d.annualMin === 'number' ? d.annualMin : min === null ? null : min * mult;
  const annualMax = typeof d.annualMax === 'number' ? d.annualMax : max === null ? null : max * mult;
  const source = d.source === 'description' ? 'description' : 'board_field';
  const ranges = typeof d.ranges === 'number' && d.ranges >= 1 ? Math.floor(d.ranges) : 1;
  return { min, max, currency, period: period as Pay['period'], source, ranges, annualMin, annualMax };
}

function enumOrNull<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  const s = str(v)?.toLowerCase().replace(/[\s-]+/g, '_');
  return s && (allowed as readonly string[]).includes(s) ? (s as T) : null;
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    const s = str(x);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

export interface NormalizeResult {
  job: Job | null;
  error: string | null;
}

/**
 * Builds a contract Job from a lenient input. Required: title, company and a link (url or canonicalUrl).
 * `now` fills only bookkeeping times (first and last seen), never a posted date.
 */
export function normalizeInput(input: unknown, nowIso: string, defaultSource?: { sourceId: string; name: string }): NormalizeResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { job: null, error: 'not a JSON object' };
  const d = input as Dict;
  const title = str(d.title);
  const company = str(d.company);
  const url = str(d.url) ?? str(d.canonicalUrl);
  if (!title) return { job: null, error: 'title is missing' };
  if (!company) return { job: null, error: 'company is missing' };
  if (!url || !/^https?:\/\//i.test(url)) return { job: null, error: 'url is missing or not an http(s) link' };
  const canonical = canonicalizeUrl(str(d.canonicalUrl) ?? url) || url;
  const ats = str(d.ats)?.toLowerCase() ?? null;
  const board = str(d.board);
  const externalId = str(d.externalId);
  let id = str(d.id);
  if (!id) {
    id = ats && board && externalId && ats !== 'external'
      ? `${ats}:${board.toLowerCase()}:${externalId}`
      : `ext:${sha256(canonical).slice(0, 24)}`;
  }
  const level = str(d.level)?.toLowerCase() ?? null;
  const levelOk = level && ['intern', 'entry', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director', 'vp', 'exec'].includes(level);
  let levels = stringList(d.levels).map((l) => l.toLowerCase()).filter((l) => (EXPERIENCE_LEVELS as readonly string[]).includes(l)) as ExperienceLevel[];
  if (levels.length === 0 && levelOk) levels = [experienceLevelOf(level as Job['level'] & string)];
  const places = normalizePlaces(d);
  let isUs: boolean | null = typeof d.isUs === 'boolean' ? d.isUs : null;
  if (isUs === null && places.length > 0 && places.every((p) => p.country)) {
    isUs = places.some((p) => p.country === 'US') ? true : false;
  }
  const yr = d.yearsRequired && typeof d.yearsRequired === 'object' ? d.yearsRequired as Dict : null;
  const yearsRequired = yr && (typeof yr.min === 'number' || typeof yr.max === 'number')
    ? { min: typeof yr.min === 'number' ? Math.max(0, Math.floor(yr.min)) : null, max: typeof yr.max === 'number' ? Math.max(0, Math.floor(yr.max)) : null }
    : null;
  const st = d.statements && typeof d.statements === 'object' ? d.statements as Dict : {};
  const sponsorship = st.sponsorship === 'yes' || st.sponsorship === 'no' ? st.sponsorship : null;
  const rs = d.remoteScope && typeof d.remoteScope === 'object' ? d.remoteScope as Dict : null;
  const remoteScope = rs && Array.isArray(rs.regions)
    ? { regions: stringList(rs.regions).map((r) => r.toUpperCase()), text: str(rs.text) ?? '' }
    : null;
  const firstSeen = isoOrNull(d.firstSeenAt) ?? nowIso;
  const lastSeen = isoOrNull(d.lastSeenAt) ?? nowIso;
  let sources: SourceAttribution[] = [];
  if (Array.isArray(d.sources)) {
    for (const s of d.sources) {
      if (!s || typeof s !== 'object') continue;
      const sd = s as Dict;
      const sid = str(sd.sourceId);
      const surl = str(sd.url);
      if (!sid || !surl || !/^https?:\/\//i.test(surl)) continue;
      const credit = sd.credit && typeof sd.credit === 'object' && str((sd.credit as Dict).text) && str((sd.credit as Dict).url)
        ? { text: str((sd.credit as Dict).text)!, url: str((sd.credit as Dict).url)! } : null;
      sources.push({ sourceId: sid, name: str(sd.name) ?? sid, url: surl, credit, firstSeenAt: isoOrNull(sd.firstSeenAt) ?? firstSeen, lastSeenAt: isoOrNull(sd.lastSeenAt) ?? lastSeen });
    }
  }
  if (sources.length === 0) {
    const sid = ats && ats !== 'other' ? (ats === 'external' ? 'external:url' : `ats:${ats}`) : defaultSource?.sourceId ?? 'import';
    const name = ats && ats !== 'external' && ats !== 'other' ? `${company} careers (${ats[0]!.toUpperCase()}${ats.slice(1)})` : defaultSource?.name ?? 'Imported file';
    sources = [{ sourceId: sid, name, url, credit: null, firstSeenAt: firstSeen, lastSeenAt: lastSeen }];
  }
  const status = d.status === 'closed' ? 'closed' : 'open';
  const job: Job = {
    id,
    status,
    closedAt: status === 'closed' ? isoOrNull(d.closedAt) ?? nowIso : null,
    closedReason: status === 'closed' ? (enumOrNull(d.closedReason, ['unseen', 'board_empty', 'source_removed', 'user'] as const) ?? 'source_removed') : null,
    title,
    company,
    companyKey: str(d.companyKey) ?? companyKeyOf(company),
    ats: (ats ?? null) as Job['ats'],
    board,
    externalId,
    url,
    applyUrl: str(d.applyUrl) && /^https?:\/\//i.test(str(d.applyUrl)!) ? str(d.applyUrl) : null,
    canonicalUrl: /^https?:\/\//.test(canonical) ? canonical : url,
    places,
    isUs,
    workModel: enumOrNull(d.workModel, WORK_MODELS),
    remoteScope,
    employmentType: enumOrNull(d.employmentType, EMPLOYMENT_TYPES),
    level: levelOk ? level as Job['level'] : null,
    levels,
    yearsRequired,
    pay: normalizePay(d.pay),
    postedAt: isoOrNull(d.postedAt),
    firstSeenAt: firstSeen,
    lastSeenAt: lastSeen,
    updatedAt: nowIso,
    department: str(d.department),
    statements: {
      sponsorship,
      clearanceRequired: typeof st.clearanceRequired === 'boolean' ? st.clearanceRequired : null,
      usCitizenOnly: typeof st.usCitizenOnly === 'boolean' ? st.usCitizenOnly : null,
    },
    skills: stringList(d.skills),
    evidence: d.evidence && typeof d.evidence === 'object' ? d.evidence as Job['evidence'] : {},
    sources,
    duplicateOf: null,
    contentHash: '',
    description: typeof d.description === 'string' ? d.description : '',
  };
  if (job.ats !== null && !['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'personio', 'workday', 'icims', 'smartrecruiters', 'oracle', 'ukg', 'taleo', 'jobvite', 'bamboohr', 'teamtailor', 'breezy', 'other'].includes(job.ats)) {
    job.ats = 'other';
  }
  if (d.ephemeral === true) job.ephemeral = true;
  job.contentHash = contentHashOf(job);
  const v = validate(JobSchema, job);
  if (!v.ok) {
    const first = v.issues[0]!;
    return { job: null, error: `${first.path || 'job'}: ${first.message}` };
  }
  return { job, error: null };
}

// ---------------------------------------------------------------- hashes and keys

/** Hash of what a reader sees. Bookkeeping times and source seen-times are not part of it. */
export function contentHashOf(j: Job): string {
  return sha256(JSON.stringify([
    j.title, j.company, j.url, j.applyUrl, j.places, j.isUs, j.workModel, j.remoteScope, j.employmentType, j.level,
    j.levels, j.yearsRequired, j.pay, j.postedAt, j.department, j.statements, j.skills, j.description,
  ])).slice(0, 32);
}

/** The recipe of the text that fit indexing embeds. Bump it and every job is embedded again (never mixed). */
export const EMBED_RECIPE = 'r1';
const ROLE_SECTION = /(what you('|’)ll do|what you will do|responsibilities|about the role|about this role|the role|your role|role overview|job summary|position summary|job description|the opportunity|what you('|’)ll be doing)\s*:?/i;

/** Title, skills and the part of the description most about the role (at most about 450 characters of it). */
export function embedTextOf(j: Pick<Job, 'title' | 'skills' | 'department' | 'description'>): string {
  const desc = j.description ?? '';
  let start = 0;
  const head = desc.slice(0, 4000);
  const m = ROLE_SECTION.exec(head);
  if (m && m.index > 0) start = m.index;
  const excerpt = desc.slice(start, start + 450).replace(/\s+/g, ' ').trim();
  const parts = [j.title];
  if (j.department) parts.push(j.department);
  if (j.skills.length > 0) parts.push(`Skills: ${j.skills.slice(0, 20).join(', ')}`);
  if (excerpt) parts.push(excerpt);
  return parts.join('. ');
}

export function embedHashOf(text: string): string {
  return sha256(`${EMBED_RECIPE}\u0000${text}`).slice(0, 32);
}

/** ATS families whose posting ids are unique across all companies. */
const GLOBAL_ID_ATS = new Set(['greenhouse', 'lever', 'ashby']);

/** Posting ids that a link names (Greenhouse gh_jid or /jobs/<n>, Lever and Ashby posting UUIDs). */
export function postingKeysFromUrl(url: string | null): string[] {
  if (!url) return [];
  let u: URL;
  try { u = new URL(url); } catch { return []; }
  const out: string[] = [];
  const host = u.hostname.toLowerCase();
  const gh = u.searchParams.get('gh_jid');
  if (gh && /^\d{4,}$/.test(gh)) out.push(`post:greenhouse:${gh}`);
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const m = /\/jobs\/(\d{4,})/.exec(u.pathname);
    if (m) out.push(`post:greenhouse:${m[1]}`);
  }
  if (/(^|\.)lever\.co$/.test(host)) {
    const m = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(u.pathname);
    if (m) out.push(`post:lever:${m[1]!.toLowerCase()}`);
  }
  if (/(^|\.)ashbyhq\.com$/.test(host)) {
    const m = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(u.pathname);
    if (m) out.push(`post:ashby:${m[1]!.toLowerCase()}`);
  }
  return out;
}

export interface JobKeys {
  /** Keys that surely name this posting (id, canonical links, ATS posting ids). */
  strong: string[];
  /** Posting-id keys only (two different ids in the same family = two different postings). */
  postingIds: string[];
  /** Same company, title, places and text: the same posting seen through another source. */
  content: string;
}

export function keysOf(j: Job): JobKeys {
  const strong = new Set<string>([`id:${j.id}`]);
  for (const u of [j.canonicalUrl, j.url]) {
    const c = canonicalizeUrl(u);
    if (c) strong.add(`url:${c}`);
  }
  const postingIds = new Set<string>();
  if (j.ats && GLOBAL_ID_ATS.has(j.ats) && j.externalId) postingIds.add(`post:${j.ats}:${j.externalId.toLowerCase()}`);
  else if (j.ats && j.board && j.externalId) postingIds.add(`post:${j.ats}:${j.board.toLowerCase()}:${j.externalId.toLowerCase()}`);
  for (const u of [j.url, j.canonicalUrl, j.applyUrl]) for (const k of postingKeysFromUrl(u)) postingIds.add(k);
  for (const k of postingIds) strong.add(k);
  const placeKey = j.places.map((p) => foldPlace(p.text)).sort().join(';');
  const content = `content:${sha256([companyKeyOf(j.company), foldPlace(j.title), placeKey, sha256(j.description.replace(/\s+/g, ' ').trim())].join('\u0000')).slice(0, 32)}`;
  return { strong: [...strong], postingIds: [...postingIds], content };
}

/** Which source wins when two sources describe the same posting: the employer's ATS, then feeds, then added jobs. */
export function precedenceOf(j: Job): number {
  if (j.ats && j.ats !== 'other') return 3;
  if (j.sources.some((s) => s.sourceId.startsWith('external:'))) return 1;
  return 2;
}

/** The board a refresh covers: "<ats>:<board>" for ATS jobs, else the first source id. */
export function boardScopeOf(j: Job): string | null {
  if (j.ats && j.board && j.ats !== 'other') return `${j.ats}:${j.board.toLowerCase()}`;
  return j.sources[0]?.sourceId ?? null;
}

// ---------------------------------------------------------------- facets (what the in-memory filter reads)

export const WORK_MODEL_CODE: Record<string, number> = { onsite: 1, hybrid: 2, remote: 3 };
export const EMP_TYPE_CODE: Record<string, number> = { full_time: 1, part_time: 2, contract: 3, internship: 4, temporary: 5, other: 6 };
export const LEVEL_BIT: Record<string, number> = Object.fromEntries(EXPERIENCE_LEVELS.map((l, i) => [l, 1 << i]));

export const STMT_SPONSOR_YES = 1, STMT_SPONSOR_NO = 2, STMT_CLEARANCE_YES = 4, STMT_CLEARANCE_NO = 8, STMT_CITIZEN_YES = 16, STMT_CITIZEN_NO = 32;

const MANAGER_TITLE = /\b(manager|mgr|director|head of|vice president|vp|chief|supervisor|superintendent)\b/i;

export interface Facets {
  levelMask: number;
  workModel: number;
  empType: number;
  /** 255 = unknown. */
  yearsMin: number;
  stmt: number;
  /** 0 = individual contributor, 1 = manager. */
  roleType: number;
  titleLen: number;
  /** -1 unknown, 0 no, 1 yes. */
  isUs: number;
  /** 0 = no pay stated, 1 = USD, 2 = another currency. */
  payKind: number;
  /** ms since epoch, NaN = unknown. */
  postedMs: number;
  /** Annual USD, NaN = unknown. */
  payLo: number;
  payHi: number;
  tags: string[];
}

export function facetsOf(j: Job): Facets {
  let levelMask = 0;
  for (const l of j.levels) levelMask |= LEVEL_BIT[l] ?? 0;
  let stmt = 0;
  if (j.statements.sponsorship === 'yes') stmt |= STMT_SPONSOR_YES;
  if (j.statements.sponsorship === 'no') stmt |= STMT_SPONSOR_NO;
  if (j.statements.clearanceRequired === true) stmt |= STMT_CLEARANCE_YES;
  if (j.statements.clearanceRequired === false) stmt |= STMT_CLEARANCE_NO;
  if (j.statements.usCitizenOnly === true) stmt |= STMT_CITIZEN_YES;
  if (j.statements.usCitizenOnly === false) stmt |= STMT_CITIZEN_NO;
  const manager = (j.level && ['manager', 'director', 'vp', 'exec'].includes(j.level)) || MANAGER_TITLE.test(j.title);
  const tags = new Set<string>();
  for (const p of j.places) {
    const city = foldPlace(p.city);
    const region = regionKey(p.region);
    const text = foldPlace(p.text);
    const country = p.country ?? null;
    if (city) { tags.add(`pc:${city}`); tags.add(`p:${city}|${region}`); }
    if (region) tags.add(`pr:${region}`);
    if (text) tags.add(`pt:${text}`);
    if (p.placeId) tags.add(`pid:${p.placeId}`);
    const c = country ?? countryFromText(p.text);
    if (c) tags.add(`c:${c}`);
  }
  if (j.isUs === true) tags.add('c:US');
  for (const s of j.skills) tags.add(`k:${skillKey(s)}`);
  for (const s of j.sources) tags.add(`s:${s.sourceId.toLowerCase()}`);
  if (j.remoteScope) for (const r of j.remoteScope.regions) tags.add(`rr:${r.toUpperCase()}`);
  let payKind = 0, payLo = NaN, payHi = NaN;
  if (j.pay) {
    payKind = j.pay.currency === 'USD' ? 1 : 2;
    if (payKind === 1) {
      payLo = j.pay.annualMin ?? NaN;
      payHi = j.pay.annualMax ?? NaN;
    }
  }
  const posted = j.postedAt ? Date.parse(j.postedAt) : NaN;
  return {
    levelMask,
    workModel: j.workModel ? WORK_MODEL_CODE[j.workModel]! : 0,
    empType: j.employmentType ? EMP_TYPE_CODE[j.employmentType]! : 0,
    yearsMin: j.yearsRequired ? Math.min(254, j.yearsRequired.min ?? j.yearsRequired.max ?? 254) : 255,
    stmt,
    roleType: manager ? 1 : 0,
    titleLen: titleTokenCount(j.title),
    isUs: j.isUs === null ? -1 : j.isUs ? 1 : 0,
    payKind,
    postedMs: Number.isFinite(posted) ? posted : NaN,
    payLo,
    payHi,
    tags: [...tags],
  };
}
const HEADER = 32;

/** Packs facets with tag ids (the ids come from the facet_tags table). */
export function packFacets(f: Facets, tagIds: number[], companyTagId: number): Uint8Array {
  const buf = new Uint8Array(HEADER + tagIds.length * 4);
  const v = new DataView(buf.buffer);
  v.setUint8(0, 1);
  v.setUint8(1, f.levelMask);
  v.setUint8(2, f.workModel);
  v.setUint8(3, f.empType);
  v.setUint8(4, f.yearsMin);
  v.setUint8(5, f.stmt);
  v.setUint8(6, f.roleType);
  v.setUint8(7, f.titleLen);
  v.setInt8(8, f.isUs);
  v.setUint8(9, f.payKind);
  v.setUint16(10, tagIds.length, true);
  v.setInt32(12, companyTagId, true);
  v.setFloat64(16, f.postedMs, true);
  v.setFloat32(24, f.payLo, true);
  v.setFloat32(28, f.payHi, true);
  for (let i = 0; i < tagIds.length; i++) v.setUint32(HEADER + i * 4, tagIds[i]!, true);
  return buf;
}

export interface PackedFacets {
  levelMask: number; workModel: number; empType: number; yearsMin: number; stmt: number; roleType: number;
  titleLen: number; isUs: number; payKind: number; postedMs: number; payLo: number; payHi: number;
  tagIds: Uint32Array | number[];
}

export function unpackFacets(buf: Uint8Array): PackedFacets {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = v.getUint16(10, true);
  const tagIds: number[] = new Array(n);
  for (let i = 0; i < n; i++) tagIds[i] = v.getUint32(HEADER + i * 4, true);
  return {
    levelMask: v.getUint8(1), workModel: v.getUint8(2), empType: v.getUint8(3), yearsMin: v.getUint8(4),
    stmt: v.getUint8(5), roleType: v.getUint8(6), titleLen: v.getUint8(7), isUs: v.getInt8(8), payKind: v.getUint8(9),
    postedMs: v.getFloat64(16, true), payLo: v.getFloat32(24, true), payHi: v.getFloat32(28, true), tagIds,
  };
}

/** The text of the head FTS table's third column: skills, department and places. */
export function extraTextOf(j: Job): string {
  return [j.skills.join(' ; '), j.department ?? '', j.places.map((p) => p.text).join(' ; ')].join(' ; ');
}
