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
