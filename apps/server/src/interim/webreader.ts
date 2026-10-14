// Reads the job pages a web search found, in the background, so they show as job cards (Jobs > Web search). Each
// result is read once, through add by link's read (a board job from its board's feed or API, any other page once,
// robots.txt and the never-contact list obeyed), and saved as a job of the source "external:web". The address is
// remembered with what came of it, so a later search never reads it again.
//
// One request a second per host (one pacer for every read), one read at a time, and nothing while the boards are
// being refreshed: the crawl has its own pacer, and the two must never ask one host together.

import type { DatabaseSync } from 'node:sqlite';
import { HttpClient, Pacer, type Store } from '@jobleft/crawler';
import { htmlToText } from '@jobleft/parsers';
import { nowIso, type WebReadStatus, type WebSearchResult } from '@jobleft/contracts';
import { ApiFailure } from '../errors.ts';
import { knownJobFor, otherBoardJobOf, rawFromResult, readJobLink, storeExternal } from './external.ts';
import { looksLikeJobList, looksLikeJobPage } from './websearch.ts';
import { mentionsAll } from './words.ts';
export { mentionsAll, searchAlternatives, searchWords } from './words.ts';

/**
 * What came of one address: a new job (its id), a job jobleft already had (known), closed, not a job page, refused
 * (robots.txt, never-contact) or failed (tried again a day later).
 */
type State = 'queued' | 'reading' | 'job' | 'known' | 'likely_job' | 'closed' | 'refused' | 'failed' | 'not_job' | 'off_topic';

/** A failed read is tried again after this long; the other outcomes are final. */
const RETRY_FAILED_MS = 24 * 3600_000;
/** Reads at once, each on another site. */
const READERS = 3;

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return url; }
}

/** At most this many addresses wait at once; a search adds its own results to the end. */
const MAX_QUEUE = 300;
/**
 * A web job is read once, so nothing notices when it closes. One the person has not liked, applied to or added
 * leaves the list this long after it was found (a search that finds it again keeps it).
 */
export const WEB_JOB_DAYS = 30;

/**
 * Titles of pages about a job that are not a posting of one: pay ("SOC Analyst Salary in India"), courses and degrees,
 * guides ("Career Roadmap", "Roles and Responsibilities", "Job Trends"), questions ("What Is ...", "How should ...") and
 * comparisons ("... vs ..."). Search engines rank these high for a job title; they read like a posting (apply,
 * experience, responsibilities) and some even carry a JobPosting record.
 */
export const NOT_A_POSTING = /\b(salar(y|ies|is|issen)|gehalt|loon|pay scale|course|cursus|opleiding|training|certificat\w*|degree|career (guide|roadmap|path)|roadmap|roles and responsibilities|job trends|interview questions|how to become|how (to|should|do|does|can)|what (is|does|are)|wat (is|doet)|vs|versus)\b/i;

/** The word sets kept with an address ("soc analyst|security analyst"). */
function altsOf(words: string | null): string[][] {
  return (words ?? '').split('|').map((x) => x.split(' ').filter(Boolean)).filter((w) => w.length);
}

export interface WebReaderDeps {
  crawlStore: Store;
  hostMap: Record<string, string>;
  offline: () => boolean;
  /** true while the boards are being refreshed (the reader waits). */
  crawling: () => boolean;
  /** A place a title or a text states, for a page without a JobPosting record ("... | Nieuwegein | ..."). */
  placeIn?: (text: string) => string | null;
  sleep?: (ms: number) => Promise<void>;
}

export class WebReader {
  private readonly d: WebReaderDeps;
  private readonly db: DatabaseSync;
  private readonly pacer = new Pacer(1000);
  private running = false;
  private stopped = false;
  private stats = { read: 0, added: 0, closed: 0, failed: 0 };

