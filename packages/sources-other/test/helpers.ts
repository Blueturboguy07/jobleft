// Test helpers: a temp data folder, the crawler store, a no-wait pacer and a stand-in on free ports.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '@jobleft/crawler';
import type { SecretStore } from '@jobleft/contracts';
import type { HostPacer } from '../src/http.ts';
import { migrateSourcesOther } from '../src/db.ts';

export const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const fixture = (rel: string): unknown => JSON.parse(readFileSync(join(FIX, rel), 'utf8'));
export const fixtureText = (rel: string): string => readFileSync(join(FIX, rel), 'utf8');

export const NOW = Date.parse('2026-09-25T12:00:00Z');

export function tempDir(prefix = 'jl-so-test-'): string {
  const base = process.platform === 'darwin' ? '/private/tmp' : tmpdir();
  return mkdtempSync(join(base, prefix));
}

export function openTestStore(dir: string): Store {
  const store = new Store(join(dir, 'jobleft.db'));
  migrateSourcesOther(store.db);
  return store;
}

export function cleanup(dir: string): void {
  // Windows keeps a just-closed database file busy for a moment; a few retries make the removal reliable there.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/** A pacer that never waits (tests that are not about pacing). */
export const noWait: HostPacer = { async wait() { /* no wait */ } };

export function memorySecrets(init: Record<string, string> = {}): SecretStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    async get(n) { return data.get(n) ?? null; },
    async set(n, v) { data.set(n, v); },
    async delete(n) { data.delete(n); },
  };
}

/** A clock the test moves by hand. */
export function clock(start = NOW): { now: () => number; advance(ms: number): void; set(t: number): void } {
  let t = start;
  return { now: () => t, advance(ms) { t += ms; }, set(x) { t = x; } };
}
