// Opens the assistant panel from anywhere (a card's Ask button, the detail's tools rail).

import { useSyncExternalStore } from 'react';

export interface ChatTarget {
  open: boolean;
  jobId: string | null;
  title: string | null;
  /** A starting question to put in the box (never sent without a click). */
  draft?: string;
  nonce: number;
}

let state: ChatTarget = { open: false, jobId: null, title: null, nonce: 0 };
const subs = new Set<() => void>();

function set(next: ChatTarget): void {
  state = next;
  for (const s of [...subs]) s();
}

export function openChat(t: { jobId?: string | null; title?: string | null; draft?: string } = {}): void {
  set({ open: true, jobId: t.jobId ?? null, title: t.title ?? null, draft: t.draft, nonce: state.nonce + 1 });
}

export function closeChat(): void {
  set({ ...state, open: false });
}

export function useChatTarget(): ChatTarget {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => state);
}
