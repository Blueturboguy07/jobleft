// While a connected computer is not linked to a publik account yet, the balance screen reads the balance again on
// its own, so the link the person makes on publikhq.com (and the plan money) shows up without "Read the balance
// again" and without an AI step. The local service reads publik at most once per 5 s whatever the screens ask, so
// the screen asks every 5 s, only while the window is visible, and only for WATCH_MS after the screen opened or
// after the person opened the link (then it stops; the window's next focus reads it again anyway).

import type { PublikConnection } from '@jobleft/contracts';

export const WATCH_MS = 3 * 60_000;
export const WATCH_EVERY_MS = 5_000;

/** true while the screen should keep reading the balance on its own. */
export function watchingBalance(c: PublikConnection | undefined, until: number, now: number = Date.now(), visible = true): boolean {
  return visible && now < until && c?.state === 'connected' && c.wallet?.claimState === 'anonymous';
}
