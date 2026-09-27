// The running app: configuration, the open database and every service built on it. Restore and delete-all close
// and reopen the data (AppData) while the server keeps listening; requests during that moment answer "not ready".

import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { nowIso, nowMs, type SavedFilter } from '@jobleft/contracts';
import { Store } from '@jobleft/crawler';
import { createStaticDataRoutes, PoliteFetch, type StaticDataRoutes } from '@jobleft/static-data';
import { FeedService } from './core/feed.ts';
import { seedBoards } from './core/seed.ts';
import { NetworkService } from '@jobleft/network';
import { openAndMigrate } from './db/open.ts';
import type { HomeLayout } from './home.ts';
import { AiFacade } from './integ/engine.ts';
import { buildAssistant } from './integ/assistant.ts';
import type { Assistant } from '@jobleft/assistant';
import { ResumeBridge } from './integ/resume.ts';
import { BoardsService } from './interim/boards.ts';
import { ChatService } from './interim/chats.ts';
import { FilterService } from './interim/filters.ts';
import { companyKey } from './interim/company-key.ts';
import { JobsService, rowToJob, toSummary } from './interim/jobs.ts';
import { ProfileService } from './interim/profile.ts';
import { TrackerService } from './interim/tracker.ts';
import type { Logger } from './log.ts';
import { Kv, SettingsService } from './services/kv.ts';
import { NotificationService } from './services/notifications.ts';
import { PairingService } from './services/pairing.ts';
import type { ServerSecretStore } from './services/secrets.ts';
import { APP_VERSION } from './version.ts';

