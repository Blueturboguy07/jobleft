// What the Tracker, the Dashboard and Alerts show from the tracker list, computed in one place so the three screens
// always agree: the open reminders (upcoming first, then overdue, compared as instants, never as text) and the
// applications per week (every application counts, whatever stage it went to first).

import type { Reminder, TrackerEntry, TrackerList } from '@jobleft/contracts';

type Item = TrackerList['items'][number];

export interface OpenReminder { r: Reminder; it: Item; at: number; overdue: boolean }

const instant = (at: string): number => { const t = Date.parse(at); return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY; };

function order<T extends { r: Reminder; at: number; overdue: boolean }>(xs: T[]): T[] {
  const upcoming = xs.filter((x) => !x.overdue).sort((a, b) => a.at - b.at || a.r.id.localeCompare(b.r.id));
  const overdue = xs.filter((x) => x.overdue).sort((a, b) => b.at - a.at || a.r.id.localeCompare(b.r.id));
  return [...upcoming, ...overdue];
}

const open = (e: TrackerEntry, now: number) => e.reminders.filter((r) => !r.done).map((r) => ({ r, at: instant(r.at), overdue: instant(r.at) <= now }));

/**
 * Every reminder not marked done, on every tracked job. Upcoming ones come first, soonest first; then the ones whose
 * time has passed, marked overdue, most recent first. "2026-10-01T23:00:00-10:00" is later than "2026-10-02T05:00:00Z".
 */
export function openReminders(items: readonly Item[], now: number): OpenReminder[] {
  return order(items.flatMap((it) => open(it.entry, now).map((x) => ({ ...x, it }))));
}

/** The one reminder a job card shows: the next upcoming one, else the latest overdue one. */
export function nextReminder(e: TrackerEntry, now: number): { r: Reminder; overdue: boolean } | null {
  return order(open(e, now))[0] ?? null;
}

/**
 * When the person applied: the applied date, else (entries saved before every stage recorded it) the time the job
 * first got a status. null = not an application.
 */
export function appliedTime(e: TrackerEntry): number | null {
  if (e.status === null) return null;
  if (e.appliedAt) return Date.parse(e.appliedAt);
  const first = e.statusHistory.find((h) => h.status !== null);
  return first ? Date.parse(first.at) : null;
}

/** Monday 00:00 (local time) of the week that holds `t`. */
export function weekStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** Applications per week over the last `n` weeks; `earlier` counts the applications before the first week shown. */
export function applicationsPerWeek(items: readonly Item[], now: number, n = 8): { weeks: number[]; counts: number[]; earlier: number; total: number } {
  const last = weekStart(now);
  // Step back by calendar weeks (not 7 x 24 h), so a daylight-saving change never shifts a week start.
  const weeks = Array.from({ length: n }, (_, i) => { const d = new Date(last); d.setDate(d.getDate() - (n - 1 - i) * 7); return d.getTime(); });
  const counts = weeks.map(() => 0);
  let earlier = 0;
  let total = 0;
  for (const it of items) {
    const at = appliedTime(it.entry);
    if (at === null || !Number.isFinite(at)) continue;
    total++;
    const idx = weeks.indexOf(weekStart(at));
    if (idx >= 0) counts[idx]!++;
    else if (at < weeks[0]!) earlier++;
  }
  return { weeks, counts, earlier, total };
}

/** Why a new reminder time cannot be saved, or null when it can. The value is a datetime-local text. */
export function reminderTimeProblem(value: string, now: number): string | null {
  if (!value) return 'Pick a date and time.';
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return 'Pick a date and time.';
  if (t <= now) return 'That time has passed. Pick a time in the future.';
  return null;
}
