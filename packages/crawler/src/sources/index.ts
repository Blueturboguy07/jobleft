import type { Ats, Source } from '../types.ts';
import { greenhouse } from './greenhouse.ts';
import { lever } from './lever.ts';
import { ashby } from './ashby.ts';

/** Registry: ATS name to adapter. A new adapter is one file plus one line here (same as freehire `All`). */
export const SOURCES: Record<Ats, Source> = { greenhouse, lever, ashby };

/** Host each ATS is fetched from. The pacer is per host, so hosts run in parallel and boards on a host run in series. */
export function hostFor(ats: Ats, region?: string): string {
  switch (ats) {
    case 'greenhouse': return 'boards-api.greenhouse.io';
    case 'lever': return region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co';
    case 'ashby': return 'api.ashbyhq.com';
  }
}
