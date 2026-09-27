// Regression tests of the Network, Interview and Assistant fix round (qa findings JL-network-*), through the real
// server and its HTTP API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { startScriptedModel } from '../../../packages/assistant/src/mock/scripted-model.ts';
import { startPublik } from '../scripts/mocks.ts';
import { cleanup, startTest, type TestServer } from './helpers.ts';

function events(text: string): any[] {
  return text.split('\n\n').map((l) => l.trim()).filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
}

/** The files of a zip the server wrote (entries with data descriptors), by name. */
function zipFiles(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let p = 0;
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const nameLen = buf.readUInt16LE(p + 26), extra = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString('utf8');
    const start = p + 30 + nameLen + extra;
    let d = start;
    for (;;) {
      d = buf.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]), d);
      if (d < 0) return out;
      if (buf.readUInt32LE(d + 8) === d - start) break;
      d += 4;
    }
    const data = buf.subarray(start, d);
    out.set(name, (method === 8 ? inflateRawSync(data) : data).toString('utf8'));
    p = d + 16;
  }
  return out;
}

async function addJob(s: TestServer, title: string, company: string, body = 'We build dashboards in SQL and Tableau.'): Promise<string> {
  const r = await s.call('POST', '/api/v1/jobs/external', { text: `${title}\nCompany: ${company}\n\n${body}` });
  assert.equal(r.status, 200, r.text);
  return r.json.job.id as string;
}

test('JL-network-17: a proposal stays with its conversation until decided; the decision is in the conversation and the tracker', async () => {
  let jobId = '';
  const model = await startScriptedModel({
    script: (ctx) => {
      if (ctx.afterTool) return { text: 'I proposed this change. Nothing has changed yet. Please approve the change to apply it.' };
      if (ctx.tools.includes('propose_changes')) return { toolCalls: [{ name: 'propose_changes', arguments: { changes: [{ kind: 'tracker_status', job_id: jobId, status: 'applied' }] } }] };
      return { text: 'ok' };
    },
  });
  const s = await startTest('jl17');
  try {
    jobId = await addJob(s, 'Staff Data Analyst', 'Stripe');
    const set = await s.call('PUT', '/api/v1/ai/settings', { provider: 'local', localKind: 'openai_compatible', baseUrl: model.url, model: 'scripted-model' });
    assert.equal(set.status, 200, set.text);
    const r = await s.call('POST', '/api/v1/ai/chat', { requestId: 'req-jl17', messages: [{ role: 'user', content: 'Mark my Stripe Staff Data Analyst job as Applied in my tracker.' }] });
    const ev = events(r.text);
    const done = ev.at(-1);
    assert.equal(done.type, 'done', r.text);
    const prop = ev.find((e) => e.type === 'proposal')?.proposal;
    assert.ok(prop, 'a proposal was made');
    // After the answer finished (and after a reload), the saved conversation still offers the proposal.
    const thread = await s.call('GET', `/api/v1/ai/chats/${done.chatId}`);
    assert.equal(thread.status, 200, thread.text);
    assert.deepEqual(thread.json.proposals.map((p: any) => p.id), [prop.id]);
    assert.equal((await s.call('GET', `/api/v1/jobs/${encodeURIComponent(jobId)}`)).json.tracker.status ?? null, null, 'nothing changed before the decision');
    const d = await s.call('POST', `/api/v1/ai/proposals/${prop.id}`, { approveActionIds: [prop.actions[0].id] });
    assert.equal(d.status, 200, d.text);
    assert.deepEqual(d.json.applied, [prop.actions[0].id]);
    assert.equal((await s.call('GET', `/api/v1/jobs/${encodeURIComponent(jobId)}`)).json.tracker.status, 'applied');
    const after = (await s.call('GET', `/api/v1/ai/chats/${done.chatId}`)).json;
    assert.equal(after.proposals, undefined);
    assert.match(after.messages.at(-1).content, /It is done:\n- Done: Move "Staff Data Analyst" at Stripe to Applied\./);
  } finally { await s.stop(); await model.close(); cleanup(s.home); }
});

