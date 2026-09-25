import type { Ats, SourceRegistry } from '../types.ts';
import { greenhouse } from './greenhouse.ts';
import { lever } from './lever.ts';
import { ashby } from './ashby.ts';

/**
 * Built-in adapters (Greenhouse, Lever, Ashby). More adapters live in @jobleft/sources-ats; the server merges both
 * registries and passes the result to crawl() as `sources`.
 */
export const SOURCES: SourceRegistry = { greenhouse, lever, ashby };

/** Host each ATS is fetched from. The pacer is per host, so hosts run in parallel and boards on a host run in series. */
export function hostFor(ats: Ats, region?: string): string {
  switch (ats) {
    case 'greenhouse': return 'boards-api.greenhouse.io';
    case 'lever': return region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co';
    case 'ashby': return 'api.ashbyhq.com';
    default: return `ats:${ats}`; // adapters outside this package report their host through Source.host()
  }
}
