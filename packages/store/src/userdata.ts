// The person's own records: tracker (likes, hidden jobs, status, notes, reminders), saved filters, the profile,
// chats, notifications and app settings. Each write is one transaction.

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  validate, AppSettingsSchema, JobFilterSchema, JobSortSchema, ProfileInputSchema, TrackerPatchSchema,
  type AppSettings, type ChatThread, type Job, type JobSummary, type Notification, type Profile, type ProfileInput,
  type SavedFilter, type TrackerEntry, type TrackerList, type TrackerPatch, type TrackerStatus, type TrackerView,
} from '@jobleft/contracts';
import { decodeRecord } from './codec.ts';
import { nextRev, StoreError, tx, q } from './db.ts';
import { sha256 } from './record.ts';
import { overlay } from './search.ts';

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------- tracker

interface TrackerRow {
  job_id: string; liked: number; hidden: number; external: number; status: string | null; applied_at: string | null;
  resume_id: string | null; created_at: string; updated_at: string;
}

/** The job id a tracker entry is kept under: the posting's own id, even when an alias id (a merged copy) is given. */
export function canonicalJobId(db: DatabaseSync, jobId: string): string | null {
  const r = q(db, `SELECT s.id AS id FROM job_keys k JOIN store_jobs s ON s.rid = k.rid WHERE k.key = ?`).get(`id:${jobId}`) as { id: string } | undefined;
  return r ? r.id : null;
}

