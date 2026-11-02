// publik first: before AI is set up, every place that names the AI setup asks for one thing, "Connect publik" (no key
// needed), and opens the existing connect step (Settings > Balance). Other providers stay one click away in Settings >
// AI provider. Pure functions, unit tested (test/aiSetup.test.ts).

import type { AiSettings, PublikConnection } from '@jobleft/contracts';
import { formatDollars } from '@jobleft/contracts';

/** The existing connect step: the disclosure, "I have read this" and the connect button (Settings > Balance). */
export const CONNECT_ROUTE = 'settings/balance';
/** The other providers: a model on this computer, a custom address, your own key. */
export const OTHER_PROVIDERS_ROUTE = 'settings/ai';

export const PUBLIK_FIRST = {
  title: 'AI runs on publik API',
  body: 'No key needed. You pay per use from your publik balance. Linking your publik account gives $0.05 of free use, once.',
  button: 'Connect publik',
  other: 'Use my own key or a local model',
} as const;

/**
 * true while AI is not ready and publik is the way to make it ready: no provider is chosen yet, or publik is chosen
 * but this computer is not connected. Undefined settings (not read yet) are not a "needs connect" state.
 */
export function needsPublikConnect(s: AiSettings | undefined, c: PublikConnection | undefined): boolean {
  if (!s) return false;
  if (!s.provider) return true;
  return s.provider === 'publik' && !!c && c.state !== 'connected';
}

/** The setup checklist's AI step: it names publik and opens the connect step. */
export function aiChecklistStep(s: AiSettings | undefined, c: PublikConnection | undefined): { done: boolean; text: string; to: string } {
  const done = !!s?.provider && !needsPublikConnect(s, c);
  return { done, text: 'Connect publik for AI (no key needed)', to: CONNECT_ROUTE };
}

export interface ChipState {
  text: string;
  /** green dot: AI answers can come now */
  on: boolean;
  /** the route the chip opens */
  to: string;
  /** the chip is the "Connect publik" call to action */
  connect: boolean;
}

/** The top bar's AI chip. `checkFailed`: the last setup check of these settings failed (JL-settings-3). */
export function chipState(s: AiSettings | undefined, c: PublikConnection | undefined, opts: { publikError?: boolean; checkFailed?: boolean; compact?: boolean } = {}): ChipState {
  const connect: ChipState = { text: PUBLIK_FIRST.button, on: false, to: CONNECT_ROUTE, connect: true };
  if (!s) return { text: 'AI: …', on: false, to: OTHER_PROVIDERS_ROUTE, connect: false };
  if (!s.provider) return connect;
  if (s.provider === 'publik') {
    const w = c?.wallet;
    if (c?.state === 'connected' && w) return { text: `Balance: ${formatDollars(w.balanceMicros)}`, on: true, to: CONNECT_ROUTE, connect: false };
    if (opts.publikError) return { text: 'Balance: not available', on: false, to: CONNECT_ROUTE, connect: false };
    if (c) return connect;
    return { text: 'Balance: …', on: false, to: CONNECT_ROUTE, connect: false };
  }
  let text = s.provider === 'local' ? (opts.compact ? 'AI on this computer' : 'AI: model on this computer') : s.provider === 'custom' ? 'AI: your server' : 'AI: your own key';
  let on = true;
  if (opts.checkFailed) { text = 'AI: not answering'; on = false; }
  return { text, on, to: OTHER_PROVIDERS_ROUTE, connect: false };
}
