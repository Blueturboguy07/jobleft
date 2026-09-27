// How facts read on screen. Rule (INTERFACES 1.5): null means unknown. These helpers return null for an unknown
// fact, so the screen leaves it out; they never print "$0", "0+ years", "undefined", "null" or "NaN".
// Pure functions: the unit tests run them under Node.

import {
  EXPERIENCE_LEVEL_LABELS, TRACKER_STATUS_LABELS, formatDollars, type EmploymentType, type ExperienceLevel, type Job, type JobSummary,
  type Pay, type PayPeriod, type Place, type WorkModel,
} from '@jobleft/contracts';

export { formatDollars };

const SYMBOL: Record<string, string> = { USD: '$', CAD: 'CA$', GBP: '£', EUR: '€', AUD: 'A$' };
const PERIOD_SHORT: Record<PayPeriod, string> = { hour: '/hr', day: '/day', week: '/wk', month: '/mo', year: '/yr' };
const PERIOD_WORD: Record<PayPeriod, string> = { hour: 'an hour', day: 'a day', week: 'a week', month: 'a month', year: 'a year' };

function num(v: number): string {
  if (!Number.isFinite(v)) return '';
  return v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

/** "$88K" only when that is exact to the hundred ("$88.5K"); otherwise the full number ("$88,550"). */
export function money(v: number, currency: string, compact = true): string {
  const sym = SYMBOL[currency] ?? `${currency} `;
  if (compact && v >= 1000 && v % 100 === 0) {
    const k = v / 1000;
    return `${sym}${k.toLocaleString('en-US', { maximumFractionDigits: 1 })}K`;
  }
  return `${sym}${num(v)}`;
}

/** Pay as the posting states it: "$38.50/hr - $52/hr", "Up to $150K/yr", "From $20/hr". null when not stated. */
export function payText(pay: Pay | null | undefined): string | null {
  if (!pay) return null;
  // a zero or broken number is "not stated", never "$0"
  const min = typeof pay.min === 'number' && Number.isFinite(pay.min) && pay.min > 0 ? pay.min : null;
  const max = typeof pay.max === 'number' && Number.isFinite(pay.max) && pay.max > 0 ? pay.max : null;
  if (min === null && max === null) return null;
  const u = PERIOD_SHORT[pay.period] ?? '';
  const f = (v: number) => `${money(v, pay.currency, pay.period === 'year')}${u}`;
  if (min !== null && max !== null) return min === max ? f(min) : `${f(min)} - ${f(max)}`;
  if (min !== null) return `From ${f(min)}`;
  return `Up to ${f(max!)}`;
}

/** The yearly figure for hourly or monthly pay, marked as converted. null for yearly pay or no pay. */
export function payConvertedText(pay: Pay | null | undefined): string | null {
  if (!pay || pay.period === 'year') return null;
  const lo = typeof pay.annualMin === 'number' && Number.isFinite(pay.annualMin) && pay.annualMin > 0 ? pay.annualMin : null;
  const hi = typeof pay.annualMax === 'number' && Number.isFinite(pay.annualMax) && pay.annualMax > 0 ? pay.annualMax : null;
  if (lo === null && hi === null) return null;
  const f = (v: number) => money(v, pay.currency);
  const range = lo !== null && hi !== null
    ? (lo === hi ? f(lo) : `${f(lo)} - ${f(hi)}`)
    : lo !== null ? `from ${f(lo)}` : `up to ${f(hi!)}`;
  return `About ${range} a year if full-time (converted from pay ${PERIOD_WORD[pay.period]})`;
}

export function payNotes(pay: Pay | null | undefined): string[] {
  if (!pay) return [];
  const out: string[] = [];
  if (pay.ranges > 1) out.push(`The posting lists ${pay.ranges} pay ranges (for example by city or level).`);
  out.push(pay.source === 'board_field' ? "From the employer's pay field." : 'Read from the posting text.');
  return out;
}

const TYPE_LABELS: Record<EmploymentType, string> = { full_time: 'Full-time', part_time: 'Part-time', contract: 'Contract', internship: 'Internship', temporary: 'Temporary', other: 'Other type' };
const MODEL_LABELS: Record<WorkModel, string> = { onsite: 'Onsite', hybrid: 'Hybrid', remote: 'Remote' };

export function typeText(t: EmploymentType | null | undefined): string | null {
  return t ? TYPE_LABELS[t] ?? null : null;
}

export function workModelText(job: Pick<JobSummary, 'workModel' | 'remoteScope'>): string | null {
  if (!job.workModel) return null;
  const base = MODEL_LABELS[job.workModel] ?? null;
  if (job.workModel === 'remote' && job.remoteScope?.text) return job.remoteScope.text;
  return base;
}

export function levelsText(levels: ExperienceLevel[] | undefined): string | null {
  if (!levels || !levels.length) return null;
  const labels = levels.map((l) => EXPERIENCE_LEVEL_LABELS[l]).filter(Boolean);
  if (!labels.length) return null;
  if (labels.length === 1) return labels[0]!;
  // "Entry, Mid, Senior Level"
  const short = labels.map((l) => l.replace(/ Level$/, ''));
  return `${short.join(', ')}${labels.every((l) => l.endsWith(' Level')) ? ' Level' : ''}`;
}

export function yearsText(y: Job['yearsRequired'] | undefined): string | null {
  if (!y) return null;
  const { min, max } = y;
  if (min !== null && max !== null) return min === max ? `${min} years exp` : `${min}-${max} years exp`;
  if (min !== null) return min === 0 ? 'No minimum years' : `${min}+ years exp`;
  if (max !== null) return `Up to ${max} years exp`;
  return null;
}

/** The first place plus "+N more", and every place for a tooltip. */
export function placesText(places: Place[] | undefined): { first: string; more: number; all: string[] } | null {
  if (!places || !places.length) return null;
  const all = places.map((p) => p.text).filter((t) => t && t.trim());
  if (!all.length) return null;
  return { first: all[0]!, more: all.length - 1, all };
}

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

/** "3 hours ago", "2 days ago", "3 weeks ago"; an absolute date past 60 days or for a time in the future. */
export function ago(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = now - t;
  if (d < 0) return dateText(iso);
  if (d < MINUTE) return 'Just now';
  if (d < HOUR) { const m = Math.floor(d / MINUTE); return `${m} ${m === 1 ? 'minute' : 'minutes'} ago`; }
  if (d < DAY) { const h = Math.floor(d / HOUR); return `${h} ${h === 1 ? 'hour' : 'hours'} ago`; }
  if (d < 14 * DAY) { const n = Math.floor(d / DAY); return `${n} ${n === 1 ? 'day' : 'days'} ago`; }
  if (d < 60 * DAY) { const w = Math.floor(d / (7 * DAY)); return `${w} weeks ago`; }
  return dateText(iso);
}

/** Whole seconds until `iso` (0 once it passed), for a countdown that reads right from its first frame. */
export function secondsLeft(iso: string, now = Date.now()): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.round((t - now) / 1000)) : 0;
}

