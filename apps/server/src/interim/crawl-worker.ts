// The crawl runs in this worker thread, so its database writes (one transaction per board) never block the
// server's answers (server O9: reads answer within 1 second while a crawl runs). One worker lives as long as the
// server, so its pacer keeps 1 request per second per host across runs. It shares the process environment
// (SHARE_ENV), so the app clock and the test time-skip are the same as the server's.
//
// i-core: the adapters are sources-ats `allSources()` (Greenhouse, Lever, Ashby with the sources-ats repairs, plus
// Workable, Recruitee, Personio, Teamtailor and Gem), every request goes through sources-ats `politeFetch` (1 s +
// 100 ms per host, Retry-After, Crawl-delay, body limit), and each request is appended to the request log
// ($JOBLEFT_HOME/logs/requests.ndjson: time, host, URL, status; never a header or a body).

import { appendFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { nowMs } from '@jobleft/contracts';
import { HttpClient, Pacer, Store, crawl, type BoardRef, type BoardResult } from '@jobleft/crawler';
import { allSources, politeFetch } from '@jobleft/sources-ats';

interface Init { dbPath: string; hostMap: Record<string, string>; requestLog: string | null }
export type ToWorker = { type: 'run'; runId: number; refs: BoardRef[] } | { type: 'stop' };
export type FromWorker =
  | { type: 'board'; runId: number; result: Omit<BoardResult, 'stats'> & { stats: BoardResult['stats'] } }
  | { type: 'done'; runId: number; boards: BoardResult[]; totals: { inserted: number; updated: number; closed: number } }
  | { type: 'failed'; runId: number; message: string };

/** The crawler's Pacer with a cap on a robots.txt Crawl-delay (sources-ats BoundedPacer, which is not exported). */
class BoundedPacer extends Pacer {
  override wait(host: string, extraIntervalMs = 0): Promise<void> {
    return super.wait(host, Math.min(extraIntervalMs, 60_000));
  }
}

const sources = allSources();
const init = workerData as Init;
const store = new Store(init.dbPath);
try { store.db.exec('PRAGMA busy_timeout = 10000; PRAGMA temp_store = MEMORY;'); } catch { /* best effort */ }
const pacer = new BoundedPacer(1000);
const stop = new AbortController();

const abortable: typeof fetch = (input, reqInit) => {
  if (stop.signal.aborted) return Promise.reject(new Error('stopping'));
  return fetch(input, { ...reqInit, signal: AbortSignal.any([stop.signal, ...(reqInit?.signal ? [reqInit.signal] : [])]) });
};
const fetchImpl = politeFetch({
  fetchImpl: abortable,
  timeoutMs: 20_000,
  onRequest: init.requestLog
    ? (e) => {
      try {
        appendFileSync(init.requestLog!, JSON.stringify({ at: e.at, host: e.host, url: e.url, status: e.status, waitedMs: e.waitedMs, ...(e.error ? { error: e.error } : {}) }) + '\n', { mode: 0o600 });
      } catch { /* the log is best effort */ }
    }
    : undefined,
});

let queue = Promise.resolve();
parentPort!.on('message', (m: ToWorker) => {
  if (m.type === 'stop') {
    stop.abort();
    void queue.finally(() => { try { store.close(); } catch { /* closed */ } process.exit(0); });
    return;
  }
  queue = queue.then(async () => {
    const http = new HttpClient({ pacer, hostMap: init.hostMap, fetchImpl, maxRequests: 5000, timeoutMs: 20_000 });
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
