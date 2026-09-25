// Test helpers. No test makes a live request: stand-in servers listen on 127.0.0.1 and fake getters serve strings.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpClient, HttpError, NotFoundError, Pacer, Store, crawl } from '@jobleft/crawler';
import type { BoardRef, RunReport } from '@jobleft/crawler';
import { allSources } from '../src/registry.ts';
import { politeFetch } from '../src/polite-fetch.ts';
import { startStandin } from '../src/standin.ts';
import type { Standin } from '../src/standin.ts';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, 'fixtures');
export const STANDIN = join(FIXTURES, 'standin');

export function fixture(rel: string): string { return readFileSync(join(FIXTURES, rel), 'utf8'); }
export function fixtureJson(rel: string): unknown { return JSON.parse(fixture(rel)); }

export function tmp(prefix = 'jobleft-sats-'): { dir: string; done: () => void } {
  const dir = mkdtempSync(join('/private/tmp', prefix));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A fake HttpGetter: `routes` maps a URL to a body string, an Error to throw, or a function. Every call is recorded. */
export type Route = string | Error | ((url: string) => string | Error);
export function fakeHttp(routes: Record<string, Route>) {
  const calls: string[] = [];
  const answer = (url: string): string => {
    calls.push(url);
    const r = routes[url];
    if (r === undefined) throw new NotFoundError(404, url);
    const v = typeof r === 'function' ? r(url) : r;
    if (v instanceof Error) throw v;
    return v;
  };
  return {
    calls,
    async getText(url: string): Promise<string> { return answer(url); },
    async getJson(url: string): Promise<unknown> {
      const t = answer(url);
      try { return JSON.parse(t); } catch (e) { throw new HttpError(200, url, `invalid JSON from ${url}: ${(e as Error).message}`); }
    },
  };
}

export interface StandinRun {
  standin: Standin;
  store: Store;
  report: RunReport;
  http: HttpClient;
}

/** Starts the stand-in folder, crawls the given boards through the real HttpClient and crawl(), and returns both. */
export async function crawlStandin(dir: string, dbPath: string, boards?: BoardRef[], opts: {
  now?: () => number; graceMs?: number; timeoutMs?: number; paceMs?: number; store?: Store; standin?: Standin;
} = {}): Promise<StandinRun> {
  const standin = opts.standin ?? await startStandin(dir);
  const store = opts.store ?? new Store(dbPath);
  const http = new HttpClient({
    hostMap: standin.hostMap, pacer: new Pacer(opts.paceMs ?? 0), retries: 0, retryDelayMs: 0,
    timeoutMs: opts.timeoutMs ?? 5000, fetchImpl: politeFetch({ maxWaitMs: 0, timeoutMs: opts.timeoutMs ?? 5000 }),
  });
  const list = boards ?? standin.boards.map(({ ats, board, company, region }) => ({ ats, board, company, ...(region ? { region } : {}) }));
  const report = await crawl(list, { store, http, sources: allSources(), now: opts.now, graceMs: opts.graceMs });
  return { standin, store, report, http };
}

export function rows<T = Record<string, unknown>>(store: Store, sql: string, ...p: Array<string | number>): T[] {
  return store.db.prepare(sql).all(...p) as unknown as T[];
}
