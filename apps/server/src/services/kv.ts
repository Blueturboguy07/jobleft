// Key-value JSON rows (table srv_kv): app settings, AI provider choice (never a key), publik connection state
// (never the key), the data folder's creation time.

import type { DatabaseSync } from 'node:sqlite';
import { AppSettingsSchema, OnboardingStateSchema, nowIso, type AppSettings, type OnboardingState } from '@jobleft/contracts';
import { parseJson, prune, tx } from '../db/util.ts';

export class Kv {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  get<T>(key: string): T | null {
    const r = this.db.prepare('SELECT value FROM srv_kv WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? parseJson<T | null>(r.value, null) : null;
  }

  set(key: string, value: unknown): void {
    tx(this.db, () => {
      this.db.prepare(`INSERT INTO srv_kv (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, JSON.stringify(value), nowIso());
    });
  }

  delete(key: string): void {
    tx(this.db, () => { this.db.prepare('DELETE FROM srv_kv WHERE key = ?').run(key); });
  }
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  crawl: { intervalHours: 6, catchUpOnLaunch: true, runInTray: true },
  notifications: { reminders: true, alerts: true },
};

export class SettingsService {
  private readonly kv: Kv;
  constructor(kv: Kv) { this.kv = kv; }

  get(): AppSettings {
    const s = this.kv.get<AppSettings>('app_settings');
    if (!s) return structuredClone(DEFAULT_APP_SETTINGS);
    return {
      crawl: { ...DEFAULT_APP_SETTINGS.crawl, ...(s.crawl ?? {}) },
      notifications: { ...DEFAULT_APP_SETTINGS.notifications, ...(s.notifications ?? {}) },
    };
  }

  put(s: AppSettings): AppSettings {
    this.kv.set('app_settings', prune(AppSettingsSchema, s));
    return this.get();
  }

  /** When this data folder was first set up (used where the contract needs a time and nothing else is known). */
  createdAt(): string {
    return this.kv.get<string>('created_at') ?? nowIso();
  }
}

/**
 * Where the first-run setup stands (JL-onboarding-2, -11, -14): the step, whether it was finished or skipped, and what
 * the person chose or typed and did not save with Next yet. Kept here, not in the browser, so a quit, a reload or a
 * new port never loses it. A data folder from before this record whose profile was saved counts as set up.
 */
export class OnboardingService {
  private readonly kv: Kv;
  private readonly hasProfile: () => boolean;
  constructor(kv: Kv, hasProfile: () => boolean) { this.kv = kv; this.hasProfile = hasProfile; }

  get(): OnboardingState {
    const s = this.kv.get<OnboardingState>('onboarding');
    if (s && typeof s === 'object' && typeof s.status === 'string') {
      return { status: s.status, step: s.step ?? 0, draft: s.draft ?? null, pendingImport: s.pendingImport ?? null };
    }
    return { status: this.hasProfile() ? 'done' : 'new', step: 0, draft: null, pendingImport: null };
  }

  put(s: OnboardingState): OnboardingState {
    this.kv.set('onboarding', prune(OnboardingStateSchema, s));
    return this.get();
  }
}
