import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TrackerEntry, TrackerList } from '@jobleft/contracts';
import { applicationsPerWeek, appliedTime, nextReminder, openReminders, reminderTimeProblem, weekStart } from '../src/lib/trackerView.ts';

type Item = TrackerList['items'][number];
const NOW = Date.parse('2026-09-27T15:00:00Z');

function entry(jobId: string, over: Partial<TrackerEntry> = {}): TrackerEntry {
  return { jobId, liked: false, hidden: false, external: false, status: null, statusHistory: [], appliedAt: null, resumeId: null, notes: [], reminders: [], createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', ...over };
}
const item = (e: TrackerEntry): Item => ({ entry: e, job: { id: e.jobId } as Item['job'] });
const rem = (id: string, at: string, done = false) => ({ id, at, text: id, done });

test('open reminders: liked and applied jobs alike, upcoming soonest first, then overdue marked; done ones left out (JL-tracker-1, -2, -9)', () => {
  const liked = item(entry('liked', { liked: true, reminders: [rem('email-sam', '2026-09-28T15:00:00Z')] }));
  const applied = item(entry('applied', { status: 'applied', reminders: [rem('applied-job', '2026-09-29T15:00:00Z'), rem('done', '2026-09-28T01:00:00Z', true)] }));
  const past = item(entry('past', { status: 'interviewing', reminders: [rem('yesterday', '2026-09-26T15:00:00Z'), rem('c-1900', '1900-01-01T00:00:00Z'), rem('oct-2', '2026-10-02T15:00:00Z')] }));
  const list = openReminders([applied, past, liked], NOW);
  assert.deepEqual(list.map((x) => x.r.id), ['email-sam', 'applied-job', 'oct-2', 'yesterday', 'c-1900']);
  assert.deepEqual(list.map((x) => x.overdue), [false, false, false, true, true]);
  assert.equal(list[0]!.it.entry.jobId, 'liked');
});

test('reminders compare as instants, never as text (JL-tracker-10)', () => {
  const a = item(entry('a', { status: 'applied', reminders: [rem('A offset -10:00', '2026-10-01T23:00:00-10:00')] }));
  const b = item(entry('b', { status: 'applied', reminders: [rem('B zulu', '2026-10-02T05:00:00Z')] }));
  assert.deepEqual(openReminders([a, b], NOW).map((x) => x.r.id), ['B zulu', 'A offset -10:00']);
  assert.equal(nextReminder(a.entry, NOW)?.r.id, 'A offset -10:00');
  assert.equal(nextReminder(entry('x', { reminders: [rem('old', '2026-09-01T00:00:00Z')] }), NOW)?.overdue, true);
  assert.equal(nextReminder(entry('y'), NOW), null);
});

test('applications per week: every application counts, whatever stage it went to first (JL-tracker-7)', () => {
  const at = (d: string) => ({ status: 'applied' as const, at: d });
  const items = [
    item(entry('applied', { status: 'applied', appliedAt: '2026-09-22T12:00:00Z', statusHistory: [at('2026-09-22T12:00:00Z')] })),
    // saved before later stages recorded the applied date: the first status time counts
    item(entry('offer', { status: 'offer_received', appliedAt: null, statusHistory: [{ status: 'offer_received', at: '2026-09-24T12:00:00Z' }] })),
    item(entry('interviewing', { status: 'interviewing', appliedAt: '2026-09-15T12:00:00Z' })),
    item(entry('old', { status: 'rejected', appliedAt: '2026-05-01T12:00:00Z' })),
    item(entry('liked only', { liked: true })),
    item(entry('back to not applied', { status: null, appliedAt: '2026-09-23T12:00:00Z' })),
  ];
  const w = applicationsPerWeek(items, NOW);
  assert.equal(w.weeks.length, 8);
  assert.equal(w.weeks.at(-1), weekStart(NOW));
  assert.equal(w.total, 4);
  assert.equal(w.earlier, 1);
  assert.equal(w.counts.reduce((a, b) => a + b, 0) + w.earlier, w.total, 'the bars and the earlier count add up to every application');
  assert.equal(w.counts.at(-1), 2);
  assert.equal(w.counts.at(-2), 1);
  assert.equal(appliedTime(items[4]!.entry), null);
});

test('a reminder time in the past is refused with a plain reason (JL-tracker-9)', () => {
  const local = (t: number) => { const d = new Date(t - new Date(t).getTimezoneOffset() * 60_000); return d.toISOString().slice(0, 16); };
  assert.match(reminderTimeProblem(local(NOW - 3 * 3600_000), NOW) ?? '', /passed/);
  assert.equal(reminderTimeProblem(local(NOW + 3600_000), NOW), null);
  assert.match(reminderTimeProblem('', NOW) ?? '', /Pick/);
});