/** "Sep 20, 2026" in the person's time zone. */
export function dateText(iso: string | null | undefined): string | null {
  if (!iso) return null;
  // a date without a time ("2026-09-24") is a calendar day, not a moment: no time-zone shift
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return calendarDate(iso);
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Sep 20, 2026, 3:04 PM CDT" in the person's time zone. */
export function dateTimeText(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

/** A calendar date "2026-09-25" shown as "Sep 25, 2026" without any time-zone shift. */
export function calendarDate(d: string | null | undefined): string | null {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, day!)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function yearMonthText(ym: string | null | undefined): string | null {
  if (!ym) return null;
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(ym);
  if (!m) return null;
  if (!m[2]) return m[1]!;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function statusLabel(s: keyof typeof TRACKER_STATUS_LABELS | null | undefined): string | null {
  return s ? TRACKER_STATUS_LABELS[s] : null;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** Initials for a monogram tile: "Harbor Health, Inc." -> "HH". */
export function initials(name: string): string {
  const words = name.replace(/,?\s+(inc|llc|ltd|corp)\.?$/i, '').split(/[\s&-]+/).filter((w) => /^[\p{L}\p{N}]/u.test(w));
  const s = words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  return s || '?';
}

/** A stable soft colour per company (no logo service is ever asked). */
export function monoColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const hues = [150, 190, 210, 260, 30, 45, 330, 110];
  return `hsl(${hues[h % hues.length]}, 70%, 88%)`;
}

/** Plain-text posting -> blocks (headings, paragraphs, bullet lists). Text only, never markup. */
export type Block = { kind: 'h'; text: string } | { kind: 'p'; text: string } | { kind: 'ul'; items: string[] };

export function textBlocks(text: string): Block[] {
  const out: Block[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let para: string[] = [];
  let list: string[] | null = null;
  const flushPara = () => { if (para.length) { out.push({ kind: 'p', text: para.join(' ') }); para = []; } };
  const flushList = () => { if (list && list.length) out.push({ kind: 'ul', items: list }); list = null; };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); flushList(); continue; }
    const bullet = /^([-*•·]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) { flushPara(); (list ??= []).push(bullet[2]!); continue; }
    flushList();
    const isHeading = line.length <= 60 && !/[.!?,;]$/.test(line) && /^[A-Z]/.test(line) && line.split(/\s+/).length <= 7 && para.length === 0;
    if (isHeading) { out.push({ kind: 'h', text: line.replace(/:$/, '') }); continue; }
    para.push(line);
  }
  flushPara();
  flushList();
  return out;
}

/** Keeps a URL only when it is an absolute http(s) link. */
export function safeUrl(u: string | null | undefined): string | null {
  return u && /^https?:\/\//i.test(u) ? u : null;
}

export function hostOf(u: string): string {
  try { return new URL(u).host; } catch { return u; }
}
