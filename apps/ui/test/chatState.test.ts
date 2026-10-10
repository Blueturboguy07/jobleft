// JL-network-17: the assistant's suggestion stays on screen until the person decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ActionProposal, ChatThread } from '@jobleft/contracts';
import { EMPTY_CHAT, adoptChat, afterDecision, chatKeyFor, onStreamEvent, proposalMode, startTurn, viewOfThread, type ChatKeyState } from '../src/lib/chatState.ts';

const proposal: ActionProposal = {
  id: 'prop_1', expiresAt: '2026-09-27T16:00:00.000Z',
  actions: [{ id: 'act_1', kind: 'tracker_status', summary: 'Move "Staff Data Analyst" at Stripe to Applied', target: { kind: 'job', id: 'greenhouse:stripe:1' } }],
};

test('JL-network-17: the proposal survives the end of the answer and the next message', () => {
  let v = startTurn(EMPTY_CHAT, 'Mark my Stripe job as Applied.');
  v = onStreamEvent(v, { type: 'delta', text: 'I proposed this change.' });
  v = onStreamEvent(v, { type: 'proposal', proposal });
  v = onStreamEvent(v, { type: 'proposal', proposal });
  assert.equal(v.proposals.length, 1, 'the same proposal is shown once');
  v = onStreamEvent(v, { type: 'done', incomplete: false, costMicros: 1200, chatId: 'chat_1' });
  assert.equal(v.proposals.length, 1, 'done keeps the proposal');
  assert.equal(v.msgs.at(-1)!.content, 'I proposed this change.');
  v = startTurn(v, 'And what else?');
  assert.equal(v.proposals.length, 1, 'a new message keeps the undecided proposal');
  v = afterDecision(v, 'prop_1');
  assert.equal(v.proposals.length, 0);
});

test('JL-network-17: a reloaded conversation shows its undecided proposals', () => {
  const t: ChatThread = {
    id: 'chat_1', title: 'Mark my Stripe job', jobId: null, createdAt: '2026-09-27T15:00:00.000Z', updatedAt: '2026-09-27T15:00:10.000Z',
    messages: [{ role: 'user', content: 'Mark my Stripe job as Applied.', at: '2026-09-27T15:00:00.000Z' }, { role: 'assistant', content: 'I proposed this change.', at: '2026-09-27T15:00:10.000Z' }],
    proposals: [proposal],
  };
  const v = viewOfThread(t);
  assert.equal(v.msgs.length, 2);
  assert.deepEqual(v.proposals.map((p) => p.id), ['prop_1']);
  assert.deepEqual(viewOfThread({ ...t, proposals: undefined }).proposals, []);
});

test('JL-network-17: one action gets a plain Apply button, several are ticked by the person', () => {
  assert.equal(proposalMode(proposal), 'single');
  assert.equal(proposalMode({ ...proposal, actions: [...proposal.actions, { ...proposal.actions[0]!, id: 'act_2' }] }), 'pick');
});

test('JL-network-17: the Assistant screen keeps the same chat when a new conversation gets its id', () => {
  let s: ChatKeyState = { key: 0, chatId: null, adopted: null };
  s = adoptChat(s, 'chat_1');
  const same = chatKeyFor(s, 'chat_1');
  assert.equal(same.key, 0, 'the new conversation getting its id keeps the chat (and its open proposal)');
  const other = chatKeyFor(same, 'chat_2');
  assert.equal(other.key, 1, 'opening another conversation starts a fresh chat');
  const fresh = chatKeyFor(other, null);
  assert.equal(fresh.key, 2, 'New conversation starts a fresh chat');
  assert.equal(chatKeyFor(fresh, null), fresh);
});

test('tool steps: a tool joins the answer when it starts, its later events replace what it said, and it stays after a failure', () => {
  let v = startTurn(EMPTY_CHAT, 'find SOC traineeships in Utrecht');
  v = onStreamEvent(v, { type: 'tool', id: 't1', name: 'web_search', state: 'running', label: 'Searching the web: SOC traineeship, Utrecht' });
  v = onStreamEvent(v, { type: 'tool', id: 't1', name: 'web_search', state: 'running', label: 'Searching the web: SOC traineeship, Utrecht', steps: ['Asking your search engine: SOC traineeship Utrecht'], sources: [] });
  v = onStreamEvent(v, { type: 'tool', id: 't1', name: 'web_search', state: 'running', label: 'Searching the web: SOC traineeship, Utrecht', steps: ['Asking your search engine: SOC traineeship Utrecht', 'acme.recruitee.com: a new job'], sources: [{ title: 'SOC trainee', url: 'https://acme.recruitee.com/o/soc-trainee' }] });
  let t = v.msgs.at(-1)!.tools!;
  assert.equal(t.length, 1);
  assert.equal(t[0]!.steps.length, 2);
  assert.equal(t[0]!.sources[0]!.url, 'https://acme.recruitee.com/o/soc-trainee');
  v = onStreamEvent(v, { type: 'tool', id: 't1', name: 'web_search', state: 'done', label: 'Searching the web: SOC traineeship, Utrecht', steps: ['a', 'b', 'c'], sources: [], summary: '1 job found · 1 page read' });
  v = onStreamEvent(v, { type: 'tool', id: 't2', name: 'get_job', state: 'running', label: 'Reading a job' });
  t = v.msgs.at(-1)!.tools!;
  assert.deepEqual(t.map((x) => [x.id, x.state]), [['t1', 'done'], ['t2', 'running']]);
  assert.equal(t[0]!.summary, '1 job found · 1 page read');
  // The answer failed before any text: the steps it took stay on screen.
  v = onStreamEvent(v, { type: 'error', error: { code: 'provider_error', message: 'x' } } as never);
  assert.equal(v.msgs.at(-1)!.role, 'assistant');
  assert.equal(v.msgs.at(-1)!.tools!.length, 2);
});
