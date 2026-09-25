// The running app: configuration, the open database and every service built on it. Restore and delete-all close
// and reopen the data (AppData) while the server keeps listening; requests during that moment answer "not ready".

import type { DatabaseSync } from 'node:sqlite';
import { nowIso, nowMs, type SavedFilter } from '@jobleft/contracts';
import { Store } from '@jobleft/crawler';
import { openAndMigrate } from './db/open.ts';
import type { HomeLayout } from './home.ts';
import { AiService } from './interim/ai.ts';
import { BoardsService } from './interim/boards.ts';
import { ChatService } from './interim/chats.ts';
import { FilterService } from './interim/filters.ts';
import { JobsService, rowToJob, toSummary } from './interim/jobs.ts';
import { NetworkService } from './interim/network.ts';
import { ProfileService } from './interim/profile.ts';
import { PublikService } from './interim/publik.ts';
import { ResumeService } from './interim/resumes.ts';
import { TrackerService } from './interim/tracker.ts';
import type { Logger } from './log.ts';
import { Kv, SettingsService } from './services/kv.ts';
import { NotificationService } from './services/notifications.ts';
import { PairingService } from './services/pairing.ts';
import type { ServerSecretStore } from './services/secrets.ts';
import { APP_VERSION } from './version.ts';

export interface AppConfig {
  home: string;
  layout: HomeLayout;
  launchToken: string;
  dev: boolean;
  offline: boolean;
  parentPid: number | null;
  uiDir: string | null;
  publikBaseUrl: string;
  publikAppToken: string | null;
  hostMap: Record<string, string>;
  log: Logger;
  secrets: ServerSecretStore;
}

export class AppData {
  readonly db: DatabaseSync;
  readonly crawlStore: Store;
  readonly kv: Kv;
  readonly settings: SettingsService;
  readonly notifications: NotificationService;
  readonly pairing: PairingService;
  readonly profile: ProfileService;
  readonly jobs: JobsService;
  readonly tracker: TrackerService;
  readonly filters: FilterService;
  readonly resumes: ResumeService;
  readonly network: NetworkService;
  readonly chats: ChatService;
  readonly publik: PublikService;
  readonly ai: AiService;
  readonly boards: BoardsService;
  readonly migrated: { from: number; to: number; fresh: boolean };
  private timers: NodeJS.Timeout[] = [];

  constructor(cfg: AppConfig) {
    const opened = openAndMigrate(cfg.layout.db);
    this.db = opened.db;
    this.migrated = { from: opened.from, to: opened.to, fresh: opened.fresh };
    // The crawler's tables (jobs, jobs_fts, boards) on the same file, through the crawler's own Store (Built).
    this.crawlStore = new Store(cfg.layout.db);
    try { this.crawlStore.db.exec('PRAGMA busy_timeout = 5000'); } catch { /* best effort */ }
    this.kv = new Kv(this.db);
    this.settings = new SettingsService(this.kv);
    this.notifications = new NotificationService(this.db);
    this.pairing = new PairingService(this.db);
    this.profile = new ProfileService(this.db, () => this.settings.createdAt());
    this.jobs = new JobsService(this.db);
    this.network = new NetworkService(this.db);
    this.tracker = new TrackerService(this.db, {
      jobExists: (id) => this.jobs.exists(id),
      summary: (id) => { const r = this.jobs.getRow(id); return r ? toSummary(rowToJob(r)) : null; },
    });
    this.filters = new FilterService(this.db);
    this.resumes = new ResumeService(this.db, cfg.home, cfg.layout.resumes, () => this.profile.get());
    this.chats = new ChatService(this.db);
    const offline = () => cfg.offline;
    this.publik = new PublikService({ kv: this.kv, secrets: cfg.secrets, baseUrl: cfg.publikBaseUrl, appToken: cfg.publikAppToken, offline, appVersion: APP_VERSION });
    this.ai = new AiService({ kv: this.kv, secrets: cfg.secrets, publik: this.publik, chats: this.chats, offline });
    this.boards = new BoardsService({
      db: this.db, crawlStore: this.crawlStore, hostMap: cfg.hostMap, offline, settings: () => this.settings.get(), log: cfg.log,
      afterRun: () => this.savedFilterAlerts(),
    });
    const orphans = this.resumes.removeOrphans();
    if (orphans) cfg.log.info('resumes.orphans_removed', { count: orphans });
  }

