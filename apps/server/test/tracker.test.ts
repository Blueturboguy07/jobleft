// The tracker keeps everything the person did in view (JL-tracker-6) and records when they applied, whatever stage a
// job goes to first (JL-tracker-7).

import { test } from 'node:test';
import assert from 'node:assert/strict';
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
    assert.ok(back.json.appliedAt, 'the applied date is kept');

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
