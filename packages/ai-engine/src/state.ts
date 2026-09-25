// Key-free state of the AI engine: provider settings, which provider address each saved key belongs to, and the
// publik connection (install id, links, the last balance read). Never a key. The server backs this with the store's
// SettingsStore (getJson/setJson); the CLI keeps it in <JOBLEFT_HOME>/ai/state.json (mode 0600).

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AiSettings } from '@jobleft/contracts';

export interface KvStore {
  getJson<T>(key: string): T | null;
  setJson(key: string, value: unknown): void;
}

export function memoryKvStore(): KvStore {
  const m = new Map<string, string>();
  return {
    getJson<T>(key: string) { const v = m.get(key); return v === undefined ? null : (JSON.parse(v) as T); },
    setJson(key: string, value: unknown) { if (value === null || value === undefined) m.delete(key); else m.set(key, JSON.stringify(value)); },
  };
}

/** A JSON file of key-value rows, written atomically with mode 0600. */
export function fileKvStore(path: string): KvStore {
  const read = (): Record<string, unknown> => {
    if (!existsSync(path)) return {};
    try {
      const v = JSON.parse(readFileSync(path, 'utf8'));
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  return {
    getJson<T>(key: string) {
      const v = read()[key];
      return v === undefined ? null : (v as T);
    },
    setJson(key: string, value: unknown) {
      const all = read();
      if (value === null || value === undefined) delete all[key];
      else all[key] = value;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
      renameSync(tmp, path);
      try { chmodSync(path, 0o600); } catch { /* ignore */ }
    },
  };
}

/** Where AiEngine keeps the (key-free) settings. The server backs it with the store. */
export interface AiSettingsStore {
  load(): AiSettings;
  save(s: AiSettings): void;
}

/** Prices of paid page fetch and web search, per 1,000 requests, in micros (plan section 5, spike S4). */
export const METERED_PRICES_PER_1000_MICROS = { search: 5_000_000, page: 2_000_000, jsPage: 4_000_000 } as const;

/** A fresh install: no provider (the app is useful without one), paid fetch off. */
export function defaultAiSettings(): AiSettings {
  return {
    provider: null,
    localKind: null,
    vendor: null,
    baseUrl: null,
    model: null,
    keySet: false,
    keyHint: null,
    meteredFetch: { enabled: false, pricesPer1000Micros: { ...METERED_PRICES_PER_1000_MICROS } },
    updatedAt: null,
  };
}

/** Settings kept in a KvStore row ("ai.settings"). */
export function kvSettingsStore(kv: KvStore, key = 'ai.settings'): AiSettingsStore {
  return {
    load() {
      const s = kv.getJson<AiSettings>(key);
      if (!s) return defaultAiSettings();
      const d = defaultAiSettings();
      return {
        ...d,
        ...s,
        meteredFetch: { enabled: s.meteredFetch?.enabled === true, pricesPer1000Micros: { ...METERED_PRICES_PER_1000_MICROS } },
      };
    },
    save(s) { kv.setJson(key, s); },
  };
}
