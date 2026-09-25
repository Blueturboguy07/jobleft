// Wiring for the CLI and the development server: one data folder, one database, one shared pacer, one directory.
// The real app server (apps/server) wires the same pieces itself; this file is what `jobleft-boards` uses.
//
// Environment (docs/INTERFACES.md section 4):
//   JOBLEFT_HOME                 the data folder (database at data/jobleft.db). Default: the OS default
//   JOBLEFT_HOST_MAP             JSON map from a real host to a LOOPBACK mock origin (tests and demos)
//   JOBLEFT_OFFLINE=1            no request at all
//   JOBLEFT_NOW, JOBLEFT_CLOCK_OFFSET   the test clock (time-skip)
//   JOBLEFT_BOARD_DIRECTORY      use this directory file instead ("none" = an empty directory)
//   JOBLEFT_REFRESH_HOURS        hours between scheduled refreshes (default 6)
//   JOBLEFT_PAID_FETCH_URL       a LOOPBACK stand-in of the paid page fetch (POST <url>/fetch); unset = no paid offer
//   JOBLEFT_PAID_FETCH_PRICE_MICROS   the price shown for one paid page fetch (default 4000 = $0.004)

import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nowMs } from '@jobleft/contracts';
import { SOURCES, Store, hostMapFromEnv } from '@jobleft/crawler';
import type { HttpClient, SourceRegistry } from '@jobleft/crawler';
import { ATS_SOURCES } from '@jobleft/sources-ats';
import { BoardDirectory, loadActiveDirectory, type LoadedDirectory } from './directory.ts';
import { SqlitePacer, createBoardHttp, offlineFromEnv } from './http.ts';
import { isLoopbackHost } from './hosts.ts';
import { BoardService, type PaidPageFetcher } from './service.ts';
import { CrawlScheduler } from './scheduler.ts';
import { boardSources } from './sources.ts';
import { boardApiHost } from './detect.ts';

type Env = Record<string, string | undefined>;

/** JOBLEFT_HOME, else the OS default (the same rule as apps/server resolveHome). */
export function resolveHome(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.JOBLEFT_HOME) return env.JOBLEFT_HOME;
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'jobleft');
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'jobleft');
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'jobleft');
}

/** The stand-in paid page fetch for tests (a loopback server only; no live paid service is called by this build). */
export function paidFetcherFromEnv(env: Env = process.env): PaidPageFetcher | null {
  const raw = env.JOBLEFT_PAID_FETCH_URL;
  if (!raw) return null;
  let base: URL;
  try { base = new URL(raw.endsWith('/') ? raw : `${raw}/`); } catch { throw new Error('JOBLEFT_PAID_FETCH_URL is not a URL.'); }
  if (!isLoopbackHost(base.hostname)) throw new Error('JOBLEFT_PAID_FETCH_URL must be a loopback stand-in (127.0.0.1 or localhost).');
  const price = Math.max(0, Math.round(Number(env.JOBLEFT_PAID_FETCH_PRICE_MICROS ?? 4000)));
  return {
    enabled: true,
    prices: () => ({ page: Math.round(price / 2), jsPage: price }),
    async fetchPage(url, opts) {
      const res = await fetch(new URL('fetch', base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, js: opts.js, maxPriceMicros: opts.maxPriceMicros }),
        signal: opts.signal ?? AbortSignal.timeout(45_000),
      });
      if (!res.ok) throw new Error(`the paid page fetch answered HTTP ${res.status}`);
      const j = await res.json() as { url?: string; html?: string; costMicros?: number };
      return { url: String(j.url ?? url), html: String(j.html ?? ''), costMicros: Number(j.costMicros ?? opts.maxPriceMicros) };
    },
  };
}

export interface BoardsApp {
  home: string;
  dbPath: string;
  crawlStore: Store;
  loaded: LoadedDirectory;
  directory: BoardDirectory;
  sources: SourceRegistry;
  pacer: SqlitePacer;
  newHttp: () => HttpClient;
  http: HttpClient;
  service: BoardService;
  scheduler: CrawlScheduler;
  offline: boolean;
  hostMap: Record<string, string>;
  close(): void;
}

export function openBoardsApp(opts: { env?: Env; onRequest?: (i: { host: string; status: number; url: string }) => void } = {}): BoardsApp {
  const env = opts.env ?? process.env;
  const home = resolveHome(env);
  mkdirSync(join(home, 'data'), { recursive: true, mode: 0o700 });
  try { chmodSync(home, 0o700); } catch { /* not ours to change */ }
  const dbPath = join(home, 'data', 'jobleft.db');
  const crawlStore = new Store(dbPath);
  crawlStore.db.exec('PRAGMA busy_timeout = 5000;');
  try { chmodSync(dbPath, 0o600); } catch { /* best effort */ }
  const loaded = loadActiveDirectory({ home, env });
  const directory = new BoardDirectory(loaded.entries);
  const sources = boardSources({ ...SOURCES, ...ATS_SOURCES });
  const pacer = new SqlitePacer(dbPath);
  const offline = offlineFromEnv(env);
  const hostMap = hostMapFromEnv(env);
  const newHttp = (): HttpClient => createBoardHttp({
    pacer, hostMap, offline: () => offline,
    ...(opts.onRequest ? { onRequest: opts.onRequest } : {}),
  });
  const http = newHttp();
  const now = (): number => nowMs(env);
  const service = new BoardService({
    db: crawlStore.db, directory, http, sources, now, newHttp, paid: paidFetcherFromEnv(env), offline: () => offline,
  });
  const hours = Number(env.JOBLEFT_REFRESH_HOURS ?? 6);
  const scheduler = new CrawlScheduler({
    boards: service, crawlStore, http, sources, now, newHttp, offline: () => offline,
    intervalHours: () => (Number.isFinite(hours) && hours > 0 ? hours : 6),
  });
  return {
    home, dbPath, crawlStore, loaded, directory, sources, pacer, newHttp, http, service, scheduler, offline, hostMap,
    close(): void { pacer.close(); try { crawlStore.close(); } catch { /* already closed */ } },
  };
}

/**
 * How many boards a refresh would ask on LIVE hosts (hosts that JOBLEFT_HOST_MAP does not send to a loopback mock).
 * The CLI and the development server refuse a large live refresh unless the person asks for it (--live).
 */
export function liveBoardCount(app: BoardsApp, ids?: string[]): number {
  const mapped = new Set(Object.keys(app.hostMap).map((h) => h.toLowerCase()));
  const refs = ids?.length
    ? ids.map((id) => app.service.get(id)).filter((e): e is NonNullable<typeof e> => e !== null && !e.hidden && !e.disabled)
    : app.service.due(nowMs(), { intervalHours: 0, catchUp: false });
  let n = 0;
  for (const b of refs) if (!mapped.has(boardApiHost(b.ats, b.board, b.region ?? null))) n++;
  return n;
}
