// The crawl runs in this worker thread, so its database writes (one transaction per board) never block the
// server's answers (server O9: reads answer within 1 second while a crawl runs). One worker lives as long as the
// server, so its pacer keeps 1 request per second per host across runs. It shares the process environment
// (SHARE_ENV), so the app clock and the test time-skip are the same as the server's.

import { parentPort, workerData } from 'node:worker_threads';
import { nowMs } from '@jobleft/contracts';
import { HttpClient, Pacer, SOURCES, Store, crawl, type BoardRef, type BoardResult, type HttpGetter, type Source, type SourceRegistry } from '@jobleft/crawler';

interface Init { dbPath: string; hostMap: Record<string, string> }
export type ToWorker = { type: 'run'; runId: number; refs: BoardRef[] } | { type: 'stop' };
export type FromWorker =
  | { type: 'board'; runId: number; result: Omit<BoardResult, 'stats'> & { stats: BoardResult['stats'] } }
  | { type: 'done'; runId: number; boards: BoardResult[]; totals: { inserted: number; updated: number; closed: number } }
  | { type: 'failed'; runId: number; message: string };

// Server O13: a posted date is the date the board says the job was PUBLISHED, never its last edit. The foundation's
// Greenhouse adapter falls back to `updated_at` when `first_published` is missing (the crawler lane removes that
// fallback). Until that lands, the server hides `updated_at` from the adapter, so a missing date stays null.
function withoutUpdatedAt(resp: unknown): unknown {
  if (!resp || typeof resp !== 'object' || !Array.isArray((resp as { jobs?: unknown }).jobs)) return resp;
  const jobs = (resp as { jobs: unknown[] }).jobs.map((j) => {
    if (!j || typeof j !== 'object') return j;
    const { updated_at: _edit, ...rest } = j as Record<string, unknown>;
    return rest;
  });
  return { ...(resp as object), jobs };
}
const greenhouseStrict: Source = {
  ...SOURCES.greenhouse!,
  fetchBoard: (board: BoardRef, http: HttpGetter) =>
    SOURCES.greenhouse!.fetchBoard(board, { getJson: async (url: string) => withoutUpdatedAt(await http.getJson(url)) }),
};
const sources: SourceRegistry = { ...SOURCES, greenhouse: greenhouseStrict };

const init = workerData as Init;
const store = new Store(init.dbPath);
try { store.db.exec('PRAGMA busy_timeout = 10000; PRAGMA temp_store = MEMORY;'); } catch { /* best effort */ }
const pacer = new Pacer(1000);
const stop = new AbortController();

const fetchImpl: typeof fetch = (input, reqInit) => {
  if (stop.signal.aborted) return Promise.reject(new Error('stopping'));
  return fetch(input, { ...reqInit, signal: AbortSignal.any([stop.signal, ...(reqInit?.signal ? [reqInit.signal] : [])]) });
};

let queue = Promise.resolve();
parentPort!.on('message', (m: ToWorker) => {
  if (m.type === 'stop') {
    stop.abort();
    void queue.finally(() => { try { store.close(); } catch { /* closed */ } process.exit(0); });
    return;
  }
  queue = queue.then(async () => {
    const http = new HttpClient({ pacer, hostMap: init.hostMap, fetchImpl, maxRequests: 5000 });
    try {
      const rep = await crawl(m.refs, {
        store, http, sources, now: () => nowMs(),
        onBoard: (r) => parentPort!.postMessage({ type: 'board', runId: m.runId, result: r } satisfies FromWorker),
      });
      parentPort!.postMessage({ type: 'done', runId: m.runId, boards: rep.boards, totals: { inserted: rep.totals.inserted, updated: rep.totals.updated, closed: rep.totals.closed } } satisfies FromWorker);
    } catch (e) {
      parentPort!.postMessage({ type: 'failed', runId: m.runId, message: e instanceof Error ? `${e.name}: ${e.message}` : 'crawl failed' } satisfies FromWorker);
    }
  });
});
