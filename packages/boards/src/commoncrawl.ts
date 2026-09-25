// Common Crawl URL index (CDX API) answers -> board tokens. Pure functions; scripts/cc-discover.ts does the fetching.

import type { CrawlAtsId } from '@jobleft/contracts';
import { detectBoardFromUrl } from './detect.ts';
import { boardId } from './ids.ts';

export interface CdxLine { url: string; status: string | null }

/** Parses one CDX answer (output=json: one JSON object per line; output=text: one URL per line). */
export function parseCdx(text: string): CdxLine[] {
  const out: CdxLine[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('{')) {
      try {
        const j = JSON.parse(line) as { url?: string; status?: string };
        if (j.url) out.push({ url: j.url, status: j.status ?? null });
      } catch { /* a cut-off line: skip */ }
    } else if (/^https?:\/\//.test(line)) out.push({ url: line.split(/\s+/)[0]!, status: null });
  }
  return out;
}

/** The board tokens in a list of CDX lines (only answers that were 200, or of unknown status). */
export function slugsFromCdx(lines: CdxLine[], source: string): Array<{ ats: CrawlAtsId; slug: string; region: string | null; source: string }> {
  const seen = new Map<string, { ats: CrawlAtsId; slug: string; region: string | null; source: string }>();
  for (const l of lines) {
    if (l.status && l.status !== '200') continue;
    const d = detectBoardFromUrl(l.url);
    if (d.kind !== 'board') continue;
    const f = d.found;
    const id = boardId(f.ats, f.board, f.region);
    if (!seen.has(id)) seen.set(id, { ats: f.ats, slug: f.board, region: f.region, source });
  }
  return [...seen.values()];
}

