// PublikWallet: the publik API balance as the local app shows it. UI copy says "balance" and dollars,
// never "credits" and never tokens. Field meanings follow the publik API contract (GET /wallet, x-publik-* headers).

import { HttpUrlSchema, IsoDateTimeSchema, MicrosSchema } from './common.ts';
import { arr, enm, int, named, nullable, obj, str, type Infer } from './schema.ts';

export const PublikWalletSchema = named(obj({
  claimState: enm(['anonymous', 'claimed']),
  /** Available balance now, in micros. */
  balanceMicros: MicrosSchema,
  /** Free starter left, while any is left. */
  starterRemainingMicros: nullable(MicrosSchema),
  plan: enm(['none', 'basic', 'pro']),
  week: obj({
    usedMicros: MicrosSchema,
    /** null without a plan. */
    budgetMicros: nullable(MicrosSchema),
    resetsAt: nullable(IsoDateTimeSchema),
  }),
  /** The ONE link to show when the balance is too low (claim link while anonymous, add-money link once claimed). */
  topUpUrl: HttpUrlSchema,
  claimUrl: nullable(HttpUrlSchema),
  addCreditUrl: nullable(HttpUrlSchema),
  /** When jobleft last read the balance (it refreshes after paid use, with no restart). */
  updatedAt: IsoDateTimeSchema,
}, {
  /**
   * publik's daily spending limit for this computer (added by the network fix round, additive). publik refuses an AI
   * step that would go over it (429 daily_cap_reached) even while balance is left; smaller steps may still fit.
   */
  daily: obj({
    /** The limit per day in micros, as publik reported it; null = publik did not say. */
    capMicros: nullable(MicrosSchema),
    /** Spent today in micros, as publik reported it; null = publik did not say. */
    usedMicros: nullable(MicrosSchema),
    /** When the limit starts again (publik resets it at midnight UTC). */
    resetsAt: IsoDateTimeSchema,
    /** When publik last refused a step for this limit, while that day lasts; null = not today. */
    reachedAt: nullable(IsoDateTimeSchema),
  }),
}), 'PublikWallet', 'The publik API balance');

export const PublikConnectionSchema = named(obj({
  state: enm(['disconnected', 'connecting', 'connected']),
  wallet: nullable(PublikWalletSchema),
  /** Version of the two-sentence disclosure the user accepted before the app connected. */
  disclosureVersion: nullable(int({ minimum: 1 })),
}, {
  /**
   * Every charge of this app's paid calls, newest first, so the balance always agrees with the list (added by the
   * i-ai lane). `costText` is `formatDollars(costMicros)`; a charge under one cent shows as "<$0.01", never "$0.00".
   */
  usage: arr(obj({
    id: str({ minLength: 1 }), at: IsoDateTimeSchema, what: str(), costMicros: int({ minimum: 0 }), costText: str(),
  })),
  /** The sum of `usage` in micros (added by the i-ai lane). */
  usageTotalMicros: int({ minimum: 0 }),
}), 'PublikConnection');

export type PublikWallet = Infer<typeof PublikWalletSchema>;
export type PublikConnection = Infer<typeof PublikConnectionSchema>;

/**
 * Formats micros as US dollars for the UI: floors to the cent, so the app never shows money that is not there,
 * and shows "<$0.01" for a positive balance under one cent, so it never shows $0.00 while money is left.
 */
export function formatDollars(micros: number): string {
  if (!Number.isFinite(micros)) return '$—';
  const sign = micros < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(micros));
  if (abs > 0 && abs < 10_000) return `${sign}<$0.01`;
  const cents = Math.floor(abs / 10_000);
  const dollars = Math.floor(cents / 100);
  const rest = String(cents % 100).padStart(2, '0');
  return `${sign}$${dollars.toLocaleString('en-US')}.${rest}`;
}
