// The assistant chat's state, kept free of React so it can be tested (JL-network-17). A proposal the assistant made
// stays on screen until the person decides: finishing the answer, sending another message or the new conversation
// getting its id never removes it. A decided proposal goes, and the conversation is read again from the server, which
// has written the decision into it.

import type { ActionProposal, ChatStreamEvent, ChatThread } from '@jobleft/contracts';

/** A tool the assistant used while answering (searching the web, reading a job), as the chat shows it. */
export interface ToolActivity {
  id: string;
  name: string;
  state: 'running' | 'done' | 'failed';
  label: string;
  steps: string[];
  sources: Array<{ title: string; url: string }>;
  summary: string | null;
}

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  incomplete?: boolean;
  costMicros?: number | null;
  /** The tools this answer used, in the order they started. */
  tools?: ToolActivity[];
}

export interface ChatView {
  msgs: ChatMsg[];
  /** Proposals still waiting for the person's decision, oldest first. */
  proposals: ActionProposal[];
}

export const EMPTY_CHAT: ChatView = { msgs: [], proposals: [] };

/** A saved conversation as the chat shows it, with the proposals it still waits on. */
export function viewOfThread(t: ChatThread): ChatView {
  return {
    msgs: t.messages.map((m) => ({
      role: m.role, content: m.content, ...(m.incomplete ? { incomplete: true } : {}),
      ...(m.tools?.length ? { tools: m.tools.map((x) => ({ ...x, summary: x.summary ?? null })) } : {}),
    })),
    proposals: t.proposals ?? [],
  };
}

/** The person's message and an empty answer that the stream fills. Open proposals stay. */
export function startTurn(v: ChatView, question: string): ChatView {
  return { ...v, msgs: [...v.msgs, { role: 'user', content: question }, { role: 'assistant', content: '' }] };
}

function patchLast(msgs: ChatMsg[], patch: (m: ChatMsg) => ChatMsg): ChatMsg[] {
  if (!msgs.length) return msgs;
  const c = [...msgs];
  c[c.length - 1] = patch(c[c.length - 1]!);
  return c;
}

/** One stream event. `done` finishes the answer and never removes a proposal. */
export function onStreamEvent(v: ChatView, ev: ChatStreamEvent): ChatView {
  switch (ev.type) {
    case 'delta': return { ...v, msgs: patchLast(v.msgs, (m) => ({ ...m, content: m.content + ev.text })) };
    case 'proposal': return v.proposals.some((p) => p.id === ev.proposal.id) ? v : { ...v, proposals: [...v.proposals, ev.proposal] };
    case 'done': return { ...v, msgs: patchLast(v.msgs, (m) => ({ ...m, incomplete: ev.incomplete, costMicros: ev.costMicros })) };
    case 'tool': return { ...v, msgs: patchLast(v.msgs, (m) => ({ ...m, tools: upsertTool(m.tools ?? [], ev) })) };
    case 'error': return dropEmptyAnswer(v);
    default: return v;
  }
}

/** A tool event: a new tool joins the list; a later event of the same tool replaces what it said before. */
function upsertTool(list: ToolActivity[], ev: Extract<ChatStreamEvent, { type: 'tool' }>): ToolActivity[] {
  const prev = list.find((t) => t.id === ev.id);
  const next: ToolActivity = {
    id: ev.id, name: ev.name, state: ev.state, label: ev.label,
    steps: ev.steps ?? prev?.steps ?? [], sources: ev.sources ?? prev?.sources ?? [], summary: ev.summary ?? prev?.summary ?? null,
  };
  return prev ? list.map((t) => (t.id === ev.id ? next : t)) : [...list, next];
}

/** After a failure: an answer that never got text is not kept. An answer that used tools keeps them on screen. */
export function dropEmptyAnswer(v: ChatView): ChatView {
  const last = v.msgs.at(-1);
  return last?.role === 'assistant' && last.content === '' && !last.tools?.length ? { ...v, msgs: v.msgs.slice(0, -1) } : v;
}

/** The proposal is decided: it leaves the screen (the server no longer offers it either). */
export function afterDecision(v: ChatView, proposalId: string): ChatView {
  return { ...v, proposals: v.proposals.filter((p) => p.id !== proposalId) };
}

/** One action: plain Apply and Decline buttons. Several: the person ticks the ones to apply. */
export function proposalMode(p: ActionProposal): 'single' | 'pick' {
  return p.actions.length === 1 ? 'single' : 'pick';
}

/**
 * Which chat instance the Assistant screen shows. A new conversation gets its id when the first answer is done and the
 * address changes to it; that is still the SAME conversation on screen, so the chat (with its open proposal) is kept.
 * Any other change of conversation starts a fresh chat.
 */
export interface ChatKeyState { key: number; chatId: string | null; adopted: string | null }

export function chatKeyFor(s: ChatKeyState, chatId: string | null): ChatKeyState {
  if (chatId === s.chatId) return s;
  if (chatId !== null && chatId === s.adopted) return { ...s, chatId };
  return { key: s.key + 1, chatId, adopted: null };
}

/** The chat on screen was given this id by the server (it started the conversation). */
export function adoptChat(s: ChatKeyState, id: string): ChatKeyState {
  return s.chatId === id ? s : { ...s, adopted: id };
}
