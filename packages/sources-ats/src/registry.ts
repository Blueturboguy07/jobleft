// The adapter registry this lane exports, and the merged registry the crawler runs with.

import type { CrawlAtsId } from '@jobleft/contracts';
import { SOURCES } from '@jobleft/crawler';
import type { Source, SourceRegistry } from '@jobleft/crawler';
import { gem } from './adapters/gem.ts';
import { personio } from './adapters/personio.ts';
import { recruitee } from './adapters/recruitee.ts';
import { teamtailor } from './adapters/teamtailor.ts';
import { workable } from './adapters/workable.ts';

/** The lane's adapters (workable, recruitee, personio, teamtailor, gem). Merge with @jobleft/crawler SOURCES: { ...SOURCES, ...ATS_SOURCES }. */
export const ATS_SOURCES: SourceRegistry = { workable, recruitee, personio, teamtailor, gem };

/** Every adapter the crawler can run: the crawler's built-ins (Greenhouse, Lever, Ashby) plus this lane's. */
export function allSources(): SourceRegistry {
  return { ...SOURCES, ...ATS_SOURCES };
}

/** The ATS ids that have an adapter in the merged registry, in a stable order. */
export function crawledAtsIds(registry: SourceRegistry = allSources()): CrawlAtsId[] {
  return (Object.keys(registry) as CrawlAtsId[]).filter((k) => (registry[k] as Source | undefined) !== undefined).sort();
}
