// Notes and reminders are saved as whole lists (the tracker contract: "notes and reminders replace the whole list").
// So every change reads the newest copy of the entry first and builds the new list from THAT, never from what this
// window showed a while ago. A note that another window saved a moment earlier is therefore kept.

import type { TrackerEntry, TrackerPatch } from '@jobleft/contracts';
import { call } from '../app/api.ts';

export const noteKeep = (e: TrackerEntry | null) => (e?.notes ?? []).map((n) => ({ id: n.id, text: n.text }));
export const reminderKeep = (e: TrackerEntry | null) => (e?.reminders ?? []).map((r) => ({ id: r.id, at: r.at, text: r.text, done: r.done }));

/**
 * Reads the newest entry, lets `build` make the patch from it, and saves. `build` may return null when the change no
 * longer applies (the note was deleted in another window): nothing is written and `stale` is true in the result.
 */
export async function patchFresh(jobId: string, build: (fresh: TrackerEntry | null) => TrackerPatch | null): Promise<{ entry: TrackerEntry | null; stale: boolean }> {
  const fresh = (await call('getJob', { params: { jobId } })).tracker;
  const body = build(fresh);
  if (!body) return { entry: fresh, stale: true };
  return { entry: await call('updateTracker', { params: { jobId }, body }), stale: false };
}
