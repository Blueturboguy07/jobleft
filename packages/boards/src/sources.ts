// Region support on top of the crawler's adapters. The crawler's Greenhouse adapter always reads the US host; a
// board on Greenhouse's EU hosts (job-boards.eu.greenhouse.io) lives behind boards-api.eu.greenhouse.io, so sending
// it to the default host would answer "not found". boardSources() keeps every adapter as it is and adds the EU host
// for Greenhouse. Lever's EU host is already handled by the crawler (region "eu").

import { mapGreenhouse, obj, arr, PAY_QUERY } from '@jobleft/crawler';
import type { BoardRef, HttpGetter, RawJob, Source, SourceRegistry } from '@jobleft/crawler';

const GH_EU_BASE = 'https://boards-api.eu.greenhouse.io/v1/boards';

function greenhouseWithRegions(base: Source): Source {
  return {
    ats: 'greenhouse',
    fullBoardListing: base.fullBoardListing,
    host: (b: BoardRef) => (b.region === 'eu' ? 'boards-api.eu.greenhouse.io' : base.host?.(b) ?? 'boards-api.greenhouse.io'),
    async fetchBoard(board: BoardRef, http: HttpGetter): Promise<RawJob[]> {
      if (board.region !== 'eu') return base.fetchBoard(board, http);
      const resp = obj(await http.getJson(`${GH_EU_BASE}/${encodeURIComponent(board.board)}/jobs?content=true${PAY_QUERY.value}`));
      const out: RawJob[] = [];
      for (const j of arr(resp.jobs)) {
        const m = mapGreenhouse(obj(j), board);
        if (m) out.push(m);
      }
      return out;
    },
  };
}

/** The adapters the boards lane crawls and verifies with: the given registry plus region support. */
export function boardSources(base: SourceRegistry): SourceRegistry {
  const out: SourceRegistry = { ...base };
  if (base.greenhouse) out.greenhouse = greenhouseWithRegions(base.greenhouse);
  return out;
}
