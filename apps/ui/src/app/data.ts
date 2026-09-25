// A small shared cache for API reads, with subscriptions (useSyncExternalStore). A screen keeps showing the last
// good data while it reloads, so nothing flashes empty; errors are kept per key so one failed panel never blanks
// the rest of the app. `invalidate(prefix)` reloads every key that starts with the prefix.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { toUiError, type UiError } from './api.ts';

interface Entry {
  data: unknown;
  error: UiError | null;
  loading: boolean;
  loaded: boolean;
  seq: number;
  fetcher: (() => Promise<unknown>) | null;
  subs: Set<() => void>;
  snapshot: Snapshot<unknown>;
}

export interface Snapshot<T> {
  data: T | undefined;
  error: UiError | null;
  loading: boolean;
  loaded: boolean;
}

const cache = new Map<string, Entry>();

function entry(key: string): Entry {
  let e = cache.get(key);
  if (!e) {
    e = { data: undefined, error: null, loading: false, loaded: false, seq: 0, fetcher: null, subs: new Set(), snapshot: { data: undefined, error: null, loading: false, loaded: false } };
    cache.set(key, e);
  }
  return e;
}

function emit(e: Entry): void {
  e.snapshot = { data: e.data, error: e.error, loading: e.loading, loaded: e.loaded };
  for (const s of [...e.subs]) s();
}

export function load(key: string): Promise<void> {
  const e = entry(key);
  if (!e.fetcher) return Promise.resolve();
  const seq = ++e.seq;
  e.loading = true;
  emit(e);
  return e.fetcher().then(
    (data) => { if (seq !== e.seq) return; e.data = data; e.error = null; e.loading = false; e.loaded = true; emit(e); },
    (err) => { if (seq !== e.seq) return; e.error = toUiError(err); e.loading = false; e.loaded = true; emit(e); },
  );
}

/** Reads `key` with `fetcher`. Pass null as the key to skip. */
export function useApi<T>(key: string | null, fetcher: () => Promise<T>): Snapshot<T> & { reload: () => Promise<void> } {
  const k = key ?? '__none__';
  const e = entry(k);
  if (key) e.fetcher = fetcher as () => Promise<unknown>;
  const subscribe = useCallback((cb: () => void) => { const en = entry(k); en.subs.add(cb); return () => { en.subs.delete(cb); }; }, [k]);
  const snap = useSyncExternalStore(subscribe, () => entry(k).snapshot);
  useEffect(() => {
    if (!key) return;
    const en = entry(key);
    if (!en.loaded && !en.loading) void load(key);
  }, [key]);
  const reload = useCallback(() => (key ? load(key) : Promise.resolve()), [key]);
  return { ...(snap as Snapshot<T>), reload };
}

/** Reloads every cached key that starts with one of the prefixes and has subscribers; others are marked stale. */
export function invalidate(...prefixes: string[]): void {
  for (const [key, e] of cache) {
    if (!prefixes.some((p) => key.startsWith(p))) continue;
    if (e.subs.size && e.fetcher) void load(key);
    else { e.loaded = false; }
  }
}

/** Replaces cached data at once (optimistic view) - only used after the server confirmed a write. */
export function setCached<T>(key: string, update: (old: T | undefined) => T): void {
  const e = entry(key);
  e.data = update(e.data as T | undefined);
  e.loaded = true;
  emit(e);
}

export function peek<T>(key: string): T | undefined {
  return cache.get(key)?.data as T | undefined;
}
