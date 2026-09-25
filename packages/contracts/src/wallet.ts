// PublikWallet: the publik API balance as the local app shows it. UI copy says "balance" and dollars,
// never "credits" and never tokens. Field meanings follow the publik API contract (GET /wallet, x-publik-* headers).

import { HttpUrlSchema, IsoDateTimeSchema, MicrosSchema } from './common.ts';
import { enm, int, named, nullable, obj, type Infer } from './schema.ts';

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
}), 'PublikWallet', 'The publik API balance');

export const PublikConnectionSchema = named(obj({
  state: enm(['disconnected', 'connecting', 'connected']),
  wallet: nullable(PublikWalletSchema),
  /** Version of the two-sentence disclosure the user accepted before the app connected. */
  disclosureVersion: nullable(int({ minimum: 1 })),
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
