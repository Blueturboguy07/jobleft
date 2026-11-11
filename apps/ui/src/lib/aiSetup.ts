// publik first: before AI is set up, every place that names the AI setup asks for one thing, "Connect publik" (no key
// needed). One press of "Connect publik" (next to the disclosure, so the press is the consent) connects this computer
// and opens the publikhq.com claim page at once; until the computer is linked there, the chip and the card say "Finish
// linking on publikhq.com". Other providers stay one click away in Settings > AI provider. Pure functions, unit tested
// (test/aiSetup.test.ts).

import type { AiSettings, PublikConnection, PublikWallet } from '@jobleft/contracts';
import { formatDollars } from '@jobleft/contracts';

/** The page with the full connect panel and the balance: Settings > Balance. */
export const CONNECT_ROUTE = 'settings/balance';
/** The other providers: a model on this computer, a custom address, your own key. */
export const OTHER_PROVIDERS_ROUTE = 'settings/ai';
/** Where the connect button is, in words, for messages that are shown away from it. */
export const CONNECT_PLACE = 'Settings > Balance';

export const PUBLIK_FIRST = {
  title: 'AI runs on publik API',
  body: 'No key needed. You signed in with publik when jobleft started. Connect it, and you pay per use from your publik balance.',
  button: 'Connect publik',
  other: 'Use my own key or a local model',
  /** One line for the first setup step. */
  setupLine: 'jobleft runs its AI on publik API. No key needed: you signed in at start, and you connect it in the last step.',
  link: 'Finish linking on publikhq.com',
  linkBody: 'publik opened in your browser. Sign in there and link this computer. jobleft sees the link by itself, and AI is ready after it.',
  walletError: 'Could not load your publik balance',
  retry: 'Try again',
} as const;

/**
 * Where publik stands for AI:
 * - "connect": no provider yet, or publik chosen and this computer not connected.
 * - "linking": connected, but not linked to a publik account and nothing to spend ($0.00): AI cannot run until the
 *   person links this computer on publikhq.com.
 * - "wallet_error": publik is the provider and connected (or the connection could not be read), but the balance did
 *   not load.
 * - "ready": publik can answer now. "other": another provider is chosen. "unknown": not read yet.
 */
export type PublikStage = 'unknown' | 'connect' | 'linking' | 'wallet_error' | 'ready' | 'other';

/** A connected computer that still has to be linked on publikhq.com before AI can run. */
export function needsLink(w: PublikWallet | null | undefined): boolean {
  return !!w && w.claimState === 'anonymous' && w.balanceMicros <= 0;
}

export function publikStage(s: AiSettings | undefined, c: PublikConnection | undefined, opts: { publikError?: boolean } = {}): PublikStage {
  if (!s) return 'unknown';
  if (!s.provider) return 'connect';
  if (s.provider !== 'publik') return 'other';
  if (!c) return opts.publikError ? 'wallet_error' : 'unknown';
  if (c.state !== 'connected') return 'connect';
  if (!c.wallet) return 'wallet_error';
  return needsLink(c.wallet) ? 'linking' : 'ready';
}

/** The publikhq.com page where this computer is linked to a publik account; null once it is linked. */
export function linkUrl(c: PublikConnection | undefined): string | null {
  const w = c?.wallet;
  if (!c || c.state !== 'connected' || !w || w.claimState !== 'anonymous') return null;
  return w.claimUrl ?? w.topUpUrl;
}

/**
 * true while AI is not ready and connecting publik is the way to make it ready: no provider is chosen yet, or publik is
 * chosen but this computer is not connected. Undefined settings (not read yet) are not a "needs connect" state.
 */
export function needsPublikConnect(s: AiSettings | undefined, c: PublikConnection | undefined): boolean {
  return publikStage(s, c) === 'connect';
}

/** The setup checklist's AI step: it names publik, and it is done only once AI can run (linked, or money to spend). */
export function aiChecklistStep(s: AiSettings | undefined, c: PublikConnection | undefined, opts: { publikError?: boolean } = {}): { done: boolean; text: string; to: string } {
  const st = publikStage(s, c, opts);
  if (st === 'linking') return { done: false, text: PUBLIK_FIRST.link, to: CONNECT_ROUTE };
  if (st === 'wallet_error') return { done: false, text: `${PUBLIK_FIRST.walletError}: read it again`, to: CONNECT_ROUTE };
  return { done: st === 'ready' || st === 'other', text: 'Connect publik for AI (no key needed)', to: CONNECT_ROUTE };
}

export interface ChipState {
  text: string;
  /** green dot: AI answers can come now */
  on: boolean;
  /** the route the chip opens (kind "status" and "connect") */
  to: string;
  /**
   * "connect": the "Connect publik" call to action (opens the connect panel); "link": opens the publikhq.com claim page
   * again; "retry": reads the balance again; "status": shows where AI answers come from.
   */
  kind: 'connect' | 'link' | 'retry' | 'status';
}

/** The top bar's AI chip. `checkFailed`: the last setup check of these settings failed (JL-settings-3). */
export function chipState(s: AiSettings | undefined, c: PublikConnection | undefined, opts: { publikError?: boolean; checkFailed?: boolean; compact?: boolean } = {}): ChipState {
  const st = publikStage(s, c, opts);
  switch (st) {
    case 'unknown': return { text: s?.provider === 'publik' ? 'Balance: …' : 'AI: …', on: false, to: s?.provider === 'publik' ? CONNECT_ROUTE : OTHER_PROVIDERS_ROUTE, kind: 'status' };
    case 'connect': return { text: PUBLIK_FIRST.button, on: false, to: CONNECT_ROUTE, kind: 'connect' };
    case 'linking': return { text: PUBLIK_FIRST.link, on: false, to: CONNECT_ROUTE, kind: 'link' };
    case 'wallet_error': return { text: `${PUBLIK_FIRST.walletError} · ${PUBLIK_FIRST.retry}`, on: false, to: CONNECT_ROUTE, kind: 'retry' };
    case 'ready': return { text: `Balance: ${formatDollars(c!.wallet!.balanceMicros)}`, on: true, to: CONNECT_ROUTE, kind: 'status' };
    case 'other': break;
  }
  let text = s!.provider === 'local' ? (opts.compact ? 'AI on this computer' : 'AI: model on this computer') : s!.provider === 'custom' ? 'AI: your server' : 'AI: your own key';
  let on = true;
  if (opts.checkFailed) { text = 'AI: not answering'; on = false; }
  return { text, on, to: OTHER_PROVIDERS_ROUTE, kind: 'status' };
}