export class TrackerStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  private entry(row: TrackerRow): TrackerEntry {
    const history = (q(this.db, 'SELECT status, at FROM tracker_history WHERE job_id = ? ORDER BY id').all(row.job_id) as Array<{ status: string | null; at: string }>)
      .map((h) => ({ status: (h.status ?? null) as TrackerStatus | null, at: h.at }));
    const notes = (q(this.db, 'SELECT id, text, created_at, updated_at FROM tracker_notes WHERE job_id = ? ORDER BY pos').all(row.job_id) as Array<{ id: string; text: string; created_at: string; updated_at: string }>)
      .map((n) => ({ id: n.id, text: n.text, createdAt: n.created_at, updatedAt: n.updated_at }));
    const reminders = (q(this.db, 'SELECT id, at, text, done FROM tracker_reminders WHERE job_id = ? ORDER BY pos').all(row.job_id) as Array<{ id: string; at: string; text: string; done: number }>)
      .map((r) => ({ id: r.id, at: r.at, text: r.text, done: Number(r.done) === 1 }));
    return {
      jobId: row.job_id,
      liked: Number(row.liked) === 1,
      hidden: Number(row.hidden) === 1,
      external: Number(row.external) === 1,
      status: (row.status ?? null) as TrackerStatus | null,
      statusHistory: history,
      appliedAt: row.applied_at,
      resumeId: row.resume_id,
      notes,
      reminders,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  get(jobId: string): TrackerEntry | null {
    const id = canonicalJobId(this.db, jobId) ?? jobId;
    const row = q(this.db, 'SELECT * FROM tracker WHERE job_id = ?').get(id) as unknown as TrackerRow | undefined;
    return row ? this.entry(row) : null;
  }

  /** Applies a patch in one transaction (status and its history entry together). The job must exist. */
  patch(jobId: string, patchIn: TrackerPatch, now: number, opts: { external?: boolean } = {}): TrackerEntry {
    const v = validate(TrackerPatchSchema, patchIn);
    if (!v.ok) throw new StoreError('bad_request', `The tracker change is not valid (${v.issues[0]!.path || 'body'}: ${v.issues[0]!.message}).`);
    const patch = v.value;
    const id = canonicalJobId(this.db, jobId);
    if (!id) throw new StoreError('not_found', 'There is no job with this id.');
    const at = iso(now);
    return tx(this.db, () => {
      const rev = nextRev(this.db);
      const cur = q(this.db, 'SELECT * FROM tracker WHERE job_id = ?').get(id) as unknown as TrackerRow | undefined;
      const liked = patch.liked ?? (cur ? Number(cur.liked) === 1 : false);
      const hidden = patch.hidden ?? (cur ? Number(cur.hidden) === 1 : false);
      const external = opts.external ?? (cur ? Number(cur.external) === 1 : false);
      const status = patch.status !== undefined ? patch.status : (cur?.status ?? null);
      const statusChanged = patch.status !== undefined && patch.status !== (cur?.status ?? null);
      const appliedAt = statusChanged && status !== null && !cur?.applied_at ? at : (status === null ? (cur?.applied_at ?? null) : (cur?.applied_at ?? (status ? at : null)));
      const resumeId = patch.resumeId !== undefined ? patch.resumeId : (cur?.resume_id ?? null);
      q(this.db, `INSERT INTO tracker (job_id, liked, hidden, external, status, applied_at, resume_id, created_at, updated_at, rev)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (job_id) DO UPDATE SET liked = excluded.liked, hidden = excluded.hidden,
        external = excluded.external, status = excluded.status, applied_at = excluded.applied_at, resume_id = excluded.resume_id,
        updated_at = excluded.updated_at, rev = excluded.rev`)
        .run(id, liked ? 1 : 0, hidden ? 1 : 0, external ? 1 : 0, status, appliedAt, resumeId, cur?.created_at ?? at, at, rev);
      if (statusChanged) q(this.db, 'INSERT INTO tracker_history (job_id, status, at) VALUES (?, ?, ?)').run(id, status, at);
      if (patch.notes) {
        const old = new Map((q(this.db, 'SELECT id, text, created_at FROM tracker_notes WHERE job_id = ?').all(id) as Array<{ id: string; text: string; created_at: string }>).map((n) => [n.id, n]));
        q(this.db, 'DELETE FROM tracker_notes WHERE job_id = ?').run(id);
        patch.notes.forEach((n, pos) => {
          const prev = n.id ? old.get(n.id) : undefined;
          q(this.db, 'INSERT INTO tracker_notes (id, job_id, pos, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(prev?.id ?? newId('note'), id, pos, n.text, prev?.created_at ?? at, prev && prev.text === n.text ? (prev.created_at) : at);
        });
      }
      if (patch.reminders) {
        const old = new Set((q(this.db, 'SELECT id FROM tracker_reminders WHERE job_id = ?').all(id) as Array<{ id: string }>).map((r) => r.id));
        q(this.db, 'DELETE FROM tracker_reminders WHERE job_id = ?').run(id);
        patch.reminders.forEach((r, pos) => {
          q(this.db, 'INSERT INTO tracker_reminders (id, job_id, pos, at, text, done) VALUES (?, ?, ?, ?, ?, ?)')
            .run(r.id && old.has(r.id) ? r.id : newId('rem'), id, pos, r.at, r.text, r.done ? 1 : 0);
        });
      }
      const row = q(this.db, 'SELECT * FROM tracker WHERE job_id = ?').get(id) as unknown as TrackerRow;
      return this.entry(row);
    });
  }

  list(view: TrackerView, status?: TrackerStatus): TrackerList {
    const rows = q(this.db, `SELECT t.*, s.status AS job_status, s.id AS sid, s.closed_at, s.closed_reason, s.first_seen, s.last_seen, d.doc AS doc
      FROM tracker t JOIN job_keys k ON k.key = 'id:' || t.job_id JOIN store_jobs s ON s.rid = k.rid JOIN job_docs d ON d.rid = s.rid ORDER BY t.updated_at DESC, t.job_id`).all() as unknown as Array<TrackerRow & {
      job_status: number; sid: string; closed_at: string | null; closed_reason: string | null; first_seen: string; last_seen: string; doc: Uint8Array }>;
    const counts = { liked: 0, applied: 0, external: 0, hidden: 0, closed: 0, byStatus: { applied: 0, interviewing: 0, offer_received: 0, rejected: 0, archived: 0 } };
    const items: TrackerList['items'] = [];
    for (const r of rows) {
      const open = Number(r.job_status) === 1;
      const liked = Number(r.liked) === 1, hidden = Number(r.hidden) === 1, external = Number(r.external) === 1;
      const tracked = r.status !== null;
      const inView: Record<TrackerView, boolean> = {
        liked: liked && open && !hidden,
        applied: tracked && open,
        external: external && !hidden,
        hidden,
        closed: !open && (liked || tracked || external),
      };
      for (const k of Object.keys(inView) as TrackerView[]) if (inView[k]) counts[k]++;
      if (r.status && r.status in counts.byStatus) counts.byStatus[r.status as TrackerStatus]++;
      if (!inView[view]) continue;
      if (status && r.status !== status) continue;
      const job = overlay(decodeRecord<Job>(r.doc), { id: r.sid, status: r.job_status, closed_at: r.closed_at, closed_reason: r.closed_reason, first_seen: r.first_seen, last_seen: r.last_seen });
      const { description, ...rest } = job;
      const summary: JobSummary = { ...rest, snippet: description.replace(/\s+/g, ' ').trim().slice(0, 400) };
      items.push({ entry: this.entry(r), job: summary });
    }
    return { items, counts };
  }
}

// ---------------------------------------------------------------- saved filters

interface FilterRow { id: string; name: string; filter: string; sort: string; alert_enabled: number; last_notified_at: string | null; created_at: string; updated_at: string }

type FilterInput = Pick<SavedFilter, 'name' | 'filter' | 'sort'> & { alert?: boolean };

export class FilterStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  private toFilter(r: FilterRow): SavedFilter {
    return {
      id: r.id, name: r.name, filter: JSON.parse(r.filter) as SavedFilter['filter'], sort: r.sort as SavedFilter['sort'],
      alert: { enabled: Number(r.alert_enabled) === 1, lastNotifiedAt: r.last_notified_at }, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  private check(input: FilterInput): void {
    if (typeof input.name !== 'string' || input.name.trim() === '' || input.name.length > 120) throw new StoreError('bad_request', 'A saved filter needs a name of 1 to 120 characters.');
    const f = validate(JobFilterSchema, input.filter);
    if (!f.ok) throw new StoreError('bad_request', `The filter is not valid (${f.issues[0]!.path || 'filter'}: ${f.issues[0]!.message}).`);
    const s = validate(JobSortSchema, input.sort);
    if (!s.ok) throw new StoreError('bad_request', 'The sort must be recommended, top_matched or most_recent.');
  }

  list(): SavedFilter[] {
    return (q(this.db, 'SELECT * FROM saved_filters ORDER BY created_at, id').all() as unknown as FilterRow[]).map((r) => this.toFilter(r));
  }

  get(id: string): SavedFilter | null {
    const r = q(this.db, 'SELECT * FROM saved_filters WHERE id = ?').get(id) as FilterRow | undefined;
    return r ? this.toFilter(r) : null;
  }

  create(input: FilterInput, now: number): SavedFilter {
    this.check(input);
    const id = newId('flt');
    const at = iso(now);
    q(this.db, 'INSERT INTO saved_filters (id, name, filter, sort, alert_enabled, last_notified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)')
      .run(id, input.name.trim(), JSON.stringify(input.filter), input.sort, input.alert ? 1 : 0, at, at);
    return this.get(id)!;
  }

  update(id: string, input: FilterInput, now: number): SavedFilter {
    this.check(input);
    const r = q(this.db, 'UPDATE saved_filters SET name = ?, filter = ?, sort = ?, alert_enabled = ?, updated_at = ? WHERE id = ?')
      .run(input.name.trim(), JSON.stringify(input.filter), input.sort, input.alert ? 1 : 0, iso(now), id);
    if (Number(r.changes) === 0) throw new StoreError('not_found', 'There is no saved filter with this id.');
    return this.get(id)!;
  }

  delete(id: string): boolean {
    return Number(q(this.db, 'DELETE FROM saved_filters WHERE id = ?').run(id).changes) > 0;
  }
}

// ---------------------------------------------------------------- profile

export function emptyProfileInput(): ProfileInput {
  return {
    personal: { firstName: null, middleName: null, lastName: null, email: null, phone: null, addressLine: null, city: null, region: null, postalCode: null, country: null, links: [] },
    summary: null, education: [], work: [], projects: [], certifications: [], skills: [],
    preferences: { jobFunctions: [], targetTitles: [], employmentTypes: [], workModels: [], levels: [], countries: [], places: [], minAnnualPayUsd: null, industries: [], companyStages: [], roleTypes: [], excludedCompanies: [] },
    workAuthorization: { usAuthorized: null, needsSponsorship: null, usCitizen: null, hasSecurityClearance: null, authorizedCountries: [] },
    eeo: { disability: null, veteran: null, gender: null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null },
  };
}

export class ProfileStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  /** The one profile (an empty one on a fresh install). */
  get(): Profile {
    const r = q(this.db, "SELECT data, version, updated_at FROM profile WHERE id = 'default'").get() as { data: string; version: string; updated_at: string } | undefined;
    if (!r) return { id: 'default', ...emptyProfileInput(), version: '', updatedAt: new Date(0).toISOString() };
    return { id: 'default', ...(JSON.parse(r.data) as ProfileInput), version: r.version, updatedAt: r.updated_at };
  }

  /** Replaces the editable part; the store sets updatedAt, and the version (a hash of the facts) when none is given. */
  put(input: ProfileInput, version: string, now: number): Profile {
    const v = validate(ProfileInputSchema, input);
    if (!v.ok) throw new StoreError('bad_request', `The profile is not valid (${v.issues[0]!.path || 'profile'}: ${v.issues[0]!.message}).`);
    const data = JSON.stringify(v.value);
    const ver = version || sha256(data).slice(0, 16);
    const at = iso(now);
    q(this.db, `INSERT INTO profile (id, data, version, updated_at) VALUES ('default', ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET data = excluded.data, version = excluded.version, updated_at = excluded.updated_at`).run(data, ver, at);
    return this.get();
  }

  /** Deletes the profile (fit order then needs a profile again). */
  clear(): void {
    q(this.db, "DELETE FROM profile WHERE id = 'default'").run();
  }
}

// ---------------------------------------------------------------- chats

export class ChatStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  list(): Array<Pick<ChatThread, 'id' | 'title' | 'jobId' | 'updatedAt'>> {
    return (q(this.db, 'SELECT id, title, job_id, updated_at FROM chats ORDER BY updated_at DESC, id').all() as Array<{ id: string; title: string; job_id: string | null; updated_at: string }>)
      .map((r) => ({ id: r.id, title: r.title, jobId: r.job_id, updatedAt: r.updated_at }));
  }

  get(id: string): ChatThread | null {
    const r = q(this.db, 'SELECT id, title, job_id, created_at, updated_at FROM chats WHERE id = ?').get(id) as { id: string; title: string; job_id: string | null; created_at: string; updated_at: string } | undefined;
    if (!r) return null;
    const messages = (q(this.db, 'SELECT message FROM chat_messages WHERE chat_id = ? ORDER BY pos').all(id) as Array<{ message: string }>).map((m) => JSON.parse(m.message) as ChatThread['messages'][number]);
    return { id: r.id, title: r.title, jobId: r.job_id, messages, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  append(id: string | null, message: ChatThread['messages'][number], meta: { jobId: string | null; now: number }): ChatThread {
    const at = iso(meta.now);
    return tx(this.db, () => {
      let chatId = id;
      if (!chatId || !q(this.db, 'SELECT 1 FROM chats WHERE id = ?').get(chatId)) {
        chatId = chatId ?? newId('chat');
        const title = message.content.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New conversation';
        q(this.db, 'INSERT INTO chats (id, title, job_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(chatId, title, meta.jobId, at, at);
      }
      const pos = Number((q(this.db, 'SELECT coalesce(max(pos), -1) + 1 AS p FROM chat_messages WHERE chat_id = ?').get(chatId) as { p: number }).p);
      q(this.db, 'INSERT INTO chat_messages (chat_id, pos, message) VALUES (?, ?, ?)').run(chatId, pos, JSON.stringify(message));
      q(this.db, 'UPDATE chats SET updated_at = ? WHERE id = ?').run(at, chatId);
      return this.get(chatId)!;
    });
  }

  delete(id: string): boolean {
    return tx(this.db, () => {
      q(this.db, 'DELETE FROM chat_messages WHERE chat_id = ?').run(id);
      return Number(q(this.db, 'DELETE FROM chats WHERE id = ?').run(id).changes) > 0;
    });
  }
}

// ---------------------------------------------------------------- notifications

export class NotificationStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  add(n: Omit<Notification, 'id' | 'createdAt'>, now: number): Notification {
    const out: Notification = { ...n, id: newId('ntf'), createdAt: iso(now) };
    q(this.db, 'INSERT INTO notifications (id, kind, title, body, target, created_at, acked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)')
      .run(out.id, out.kind, out.title.slice(0, 120), out.body.slice(0, 400), out.target, out.createdAt);
    return out;
  }

  pending(): Notification[] {
    return (q(this.db, 'SELECT id, kind, title, body, target, created_at FROM notifications WHERE acked_at IS NULL ORDER BY created_at, id').all() as Array<{ id: string; kind: Notification['kind']; title: string; body: string; target: string | null; created_at: string }>)
      .map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, target: r.target, createdAt: r.created_at }));
  }

  ack(id: string): boolean {
    return Number(q(this.db, 'UPDATE notifications SET acked_at = ? WHERE id = ? AND acked_at IS NULL').run(new Date().toISOString(), id).changes) > 0;
  }
}

// ---------------------------------------------------------------- settings

export const DEFAULT_SETTINGS: AppSettings = {
  crawl: { intervalHours: 12, catchUpOnLaunch: true, runInTray: true },
  notifications: { reminders: true, alerts: true },
};

export class SettingsStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  get(): AppSettings {
    return this.getJson<AppSettings>('app') ?? structuredClone(DEFAULT_SETTINGS);
  }

  put(s: AppSettings): AppSettings {
    const v = validate(AppSettingsSchema, s);
    if (!v.ok) throw new StoreError('bad_request', `The settings are not valid (${v.issues[0]!.path || 'settings'}: ${v.issues[0]!.message}).`);
    this.setJson('app', v.value);
    return this.get();
  }

  /** Key-value rows for other packages' small settings (for example the key-free AI settings). */
  getJson<T>(key: string): T | null {
    const r = q(this.db, 'SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!r) return null;
    try { return JSON.parse(r.value) as T; } catch { return null; }
  }

  setJson(key: string, value: unknown): void {
    q(this.db, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }
}
