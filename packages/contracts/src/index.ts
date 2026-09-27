// @jobleft/contracts: the shared contracts of jobleft. Types, JSON Schemas and small runtime validators for
// Job, Company, Profile, Resume, MatchResult, TrackerEntry, NetworkContact, PublikWallet, the LOCAL API and the
// extension protocol. No dependency; runs in Node 24, in the UI and in the extension.
//
// CHANGE RULES (additive only):
//   * never remove or rename a field, a route, an enum value or an export; never change a field's meaning or type;
//   * new fields are optional (`obj(required, optional)`) or nullable, and readers treat "missing" as unknown;
//   * a new enum value is allowed; every reader handles values it does not know (show nothing, never crash);
//   * a new route is allowed; a changed route is a new route (new path);
//   * bump CONTRACTS_VERSION (minor) and regenerate schemas/ (`pnpm --filter @jobleft/contracts run gen`) in the
//     same commit. A breaking change needs the owner's approval and a new API version (/api/v2).
// Interface: docs/INTERFACES.md, section "@jobleft/contracts".

export const PACKAGE_NAME = '@jobleft/contracts';
export const CONTRACTS_VERSION = '1.1.0';

export * from './schema.ts';
export * from './validate.ts';
export * from './clock.ts';
export * from './common.ts';
export * from './job.ts';
export * from './company.ts';
export * from './match.ts';
export * from './tracker.ts';
export * from './filter.ts';
export * from './profile.ts';
export * from './profile-check.ts';
export * from './resume.ts';
export * from './network.ts';
export * from './wallet.ts';
export * from './ai.ts';
export * from './sources.ts';
export * from './extension.ts';
export * from './api.ts';
export * from './registry.ts';
export * from './client.ts';
