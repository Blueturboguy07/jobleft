// Where each ATS family's public feed lives. Regional hosts are chosen by BoardRef.region.
//
// | ATS        | Feed host                                   | region values          |
// |------------|---------------------------------------------|------------------------|
// | greenhouse | boards-api.greenhouse.io, boards-api.eu.greenhouse.io | "eu"          |
// | lever      | api.lever.co, api.eu.lever.co               | "eu"                   |
// | ashby      | api.ashbyhq.com                             | none                   |
// | workable   | apply.workable.com                          | none                   |
// | recruitee  | <board>.recruitee.com                       | none                   |
// | personio   | <board>.jobs.personio.de, .jobs.personio.com | "com" for .com         |
// | teamtailor | <board>.teamtailor.com, <board>.na.teamtailor.com | "na" for North America |
// | gem        | api.gem.com                                 | none                   |

import type { CrawlAtsId } from '@jobleft/contracts';
import { hostFor } from '@jobleft/crawler';
import type { BoardRef } from '@jobleft/crawler';

/** Families whose boards each live on their own sub-domain. */
export const SUBDOMAIN_FAMILIES: ReadonlySet<CrawlAtsId> = new Set<CrawlAtsId>(['recruitee', 'personio', 'teamtailor']);

/** The region values an ATS accepts (lower case). Anything else is treated as "no region". */
export function normalRegion(ats: CrawlAtsId, region: string | null | undefined): string | null {
  const r = (region ?? '').trim().toLowerCase();
  if (!r) return null;
  if ((ats === 'lever' || ats === 'greenhouse') && r === 'eu') return 'eu';
  if (ats === 'personio' && (r === 'com' || r === 'de')) return r === 'com' ? 'com' : null;
  if (ats === 'teamtailor' && r === 'na') return 'na';
  return null;
}

/**
 * The public feed host of an ATS (regional hosts included). For families where every board has its own sub-domain
 * (Recruitee, Personio, Teamtailor) this is the parent domain; `boardHost` gives the exact host of one board.
 */
export function atsHost(ats: CrawlAtsId, region: string | null): string {
  const r = normalRegion(ats, region);
  switch (ats) {
    case 'greenhouse': return r === 'eu' ? 'boards-api.eu.greenhouse.io' : hostFor(ats);
    case 'ashby': return hostFor(ats);
    case 'lever': return hostFor('lever', r ?? undefined);
    case 'workable': return 'apply.workable.com';
    case 'recruitee': return 'recruitee.com';
    case 'personio': return r === 'com' ? 'jobs.personio.com' : 'jobs.personio.de';
    case 'teamtailor': return r === 'na' ? 'na.teamtailor.com' : 'teamtailor.com';
    case 'gem': return 'api.gem.com';
    default: {
      const never: never = ats;
      return String(never);
    }
  }
}

/** The exact host one board is fetched from (the pacer and robots.txt work per host). */
export function boardHost(ref: Pick<BoardRef, 'ats' | 'board' | 'region'>): string {
  const base = atsHost(ref.ats, ref.region ?? null);
  if (SUBDOMAIN_FAMILIES.has(ref.ats)) return `${ref.board.trim().toLowerCase()}.${base}`;
  return base;
}
