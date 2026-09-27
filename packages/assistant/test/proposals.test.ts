// JL-network-17: a proposal stays with its conversation until the person decides, and the decision is written into
// the conversation (so "nothing has changed yet" is never the last word after an approval).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Script } from '../src/mock/scripted-model.ts';
import { chatReq, makeRig, runChat } from './helpers.ts';

const proposeApplied: Script = (ctx) => {
  if (ctx.afterTool) return { text: 'I proposed this change: Move Data Analyst at Globex to Applied. Nothing has changed yet. Please approve the change to apply it.' };
  return { toolCalls: [{ name: 'propose_changes', arguments: { changes: [{ kind: 'tracker_status', job_id: 'lever:globex:2001', status: 'applied' }] } }] };
};

test('JL-network-17: the proposal is still there when the answer is done, and a reload of the conversation shows it', async () => {
  const rig = await makeRig({ script: proposeApplied });
  try {
    const r = await runChat(rig.assistant, chatReq('Mark my Globex Data Analyst job as Applied in my tracker.'));
    assert.equal(r.error, null);
    assert.equal(r.proposals.length, 1);
    const chatId = r.done!.chatId!;
    const thread = rig.assistant.getChat(chatId);
    assert.equal(thread.proposals?.length, 1, 'the saved conversation carries the undecided proposal');
    assert.equal(thread.proposals![0]!.id, r.proposals[0]!.id);
    assert.match(thread.proposals![0]!.actions[0]!.summary, /Move "Data Analyst" at Globex Corporation to Applied/);
    // nothing changed before the decision
    assert.equal((await rig.world.asApi().call('getJob', { params: { jobId: 'lever:globex:2001' } }) as { tracker: { status: string | null } | null }).tracker?.status ?? null, null);
  } finally { await rig.close(); }
});

test('JL-network-17: approving applies the change, removes the card and records the decision in the conversation', async () => {
  const rig = await makeRig({ script: proposeApplied });
  try {
    const r = await runChat(rig.assistant, chatReq('Mark my Globex Data Analyst job as Applied in my tracker.'));
    const p = r.proposals[0]!;
    const chatId = r.done!.chatId!;
    const res = await rig.assistant.decideProposal(p.id, [p.actions[0]!.id]);
    assert.deepEqual(res.applied, [p.actions[0]!.id]);
    const job = await rig.world.asApi().call('getJob', { params: { jobId: 'lever:globex:2001' } }) as { tracker: { status: string | null } | null };
    assert.equal(job.tracker?.status, 'applied');
    const thread = rig.assistant.getChat(chatId);
    assert.equal(thread.proposals, undefined, 'a decided proposal is not offered again');
    const last = thread.messages.at(-1)!;
    assert.equal(last.role, 'assistant');
    assert.match(last.content, /You approved the suggested change\. It is done:/);
    assert.match(last.content, /Done: Move "Data Analyst" at Globex Corporation to Applied\./);
  } finally { await rig.close(); }
});

test('JL-network-17: declining changes nothing and says so in the conversation', async () => {
  const rig = await makeRig({ script: proposeApplied });
  try {
    const r = await runChat(rig.assistant, chatReq('Mark my Globex Data Analyst job as Applied in my tracker.'));
    const p = r.proposals[0]!;
    const res = await rig.assistant.decideProposal(p.id, []);
    assert.deepEqual(res.applied, []);
    const job = await rig.world.asApi().call('getJob', { params: { jobId: 'lever:globex:2001' } }) as { tracker: { status: string | null } | null };
    assert.equal(job.tracker?.status ?? null, null);
    const last = rig.assistant.getChat(r.done!.chatId!).messages.at(-1)!;
    assert.match(last.content, /You declined the suggested change\. Nothing was changed:/);
    assert.match(last.content, /Not done, because you declined it: Move "Data Analyst" at Globex Corporation to Applied\./);
    await assert.rejects(rig.assistant.decideProposal(p.id, []), /already decided/);
  } finally { await rig.close(); }
});
