// The daily summary: when it is due, what it says, and what GET /digest answers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestDue, digestText, localDay, profileFilter } from '../src/interim/digest.ts';
import { cleanup, startTest } from './helpers.ts';

test('the daily summary is due once a day, at the hour or the first look after it, counting from the last one', () => {
  const at = (h: number, day = 12) => new Date(2026, 9, day, h, 5);
  assert.equal(digestDue(at(7), {}, null), null, 'before 8 by default');
  assert.equal(digestDue(at(9), { digest: false }, null), null, 'off');
  assert.equal(digestDue(at(9), { digestHour: 10 }, null), null);
  assert.equal(digestDue(at(9), {}, null)!.getTime(), at(9).getTime() - 86_400_000, 'the first: the last 24 hours');
  const last = { date: localDay(at(8, 11)), at: at(8, 11).toISOString() };
  assert.equal(digestDue(at(9), {}, last)!.toISOString(), last.at, 'from the last one');
  assert.equal(digestDue(at(23), {}, { date: localDay(at(9)), at: at(9).toISOString() }), null, 'once a day');
  const old = { date: '2026-09-01', at: new Date(2026, 8, 1, 8).toISOString() };
  assert.equal(digestDue(at(9), {}, old)!.getTime(), at(9).getTime() - 7 * 86_400_000, 'at most a week back');
});

test('the summary text: the count, the best fit, and what is due; nothing when there is nothing', () => {
  const item = (title: string, percent: number | null) => ({ job: { title, company: 'Acme' }, match: percent === null ? null : { percent } }) as never;
  const g = (boards: unknown[], web: unknown[], r = 0, f = 0) => ({ since: '', until: '', boards: { total: boards.length, top: boards }, web: { total: web.length, top: web }, remindersDue: r, followUpsDue: f }) as never;
  assert.equal(digestText(g([], [])), null);
  assert.deepEqual(digestText(g([item('SOC Analyst', 71), item('Analyst', 90)], [item('SOC analist', 55)], 2)), {
    title: 'Today in jobleft: 3 new jobs for you', body: 'Best fit: Analyst at Acme (90%). 1 of them from web searches. 2 reminders due today.',
  });
  assert.deepEqual(digestText(g([], [], 0, 1)), { title: 'Today in jobleft: nothing new, but things are due', body: '1 follow-up due.' });
  assert.deepEqual(profileFilter(null), {});
});

test('GET /digest: the new jobs of the last hours, from the boards and from web searches, best first', async () => {
  const s = await startTest('digest');
  try {
    let d = (await s.call('GET', '/api/v1/digest')).json;
    assert.deepEqual([d.boards.total, d.web.total, d.remindersDue], [0, 0, 0]);
    const ext = await s.call('POST', '/api/v1/jobs/external', { text: 'SOC Analyst\nCompany: Acme Security\nLocation: Utrecht, Netherlands\nYou watch the alerts.' });
    assert.equal(ext.status, 200, ext.text);
    const web = await s.call('POST', '/api/v1/websearch/save', { url: 'https://werken.voorbeeld.nl/vacature/1', title: 'SOC analist bij Gemeente Voorbeeld', snippet: 'Utrecht' });
    assert.equal(web.status, 200, web.text);
    await s.call('PATCH', `/api/v1/tracker/${encodeURIComponent(ext.json.job.id)}`, { reminders: [{ at: new Date(Date.now() - 60_000).toISOString(), text: 'Apply', done: false }] });
    d = (await s.call('GET', '/api/v1/digest?hours=24')).json;
    assert.deepEqual([d.boards.total, d.web.total, d.remindersDue], [1, 1, 1]);
    assert.equal(d.boards.top[0].job.title, 'SOC Analyst');
    assert.equal(d.web.top[0].job.company, 'Gemeente Voorbeeld');
    // A hidden job is not news.
    await s.call('PATCH', `/api/v1/tracker/${encodeURIComponent(ext.json.job.id)}`, { hidden: true });
    assert.equal((await s.call('GET', '/api/v1/digest')).json.boards.total, 0);
    // The settings keep the summary's choices when a writer leaves them out.
    const st = (await s.call('GET', '/api/v1/settings')).json;
    assert.deepEqual([st.notifications.digest, st.notifications.digestHour], [true, 8]);
    await s.call('PUT', '/api/v1/settings', { ...st, notifications: { ...st.notifications, digestHour: 7 } });
    await s.call('PUT', '/api/v1/settings', { ...st, notifications: { reminders: true, alerts: false } });
    const after = (await s.call('GET', '/api/v1/settings')).json.notifications;
    assert.deepEqual([after.alerts, after.digest, after.digestHour], [false, true, 7]);
  } finally { await s.stop(); cleanup(s.home); }
});
