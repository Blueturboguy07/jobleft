// Regression tests of the Network, Interview and Assistant fix round (qa findings JL-network-*), through the real
// server and its HTTP API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startScriptedModel } from '../../../packages/assistant/src/mock/scripted-model.ts';
import { cleanup, startTest, type TestServer } from './helpers.ts';

function events(text: string): any[] {
  return text.split('\n\n').map((l) => l.trim()).filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
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
