// "I have this" and "I don't have this" on a job's skill. Both change the PROFILE (never one job), so every job that
// names the skill follows, the change survives a restart wherever the profile is stored, and it can be undone.

import type { ProfileInput, SkillEntry } from '@jobleft/contracts';
import { skillIdFor, skillName } from './taxonomy.ts';

export interface SkillClaimChange {
  skill: string;
  has: boolean;
  /** The two profile fields exactly as they were, for undo. */
  before: { skills: SkillEntry[]; declinedSkills: string[] };
}

type WithDeclined = ProfileInput & { declinedSkills?: string[] };

function sameSkill(a: string, b: string): boolean {
  const ia = skillIdFor(a);
  const ib = skillIdFor(b);
  if (ia && ib) return ia === ib;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Marks a skill as held (`has: true`) or not held (`has: false`) in the profile. Returns the new profile, the change
 * (for undo) and the notice to show: the screen must say that this changes the profile.
 */
export function setSkillClaim<P extends WithDeclined>(profile: P, skill: string, has: boolean): { profile: P; change: SkillClaimChange; notice: string } {
  const name = skill.trim();
  if (!name) throw new Error('a skill name is needed');
  const id = skillIdFor(name);
  const display = id ? skillName(id) : name;
  const before = { skills: profile.skills.map((s) => ({ ...s })), declinedSkills: [...(profile.declinedSkills ?? [])] };
  let skills = profile.skills.slice();
  let declined = (profile.declinedSkills ?? []).filter((d) => !sameSkill(d, name));
  let notice: string;
  if (has) {
    if (!skills.some((s) => sameSkill(s.name, name))) skills.push({ name: display, years: null, source: 'user' });
    notice = `This changes your profile: ${display} is now in your skills. Every job that asks for ${display} updates.`;
  } else {
    skills = skills.filter((s) => !sameSkill(s.name, name));
    declined = [...declined, display];
    notice = `This changes your profile: ${display} is marked as a skill you do not have. No job counts it, even if a past role mentions it.`;
  }
  const next = { ...profile, skills, declinedSkills: declined } as P;
  return { profile: next, change: { skill: display, has, before }, notice };
}

/** Puts the two fields back as they were before the change. */
export function undoSkillClaim<P extends WithDeclined>(profile: P, change: SkillClaimChange): P {
  const next = { ...profile, skills: change.before.skills.map((s) => ({ ...s })) } as P;
  if (change.before.declinedSkills.length) next.declinedSkills = [...change.before.declinedSkills];
  else delete next.declinedSkills;
  return next;
}