test('JL-network-23: "Export all my data" holds the assistant conversations, the practice answers and feedback, and the question bank', async () => {
  const model = await startScriptedModel({ script: () => ({ text: 'Here is a plain answer about your jobs.' }) });
  const s = await startTest('jl23');
  try {
    const jobId = await addJob(s, 'Staff Data Analyst', 'Stripe');
    await s.call('PUT', '/api/v1/ai/settings', { provider: 'local', localKind: 'openai_compatible', baseUrl: model.url, model: 'scripted-model' });
    const r = await s.call('POST', '/api/v1/ai/chat', { requestId: 'req-jl23', messages: [{ role: 'user', content: 'How many jobs did I like? EXPORTMARK' }] });
    assert.equal(events(r.text).at(-1).type, 'done', r.text);
    const ps = await s.call('POST', '/api/v1/practice/sessions', { jobId });
    assert.equal(ps.status, 200, ps.text);
    const q = ps.json.questions[0];
    const fb = await s.call('POST', '/api/v1/practice/feedback', { sessionId: ps.json.id, questionId: q.id, answer: 'PRACTICEANSWER I wrote SQL for the weekly report.' });
    assert.equal(fb.status, 200, fb.text);
    // A reload of the Practice screen gets the same session with the answer and its feedback.
    const again = await s.call('POST', '/api/v1/practice/sessions', { jobId });
    assert.equal(again.json.resumed, true);
    assert.equal(again.json.answers[0].answer, 'PRACTICEANSWER I wrote SQL for the weekly report.');
    assert.ok(again.json.answers[0].feedback);
    assert.equal((await s.call('POST', '/api/v1/practice/items', { jobId, kind: 'debrief', notes: 'DEBRIEFMARK they asked about SQL' })).status, 200);
    assert.equal((await s.call('POST', '/api/v1/practice/items', { jobId, kind: 'debrief', notes: '' })).status, 400, 'an empty debrief is refused');

    const exp = await s.call('GET', '/api/v1/export');
    assert.equal(exp.status, 200);
    const files = zipFiles(exp.body);
    const chats = JSON.parse(files.get('chats.json')!);
    assert.equal(chats.length, 1);
    assert.match(chats[0].messages[0].content, /EXPORTMARK/);
    assert.equal(chats[0].messages[1].content, 'Here is a plain answer about your jobs.');
    const practice = JSON.parse(files.get('interview-practice.json')!);
    assert.equal(practice.sessions.length, 1);
    assert.match(practice.sessions[0].answers[0].answer, /PRACTICEANSWER/);
    assert.ok(practice.sessions[0].answers[0].feedback);
    assert.match(practice.questionBank[0].notes, /DEBRIEFMARK/);
    assert.ok(files.has('ai-charges.json'));
    assert.match(files.get('README.txt')!, /interview-practice\.json/);
  } finally { await s.stop(); await model.close(); cleanup(s.home); }
});

