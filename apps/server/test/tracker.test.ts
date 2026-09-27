// The tracker keeps everything the person did in view (JL-tracker-6) and records when they applied, whatever stage a
// job goes to first (JL-tracker-7).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cleanup, startTest, type TestServer } from './helpers.ts';

async function addJob(s: TestServer, title: string): Promise<string> {
  const r = await s.call('POST', '/api/v1/jobs/external', { text: `${title}\nCompany: Acme Robotics\nWe build robots.`, applyUrl: `https://example.com/jobs/${encodeURIComponent(title)}` });
  assert.equal(r.status, 200, r.text);
  return r.json.job.id as string;
}

const patch = (s: TestServer, id: string, body: unknown) => s.call('PATCH', `/api/v1/tracker/${encodeURIComponent(id)}`, body);
const tracked = async (s: TestServer) => (await s.call('GET', '/api/v1/tracker?view=tracked')).json;

test('a job with notes, reminders or an applied date never drops out of the tracker', async () => {
  const s = await startTest('trk');
  try {
    // 1. Applied (never liked), with a note and a reminder, then set back to "Not applied".
    const a = await addJob(s, 'Data Analyst A');
    assert.equal((await patch(s, a, { status: 'applied', notes: [{ text: 'Referral from Pat, keep this.' }], reminders: [{ at: '2026-10-29T15:00:00Z', text: 'Call Pat', done: false }] })).status, 200);
    const back = await patch(s, a, { status: null });
    assert.equal(back.status, 200, back.text);
    assert.equal(back.json.status, null);
    assert.equal(back.json.appliedAt, null, 'a job set back to "not applied" has no applied date (JL-v2-4)');
    assert.equal(back.json.notes.length, 1, 'its note stays');

    // 2. Liked with a note and a reminder, then unliked.
    const b = await addJob(s, 'Data Analyst B');
    await patch(s, b, { liked: true, notes: [{ text: 'Recruiter Dana said apply by Oct 5' }], reminders: [{ at: '2026-10-04T15:00:00Z', text: 'Apply', done: false }] });
    assert.equal((await patch(s, b, { liked: false })).json.liked, false);

    // 3. A note on a job that was never liked or applied; a reminder on another.
    const c = await addJob(s, 'Data Analyst C');
    await patch(s, c, { notes: [{ text: 'Looks interesting' }] });
    const d = await addJob(s, 'Data Analyst D');
    await patch(s, d, { reminders: [{ at: '2026-10-02T15:00:00Z', text: 'Read about the team', done: false }] });

    // A job only added (nothing done to it yet) stays in the External tab only.
    const e = await addJob(s, 'Data Analyst E');

    const t = await tracked(s);
    const ids = t.items.map((x: any) => x.entry.jobId);
    for (const id of [a, b, c, d]) assert.ok(ids.includes(id), `${id} is in the tracked view`);
    assert.ok(!ids.includes(e), 'an added job with nothing done to it is not on the board');
    const byId = new Map(t.items.map((x: any) => [x.entry.jobId, x.entry]));
    assert.equal((byId.get(a) as any).notes[0].text, 'Referral from Pat, keep this.');
    assert.equal((byId.get(b) as any).reminders[0].text, 'Apply');
    // The other views keep their meaning: B is no longer liked, A is no longer an application.
    const liked = (await s.call('GET', '/api/v1/tracker?view=liked')).json;
    assert.ok(!liked.items.some((x: any) => x.entry.jobId === b));
    assert.equal(liked.counts.applied, 0);
    // Deleting the last note and reminder of a job nobody liked or applied to takes it off the board.
    await patch(s, c, { notes: [] });
    assert.ok(!(await tracked(s)).items.some((x: any) => x.entry.jobId === c));
  } finally { await s.stop(); cleanup(s.home); }
});

test('every stage after Applied records the applied date, so the weekly chart counts every application', async () => {
  const s = await startTest('trkapp');
  try {
    for (const status of ['interviewing', 'offer_received', 'rejected', 'archived'] as const) {
      const id = await addJob(s, `Analyst ${status}`);
      await patch(s, id, { liked: true });
      const r = await patch(s, id, { status });
      assert.equal(r.status, 200, r.text);
      assert.ok(r.json.appliedAt, `${status} sets the applied date`);
      assert.equal(r.json.appliedAt, r.json.statusHistory.at(-1).at);
    }
    // A date that is already set never moves.
    const id = await addJob(s, 'Analyst moved on');
    const first = (await patch(s, id, { status: 'applied' })).json.appliedAt;
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await patch(s, id, { status: 'interviewing' })).json.appliedAt, first);
    const list = (await s.call('GET', '/api/v1/tracker?view=applied')).json;
    assert.equal(list.counts.applied, 5);
    assert.equal(list.items.filter((x: any) => x.entry.appliedAt).length, 5, 'every application has a date');
  } finally { await s.stop(); cleanup(s.home); }
});

