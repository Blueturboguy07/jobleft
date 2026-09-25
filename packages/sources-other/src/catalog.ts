// Every non-ATS source jobleft knows about: the ones it crawls (each ships OFF until the person turns it on) and the
// ones it does not, with the reason and the date the reason was checked. The notes behind each entry live in
// docs/sources/<name>.md and must agree with this file.

import type { SourceInfo } from '@jobleft/contracts';
import type { JobFeed } from './types.ts';
import { GITHUB_FEEDS } from './feeds/github.ts';
import { hnWhoIsHiring } from './feeds/hn.ts';
import { remoteOk } from './feeds/remoteok.ts';
import { remotive } from './feeds/remotive.ts';
import { theMuse } from './feeds/themuse.ts';
import { usajobs } from './feeds/usajobs.ts';

/**
 * Hosts whose robots.txt jobleft may skip. EMPTY on purpose: only the owner can add a host here, in writing, for a
 * source whose operator issues keys for automated use (for example data.usajobs.gov). No lane adds to it.
 */
export const ROBOTS_EXCEPTIONS: readonly string[] = [];

/** Every feed with an adapter, crawled or not. */
export const ALL_FEEDS: readonly JobFeed[] = [remoteOk, theMuse, hnWhoIsHiring, ...GITHUB_FEEDS, remotive, usajobs];

/** Every approved feed (crawled: true). Each one ships OFF until reviewed and turned on by the person. */
export const OTHER_FEEDS: readonly JobFeed[] = ALL_FEEDS.filter((f) => f.info.crawled);

/** Sources that are listed so the person can see why they are absent, but have no adapter. */
export const LISTED_ONLY: ReadonlyArray<Omit<SourceInfo, 'enabled' | 'keySet' | 'status'>> = [
  {
    id: 'adzuna',
    name: 'Adzuna',
    kind: 'search_partner',
    crawled: false,
    reason: 'its terms forbid storing or aggregating results without written consent, and the plan has not approved a per-query search partner',
    checkedOn: '2026-09-25',
    evidenceUrl: 'https://developer.adzuna.com/docs/terms_of_service',
    needsKey: true,
    credit: { text: 'Jobs by Adzuna', url: 'https://www.adzuna.com/' },
    limits: 'Adzuna allows 25 calls a minute and 250 a day on a free key',
  },
];

export function feedById(id: string): JobFeed | undefined {
  return ALL_FEEDS.find((f) => f.id === id);
}

/** Environment variable the CLI reads a source's key from (keys are never written to a file). */
export function keyEnvName(sourceId: string): string {
  return `JOBLEFT_SOURCE_KEY_${sourceId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}
