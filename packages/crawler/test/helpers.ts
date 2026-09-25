// Shared helpers for the end-to-end tests: loopback mock boards (testkit), a store in memory or under /private/tmp,
// and one crawl run through the same code path the CLI uses (runOnce).
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '../src/config.ts';
import type { CrawlerConfig } from '../src/config.ts';
import { Pacer } from '../src/http.ts';
import { runOnce } from '../src/scheduler.ts';
import type { RunOutcome } from '../src/scheduler.ts';
import { Store } from '../src/store.ts';
import type { BoardRef } from '../src/types.ts';
import { queryJobs } from '../src/contract.ts';
import { startMockBoards } from '../testkit/mock-boards.ts';
import type { MockBoard, MockJob, MockMode, MockServer } from '../testkit/mock-boards.ts';

export { startMockBoards };
export type { MockBoard, MockJob, MockMode, MockServer };

export const TEST_UA = 'jobleft-build/0.1 (research build; no personal data)';

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync('/private/tmp/jobleft-crawler-test-');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function tempStore(): { store: Store; path: string; cleanup: () => void } {
  const t = tempDir();
  const path = join(t.dir, 'jobleft.db');
  const store = new Store(path);
  return { store, path, cleanup: () => { try { store.close(); } catch { /* closed */ } t.cleanup(); } };
}

export function cfg(over: Partial<CrawlerConfig> = {}): CrawlerConfig {
  return makeConfig({ confirmDelaySeconds: 0, requestTimeoutSeconds: 10, ...over });
}

/** One mock server per board, so every board is its own host (as the outcome tests assume). */
export async function serveBoards(defs: Record<string, MockBoard>): Promise<{ boards: BoardRef[]; servers: Record<string, MockServer>; close: () => Promise<void> }> {
  const servers: Record<string, MockServer> = {};
  const boards: BoardRef[] = [];
  for (const [token, def] of Object.entries(defs)) {
    const m = await startMockBoards({ boards: { [token]: def } });
    servers[token] = m;
    boards.push({ ats: def.ats, board: token, company: `${token} Co`, origin: m.origin });
  }
  return { boards, servers, close: async () => { for (const s of Object.values(servers)) await s.close(); } };
}

export interface RunOpts { config?: CrawlerConfig; clock?: () => number; pacerMs?: number; force?: boolean; retryFailing?: boolean; signal?: AbortSignal }

/** One run through runOnce (the CLI path). A fast pacer by default; the politeness tests pass pacerMs 1000. */
export async function crawlOnce(store: Store, boards: BoardRef[], o: RunOpts = {}): Promise<RunOutcome> {
  const out = await runOnce(
    { store, config: o.config ?? cfg(), clock: o.clock ?? (() => Date.now()), pacer: new Pacer(o.pacerMs ?? 20) },
    { reason: 'manual', boards, force: o.force, retryFailing: o.retryFailing ?? true, signal: o.signal },
  );
  if (!out) throw new Error('nothing crawled');
  return out;
}

export function allJobs(store: Store, status: 'open' | 'closed' | 'all' = 'all') {
  return queryJobs(store.db, { status, limit: 10_000 });
}

export function jobsOf(n: number, prefix: string, over: (i: number) => Partial<MockJob> = () => ({})): MockJob[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`, title: `Role ${prefix} ${i}`, location: 'Austin, TX', description: `<p>Job ${prefix} ${i}.</p>`,
    postedAt: '2026-09-01T00:00:00Z', ...over(i),
  }));
}

export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;