test('tracker refusals: an empty note or reminder, and a wrong status, in plain words (JL-tracker-20)', async () => {
  const s = await startTest('trkbad');
  try {
    const id = await addJob(s, 'Analyst refusals');
    const note = await patch(s, id, { notes: [{ text: '  ' }] });
    assert.equal(note.status, 400);
    assert.equal(note.json.error.message, 'A note needs some text. Nothing was saved.');
    assert.equal((await patch(s, id, { reminders: [{ at: '2026-10-01T10:00:00Z', text: '', done: false }] })).status, 400);
    const bad = await patch(s, id, { status: 'bogus' });
    assert.equal(bad.status, 400);
    assert.match(JSON.stringify(bad.json.error.details), /must be one of \\"applied\\"/);
    const entry = (await s.call('GET', `/api/v1/jobs/${encodeURIComponent(id)}`)).json.tracker;
    assert.deepEqual([entry.notes.length, entry.reminders.length, entry.status], [0, 0, null], 'nothing was saved');
  } finally { await s.stop(); cleanup(s.home); }
});

// JL-v2-4: jobs marked "Not interested" after being set back to "Not applied" (no note, no reminder) sat in "Not applied
// yet" with "Kept here for your notes and reminders", and the Table showed an "Applied" date on "Not applied" jobs.
test('"Not interested" alone is not tracked, and a job set back to "not applied" has no applied date (JL-v2-4)', async () => {
  const s = await startTest('trkhid');
  let running = true;
  try {
    // Applied, set back to "not applied" with its note and reminder emptied, then marked "Not interested".
    const a = await addJob(s, 'Staff Data Analyst');
    await patch(s, a, { status: 'applied', notes: [{ text: 'Sent Monday' }], reminders: [{ at: '2026-10-01T15:00:00Z', text: 'Follow up', done: false }] });
    const back = (await patch(s, a, { status: null, notes: [], reminders: [] })).json;
    assert.equal(back.appliedAt, null);
    assert.equal((await patch(s, a, { hidden: true })).json.appliedAt, null);
    // Only marked "Not interested".
    const h = await addJob(s, 'Clover Analyst');
    await patch(s, h, { hidden: true });
    // Set back to "not applied" but with a note: still tracked, with no applied date.
    const n = await addJob(s, 'Kept Analyst');
    await patch(s, n, { status: 'applied', notes: [{ text: 'Keep this one' }] });
    await patch(s, n, { status: null });

    const t = await tracked(s);
    const ids = t.items.map((x: any) => x.entry.jobId);
    assert.ok(!ids.includes(a), 'a hidden job with nothing else is not on the board');
    assert.ok(!ids.includes(h), 'a hidden job with nothing else is not on the board');
    assert.ok(ids.includes(n), 'a job with a note stays on the board');
    for (const x of t.items) if (x.entry.status === null) assert.equal(x.entry.appliedAt, null, `${x.entry.jobId} is "Not applied" with an applied date`);
    const hidden = (await s.call('GET', '/api/v1/tracker?view=hidden')).json;
    assert.deepEqual(hidden.items.map((x: any) => x.entry.jobId).sort(), [a, h].sort());

    // Applying again gives a new date.
    const again = (await patch(s, n, { status: 'applied' })).json;
    assert.ok(again.appliedAt);
    assert.equal(again.appliedAt, again.statusHistory.at(-1).at);

    // A row an older build left with an applied date and no stage reads as not applied, and is not tracked by it.
    const old = await addJob(s, 'Old Analyst');
    await patch(s, old, { hidden: true });
    await s.stop();
    running = false;
    const db = new DatabaseSync(join(s.home, 'data', 'jobleft.db'));
    db.prepare("UPDATE srv_tracker SET applied_at = '2026-09-27T10:00:00.000Z', status = NULL WHERE job_id = ?").run(old);
    db.close();
    const s2 = await startTest('trkhid', { home: s.home });
    try {
      const t2 = await tracked(s2);
      assert.ok(!t2.items.some((x: any) => x.entry.jobId === old), 'an old applied date alone does not track a job');
      const e = (await s2.call('GET', '/api/v1/tracker?view=hidden')).json.items.find((x: any) => x.entry.jobId === old);
      assert.equal(e.entry.appliedAt, null);
      const re = (await patch(s2, old, { status: 'applied' })).json;
      assert.notEqual(re.appliedAt, '2026-09-27T10:00:00.000Z', 'applying again gives a new date, not the old one');
    } finally { await s2.stop(); }
  } finally { if (running) await s.stop(); cleanup(s.home); }
});
