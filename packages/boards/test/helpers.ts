import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCES, Store } from '@jobleft/crawler';
import type { DirectoryRow } from '@jobleft/static-data';
import { BoardDirectory, BoardService, BusyPacer, CrawlScheduler, boardSources, createBoardHttp } from '../src/index.ts';
import type { PaidPageFetcher } from '../src/index.ts';
import { startMockHosts, type MockConfig, type MockHosts } from '../scripts/mock-hosts.ts';

export interface Rig {
  mock: MockHosts;
  store: Store;
  service: BoardService;
  scheduler: CrawlScheduler;
  clock: { now: number };
  dir: string;
  /** Every request any client sent (URL after the host map). */
  sent: string[];
  close(): Promise<void>;
}

export async function rig(config: MockConfig, opts: {
  directory?: DirectoryRow[]; intervalMs?: number; offline?: boolean; paid?: PaidPageFetcher | null; timeoutMs?: number;
} = {}): Promise<Rig> {
  const mock = await startMockHosts(config);
  const dir = mkdtempSync(join('/private/tmp', 'jl-boards-test-'));
  const store = new Store(join(dir, 'jobleft.db'));
  const pacer = new BusyPacer(opts.intervalMs ?? 0);
  const clock = { now: Date.parse('2026-09-25T12:00:00Z') };
  const sent: string[] = [];
  const newHttp = () => createBoardHttp({ pacer, hostMap: mock.hostMap, timeoutMs: opts.timeoutMs ?? 1500, retries: 1, retryDelayMs: 10, offline: () => !!opts.offline, onRequest: (i) => sent.push(i.url) });
  const http = newHttp();
  const sources = boardSources(SOURCES);
  const service = new BoardService({
    db: store.db, directory: new BoardDirectory(opts.directory ?? []), http, newHttp, sources, now: () => clock.now,
    paid: opts.paid ?? null, offline: () => !!opts.offline, resolveDeadlineMs: 10_000,
  });
  const scheduler = new CrawlScheduler({ boards: service, crawlStore: store, http, newHttp, sources, now: () => clock.now, intervalHours: () => 6 });
  return {
    mock, store, service, scheduler, clock, dir, sent,
    close: async () => { await scheduler.stop(); store.close(); await mock.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

export function row(ats: DirectoryRow['ats'], board: string, company: string, region: string | null = null): DirectoryRow {
  return { ats, board, company, region, source: 'test' };
}
