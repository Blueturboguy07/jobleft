// Compact, honest views of the person's records for the model. Rules:
//   * a fact the record does not state is `null` with a plain note ("not listed"), never a guess or a default;
//   * lists carry facts only, never the description text (a request carries only the jobs the question is about);
//   * dates are shown in the person's own time zone with the zone named, so "today" and "overdue" agree with the screens.

import { TRACKER_STATUS_LABELS, formatDollars, nowMs, type Job, type JobSummary, type Pay, type TrackerEntry } from '@jobleft/contracts';

/** The person's time zone: JOBLEFT_TZ, then TZ, then the system zone. */
export function zoneOf(env: Record<string, string | undefined> = process.env): string {
  const z = env.JOBLEFT_TZ || env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try { new Intl.DateTimeFormat('en-CA', { timeZone: z }); return z; } catch { return 'UTC'; }
}

function parts(ms: number, tz: string): Record<string, string> {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
}

/** "2026-10-01" in the zone. */
export function localDate(iso: string | number, tz: string): string {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso);
  const p = parts(ms, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "2026-10-01 10:00" in the zone. */
export function localDateTime(iso: string, tz: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const p = parts(ms, tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function money(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

/** The pay exactly as the posting states it; null = the posting lists no pay. */
export function payText(pay: Pay | null | undefined): string | null {
  if (!pay) return null;
  const sym = pay.currency === 'USD' ? '$' : `${pay.currency} `;
  const per = pay.period === 'year' ? 'per year' : `per ${pay.period}`;
  if (pay.min !== null && pay.max !== null) return `${sym}${money(pay.min)} to ${sym}${money(pay.max)} ${per}`;
  if (pay.max !== null) return `up to ${sym}${money(pay.max)} ${per}`;
  if (pay.min !== null) return `from ${sym}${money(pay.min)} ${per}`;
  return null;
}

export interface JobCard {
  id: string;
  title: string;
  company: string;
  status: 'open' | 'closed';
  places: string[];
  workModel: string | null;
  employmentType: string | null;
  pay: string | null;
  postedAt: string | null;
  link: string;
  applyLink: string | null;
  trackerStatus?: string | null;
  liked?: boolean;
  hidden?: boolean;
  matchPercent?: number | null;
  notStated: string[];
}

export function jobCard(job: Job | JobSummary, extra: { trackerStatus?: string | null; liked?: boolean; hidden?: boolean; matchPercent?: number | null } = {}): JobCard {
  const pay = payText(job.pay);
  const notStated: string[] = [];
  if (pay === null) notStated.push('pay');
  if (!job.places.length) notStated.push('place');
  if (!job.workModel) notStated.push('work model');
  if (!job.postedAt) notStated.push('posted date');
  return {
    id: job.id, title: job.title, company: job.company, status: job.status,
    places: job.places.slice(0, 3).map((p) => p.text), workModel: job.workModel, employmentType: job.employmentType,
    pay, postedAt: job.postedAt, link: job.url, applyLink: job.applyUrl,
    ...(extra.trackerStatus !== undefined ? { trackerStatus: extra.trackerStatus === null ? null : (TRACKER_STATUS_LABELS[extra.trackerStatus as keyof typeof TRACKER_STATUS_LABELS] ?? extra.trackerStatus) } : {}),
    ...(extra.liked !== undefined ? { liked: extra.liked } : {}),
    ...(extra.hidden !== undefined ? { hidden: extra.hidden } : {}),
    ...(extra.matchPercent !== undefined ? { matchPercent: extra.matchPercent } : {}),
    notStated,
  };
}

export function trackerView(t: TrackerEntry, tz: string) {
  return {
    status: t.status ? TRACKER_STATUS_LABELS[t.status] : null,
    liked: t.liked, hidden: t.hidden, external: t.external,
    appliedOn: t.appliedAt ? localDate(t.appliedAt, tz) : null,
    statusHistory: t.statusHistory.map((h) => ({ status: h.status ? TRACKER_STATUS_LABELS[h.status] : null, on: localDate(h.at, tz) })),
    notes: t.notes.map((n) => ({ id: n.id, text: n.text.slice(0, 500), on: localDate(n.updatedAt, tz) })),
    reminders: t.reminders.map((r) => ({ id: r.id, text: r.text, due: localDateTime(r.at, tz), done: r.done, overdue: !r.done && Date.parse(r.at) < nowMs() })),
  };
}

export function dollars(micros: number): string { return formatDollars(micros); }

/** Cuts text to at most `n` characters, on a whole character. */
export function clip(text: string, n: number): string {
  const chars = [...text];
  return chars.length <= n ? text : chars.slice(0, n).join('') + '…';
}
