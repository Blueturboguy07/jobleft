// INTERIM stand-in for @jobleft/store ProfileStore (table srv_profile). The one local profile. A fresh install has
// an empty profile: every fact null or empty, never a default (INTERFACES 1.5).

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ProfileInputSchema, nowIso, type Profile, type ProfileInput } from '@jobleft/contracts';
import { parseJson, prune, tx } from '../db/util.ts';

export function emptyProfileInput(): ProfileInput {
  return {
    personal: {
      firstName: null, middleName: null, lastName: null, email: null, phone: null, addressLine: null, city: null,
      region: null, postalCode: null, country: null, links: [],
    },
    summary: null,
    education: [],
    work: [],
    projects: [],
    certifications: [],
    skills: [],
    preferences: {
      jobFunctions: [], targetTitles: [], employmentTypes: [], workModels: [], levels: [], countries: [], places: [],
      minAnnualPayUsd: null, industries: [], companyStages: [], roleTypes: [], excludedCompanies: [],
    },
    workAuthorization: { usAuthorized: null, needsSponsorship: null, usCitizen: null, hasSecurityClearance: null, authorizedCountries: [] },
    eeo: { disability: null, veteran: null, gender: null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null },
  };
}

/** Stable JSON (sorted keys) so the same facts always give the same version hash. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function profileVersionOf(input: ProfileInput): string {
  return createHash('sha256').update(stable(input)).digest('hex').slice(0, 16);
}

export class ProfileService {
  private readonly db: DatabaseSync;
  private readonly createdAt: () => string;
  constructor(db: DatabaseSync, createdAt: () => string) { this.db = db; this.createdAt = createdAt; }

  /** True once the person saved a profile. */
  exists(): boolean {
    return this.db.prepare("SELECT 1 FROM srv_profile WHERE id = 'default'").get() !== undefined;
  }

  get(): Profile {
    const r = this.db.prepare("SELECT data, version, updated_at FROM srv_profile WHERE id = 'default'").get() as { data: string; version: string; updated_at: string } | undefined;
    const input = r ? parseJson<ProfileInput>(r.data, emptyProfileInput()) : emptyProfileInput();
    return { id: 'default', ...input, version: r ? r.version : profileVersionOf(input), updatedAt: r ? r.updated_at : this.createdAt() };
  }

  put(input: ProfileInput): Profile {
    const clean = prune(ProfileInputSchema, input) as ProfileInput;
    const version = profileVersionOf(clean);
    const now = nowIso();
    tx(this.db, () => {
      this.db.prepare(`INSERT INTO srv_profile (id, data, version, updated_at) VALUES ('default', ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data, version = excluded.version, updated_at = excluded.updated_at`)
        .run(JSON.stringify(clean), version, now);
    });
    return this.get();
  }
}

/** Profile facts most application forms need, by name, when missing (extension status). */
export function missingProfileFields(p: Profile): string[] {
  const out: string[] = [];
  if (!p.personal.firstName) out.push('first name');
  if (!p.personal.lastName) out.push('last name');
  if (!p.personal.email) out.push('email');
  if (!p.personal.phone) out.push('phone');
  if (!p.personal.city) out.push('city');
  return out;
}
