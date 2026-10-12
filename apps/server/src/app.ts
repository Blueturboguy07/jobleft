// The running app: configuration, the open database and every service built on it. Restore and delete-all close
// and reopen the data (AppData) while the server keeps listening; requests during that moment answer "not ready".

import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { nowIso, nowMs, type Digest, type SavedFilter, type WebResultOutcome, type WebSearchRequest, type WebSearchResponse } from '@jobleft/contracts';
import { ApiFailure } from './errors.ts';
import { Store } from '@jobleft/crawler';
import { createStaticDataRoutes, PoliteFetch, type StaticDataRoutes } from '@jobleft/static-data';
import { BoardDirectory, BoardService, SqlitePacer, boardSources, createBoardHttp, loadActiveDirectory } from '@jobleft/boards';
import { allSources } from '@jobleft/sources-ats';
import { FeedService } from './core/feed.ts';
import { SEED_BY_COUNTRY, countriesFor, seedBoards } from './core/seed.ts';
import { NetworkService, followUpReminderText } from '@jobleft/network';
import { openAndMigrate } from './db/open.ts';
import type { HomeLayout } from './home.ts';
import { AiFacade } from './integ/engine.ts';
import { buildAssistant } from './integ/assistant.ts';
import { WebReader, searchAlternatives, searchWords } from './interim/webreader.ts';
import { AiError } from '@jobleft/ai-engine';
import { WebSavedSearches } from './interim/websaved.ts';
import { WebTabsStore } from './interim/webtabs.ts';
import { buildDigest, digestDue, digestText, localDay } from './interim/digest.ts';
import { SearxClient, alternativesOf, dutchTitle, searchLinks, webSearchJobs } from './interim/websearch.ts';
import { widenTitles } from './interim/widen.ts';
import type { Assistant } from '@jobleft/assistant';
import { ResumeBridge } from './integ/resume.ts';
import { BoardsService, boardIdOf } from './interim/boards.ts';
import { ChatService } from './interim/chats.ts';
import { FilterService } from './interim/filters.ts';
import { companyKey } from './interim/company-key.ts';
import { JobsService, rowToJob, toSummary } from './interim/jobs.ts';
import { ProfileService } from './interim/profile.ts';
import { TrackerService } from './interim/tracker.ts';
import type { Logger } from './log.ts';
import { Kv, OnboardingService, SettingsService } from './services/kv.ts';
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

/** Country names the place dictionary reads as towns or does not know, in Dutch and in English. */
const COUNTRY_NAMES: Record<string, string> = {
  nederland: 'NL', netherlands: 'NL', 'the netherlands': 'NL', holland: 'NL', 'den haag': 'NL', "'s-gravenhage": 'NL', 'the hague': 'NL',
  belgie: 'BE', 'belgië': 'BE', belgium: 'BE', duitsland: 'DE', deutschland: 'DE', germany: 'DE',
};

const REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });
const countryDisplay = (code: string) => REGION_NAMES.of(code) ?? code;

