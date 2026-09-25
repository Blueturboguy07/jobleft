// Region support on top of the crawler's adapters.
//
// Lever: the crawler reads api.eu.lever.co for region "eu" (documented by Lever).
// Greenhouse: boards on its EU hosts (job-boards.eu.greenhouse.io) have no public job feed that jobleft can read.
// Greenhouse documents only boards-api.greenhouse.io (https://docs.greenhouse.io/job-board.html, read 2026-09-25);
// boards-api.eu.greenhouse.io does not exist in DNS and api.eu.greenhouse.io answers 401 (needs a key). So a
// Greenhouse EU board is recognised but refused plainly (never sent to the US host, where it would be "not found").

import type { CrawlAtsId } from '@jobleft/contracts';
import type { SourceRegistry } from '@jobleft/crawler';

/** Why a board on this provider and region cannot be read, or null when it can. */
export function unreadableRegion(ats: CrawlAtsId, region: string | null): string | null {
  if (ats === 'greenhouse' && region === 'eu') {
    return "This board is on Greenhouse's EU host, which has no public job feed jobleft can read (Greenhouse documents a public feed only for its US host).";
  }
  return null;
}

/** The adapters the boards lane crawls and verifies with. */
export function boardSources(base: SourceRegistry): SourceRegistry {
  return { ...base };
}
