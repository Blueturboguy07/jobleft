import type { CrawlAtsId } from '@jobleft/contracts';

/** "<ats>:<board>" or "<ats>:<region>:<board>", lower case (BoardEntry.id). */
export function boardId(ats: CrawlAtsId, board: string, region?: string | null): string {
  const b = board.trim().toLowerCase();
  return region ? `${ats}:${region.toLowerCase()}:${b}` : `${ats}:${b}`;
}

const CRAWL_ATS = new Set<string>(['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'personio']);

/** Splits a board id back into its parts, or null when it is not a board id. */
export function parseBoardId(id: string): { ats: CrawlAtsId; board: string; region: string | null } | null {
  const parts = id.trim().toLowerCase().split(':');
  if (parts.length < 2 || !CRAWL_ATS.has(parts[0]!)) return null;
  if (parts.length === 2 && parts[1]) return { ats: parts[0] as CrawlAtsId, board: parts[1], region: null };
  if (parts.length === 3 && parts[1] && parts[2]) return { ats: parts[0] as CrawlAtsId, board: parts[2], region: parts[1] };
  return null;
}

export function isCrawlAts(s: string): s is CrawlAtsId { return CRAWL_ATS.has(s); }
