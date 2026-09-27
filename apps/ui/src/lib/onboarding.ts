// First-run setup state, as pure functions (unit tested). The local service keeps the state (OnboardingState): the
// step the person is on and what they chose or typed and did not save with Next yet, so a quit or a reload never loses
// a step or a value (JL-onboarding-2, -11), and "Skip setup" keeps what was chosen (JL-onboarding-14).

import type { OnboardingState, Profile, ProfileInput } from '@jobleft/contracts';
import { mergeImported } from './importMerge.ts';

export const LAST_STEP = 5;
export type PendingImport = NonNullable<OnboardingState['pendingImport']>;

export function toInput(p: Profile): ProfileInput {
  const { id: _i, version: _v, updatedAt: _u, ...rest } = p;
  return rest;
}

/** Where the setup opens: the saved step and draft, or the first step with the profile. */
export function resumeSetup(s: OnboardingState, profile: Profile): { step: number; d: ProfileInput; pending: PendingImport | null } {
  const step = Math.min(Math.max(0, Math.floor(s.step || 0)), LAST_STEP);
  return { step, d: s.draft ?? toInput(profile), pending: s.pendingImport ?? null };
}

/** The state to keep while the person works: the draft only when it differs from the saved profile. */
export function keptState(status: OnboardingState['status'], step: number, d: ProfileInput, pending: PendingImport | null, profile: Profile): OnboardingState {
  const same = JSON.stringify(d) === JSON.stringify(toInput(profile));
  return { status: status === 'new' ? 'active' : status, step, draft: same ? null : d, pendingImport: pending };
}

/** What Next, Skip and the last step save: the draft, plus the resume's facts when the person chose to use them. */
export function bodyToSave(d: ProfileInput, pending: PendingImport | null): ProfileInput {
  return pending?.useFacts ? mergeImported(d, pending.proposed) : d;
}

/** The state once setup is finished or skipped: nothing waits. A setup reopened after it was finished stays finished. */
export function closedState(prev: OnboardingState['status'], how: 'done' | 'skipped'): OnboardingState {
  return { status: how === 'skipped' && prev === 'done' ? 'done' : how, step: 0, draft: null, pendingImport: null };
}

/**
 * Whether the app opens the setup at launch: when it was never finished or skipped. `legacySkipped` is the old
 * browser-only "skipped" mark of jobleft 0.1.2 and earlier.
 */
export function setupPending(s: OnboardingState, legacySkipped: boolean): boolean {
  if (s.status === 'active') return true;
  return s.status === 'new' && !legacySkipped;
}

export const MAX_FUNCTION_LENGTH = 100;

/**
 * Adds a typed job function: blank text is ignored, a listed function in other letter case selects the listed one,
 * and a function already chosen is not added twice (JL-onboarding-24).
 */
export function addJobFunction(chosen: string[], typed: string, listed: string[]): string[] {
  const t = typed.trim().replace(/\s+/g, ' ').slice(0, MAX_FUNCTION_LENGTH);
  if (!t) return chosen;
  const key = t.toLowerCase();
  const canonical = listed.find((x) => x.toLowerCase() === key) ?? t;
  if (chosen.some((x) => x.toLowerCase() === key)) return chosen;
  return [...chosen, canonical];
}
