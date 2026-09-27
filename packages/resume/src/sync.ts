// The profile snapshot a base resume keeps. A resume built from the profile follows the profile only while the person
// has not changed it (ResumeService compares its sections with the ones this snapshot gives). An uploaded resume and a
// resume the person edited are the person's own: the profile never rewrites them (JL-resume-1, JL-resume-23).
// Tailored versions never change (resume O12: an old version keeps its content).

import type { Profile, ProfileInput } from '@jobleft/contracts';

export function snapshotOf(p: Profile | ProfileInput): ProfileInput {
  const { id: _id, version: _v, updatedAt: _u, ...rest } = p as Profile;
  void _id; void _v; void _u;
  return structuredClone(rest) as ProfileInput;
}
