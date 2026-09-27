// The last setup check of the saved AI provider (JL-settings-3): the header chip showed a green "AI: model on this
// Mac" while the saved setup failed its own test. Settings records each check here; the chip turns grey and says
// "AI: not answering" while the last check of the settings in use failed.

let last: { at: string | null; ok: boolean } | null = null;
const subs = new Set<() => void>();

/** Records a check of the settings saved at `settingsUpdatedAt`. */
export function rememberAiCheck(settingsUpdatedAt: string | null, ok: boolean): void {
  last = { at: settingsUpdatedAt, ok };
  for (const s of [...subs]) s();
}

export function subscribeAiCheck(cb: () => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

export function lastAiCheck(): { at: string | null; ok: boolean } | null { return last; }

/** true while the last check of exactly these settings failed (a new save starts unknown). */
export function aiCheckFailed(check: { at: string | null; ok: boolean } | null, settingsUpdatedAt: string | null | undefined): boolean {
  return !!check && !check.ok && check.at === (settingsUpdatedAt ?? null);
}