  /** Background work: reminders, follow-ups and the crawl scheduler. Never before the server answers. */
  startBackground(log: Logger): void {
    const tick = () => {
      try { this.reminderTick(); } catch (e) { log.warn('reminders.failed', { error: e instanceof Error ? e.name : 'error' }); }
    };
    const first = setTimeout(tick, 2000);
    const every = setInterval(tick, 30_000);
    first.unref(); every.unref();
    this.timers.push(first, every);
    this.boards.start();
  }

  reminderTick(): void {
    const s = this.settings.get();
    if (!s.notifications.reminders) return;
    for (const r of this.tracker.dueReminders(nowMs())) {
      const job = this.jobs.get(r.jobId);
      this.notifications.add({ kind: 'reminder', title: job ? `Reminder: ${job.title}, ${job.company}` : 'Reminder', body: r.text || 'A reminder you set is due.', target: `/jobs/${encodeURIComponent(r.jobId)}` }, `reminder:${r.id}:${r.at}`);
      this.tracker.markReminderNotified(r.id);
    }
    const today = new Date(nowMs()).toISOString().slice(0, 10);
    for (const c of this.network.due(today)) {
      this.notifications.add({ kind: 'follow_up', title: `Follow up with ${c.firstName} ${c.lastName}`.trim(), body: c.company ? `You planned to follow up (${c.company}).` : 'You planned to follow up.', target: `/network/${encodeURIComponent(c.id)}` }, `follow:${c.id}:${c.followUpOn}`);
    }
  }

  /** New jobs for saved filters with alerts on (after a crawl that saved new jobs). */
  savedFilterAlerts(): void {
    if (!this.settings.get().notifications.alerts) return;
    for (const f of this.filters.list()) {
      if (!f.alert.enabled) continue;
      const since = f.alert.lastNotifiedAt ?? f.updatedAt;
      const res = this.jobs.search({ sort: 'most_recent', filter: f.filter, limit: 100 }, { hasProfile: () => this.profile.exists(), networkCount: () => null });
      const fresh = res.items.filter((i) => i.job.firstSeenAt > since).length;
      if (fresh > 0) {
        this.notifications.add({ kind: 'saved_filter_alert', title: `${fresh} new job${fresh === 1 ? '' : 's'} for "${f.name}"`, body: 'Open jobleft to see them.', target: `/jobs?filter=${encodeURIComponent(f.id)}` }, `alert:${f.id}:${nowIso()}`);
        this.markAlerted(f);
      }
    }
  }

  private markAlerted(f: SavedFilter): void {
    this.db.prepare('UPDATE srv_saved_filters SET last_notified_at = ? WHERE id = ?').run(nowIso(), f.id);
  }

  /** Stops background work and closes both connections (the WAL is checkpointed on close). */
  async close(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.ai.cancelAll();
    await this.boards.stop();
    try { this.crawlStore.close(); } catch { /* already closed */ }
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
    try { this.db.close(); } catch { /* already closed */ }
  }
}

export class App {
  readonly cfg: AppConfig;
  private current: AppData | null = null;
  /** Set while a restore or a delete-all swaps the data. */
  maintenance: string | null = null;

  constructor(cfg: AppConfig) { this.cfg = cfg; }

  open(): AppData {
    this.current = new AppData(this.cfg);
    return this.current;
  }

  get data(): AppData | null { return this.maintenance ? null : this.current; }

  /** Closes the data for a swap, runs fn, and reopens. The previous data is reopened when fn fails. */
  async swap<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
    if (this.maintenance) throw new Error('busy');
    this.maintenance = label;
    try {
      if (this.current) { await this.current.close(); this.current = null; }
      try {
        return await fn();
      } finally {
        this.current = new AppData(this.cfg);
        this.current.startBackground(this.cfg.log);
      }
    } finally {
      this.maintenance = null;
    }
  }

  async close(): Promise<void> {
    if (this.current) { await this.current.close(); this.current = null; }
  }
}
