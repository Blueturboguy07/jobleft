// publik's daily spending limit for this computer, in words (JL-network-19). publik refuses an AI step that would go
// over it even while balance is left; smaller steps may still fit. The words name only amounts publik reported.

import { formatDollars, type PublikWallet } from '@jobleft/contracts';

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function resetText(iso: string, now: number): string {
  const t = Date.parse(iso);
  const day = (x: number) => new Date(x).toDateString();
  const when = day(t) === day(now) ? 'today' : day(t) === day(now + 86_400_000) ? 'tomorrow' : new Date(t).toLocaleDateString('en-US', { weekday: 'long' });
  return `${when} at ${clock(iso)}${/T00:00:00(\.000)?Z$/.test(iso) ? ' (midnight UTC)' : ''}`;
}

/** true while a refusal for the daily limit is still in force (it was today and the limit has not started again). */
export function dailyLimitReached(w: PublikWallet | null | undefined, now: number = Date.now()): boolean {
  const d = w?.daily;
  return !!d?.reachedAt && Date.parse(d.resetsAt) > now;
}

/** The limit for the balance card: what it is, how much is used and left today, and when it starts again. */
export function dailyLimitText(w: PublikWallet, now: number = Date.now()): { summary: string; reached: string | null } | null {
  const d = w.daily;
  if (!d) return null;
  const again = resetText(d.resetsAt, now);
  const summary = d.capMicros !== null
    ? `publik lets this computer spend up to ${formatDollars(d.capMicros)} a day on AI steps, even when more balance is left.${d.usedMicros !== null ? ` Used today: ${formatDollars(d.usedMicros)} (${formatDollars(Math.max(0, d.capMicros - d.usedMicros))} left today).` : ''} The limit starts again ${again}.`
    : `publik also limits how much this computer can spend on AI steps in one day, even when more balance is left. publik has not told jobleft the amount. The limit starts again ${again}.`;
  const reached = dailyLimitReached(w, now)
    ? `Today at ${clock(d.reachedAt!)} publik refused an AI step because it would go over this limit. Nothing was charged for it. Smaller steps may still run; steps that would go over it can run again ${again}.`
    : null;
  return { summary, reached };
}

/**
 * One plain line for a $0.00 balance (JL-v2-5). Since publik's 2026-09-28 policy a new connection always starts at
 * $0.00 and the only free use is $0.05 paid once when the computer is linked to a publik account; the line says so
 * instead of letting the words promise a free amount, and the screen shows it with the top-up link publik returned
 * (the claim page while unlinked). null when there is money in the balance.
 */
export function zeroBalanceText(w: PublikWallet): string | null {
  if (w.balanceMicros > 0) return null;
  return w.claimState === 'anonymous'
    ? `Your publik balance is ${formatDollars(0)}, so AI steps cannot run yet. Link this computer to your publik account for $0.05 of free use, once, or add money at publik.`
    : `Your publik balance is ${formatDollars(0)}, so AI steps cannot run until you add money at publik.`;
}