  constructor(d: WebReaderDeps) {
    this.d = d;
    this.db = d.crawlStore.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS srv_web_results (
      url TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      job_id TEXT,
      message TEXT,
      query TEXT,
      found_at TEXT NOT NULL,
      read_at TEXT,
      words TEXT,
      title TEXT
    )`);
    try { this.db.exec('ALTER TABLE srv_web_results ADD COLUMN words TEXT'); } catch { /* there already */ }
    try { this.db.exec('ALTER TABLE srv_web_results ADD COLUMN title TEXT'); } catch { /* there already */ }
    // A read cut short by a quit is read again.
    this.db.exec("UPDATE srv_web_results SET state = 'queued' WHERE state = 'reading'");
  }

  /**
   * Notes what is already known about each result (a job jobleft has, or one it found closed) and queues the job
   * pages it has not read. Returns the results with `jobId` filled in where known.
   */
  enqueue(results: WebSearchResult[], query: string, alts: string[][] = [], start = true): WebSearchResult[] {
    const now = nowIso();
    this.expire();
    const out: WebSearchResult[] = [];
    const get = this.db.prepare('SELECT state, job_id, message, read_at FROM srv_web_results WHERE url = ?');
    const put = this.db.prepare(`INSERT INTO srv_web_results (url, state, query, found_at, words, title) VALUES (?, 'queued', ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET state = 'queued', query = excluded.query, words = excluded.words, title = excluded.title`);
    const queued = (this.db.prepare("SELECT count(*) AS n FROM srv_web_results WHERE state = 'queued'").get() as { n: number }).n;
    let room = MAX_QUEUE - queued;
    for (const r of results) {
      if (r.kind !== 'board_job' && r.kind !== 'page') { out.push(r); continue; }
      if (r.jobId) { out.push(r); continue; }
      const row = get.get(r.url) as { state: State; job_id: string | null; message: string | null; read_at: string | null } | undefined;
      if ((row?.state === 'job' || row?.state === 'known') && row.job_id) {
        // Found again: still listed somewhere, so it stays (its time starts again).
        this.db.prepare("UPDATE jobs SET last_seen = ? WHERE ats = 'external' AND board = 'web' AND job_id = ? AND closed_at IS NULL").run(now, row.job_id.split(':').slice(2).join(':'));
        out.push({ ...r, jobId: row.job_id });
        continue;
      }
      if (row && row.state !== 'failed') { out.push({ ...r, note: row.state === 'queued' ? null : row.message }); continue; }
      if (row?.state === 'failed' && row.read_at && Date.parse(row.read_at) + RETRY_FAILED_MS > Date.now()) { out.push({ ...r, note: row.message }); continue; }
      if (room-- > 0) put.run(r.url, query.slice(0, 300), now, alts.map((w) => w.join(' ')).join('|'), r.title.slice(0, 300));
      out.push(r);
    }
    // The assistant reads its own first (readNow), then starts the reader.
    if (start) void this.run();
    return out;
  }

  /**
   * Keeps a result as a job when the person likes or tracks it: the job read from it when there is one, else a job
   * made from the search result itself (title, address, short text; rawFromResult). Nothing is sent to the site. A
   * page still waiting to be read is not saved from its result: the read gives the real posting.
   */
  saveResult(url: string, title: string, snippet: string): string {
    let u: URL;
    try { u = new URL(url); } catch { throw new ApiFailure('bad_request', 'That is not a web address.'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ApiFailure('bad_request', 'That is not a web address.');
    const row = this.db.prepare('SELECT state, job_id FROM srv_web_results WHERE url = ?').get(url) as { state: State; job_id: string | null } | undefined;
    if ((row?.state === 'job' || row?.state === 'known') && row.job_id) return row.job_id;
    if (row?.state === 'queued' || row?.state === 'reading') throw new ApiFailure('conflict', 'jobleft is still reading this page. Try again in a moment.');
    const known = knownJobFor(this.d.crawlStore, u);
    if (known) return known;
    const raw = rawFromResult(url, title, snippet);
    if (!raw.title) throw new ApiFailure('bad_request', 'The result has no title to save it by.');
    // No place from the title's words: a part like "Bureau" reads as a town somewhere. Only "... in Utrecht" counts.
    const id = storeExternal(this.d.crawlStore, raw, 'web');
    this.db.prepare(`INSERT INTO srv_web_results (url, state, job_id, message, query, found_at, read_at, title) VALUES (?, 'job', ?, ?, 'saved', ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET state = 'job', job_id = excluded.job_id, message = excluded.message`)
      .run(url, id, 'Saved from the search result (the page was not read).', nowIso(), nowIso(), title.slice(0, 300));
    return id;
  }

  /**
   * Closes the web jobs not found again for WEB_JOB_DAYS that the person did not act on, and those whose title says
   * they are a page about the job, not a posting (kept by an earlier version). Returns how many.
   */
  expire(now = Date.now()): number {
    const untouched = `('external:web:' || job_id) NOT IN (SELECT job_id FROM srv_tracker WHERE liked = 1 OR external = 1 OR status IS NOT NULL)`;
    const open = this.db.prepare(`SELECT id, title, canonical_url AS url FROM jobs WHERE ats = 'external' AND board = 'web' AND closed_at IS NULL AND ${untouched}`).all() as Array<{ id: number; title: string; url: string }>;
    const close = this.db.prepare("UPDATE jobs SET closed_at = ?, closed_reason = 'not_a_posting' WHERE id = ?");
    let n = 0;
    for (const j of open) if (NOT_A_POSTING.test(j.title) || looksLikeJobList(j.url ?? '', j.title)) n += Number(close.run(new Date(now).toISOString(), j.id).changes);
    const before = new Date(now - WEB_JOB_DAYS * 86_400_000).toISOString();
    const r = this.db.prepare(`UPDATE jobs SET closed_at = ?, closed_reason = 'expired'
      WHERE ats = 'external' AND board = 'web' AND closed_at IS NULL AND last_seen < ? AND ${untouched}`).run(new Date(now).toISOString(), before);
    return n + Number(r.changes);
  }

  status(): WebReadStatus {
    const n = (s: State) => (this.db.prepare('SELECT count(*) AS n FROM srv_web_results WHERE state = ?').get(s) as { n: number }).n;
    return { running: this.running, queued: n('queued') + n('reading'), ...this.stats, jobs: n('job') };
  }

  /** Stops reading; resolves when the read in progress has finished (at most 5 seconds), so the database can close. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.current.size) await Promise.race([Promise.all([...this.current].map((p) => p.catch(() => undefined))), new Promise((r) => setTimeout(r, 5000))]);
  }

  /** The reads in progress. */
  private current = new Set<Promise<void>>();

  private async readGuarded(url: string, alts: string[][]): Promise<void> {
    const p = this.readOne(url, alts);
    this.current.add(p);
    try { await p; } catch (e) { if (!this.stopped) throw e; } finally { this.current.delete(p); }
  }

  /** Takes a queued address for one reader: false when another reader has it already. */
  private claim(url: string): boolean {
    return Number(this.db.prepare("UPDATE srv_web_results SET state = 'reading' WHERE url = ? AND state = 'queued'").run(url).changes) === 1;
  }

  /**
   * Reads these queued addresses now, in this order (the assistant's web search waits for them), and says what came
   * of each. While the boards are being refreshed nothing is read: they stay queued for later.
   */
  async readNow(urls: string[], onEach: (url: string, state: string, jobId: string | null) => void): Promise<number> {
    let read = 0;
    for (const url of urls) {
      if (this.stopped || this.d.offline() || this.d.crawling()) break;
      const row = this.db.prepare('SELECT words FROM srv_web_results WHERE url = ?').get(url) as { words: string | null } | undefined;
      if (!row || !this.claim(url)) continue;
      await this.readGuarded(url, altsOf(row.words));
      if (this.stopped) break;
      read++;
      const after = this.db.prepare('SELECT state, job_id FROM srv_web_results WHERE url = ?').get(url) as { state: string; job_id: string | null };
      onEach(url, after.state, after.job_id);
    }
    if (!this.stopped) void this.run();
    return read;
  }

  /** What came of an address, if it was read. */
  outcome(url: string): { state: string; jobId: string | null; message: string | null } | null {
    const r = this.db.prepare('SELECT state, job_id, message FROM srv_web_results WHERE url = ?').get(url) as { state: string; job_id: string | null; message: string | null } | undefined;
    return r ? { state: r.state, jobId: r.job_id, message: r.message } : null;
  }

  /**
   * Reads the queue with up to READERS reads at once, never two on one site (each site still gets at most one
   * request a second, through the shared pacer).
   */
  private async run(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    const sleep = this.d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const busy = new Set<string>();
    const worker = async () => {
      for (;;) {
        if (this.stopped || this.d.offline()) return;
        if (this.d.crawling()) { await sleep(2000); continue; }
        const queued = this.db.prepare("SELECT url, words FROM srv_web_results WHERE state = 'queued' ORDER BY found_at, rowid LIMIT 50").all() as Array<{ url: string; words: string | null }>;
        if (!queued.length) return;
        const next = queued.find((q) => !busy.has(hostOf(q.url)));
        // Every waiting page is on a site another read is on: this reader is done; that one goes on.
        if (!next) return;
        const host = hostOf(next.url);
        if (!this.claim(next.url)) continue;
        busy.add(host);
        try { await this.readGuarded(next.url, altsOf(next.words)); } finally { busy.delete(host); }
      }
    };
    try {
      await Promise.all(Array.from({ length: READERS }, (_, i) => sleep(i * 300).then(worker)));
      // A reader that stopped early (every page on a busy site) leaves pages: read them now.
      if (!this.stopped && !this.d.offline() && (this.db.prepare("SELECT 1 FROM srv_web_results WHERE state = 'queued' LIMIT 1").get())) await worker();
    } finally { this.running = false; }
  }

  private async readOne(url: string, alts: string[][]): Promise<void> {
    const set = (state: State, jobId: string | null, message: string | null) => this.db.prepare('UPDATE srv_web_results SET state = ?, job_id = ?, message = ?, read_at = ? WHERE url = ?').run(state, jobId, message, nowIso(), url);
    let u: URL;
    try { u = new URL(url); } catch { set('refused', null, 'Not a web address.'); return; }
    this.stats.read++;
    const known = knownJobFor(this.d.crawlStore, u);
    if (known) { set('known', known, null); return; }
    // A paged feed (Teamtailor, Workable) can take several requests for one board.
    const http = new HttpClient({ hostMap: this.d.hostMap, pacer: this.pacer, timeoutMs: 10_000, retries: 0, maxRequests: otherBoardJobOf(u) ? 12 : 3 });
    try {
      const raw = await readJobLink(u, { crawlStore: this.d.crawlStore }, http, { titleMustMention: alts });
      // A page about the job, or a list of jobs, is not one posting, whatever it reads like.
      const found = (this.db.prepare('SELECT title FROM srv_web_results WHERE url = ?').get(url) as { title: string | null } | undefined)?.title ?? '';
      if (NOT_A_POSTING.test(raw.title) || NOT_A_POSTING.test(found) || looksLikeJobList(url, raw.title) || (found && looksLikeJobList(url, found))) {
        set('not_job', null, 'A page about the job (pay, a guide, a course) or a list of jobs, not a posting of one.');
        return;
      }
      const text = `${raw.title}\n${htmlToText(raw.descriptionHtml)}`;
      if (alts.length && !alts.some((w) => mentionsAll(text, w))) {
        set('off_topic', null, `The job is not about ${alts.map((w) => w.join(' ')).join(' or ')}.`);
        return;
      }
      // A page without a JobPosting record: its title often names the place, and "Vacature:" is not part of the title.
      raw.title = raw.title.replace(/^\s*(?:vacature|vacancy|job|stellenangebot)\s*[:\-–|]\s*/i, '').trim() || raw.title;
      if (!raw.location && this.d.placeIn) {
        const titled = this.db.prepare('SELECT title FROM srv_web_results WHERE url = ?').get(url) as { title: string | null } | undefined;
        raw.location = this.d.placeIn(`${raw.title} | ${titled?.title ?? ''}`) ?? '';
      }
      const id = storeExternal(this.d.crawlStore, raw, 'web');
      this.stats.added++;
      set('job', id, null);
    } catch (e) {
      const f = e instanceof ApiFailure ? e : null;
      if (f?.code === 'not_found') { this.stats.closed++; set('closed', null, f.message); return; }
      const likely = () => {
        const t = this.db.prepare('SELECT title FROM srv_web_results WHERE url = ?').get(url) as { title: string | null } | undefined;
        return !!t?.title && alts.some((w) => mentionsAll(t.title!, w)) && looksLikeJobPage(url, t.title) && !looksLikeJobList(url, t.title) && !NOT_A_POSTING.test(t.title);
      };
      if (f?.code === 'forbidden_source') {
        if (likely()) { set('likely_job', null, `Most likely a job posting, but ${f.message.charAt(0).toLowerCase()}${f.message.slice(1)} Open it in your browser.`); return; }
        set('refused', null, f.message);
        return;
      }
      if (f?.code === 'unsupported_source' && /does not look like a job posting|no job title/.test(f.message)) {
        // The title names the job searched for and the address reads like one job: most likely a posting whose
        // page is built by script, so its details could not be read. It is not made a job from guesses.
        const title = this.db.prepare('SELECT title FROM srv_web_results WHERE url = ?').get(url) as { title: string | null } | undefined;
        if (title?.title && alts.some((w) => mentionsAll(title.title!, w)) && looksLikeJobPage(url, title.title) && !looksLikeJobList(url, title.title) && !NOT_A_POSTING.test(title.title)) {
          set('likely_job', null, 'Most likely a job posting, but its details could not be read (the page is built by script). Open it in your browser.');
          return;
        }
        set('not_job', null, f.message);
        return;
      }
      this.stats.failed++;
      if (likely()) { set('likely_job', null, 'Most likely a job posting, but the site did not let jobleft read it. Open it in your browser.'); return; }
      set('failed', null, f?.message ?? 'The page could not be read.');
    }
  }
}
