// The assistant's web_search tool, through the app's own web search and web reader: the person's SearXNG is asked
// (four searches), the most promising job pages are read at once (at most six, board jobs first, with the same rules
// as every web read), and the jobs come back with their ids. The other job pages stay queued and are read in the
// background into Jobs > Web jobs. Every step is reported, so the chat can show it as it happens.

import type { WebSearchTool, WebFoundJob } from '@jobleft/assistant';
import type { App, AppData } from '../app.ts';

/** Pages read while the assistant waits; the rest are read in the background. */
const READ_NOW = 6;

const OUTCOME: Record<string, string> = {
  job: 'a new job', known: 'a job you already have', closed: 'closed', not_job: 'not a job posting', off_topic: 'not about this search',
  refused: 'the site does not allow programs', failed: 'could not be read', queued: 'waiting', reading: 'being read',
};

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

export function webSearchToolFor(app: App, d: AppData): WebSearchTool {
  return {
    available: () => !app.cfg.offline && !!d.settings.get().webSearch?.url,
    async search(a, progress, signal) {
      const r = await d.webSearch({ q: a.query, ...(a.place ? { place: a.place } : {}) }, [a.query, a.place ?? ''].join(' ').trim(), signal,
        (q) => progress(`Asking your search engine: ${q}`), { deferReading: true });
      const pages = r.results.filter((x) => x.kind === 'board_job' || x.kind === 'page');
      progress(`${r.results.length} results: ${pages.length} job pages, ${r.boards.length} boards`);
      const byUrl = new Map(r.results.map((x) => [x.url, x]));
      const todo = [...pages.filter((x) => x.kind === 'board_job'), ...pages.filter((x) => x.kind === 'page')]
        .filter((x) => !x.jobId && d.webReader.outcome(x.url)?.state === 'queued').slice(0, READ_NOW);
      const read = await d.webReader.readNow(todo.map((x) => x.url), (url, state) => {
        const x = byUrl.get(url);
        progress(`${hostOf(url)}: ${OUTCOME[state] ?? state}`, x ? { title: x.title, url } : undefined);
      });
      const jobs: WebFoundJob[] = [];
      const ids = new Set<string>();
      let stillReading = 0;
      for (const x of pages) {
        const o = x.jobId ? { state: 'known', jobId: x.jobId } : d.webReader.outcome(x.url);
        if (o?.state === 'queued' || o?.state === 'reading') { stillReading++; continue; }
        if (!o?.jobId || ids.has(o.jobId) || (o.state !== 'job' && o.state !== 'known')) continue;
        const j = d.jobs.get(o.jobId);
        if (!j || j.status === 'closed') continue;
        ids.add(o.jobId);
        jobs.push({ id: j.id, title: j.title, company: j.company, places: (j.places ?? []).map((p) => p.text).filter(Boolean).join('; '), url: j.applyUrl || x.url, isNew: o.state === 'job' });
      }
      return {
        message: r.message,
        jobs: jobs.slice(0, 15),
        others: r.results.filter((x) => x.kind !== 'board_job' && x.kind !== 'page').slice(0, 12).map((x) => ({ title: x.title, url: x.url, snippet: x.snippet.slice(0, 300), kind: x.kind })),
        boards: r.boards.slice(0, 10).map((b) => ({ company: b.company, board: b.board, system: b.ats, followed: b.followed })),
        pagesRead: read,
        stillReading,
      };
    },
  };
}