export class AppData {
  readonly db: DatabaseSync;
  readonly crawlStore: Store;
  readonly kv: Kv;
  readonly settings: SettingsService;
  readonly onboarding: OnboardingService;
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
  /** Reads the job pages web searches found, in the background (Jobs > Web search). */
  readonly webReader: WebReader;
  /** Saved web searches: they run by themselves and alert on new jobs. */
  readonly webSaved: WebSavedSearches;
  readonly webTabs: WebTabsStore;
  /** One web search at a time (a person's or a saved one's): each sends four searches through SearXNG. */
  private webSearchBusy = false;
  readonly feed: FeedService;
  readonly migrated: { from: number; to: number; fresh: boolean };
  private timers: NodeJS.Timeout[] = [];
  private staticRoutes: StaticDataRoutes | null = null;
  private resolver: { service: BoardService; pacer: SqlitePacer } | null = null;
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
    this.onboarding = new OnboardingService(this.kv, () => this.profile.exists());
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
    this.webReader = new WebReader({
      crawlStore: this.crawlStore, hostMap: cfg.hostMap, offline, crawling: () => this.boards.status().running,
      placeIn: (text) => this.placeIn(text),
    });
    try { this.webReader.expire(); } catch { /* the next search tries again */ }
    this.webTabs = new WebTabsStore(this.db);
    this.webSaved = new WebSavedSearches({
      db: this.db, reader: this.webReader,
      search: async (req, tag) => { await this.webSearch(req, tag); },
      ready: () => !cfg.offline && !!this.settings.get().webSearch?.url && !this.webSearchBusy && !this.boards.status().running,
      alertsOn: () => this.settings.get().notifications.alerts,
      notify: (title, body, key) => { this.notifications.add({ kind: 'saved_filter_alert', title, body, target: '/jobs/web' }, key); },
    });
    this.feed = new FeedService({
      db: this.db, jobs: this.jobs,
      profile: () => (this.profile.exists() ? this.profile.get() : null),
      h1b: () => { try { return this.staticData().h1b; } catch { return null; } },
      places: () => { try { return this.staticData().places; } catch { return null; } },
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
   * JL-settings-12: finds the board behind a pasted careers or job link with the boards lane's resolver (preview
   * only; it adds nothing). Forbidden hosts (LinkedIn, Indeed, Glassdoor, SmartRecruiters, Workday, iCIMS, ...) get
   * no request and a plain refusal; every request goes through the polite client (1.1 s per host, robots.txt).
   * "Already added" is read from this server's board list. Made on first use.
   */
  boardResolver(): BoardService {
    if (!this.resolver) {
      const cfg = this.cfg;
      let directory: BoardDirectory;
      try { directory = new BoardDirectory(loadActiveDirectory({ home: cfg.home, env: cfg.env ?? process.env }).entries); } catch { directory = new BoardDirectory([]); }
      const pacer = new SqlitePacer(cfg.layout.db, 1100);
      const newHttp = () => createBoardHttp({ pacer, hostMap: cfg.hostMap, offline: () => cfg.offline });
      const service = new BoardService({
        db: this.db, directory, http: newHttp(), newHttp, sources: boardSources(allSources()), offline: () => cfg.offline,
        isAdded: (id) => this.boards.get(id) !== null,
      });
      this.resolver = { service, pacer };
    }
    return this.resolver.service;
  }

  /**
   * i-core first-run choice: after the preference step (the first profile save that states a job function, a title,
   * a place or a work model), a person with no boards gets the starting boards for their field and the first crawl
   * starts at once. Runs once per data folder.
   */
  afterProfileSaved(): void {
    if (this.kv.get<boolean>('core.seedDone')) { this.reseedForPlace(); return; }
    const p = this.profile.get();
    const pr = p.preferences;
    if (!(pr.jobFunctions.length || pr.targetTitles.length || pr.places.length || pr.workModels.length || pr.countries.length)) return;
    this.kv.set('core.seedDone', true);
    if (pr.places.length || pr.countries.length) this.kv.set('core.seedPlaceDone', true);
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

  /**
   * The setup saves after every step, so the first seed happens at "Looking for", before the place step. The first
   * save that names a place looks again, once: if the place has a country list (SEED_BY_COUNTRY) and the person still
   * follows exactly the boards jobleft seeded, the country boards are added and, when the places are only listed
   * countries, the seeded boards outside the new set are unfollowed (never deleted; the person can follow them again).
   */
  private reseedForPlace(): void {
    if (this.kv.get<boolean>('core.seedPlaceDone')) return;
    const pr = this.profile.get().preferences;
    if (!(pr.places.length || pr.countries.length)) return;
    this.kv.set('core.seedPlaceDone', true);
    const where = countriesFor(pr);
    if (!where.codes.some((c) => SEED_BY_COUNTRY[c])) return;
    const seeded = [...(this.kv.get<string[]>('core.seededBoards') ?? [])].sort();
    const followed = this.boards.followedIds();
    if (!seeded.length || followed.length !== seeded.length || followed.some((id, i) => id !== seeded[i])) {
      this.cfg.log.info('seed.place_skipped', { reason: 'boards_changed' });
      return;
    }
    let list: ReturnType<typeof seedBoards> = [];
    try { list = seedBoards(pr); } catch (e) { this.cfg.log.warn('seed.failed', { error: e instanceof Error ? e.name : 'error' }); return; }
    const added = this.boards.seedMore(list);
    const keep = new Set(list.map((b) => boardIdOf(b.ats, b.board, b.region ?? null)));
    let unfollowed = 0;
    if (where.onlyListed) for (const id of seeded) if (!keep.has(id)) { this.boards.update(id, { followed: false }); unfollowed++; }
    this.kv.set('core.seededBoards', [...keep]);
    this.cfg.log.info('seed.place_added', { boards: added.length, unfollowed });
    const auto = (this.cfg.env ?? process.env).JOBLEFT_AUTO_CRAWL !== '0';
    if (added.length && auto) this.boards.runAfterCurrent(added);
  }

  /** The assistant (chat with tools, practice), built once per data folder on first use. */
  assistant(app: App): Assistant {
    if (!this.assistantInstance) this.assistantInstance = buildAssistant(app, this, this.db);
    return this.assistantInstance;
  }

  /**
   * One web search through the saved SearXNG; the job pages it finds are queued for the web reader under `tag`
   * (the search words, or a saved search's tag). Results that jobleft already knows come back with their job id.
   */
  async webSearch(req: WebSearchRequest, tag: string, signal?: AbortSignal, onQuery?: (q: string) => void, o: { deferReading?: boolean; general?: boolean } = {}): Promise<WebSearchResponse> {
    const url = this.settings.get().webSearch?.url ?? null;
    if (!url) throw new ApiFailure('not_ready', 'Web search is not set up. Add your SearXNG address in Settings > Web search.');
    if (this.cfg.offline) throw new ApiFailure('offline', 'jobleft is set to work offline, so it did not search the web.');
    if (this.webSearchBusy) throw new ApiFailure('conflict', 'A web search is already running. Wait for it to finish.');
    this.webSearchBusy = true;
    try {
      const deps = { crawlStore: this.crawlStore, board: (id: string) => { const b = this.boards.get(id); return b ? { company: b.company, followed: b.followed } : null; } };
      const country = req.place ? this.countryOf(req.place) : null;
      // Widen with AI: titles that mean the same job join the person's own (one small call, kept for a day).
      let widenedWith: string[] = [];
      let widenProblem: string | undefined;
      if (req.widen && !o.general) {
        try {
          // A suggestion that is a place ("Utrecht") is not a title.
          widenedWith = (await widenTitles(this.ai.client(), alternativesOf(req.q), country, signal)).filter((t) => !this.placeIn(t));
        } catch (e) {
          widenProblem = e instanceof AiError && e.code === 'no_provider'
            ? 'Not widened: no AI provider is set up (Settings > AI provider).'
            : `Not widened: the AI provider did not answer (${e instanceof Error ? e.message : 'unknown error'}).`;
        }
      }
      const titles = [...alternativesOf(req.q), ...widenedWith];
      // The words of every title searched for (and their Dutch spelling): a result that names none is unrelated.
      const titleWords = [...new Set([...titles, ...(country === 'NL' || country === 'BE' ? titles.map((t) => dutchTitle(t) ?? '') : [])].flatMap((t) => searchWords(t)))];
      const found = await webSearchJobs(req, new SearxClient(url), deps, { signal, onQuery, country, general: o.general, extraTitles: widenedWith, words: titleWords });
      const extra = { ...(widenedWith.length ? { widenedWith } : {}), ...(widenProblem ? { widenProblem } : {}) };
      // A general search's pages are not job pages: nothing is queued for reading.
      if (o.general) return found;
      // A job may name any of the titles, or the Dutch spelling of one ("analist"), which the searches asked for too.
      const alts = titles.flatMap((t) => searchAlternatives(t));
      if (country === 'NL' || country === 'BE') for (const t of titles) { const nl = dutchTitle(t); if (nl) alts.push(...searchAlternatives(nl)); }
      return { ...found, ...extra, searchLinks: searchLinks(req, country), results: this.webReader.enqueue(found.results, tag, alts.slice(0, 12), !o.deferReading) };
    } finally { this.webSearchBusy = false; }
  }

  /**
   * The country a place names ("Netherlands", "Utrecht", "Den Haag" -> NL), or null. A name that is several places
   * (Amsterdam, NL and Amsterdam, MO) is the one in a country of the person's profile, else the first.
   */
  countryOf(text: string): string | null {
    const t = text.trim().toLowerCase();
    const own = COUNTRY_NAMES[t];
    if (own) return own;
    try {
      const r = this.staticData().placeLookup({ text });
      const mine = new Set(this.profile.exists() ? this.profile.get().preferences.countries : []);
      const all = [...(r.places ?? []), ...(r.ambiguous ?? [])].filter((p) => p.country);
      return (all.find((p) => mine.has(p.country!)) ?? r.places?.[0] ?? null)?.country ?? null;
    } catch { return null; }
  }

  /**
   * A place a job's title states ("Vacature Junior SOC Analyst | Nieuwegein | Tesorion", "... bij KVK (Utrecht)"):
   * each part of the title is looked up, and the first that is one city or a country is the place. Null when none.
   */
  placeIn(text: string): string | null {
    const parts = text.split(/\s*[|·–—(),]\s*|\s+-\s+|\s+(?:in|bij|te|at)\s+/i).map((x) => x.trim()).filter((x) => x && x.length <= 40 && x.split(/\s+/).length <= 3);
    // Also each capitalised word on its own ("Job Utrecht area", "Utrecht Netherlands"), after the parts.
    const words = text.match(/\b\p{Lu}[\p{L}'-]{2,}\b/gu) ?? [];
    for (const w of words) { const c = COUNTRY_NAMES[w.toLowerCase()]; if (c) { const city = words.find((x) => x !== w && this.cityIn(x, c)); return [city, countryDisplay(c)].filter(Boolean).join(', '); } }
    for (const part of [...parts, ...words]) {
      const c = COUNTRY_NAMES[part.toLowerCase()];
      if (c) return countryDisplay(c);
      try {
        const r = this.staticData().placeLookup({ text: part });
        const p = r.places?.[0];
        // Only a place the dictionary is sure of: a known city or a country, never a guess among several.
        if (p?.country && (p.city || r.notACity) && !(r.ambiguous ?? []).length) return [p.city, countryDisplay(p.country)].filter(Boolean).join(', ');
      } catch { return null; }
    }
    return null;
  }

  /** true when the word is a city of that country, and no other place of that name exists. */
  private cityIn(word: string, country: string): boolean {
    try {
      const r = this.staticData().placeLookup({ text: word });
      return !!r.places?.[0]?.city && r.places[0].country === country && !(r.ambiguous ?? []).some((p) => p.country !== country);
    } catch { return false; }
  }

  /** What came of reading web search results, with each job's places checked against the country asked for. */
  webOutcomes(urls: string[], country: string | null): WebResultOutcome[] {
    return urls.map((url) => {
      const o = this.webReader.outcome(url);
      if (!o) return { url, state: 'unread', message: null, job: null, inPlace: null };
      const j = o.jobId ? this.jobs.get(o.jobId) : null;
      // The countries come from the crawler's parsed places (the job record's places carry only their text).
      const [ats, board, ...rest] = (o.jobId ?? '').split(':');
      const row = o.jobId ? this.crawlStore.db.prepare('SELECT places_json FROM jobs WHERE lower(ats) = ? AND lower(board) = ? AND job_id = ? LIMIT 1').get(ats ?? '', board ?? '', rest.join(':')) as { places_json: string | null } | undefined : undefined;
      let parsed: Array<{ country?: string | null }> = [];
      try { parsed = JSON.parse(row?.places_json ?? '[]') as Array<{ country?: string | null }>; } catch { /* none */ }
      const job = j && j.status !== 'closed' ? {
        id: j.id, title: j.title, company: j.company, places: (j.places ?? []).map((p) => p.text).filter(Boolean).join('; '),
        countries: [...new Set([...parsed, ...(j.places ?? [])].map((p) => p.country).filter((c): c is string => !!c))], remote: j.workModel === 'remote', postedAt: j.postedAt ?? null,
      } : null;
      const inPlace = !job || !country ? null : job.countries.length ? job.countries.includes(country) : null;
      return { url, state: o.state as WebResultOutcome['state'], message: o.message, job, inPlace };
    });
  }

  /** Background work: reminders, follow-ups and the crawl scheduler. Never before the server answers. */
  startBackground(log: Logger): void {
    const tick = () => {
      try { this.reminderTick(); } catch (e) { log.warn('reminders.failed', { error: e instanceof Error ? e.name : 'error' }); }
      try { this.digestTick(); } catch (e) { log.warn('digest.failed', { error: e instanceof Error ? e.name : 'error' }); }
    };
    const first = setTimeout(tick, 2000);
    const every = setInterval(tick, 30_000);
    // Saved web searches: a look every 5 minutes (a run starts only when nothing else is busy).
    const web = setInterval(() => { this.webSaved.tick().catch((e) => log.warn('websaved.failed', { error: e instanceof Error ? e.name : 'error' })); }, 5 * 60_000);
    first.unref(); every.unref(); web.unref();
    this.timers.push(first, every, web);
    this.boards.start();
  }

  /** The daily summary for jobs first seen after `since` (see interim/digest.ts). */
  digest(since: Date, until = new Date()): Digest {
    const end = new Date(until.getFullYear(), until.getMonth(), until.getDate(), 23, 59, 59, 999);
    const deps = { hasProfile: () => this.profile.exists(), networkCount: (k: string) => this.network.countFor(k) };
    return buildDigest({
      profile: () => (this.profile.exists() ? this.profile.get() : null),
      freshIds: (iso, web) => this.jobs.idsFirstSeenSince(iso, web),
      rank: (filter, ids, limit) => { const r = this.feed.search({ sort: 'recommended', filter, limit }, deps, ids); return { items: r.items, total: r.total }; },
      remindersDueBy: (iso) => this.tracker.remindersDueBy(iso),
      followUpsDue: () => this.network.due().length,
    }, since, until, end);
  }

  /**
   * Once a day, at the hour in Settings > Notifications or the first look after it: one notification with the
   * summary since the last one (at most a week back), when there is something new or due.
   */
  digestTick(now = new Date()): void {
    const since = digestDue(now, this.settings.get().notifications, this.kv.get<{ date: string; at: string }>('digest_last'));
    if (!since) return;
    const today = localDay(now);
    const g = this.digest(since, now);
    this.kv.set('digest_last', { date: today, at: now.toISOString() });
    const text = digestText(g);
    if (text) this.notifications.add({ kind: 'new_matches', ...text, target: '/dashboard' }, `digest:${today}`);
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
   * Network follow-ups whose date is today or past. ONE unread notification carries the number due now and no name
   * (the desktop notification centre keeps its own copy outside the data folder, network O12). A follow-up that
   * becomes due replaces it with a new one; one that is done, moved or deleted changes its number in place, and it
   * goes when nothing is due (JL-network-5).
   */
  followUpReminders(opts: { afterDelete?: boolean } = {}): void {
    if (!this.settings.get().notifications.reminders) {
      if (opts.afterDelete) this.notifications.dropPending('follow_up'); // a deleted contact's follow-up must not fire
      return;
    }
    const fresh = this.network.takeReminders();
    const due = this.network.due().length;
    const open = this.notifications.pending().filter((n) => n.kind === 'follow_up');
    if (due === 0) { if (open.length) this.notifications.dropPending('follow_up'); return; }
    const text = followUpReminderText(due);
    if (fresh.count > 0) {
      this.notifications.dropPending('follow_up');
      this.notifications.add({ kind: 'follow_up', title: text.title, body: text.body, target: '/network/followups' }, `follow:${this.network.today()}:${fresh.contactIds.join(',')}`);
      return;
    }
    const [keep, ...extra] = open;
    for (const x of extra) this.notifications.remove(x.id);
    if (keep && (keep.title !== text.title || keep.body !== text.body)) this.notifications.update(keep.id, text);
  }

  /** New jobs for saved filters with alerts on (after a crawl that saved new jobs). */
  savedFilterAlerts(): void {
    if (!this.settings.get().notifications.alerts) return;
    for (const f of this.filters.list()) {
      if (!f.alert.enabled) continue;
      const since = f.alert.lastNotifiedAt ?? f.updatedAt;
      // The alert watches what the filter shows: its filters AND its search words (JL-tracker-15).
      const res = this.jobs.search({ sort: 'most_recent', filter: f.filter, ...(f.q ? { q: f.q } : {}), limit: 100 }, { hasProfile: () => this.profile.exists(), networkCount: () => null });
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
    await this.webReader.stop();
    this.ai.cancelAll();
    await this.boards.stop();
    this.resolver?.pacer.close();
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