test('JL-network-19: publik\'s daily limit is named the same way by every AI step, and the balance says it', async () => {
  const pub = await startPublik({ balanceMicros: 100_000 });
  const s = await startTest('jl19', { env: { JOBLEFT_PUBLIK_APP_TOKEN: 'stand-in-app-token', JOBLEFT_PUBLIK_BASE_URL: `${pub.origin}/api/v1` } });
  try {
    assert.equal((await s.call('POST', '/api/v1/publik/connect', { disclosureAccepted: true, disclosureVersion: 1 })).status, 200);
    await s.call('PUT', '/api/v1/ai/settings', { provider: 'publik' });
    pub.setDaily({ capMicros: 250_000, spentMicros: 145_795, refuse: false });
    const before = (await s.call('POST', '/api/v1/publik/refresh')).json;
    assert.equal(before.wallet.daily.capMicros, 250_000, 'the balance card knows the daily limit before it is reached');
    assert.equal(before.wallet.daily.usedMicros, 145_795);
    assert.equal(before.wallet.daily.reachedAt, null);
    assert.match(before.wallet.daily.resetsAt, /T00:00:00\.000Z$/);

    pub.setDaily({ capMicros: 250_000, spentMicros: 145_795, refuse: true });
    const chat = events((await s.call('POST', '/api/v1/ai/chat', { requestId: 'req-jl19', messages: [{ role: 'user', content: 'Say OK.' }] })).text).at(-1);
    assert.equal(chat.type, 'error');
    const words = chat.error.message as string;
    assert.match(words, /would go over today's publik spending limit for this computer \(\$0\.25 a day, \$0\.14 used so far\)/);
    assert.match(words, /nothing was charged/);
    assert.match(words, /smaller AI steps may still run/);
    assert.match(words, /starts again (today|tomorrow) at .+ \(midnight UTC\)/);
    assert.doesNotMatch(words, /credit/i);

    // A message draft is refused with the same words (not a different story per feature).
    await s.call('POST', '/api/v1/network/import', Buffer.from('First Name,Last Name,URL,Email Address,Company,Position,Connected On\nMaria,Delgado,,,Kroger,Data Manager,04 Mar 2025\n'), { 'content-type': 'text/csv' });
    const contact = (await s.call('GET', '/api/v1/network/contacts')).json[0];
    const draft = await s.call('POST', `/api/v1/network/contacts/${contact.id}/draft`, { variant: 'short', confirmRemote: true });
    assert.ok(draft.status >= 400, draft.text);
    assert.equal(draft.json.error.message, words);

    const after = (await s.call('GET', '/api/v1/publik')).json;
    assert.ok(after.wallet.daily.reachedAt, 'the balance card says the limit was reached today');
    assert.equal(after.wallet.balanceMicros, 100_000, 'the balance itself is untouched');
  } finally { await s.stop(); await pub.close(); cleanup(s.home); }
});

test('JL-network-2: legal names, domains and reviewed aliases count at the target, look-alikes do not, and the job card agrees', async () => {
  const s = await startTest('jl2');
  try {
    const ids: Record<string, string> = {};
    for (const c of ['Coinbase', 'Meta', 'EY', 'Palantir Technologies', 'Gong', 'Stripe', 'Blue Bottle Coffee']) ids[c] = await addJob(s, 'Data Analyst', c);
    const csv = ['First Name,Last Name,URL,Email Address,Company,Position,Connected On',
      'Ada,One,,,"Coinbase Global, Inc.",Analyst,04 Mar 2025', 'Flo,Six,,,"Meta Platforms, Inc.",Analyst,04 Mar 2025', 'Gus,Seven,,,Meta,Analyst,04 Mar 2025',
      'Hal,Eight,,,Ernst & Young LLP,Analyst,04 Mar 2025', 'Bo,Two,,,Palantir,Analyst,04 Mar 2025', 'Cy,Three,,,Gong.io,Analyst,04 Mar 2025',
      'Jo,Ten,,,Blue Bottle,Barista,04 Mar 2025', 'Kai,Eleven,,,Stripe Press,Editor,04 Mar 2025', 'Lu,Twelve,,,Metabase,Engineer,04 Mar 2025',
      'Ned,Fourteen,,,Gong Cha,Manager,04 Mar 2025'].join('\n');
    assert.equal((await s.call('POST', '/api/v1/network/import', Buffer.from(csv), { 'content-type': 'text/csv' })).status, 200);
    const cov = (await s.call('GET', '/api/v1/network/coverage')).json as Array<{ companyKey: string; companyName: string; count: number }>;
    const n = (name: string) => cov.find((c) => c.companyName === name)?.count;
    assert.equal(n('Coinbase'), 1);
    assert.equal(n('Meta'), 2);
    assert.equal(n('EY'), 1);
    assert.equal(n('Palantir Technologies'), 1);
    assert.equal(n('Gong'), 1);
    assert.equal(n('Stripe'), 0, 'Stripe Press is another company');
    assert.equal(n('Blue Bottle Coffee'), 0, 'not in the reviewed list: not counted');
    // The job card shows the same count as the Network screen.
    for (const [name, id] of Object.entries(ids)) {
      const card = (await s.call('GET', `/api/v1/jobs/${encodeURIComponent(id)}`)).json.networkCount ?? 0;
      assert.equal(card, n(name), `card and Companies agree for ${name}`);
    }
    // The near miss is shown next to the target, with the reason.
    const bb = cov.find((c) => c.companyName === 'Blue Bottle Coffee')!;
    const x = (await s.call('GET', `/api/v1/network/match?companyKey=${bb.companyKey}&companyName=${encodeURIComponent('Blue Bottle Coffee')}`)).json;
    assert.deepEqual(x.notCounted.map((m: any) => m.name), ['Blue Bottle']);
  } finally { await s.stop(); cleanup(s.home); }
});

test('JL-network-5: one follow-up alert that says how many are due now; clearing a date updates it, clearing all removes it', async () => {
  const s = await startTest('jl5', { env: { JOBLEFT_TZ: 'America/Chicago' } });
  try {
    const csv = ['First Name,Last Name,URL,Email Address,Company,Position,Connected On',
      'Maria,Delgado,,,Kroger,Manager,04 Mar 2025', 'Priya,Raman,,,Kroger,Analyst,04 Mar 2025', 'Bo,Lindqvist,,,Nike,Designer,04 Mar 2025'].join('\n');
    await s.call('POST', '/api/v1/network/import', Buffer.from(csv), { 'content-type': 'text/csv' });
    const people = (await s.call('GET', '/api/v1/network/contacts')).json as Array<{ id: string; firstName: string }>;
    const id = (n: string) => people.find((p) => p.firstName === n)!.id;
    const follow = async () => ((await s.call('GET', '/api/v1/notifications')).json as Array<{ kind: string; body: string }>).filter((n) => n.kind === 'follow_up');
    for (const [n, d] of [['Maria', '2026-01-01'], ['Priya', '2026-01-02'], ['Bo', '2026-01-03']] as const) {
      assert.equal((await s.call('PATCH', `/api/v1/network/contacts/${id(n)}`, { followUpOn: d })).status, 200);
    }
    let f = await follow();
    assert.equal(f.length, 1, 'one alert, not one per person');
    assert.equal(f[0]!.body, '3 network follow-ups are due. Open Network > Follow-ups to see them.');
    await s.call('PATCH', `/api/v1/network/contacts/${id('Maria')}`, { followUpOn: null });
    f = await follow();
    assert.equal(f.length, 1);
    assert.equal(f[0]!.body, '2 network follow-ups are due. Open Network > Follow-ups to see them.', 'the number follows a cleared date');
    await s.call('DELETE', `/api/v1/network/contacts/${id('Priya')}`);
    assert.equal((await follow())[0]!.body, '1 network follow-up is due. Open Network > Follow-ups to see who.');
    await s.call('PATCH', `/api/v1/network/contacts/${id('Bo')}`, { followUpOn: null });
    assert.equal((await follow()).length, 0, 'nothing due: no alert');
    // The People filter "Follow-up due" and the Follow-ups tab agree (JL-network-7).
    await s.call('PATCH', `/api/v1/network/contacts/${id('Bo')}`, { followUpOn: '2026-01-05' });
    const byStage = (await s.call('GET', '/api/v1/network/contacts?stage=follow_up_due')).json as unknown[];
    const byDue = (await s.call('GET', '/api/v1/network/contacts?due=true')).json as unknown[];
    assert.equal(byStage.length, 1);
    assert.equal(byDue.length, 1);
  } finally { await s.stop(); cleanup(s.home); }
});

test('JL-network-22: the Companies coverage names the target job, so a draft from there is about it', async () => {
  const s = await startTest('jl22');
  try {
    const jobId = await addJob(s, 'Store Data Analyst', 'Kroger');
    await s.call('POST', '/api/v1/network/import', Buffer.from('First Name,Last Name,URL,Email Address,Company,Position,Connected On\nMaria,Delgado,,,Kroger,Data Manager,04 Mar 2025\n'), { 'content-type': 'text/csv' });
    const cov = (await s.call('GET', '/api/v1/network/coverage')).json as Array<{ companyName: string; jobs?: Array<{ id: string; title: string }> }>;
    const kroger = cov.find((c) => c.companyName === 'Kroger')!;
    assert.deepEqual(kroger.jobs, [{ id: jobId, title: 'Store Data Analyst' }]);
    const contact = (await s.call('GET', '/api/v1/network/contacts')).json[0];
    const p = await s.call('POST', `/api/v1/network/contacts/${contact.id}/draft/preview`, { variant: 'short', jobId: kroger.jobs![0]!.id });
    assert.equal(p.status, 200, p.text);
    assert.equal(p.json.sends.job.title, 'Store Data Analyst');
  } finally { await s.stop(); cleanup(s.home); }
});