export interface AppConfig {
  /** Set by the server once it is listening: stops everything cleanly and exits (the shutdown route). */
  requestShutdown?: () => void;
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
  /** The environment the server was started with (the AI engine reads JOBLEFT_AI_HOST_MAP and friends). */
  env?: Record<string, string | undefined>;
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
  readonly resumes: ResumeBridge;
  readonly network: NetworkService;
  readonly chats: ChatService;
  readonly ai: AiFacade;
  private assistantInstance: Assistant | null = null;
  readonly boards: BoardsService;
  readonly feed: FeedService;
  readonly migrated: { from: number; to: number; fresh: boolean };
  private timers: NodeJS.Timeout[] = [];
  private staticRoutes: StaticDataRoutes | null = null;
  private readonly cfg: AppConfig;

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
    const opened = openAndMigrate(cfg.layout.db);
    this.db = opened.db;
    this.migrated = { from: opened.from, to: opened.to, fresh: opened.fresh };
    // The crawler's tables (jobs, jobs_fts, boards) on the same file, through the crawler's own Store (Built).
    this.crawlStore = new Store(cfg.layout.db);
    try { this.crawlStore.db.exec('PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;'); } catch { /* best effort */ }
    this.kv = new Kv(this.db);
    this.settings = new SettingsService(this.kv);
    this.notifications = new NotificationService(this.db);
    this.pairing = new PairingService(this.db);
    this.profile = new ProfileService(this.db, () => this.settings.createdAt());
    this.jobs = new JobsService(this.db);
    this.network = new NetworkService({ db: this.db, companyKey });
    this.tracker = new TrackerService(this.db, {
      jobExists: (id) => this.jobs.exists(id),
      summary: (id) => { const r = this.jobs.getRow(id); return r ? toSummary(rowToJob(r)) : null; },
    });
    this.filters = new FilterService(this.db);
    this.chats = new ChatService(this.db);
    const offline = () => cfg.offline;
    // i-resume: the real AI engine (settings, keys, publik balance, chat) and the real resume engine.
    this.ai = new AiFacade({
      kv: this.kv, secrets: cfg.secrets, chats: this.chats, publikBaseUrl: cfg.publikBaseUrl, publikAppToken: cfg.publikAppToken,
      offline: cfg.offline, env: cfg.env ?? process.env, appVersion: APP_VERSION,
    });
    this.resumes = new ResumeBridge({
      db: this.db, filesDir: cfg.layout.resumes, profile: () => this.profile.get(), job: (id) => this.jobs.get(id), ai: () => this.ai.client(),
    });
    this.boards = new BoardsService({
      db: this.db, dbPath: cfg.layout.db, crawlStore: this.crawlStore, hostMap: cfg.hostMap, offline, settings: () => this.settings.get(), log: cfg.log,
      afterRun: () => this.savedFilterAlerts(),
      requestLog: join(cfg.layout.logs, 'requests.ndjson'),
      seeded: () => new Set(this.kv.get<string[]>('core.seededBoards') ?? []),
      autoCrawl: () => (cfg.env ?? process.env).JOBLEFT_AUTO_CRAWL !== '0',
    });
    this.feed = new FeedService({
      db: this.db, jobs: this.jobs,
      profile: () => (this.profile.exists() ? this.profile.get() : null),
      h1b: () => { try { return this.staticData().h1b; } catch { return null; } },
    });
    const orphans = this.resumes.removeOrphans();
    if (orphans) cfg.log.info('resumes.orphans_removed', { count: orphans });
  }

  /**
   * The shipped datasets (H-1B filings, places) and company facts (static-data), loaded on first use. Company-fact
   * requests go only to the documented fact sources (Wikidata, SEC, GLEIF), only when the person asks for a refresh.
   */
  staticData(): StaticDataRoutes {
    if (!this.staticRoutes) {
      const pf = new PoliteFetch({ offline: this.cfg.offline });
      this.staticRoutes = createStaticDataRoutes({
        dataDir: this.cfg.layout.datasets, db: this.db, fetchText: (u) => pf.text(u),
        manifestUrl: process.env.JOBLEFT_DATASET_MANIFEST_URL || null,
      });
    }
    return this.staticRoutes;
  }

  /**
   * i-core first-run choice: after the preference step (the first profile save that states a job function, a title,
   * a place or a work model), a person with no boards gets the starting boards for their field and the first crawl
   * starts at once. Runs once per data folder.
   */
  afterProfileSaved(): void {
    if (this.kv.get<boolean>('core.seedDone')) return;
    const p = this.profile.get();
    const pr = p.preferences;
    if (!(pr.jobFunctions.length || pr.targetTitles.length || pr.places.length || pr.workModels.length || pr.countries.length)) return;
    this.kv.set('core.seedDone', true);
    // JOBLEFT_AUTO_CRAWL=0 (tests): the boards are seeded, but no crawl of real employer boards starts on its own.
    const auto = (this.cfg.env ?? process.env).JOBLEFT_AUTO_CRAWL !== '0';
    if (this.boards.count() > 0) { if (auto) this.boards.runNow(undefined, 'first_run').catch(() => { /* offline: the scheduler retries */ }); return; }
    let list: ReturnType<typeof seedBoards> = [];
    try { list = seedBoards(pr); } catch (e) { this.cfg.log.warn('seed.failed', { error: e instanceof Error ? e.name : 'error' }); }
    const added = this.boards.seed(list);
    this.kv.set('core.seededBoards', added);
    this.cfg.log.info('seed.added', { boards: added.length });
    if (added.length && auto) this.boards.runNow(undefined, 'first_run').catch((e) => this.cfg.log.warn('seed.crawl_not_started', { error: e instanceof Error ? e.message : 'error' }));
  }

  /** The assistant (chat with tools, practice), built once per data folder on first use. */
  assistant(app: App): Assistant {
    if (!this.assistantInstance) this.assistantInstance = buildAssistant(app, this, this.db);
    return this.assistantInstance;
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
    this.followUpReminders();
  }

  /**
   * Network follow-ups whose date is today or past, once per date. One notification carries a count and no name:
   * the desktop notification centre keeps its own copy outside the data folder (network O12).
   */
  followUpReminders(): void {
    if (!this.settings.get().notifications.reminders) return;
    const r = this.network.takeReminders();
    if (r.count === 0 || !r.text) return;
    this.notifications.add({ kind: 'follow_up', title: r.text.title, body: r.text.body, target: '/network/followups' }, `follow:${r.contactIds.join(',')}`);
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
    this.feed.stop();
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
