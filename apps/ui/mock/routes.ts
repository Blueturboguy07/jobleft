// Handlers for every LOCAL_API route (packages/contracts/src/api.ts), backed by the mock state.
// Each handler gets the validated body and query and returns the response body, a file, or an SSE stream.

import type { ServerResponse } from 'node:http';
import {
  bandFor, nowIso, nowMs, type AiSettings, type AppSettings, type OnboardingState, type ChatThread, type Company, type CoverLetter, type Job, type JobFilter, type JobSearchRequest,
  type MatchResult, type NetworkContact, type Notification, type PairingInfo, type PracticeItem, type PracticeSession, type Profile, type ProfileInput,
  type ProviderCheck, type PublikConnection, type PublikWallet, type Resume, type ResumeDocument, type RouteName, type SavedFilter, type SourceInfo,
  type TailorProposal, type TrackerEntry, type TrackerList, type TrackerPatch, type ActionProposal, type BoardEntry, type DatasetInfo,
} from '@jobleft/contracts';
import { ApiFail, complete, isLoopback, isOffline, listModels, publikBase, scrubCredits, stream, type ChatMsg } from './ai-client.ts';
import { CITIES, cityText, resolveCity } from './cities.ts';
import type { Crawler } from './crawl.ts';
import { makeDocx, makePdf, makeZip, readZip } from './docs.ts';
import { toJob, toSummary, boardsOrigin } from './jobs.ts';
import { scoreMatch } from './match.ts';
import { mergeImport, rankAt } from './network.ts';
import { atsCheck, documentFromProfile, emptyProfileInput, fitCheck, importResumeBytes, keywordGaps, renderDocx, renderPdf } from './resume.ts';
import { h1bTagOf, search } from './search.ts';
import { DEFAULT_SETTINGS, defaultAi, type JobRec, type MockState } from './state.ts';
import { companyKey, newId, sha256, PORTS } from './util.ts';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface Ctx {
  state: MockState;
  crawler: Crawler;
  dev: boolean;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  raw: Uint8Array | null;
  headers: Record<string, string | string[] | undefined>;
  res: ServerResponse;
}

export type Result =
  | { kind: 'json'; status?: number; body: unknown }
  | { kind: 'file'; fileName: string; mime: string; bytes: Uint8Array }
  | { kind: 'sse' };

const json = (body: unknown, status = 200): Result => ({ kind: 'json', body, status });
const file = (fileName: string, mime: string, bytes: Uint8Array): Result => ({ kind: 'file', fileName, mime, bytes });
const fail = (code: string, status: number, message: string) => new ApiFail(code, status, message);

// ------------------------------------------------------------------ profile and match cache

const EMPTY_TIME = '2026-01-01T00:00:00.000Z';

export function emptyProfile(): Profile {
  return { id: 'default', ...emptyProfileInput(), version: 'empty', updatedAt: EMPTY_TIME };
}

export function hasProfile(p: Profile | null): p is Profile {
  if (!p) return false;
  return !!(p.personal.firstName || p.work.length || p.skills.length || p.preferences.jobFunctions.length || p.preferences.targetTitles.length);
}

let matchCache = new Map<string, MatchResult | null>();
let matchCacheVersion = '';

export function matchFor(state: MockState, rec: JobRec): MatchResult | null {
  const p = state.data.profile;
  if (!hasProfile(p)) return null;
  if (p.version !== matchCacheVersion) { matchCache = new Map(); matchCacheVersion = p.version; }
  const key = `${rec.job.id}:${rec.job.contentHash}`;
  if (matchCache.has(key)) return matchCache.get(key)!;
  const m = scoreMatch({ profile: p, job: rec.job, company: state.companyFor(rec.job), networkCount: state.networkCount(rec.job.companyKey), now: Date.parse(p.updatedAt) });
  matchCache.set(key, m);
  return m;
}

export function clearMatchCache(): void {
  matchCache = new Map();
}

function profileVersion(p: ProfileInput): string {
  const { eeo: _e, ...facts } = p;
  return sha256(JSON.stringify(facts)).slice(0, 16);
}

function jobOr404(state: MockState, id: string): JobRec {
  const r = state.jobs.get(id);
  if (!r) throw fail('not_found', 404, 'That job is not in your saved jobs.');
  return r;
}

// ------------------------------------------------------------------ tracker

function newEntry(jobId: string, now: string): TrackerEntry {
  return { jobId, liked: false, hidden: false, external: false, status: null, statusHistory: [], appliedAt: null, resumeId: null, notes: [], reminders: [], createdAt: now, updatedAt: now };
}

function trackerList(state: MockState, view: string, status?: string): TrackerList {
  const items: TrackerList['items'] = [];
  const counts = { liked: 0, applied: 0, external: 0, hidden: 0, closed: 0, byStatus: { applied: 0, interviewing: 0, offer_received: 0, rejected: 0, archived: 0 } };
  const entries = Object.values(state.data.tracker).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.jobId < b.jobId ? -1 : 1));
  for (const e of entries) {
    const rec = state.jobs.get(e.jobId);
    if (!rec) continue;
    const open = rec.job.status === 'open';
    const inView = {
      liked: e.liked && !e.hidden && open,
      applied: e.status !== null,
      external: e.external,
      hidden: e.hidden,
      closed: !open && (e.liked || e.status !== null || e.external),
      tracked: e.liked || e.status !== null || e.appliedAt !== null || e.notes.length > 0 || e.reminders.length > 0,
    };
    if (inView.liked) counts.liked++;
    if (inView.applied) { counts.applied++; counts.byStatus[e.status!]++; }
    if (inView.external) counts.external++;
    if (inView.hidden) counts.hidden++;
    if (inView.closed) counts.closed++;
    if (inView[view as keyof typeof inView] && (view !== 'applied' || !status || e.status === status)) items.push({ entry: e, job: toSummary(rec.job) });
  }
  return { items, counts };
}

export function patchTracker(state: MockState, jobId: string, patch: TrackerPatch): TrackerEntry {
  jobOr404(state, jobId);
  const now = nowIso();
  let out!: TrackerEntry;
  state.mutate('tracker', 'this change', (d) => {
    const e = d[jobId] ?? newEntry(jobId, now);
    if (patch.liked !== undefined) e.liked = patch.liked;
    if (patch.hidden !== undefined) e.hidden = patch.hidden;
    if (patch.status !== undefined && patch.status !== e.status) {
      e.status = patch.status;
      e.statusHistory.push({ status: patch.status, at: now });
      if (patch.status !== null && !e.appliedAt) e.appliedAt = now;
    }
    if (patch.resumeId !== undefined) e.resumeId = patch.resumeId;
    if (patch.notes) {
      e.notes = patch.notes.map((n) => {
        const old = n.id ? e.notes.find((x) => x.id === n.id) : undefined;
        return old ? { ...old, text: n.text, updatedAt: old.text === n.text ? old.updatedAt : now } : { id: newId('note'), text: n.text, createdAt: now, updatedAt: now };
      });
    }
    if (patch.reminders) {
      e.reminders = patch.reminders.map((r) => ({ id: r.id ?? newId('rem'), at: r.at, text: r.text, done: r.done ?? false }));
    }
    e.updatedAt = now;
    d[jobId] = e;
    out = e;
  });
  return out;
}

// ------------------------------------------------------------------ AI settings and publik

async function publikFetch(state: MockState, path: string, init: RequestInit = {}): Promise<Response> {
  if (isOffline(state)) throw fail('offline', 503, 'This computer is offline, so publik cannot be reached right now.');
  try {
    return await fetch(`${publikBase()}${path}`, { ...init, signal: AbortSignal.timeout(10_000), headers: { 'content-type': 'application/json', ...(state.data.publik.key ? { authorization: `Bearer ${state.data.publik.key}` } : {}), ...(init.headers as Record<string, string> ?? {}) } });
  } catch {
    throw fail('provider_error', 502, 'publik did not answer. Check your connection and try again.');
  }
}

async function publikStatus(state: MockState): Promise<PublikConnection> {
  const p = state.data.publik;
  if (p.state !== 'connected' || !p.key) return { state: 'disconnected', wallet: null, disclosureVersion: p.disclosureVersion };
  const res = await publikFetch(state, '/wallet');
  if (res.status === 401) return { state: 'disconnected', wallet: null, disclosureVersion: p.disclosureVersion };
  if (!res.ok) throw fail('provider_error', 502, 'publik could not show the balance right now. Try again.');
  const wallet = await res.json() as PublikWallet;
  return { state: 'connected', wallet, disclosureVersion: p.disclosureVersion };
}

async function priceMicros(state: MockState): Promise<number | null> {
  try {
    const res = await publikFetch(state, '/prices');
    if (!res.ok) return null;
    const j = await res.json() as { perCallMicros?: number };
    return typeof j.perCallMicros === 'number' ? j.perCallMicros : null;
  } catch { return null; }
}

async function aiSettingsView(state: MockState): Promise<AiSettings> {
  const s = { ...state.data.ai };
  s.keySet = state.secrets.has('ai');
  s.keyHint = s.keySet ? state.secrets.get('ai')!.slice(-4) : null;
  s.costEstimates = null;
  if (s.provider === 'publik' && state.data.publik.state === 'connected') {
    const p = await priceMicros(state);
    if (p !== null) s.costEstimates = { chatTurn: p, tailor: p, coverLetter: p, outreachDraft: p, practice: p };
  }
  return s;
}

async function runCheck(state: MockState): Promise<ProviderCheck> {
  const checkedAt = nowIso();
  try {
    const models = await listModels(state);
    const s = state.data.ai;
    return { ok: true, problem: null, message: s.provider === 'publik' ? 'publik answered. AI steps will charge your publik balance.' : s.provider === 'local' ? 'The model on this computer answered. AI text stays on this computer.' : 'The AI server answered.', models, checkedAt };
  } catch (err) {
    const e = err instanceof ApiFail ? err : fail('provider_error', 502, 'The provider did not answer.');
    const problem: ProviderCheck['problem'] = e.code === 'needs_provider' ? 'no_provider' : e.code === 'provider_timeout' ? 'timeout' : e.code === 'insufficient_balance' ? 'balance_too_low' : e.code === 'offline' ? 'unreachable' : /refused the key/.test(e.message) ? 'key_refused' : /does not know the model/.test(e.message) ? 'model_not_found' : 'unreachable';
    return { ok: false, problem, message: e.message, models: [], checkedAt };
  }
}

/** A plain sentence naming where AI text goes, for chat "start" and drafts. */
function providerKind(state: MockState): 'publik' | 'local' | 'custom' | 'own_key' {
  return state.data.ai.provider ?? 'local';
}

// ------------------------------------------------------------------ chat

const running = new Map<string, AbortController>();
const proposals = new Map<string, ActionProposal & { jobId: string | null; payload: Record<string, unknown> }>();

function proposalFor(state: MockState, text: string, jobId: string | null): (ActionProposal & { jobId: string | null; payload: Record<string, unknown> }) | null {
  if (!jobId) return null;
  const rec = state.jobs.get(jobId);
  if (!rec) return null;
  const label = `${rec.job.company}, ${rec.job.title}`;
  const actions: ActionProposal['actions'] = [];
  const payload: Record<string, unknown> = {};
  const st = /\b(?:move|mark|set)\b.*\b(applied|interviewing|offer|rejected|archived)\b/i.exec(text);
  if (st) {
    const status = st[1]!.toLowerCase() === 'offer' ? 'offer_received' : st[1]!.toLowerCase();
    const id = newId('act');
    actions.push({ id, kind: 'tracker_status', summary: `Move ${label} to ${status.replace('_', ' ')}`, target: { kind: 'job', id: jobId } });
    payload[id] = { status };
  }
  if (/\blike (this|the) job\b|\bsave (this|the) job\b/i.test(text)) {
    const id = newId('act');
    actions.push({ id, kind: 'like', summary: `Like ${label}`, target: { kind: 'job', id: jobId } });
    payload[id] = { liked: true };
  }
  const note = /\badd (?:a )?note:?\s+(.+)$/i.exec(text);
  if (note) {
    const id = newId('act');
    actions.push({ id, kind: 'note_add', summary: `Add a note to ${label}: "${note[1]!.slice(0, 80)}"`, target: { kind: 'job', id: jobId } });
    payload[id] = { note: note[1] };
  }
  if (!actions.length) return null;
  return { id: newId('prop'), actions, expiresAt: new Date(nowMs() + 15 * 60_000).toISOString(), jobId, payload };
}

async function handleChat(ctx: Ctx): Promise<Result> {
  const { state, res } = ctx;
  const req = ctx.body as { requestId: string; messages: ChatMsg[]; chatId?: string; jobId?: string; preset?: string };
  const ac = new AbortController();
  running.set(req.requestId, ac);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (ev: unknown) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  res.on('close', () => ac.abort());
  let text = '';
  const jobRec = req.jobId ? state.jobs.get(req.jobId) : undefined;
  const p = state.data.profile;
  const context: ChatMsg[] = [];
  if (jobRec) context.push({ role: 'user', content: `Job: ${jobRec.job.title} at ${jobRec.job.company}. Skills named: ${jobRec.job.skills.join(', ') || 'none'}.\n${jobRec.job.description.slice(0, 1500)}` });
  if (hasProfile(p)) context.push({ role: 'user', content: `My skills: ${p.skills.map((s) => s.name).join(', ') || 'none listed'}. My titles: ${p.work.map((w) => w.title).join(', ') || 'none listed'}.` });
  try {
    let startSent = false;
    const out = await stream(state, [...context, ...req.messages.filter((m) => m.role !== 'system')], `chat:${req.preset ?? 'chat'}`, ac.signal, (d) => {
      if (!startSent) { send({ type: 'start', requestId: req.requestId, provider: providerKind(state), model: state.data.ai.model ?? 'default' }); startSent = true; }
      text += d;
      send({ type: 'delta', text: d });
    });
    if (!startSent) send({ type: 'start', requestId: req.requestId, provider: out.provider, model: out.model });
    const last = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    const prop = proposalFor(state, last, req.jobId ?? null);
    if (prop) { proposals.set(prop.id, prop); send({ type: 'proposal', proposal: { id: prop.id, actions: prop.actions, expiresAt: prop.expiresAt } }); }
    // keep the conversation on this computer
    let chatId: string | null = req.chatId ?? null;
    try {
      const now = nowIso();
      state.mutate('chats', 'the conversation', (d) => {
        let t = chatId ? d.find((c) => c.id === chatId) : undefined;
        if (!t) {
          t = { id: newId('chat'), title: last.slice(0, 60) || 'Conversation', jobId: req.jobId ?? null, messages: [], createdAt: now, updatedAt: now };
          d.unshift(t);
        }
        t.messages.push({ role: 'user', content: last, at: now });
        t.messages.push({ role: 'assistant', content: text, at: now, ...(out.incomplete ? { incomplete: true } : {}) });
        t.updatedAt = now;
        chatId = t.id;
      });
    } catch { /* the answer still shows; saving is reported by the next write */ }
    send({ type: 'done', incomplete: out.incomplete, costMicros: out.costMicros, chatId });
  } catch (err) {
    const e = err instanceof ApiFail ? err : fail('provider_error', 502, 'The AI provider stopped answering.');
    if (text) send({ type: 'done', incomplete: true, costMicros: null, chatId: req.chatId ?? null });
    else send({ type: 'error', error: { code: e.code, message: scrubCredits(e.message), ...(e.link ? { link: e.link } : {}) } });
  } finally {
    running.delete(req.requestId);
    res.end();
  }
  return { kind: 'sse' };
}

// ------------------------------------------------------------------ sources and datasets

const CHECKED = '2026-09-24';

function sourceList(state: MockState): SourceInfo[] {
  const base: Array<Omit<SourceInfo, 'enabled' | 'keySet' | 'status'>> = [
    { id: 'ats:greenhouse', name: 'Greenhouse job boards', kind: 'ats', crawled: true, reason: null, checkedOn: CHECKED, evidenceUrl: 'https://developers.greenhouse.io/job-board.html', needsKey: false, credit: null, limits: 'One request a second per host' },
    { id: 'ats:lever', name: 'Lever job boards', kind: 'ats', crawled: true, reason: null, checkedOn: CHECKED, evidenceUrl: 'https://github.com/lever/postings-api', needsKey: false, credit: null, limits: 'One request a second per host' },
    { id: 'ats:ashby', name: 'Ashby job boards', kind: 'ats', crawled: true, reason: null, checkedOn: CHECKED, evidenceUrl: 'https://developers.ashbyhq.com/docs/public-job-posting-api', needsKey: false, credit: null, limits: 'One request a second per host' },
    { id: 'ats:workday', name: 'Workday', kind: 'ats', crawled: false, reason: 'Its job feed is not a documented public API. jobleft asks the owner before any request.', checkedOn: CHECKED, evidenceUrl: null, needsKey: false, credit: null, limits: null },
    { id: 'ats:smartrecruiters', name: 'SmartRecruiters', kind: 'ats', crawled: false, reason: 'Its robots.txt asks crawlers to stay away, so jobleft does not read it.', checkedOn: CHECKED, evidenceUrl: null, needsKey: false, credit: null, limits: null },
    { id: 'board:linkedin', name: 'LinkedIn, Indeed and Glassdoor', kind: 'job_board', crawled: false, reason: 'jobleft never reads these sites. Paste the posting text in the External tab instead.', checkedOn: CHECKED, evidenceUrl: null, needsKey: false, credit: null, limits: null },
    { id: 'gov:usajobs', name: 'USAJOBS (US federal jobs)', kind: 'government', crawled: true, reason: null, checkedOn: CHECKED, evidenceUrl: 'https://developer.usajobs.gov/', needsKey: true, credit: null, limits: 'Needs your own free key' },
    { id: 'partner:search', name: 'Paid web search for more jobs', kind: 'search_partner', crawled: false, reason: 'Paid per request from your publik balance. Off until you turn it on in AI provider settings.', checkedOn: CHECKED, evidenceUrl: null, needsKey: false, credit: null, limits: '$5.00 per 1,000 searches' },
  ];
  return base.map((b) => {
    const on = state.data.sources[b.id]?.enabled ?? (b.kind === 'ats' && b.crawled);
    const keySet = state.secrets.has(`source:${b.id}`);
    const stateName: SourceInfo['status']['state'] = !b.crawled && b.kind !== 'search_partner' ? 'off' : !on ? 'off' : b.needsKey && !keySet ? 'needs_key' : b.kind === 'ats' ? 'ok' : 'never_run';
    const open = b.kind === 'ats' ? [...state.jobs.values()].filter((r) => r.job.status === 'open' && r.job.sources.some((s) => s.sourceId === b.id)).length : null;
    return { ...b, enabled: on, keySet, status: { state: stateName, lastSuccessAt: b.kind === 'ats' ? state.data.crawlRuns.at(-1)?.finishedAt ?? null : null, openJobs: open, lastProblem: null, nextAllowedAt: null } };
  });
}

function datasets(): DatasetInfo[] {
  return [
    { id: 'h1b', name: 'H-1B filings by employer', version: '2026-06', dataThrough: '2026-06-30', licence: 'US public domain (US Department of Labor)', attribution: 'US Department of Labor, LCA disclosure data (stand-in copy for the mock)', sourceUrl: 'https://www.dol.gov/agencies/eta/foreign-labor/performance', bytes: 8_400_000, updatedAt: '2026-09-20T12:00:00.000Z', lastUpdateError: null },
    { id: 'places', name: 'City dictionary', version: 'mock-1', dataThrough: null, licence: 'CC BY 4.0', attribution: 'City coordinates (stand-in list for the mock)', sourceUrl: null, bytes: 4_000, updatedAt: '2026-09-20T12:00:00.000Z', lastUpdateError: null },
    { id: 'boards', name: 'Job board directory', version: 'mock-1', dataThrough: null, licence: 'Made-up boards for the mock', attribution: null, sourceUrl: null, bytes: 20_000, updatedAt: '2026-09-20T12:00:00.000Z', lastUpdateError: null },
  ];
}

function boardEntries(state: MockState): BoardEntry[] {
  return state.boardFiles().map((b) => {
    const pref = state.data.boardPrefs[b.id] ?? { followed: true, hidden: false, disabled: false };
    const st = state.data.boardStatus[b.id] ?? { state: 'not_checked', lastCheckAt: null, lastSuccessAt: null, openJobs: null, lastError: null };
    return {
      id: b.id, ats: b.ats, board: b.board, region: null, company: b.company, origin: (b as { userAdded?: boolean }).userAdded ? 'user' : 'directory',
      followed: pref.followed, hidden: pref.hidden, disabled: pref.disabled, state: st.state, lastCheckAt: st.lastCheckAt, lastSuccessAt: st.lastSuccessAt,
      nextCheckAt: null, openJobs: st.openJobs, lastError: st.lastError,
    };
  });
}

// ------------------------------------------------------------------ helpers

function asFilterFromProfile(p: Profile | null): JobFilter {
  if (!hasProfile(p)) return {};
  const pr = p.preferences;
  const f: JobFilter = {};
  if (pr.jobFunctions.length) f.jobFunctions = pr.jobFunctions;
  if (pr.employmentTypes.length) f.employmentTypes = pr.employmentTypes;
  if (pr.workModels.length) f.workModels = pr.workModels;
  if (pr.levels.length) f.levels = pr.levels;
  if (pr.countries.length) f.countries = pr.countries;
  return f;
}

function resumeOr404(state: MockState, id: string): Resume {
  const r = state.data.resumes.find((x) => x.id === id);
  if (!r) throw fail('not_found', 404, 'That resume was not found. It may have been deleted.');
  return r;
}

function saveResume(state: MockState, r: Resume): void {
  state.mutate('resumes', 'the resume', (d) => {
    const i = d.findIndex((x) => x.id === r.id);
    if (i >= 0) d[i] = r; else d.push(r);
  });
}

function profileInputOf(p: Profile | null): ProfileInput {
  if (!p) return emptyProfileInput();
  const { id: _i, version: _v, updatedAt: _u, ...rest } = p;
  return rest;
}

function companyView(state: MockState, key: string): Company {
  const c = state.companies.get(key);
  if (c) return c;
  const anyJob = [...state.jobs.values()].find((r) => r.job.companyKey === key);
  return { key, name: anyJob?.job.company ?? key, aliases: [], facts: {}, h1b: null, isStaffingAgency: null, factsFreshUntil: null, updatedAt: nowIso() };
}

const NEVER = /(^|\.)(linkedin\.com|indeed\.com|glassdoor\.com|smartrecruiters\.com|myworkdayjobs\.com|myworkdaysite\.com|workday\.com|licdn\.com)$/i;

// ------------------------------------------------------------------ the table

type Handler = (ctx: Ctx) => Result | Promise<Result>;

export const HANDLERS: Partial<Record<RouteName, Handler>> = {
  health: () => json({ app: 'jobleft', version: '0.1.0-ui-mock', apiVersion: 1, extensionProtocol: 1 }),

  getSettings: ({ state }) => json(state.data.settings),
  putSettings: ({ state, body, crawler }) => { const s = state.set('settings', 'your settings', body as AppSettings); crawler.schedule(); return json(s); },
  getOnboarding: ({ state }) => json(state.data.onboarding ?? { status: state.data.profile ? 'done' : 'new', step: 0, draft: null, pendingImport: null }),
  putOnboarding: ({ state, body }) => json(state.set('onboarding', 'your setup', body as OnboardingState)),

  storage: ({ state }) => {
    let bytes = 0;
    for (const f of readdirSync(state.dirs.state)) { try { bytes += readFileSync(join(state.dirs.state, f)).length; } catch { /* skip */ } }
    const all = [...state.jobs.values()];
    return json({ dataDir: state.home, dbPath: state.dirs.state, dbBytes: bytes, jobs: all.length, openJobs: all.filter((r) => r.job.status === 'open').length });
  },

  backup: ({ state }) => {
    const files: Array<{ name: string; data: Uint8Array }> = [{ name: 'manifest.json', data: new Uint8Array(Buffer.from(JSON.stringify({ app: 'jobleft', kind: 'backup', version: 1, createdAt: nowIso() }))) }];
    for (const f of readdirSync(state.dirs.state)) if (f.endsWith('.json') && f !== 'publik.json') files.push({ name: `state/${f}`, data: new Uint8Array(readFileSync(join(state.dirs.state, f))) });
    const jobsFile = join(state.dirs.state, 'jobs.ndjson');
    if (existsSync(jobsFile)) files.push({ name: 'state/jobs.ndjson', data: new Uint8Array(readFileSync(jobsFile)) });
    const day = nowIso().slice(0, 10);
    return file(`jobleft-backup-${day}.zip`, 'application/zip', makeZip(files));
  },

  restore: ({ state, raw }) => {
    const zip = raw ? readZip(raw) : null;
    const manifest = zip?.get('manifest.json');
    let ok = false;
    try { ok = !!manifest && (JSON.parse(Buffer.from(manifest).toString('utf8')) as { app?: string; kind?: string }).app === 'jobleft'; } catch { ok = false; }
    if (!zip || !ok) throw fail('bad_request', 400, 'This file is not a jobleft backup, or it is damaged. Nothing was changed.');
    const restored: Record<string, number> = {};
    const next: Record<string, unknown> = {};
    for (const [name, data] of zip) {
      if (!/^state\/[a-zA-Z]+\.json$/.test(name)) continue;
      const key = name.slice(6, -5);
      if (!(key in state.data) || key === 'publik') continue;
      try { next[key] = JSON.parse(Buffer.from(data).toString('utf8')); } catch { throw fail('bad_request', 400, 'The backup file is damaged. Nothing was changed.'); }
    }
    for (const [key, value] of Object.entries(next)) {
      state.set(key as keyof MockState['data'], 'the restored data', value as never);
      restored[key] = Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : 1;
    }
    clearMatchCache();
    state.loadJobs();
    return json({ restored });
  },

  exportAll: ({ state }) => {
    const enc = (v: unknown) => new Uint8Array(Buffer.from(JSON.stringify(v, null, 2)));
    const d = state.data;
    return file(`jobleft-export-${nowIso().slice(0, 10)}.zip`, 'application/zip', makeZip([
      { name: 'README.txt', data: new Uint8Array(Buffer.from('Your jobleft data as readable JSON files. Keys and tokens are never included.\n')) },
      { name: 'profile.json', data: enc(d.profile) }, { name: 'tracker.json', data: enc(d.tracker) }, { name: 'saved-filters.json', data: enc(d.filters) },
      { name: 'resumes.json', data: enc(d.resumes) }, { name: 'cover-letters.json', data: enc(d.coverLetters) }, { name: 'contacts.json', data: enc(d.contacts) },
      { name: 'conversations.json', data: enc(d.chats) }, { name: 'practice.json', data: enc({ sessions: d.practiceSessions, items: d.practiceItems }) },
      { name: 'settings.json', data: enc(d.settings) },
    ]));
  },

  deleteAllData: ({ state }) => {
    const fresh = { tracker: {}, filters: [], profile: null, resumes: [], coverLetters: [], proposals: [], chats: [], contacts: [], notifications: [], practiceSessions: [], practiceItems: [], pairings: [], externalJobs: [] } as const;
    for (const [k, v] of Object.entries(fresh)) state.set(k as keyof MockState['data'], 'the deletion', structuredClone(v) as never);
    state.set('settings', 'the deletion', DEFAULT_SETTINGS);
    state.set('ai', 'the deletion', defaultAi());
    state.set('publik', 'the deletion', { state: 'disconnected', key: null, disclosureVersion: null });
    state.secrets.clear();
    clearMatchCache();
    state.loadJobs();
    return json({ ok: true });
  },

  listNotifications: ({ state }) => json(state.data.notifications.filter((n) => !(n as Notification & { acked?: boolean }).acked).map(({ ...n }) => { delete (n as { acked?: boolean }).acked; return n; })),
  ackNotification: ({ state, params }) => {
    if (!state.data.notifications.some((n) => n.id === params.notificationId)) throw fail('not_found', 404, 'That notification was not found.');
    state.mutate('notifications', 'the notification', (d) => { const n = d.find((x) => x.id === params.notificationId) as Notification & { acked?: boolean }; n.acked = true; });
    return json({ ok: true });
  },

  exportJobs: ({ state }) => {
    const lines: string[] = [];
    for (const e of Object.values(state.data.tracker)) {
      const r = state.jobs.get(e.jobId);
      if (r && (e.liked || e.status || e.external)) lines.push(JSON.stringify({ job: r.job, sources: r.job.sources, tracker: e }));
    }
    return file(`jobleft-saved-jobs-${nowIso().slice(0, 10)}.ndjson`, 'application/x-ndjson', new Uint8Array(Buffer.from(lines.join('\n') + '\n')));
  },

  devClock: ({ dev, body }) => {
    if (!dev) throw fail('not_found', 404, 'Not found.');
    const b = body as { offset?: string; now?: string };
    if (b.now) process.env.JOBLEFT_NOW = b.now; else delete process.env.JOBLEFT_NOW;
    if (b.offset) process.env.JOBLEFT_CLOCK_OFFSET = b.offset;
    return json({ now: nowIso() });
  },

  listJobs: ({ state, query }) => {
    const req: JobSearchRequest = { sort: (query.sort as JobSearchRequest['sort']) ?? 'recommended', q: query.q, cursor: query.cursor, limit: query.limit ? Math.min(100, Number(query.limit)) : 30, filter: { ...asFilterFromProfile(state.data.profile), ...(query.status ? { status: query.status as 'open' } : {}) } };
    const r = search({ state, profile: hasProfile(state.data.profile) ? state.data.profile : null, matchFor: (rec) => matchFor(state, rec), now: nowMs() }, req);
    if ('error' in r) throw fail('bad_request', 400, r.error);
    return json(r);
  },

  searchJobs: ({ state, body }) => {
    const r = search({ state, profile: hasProfile(state.data.profile) ? state.data.profile : null, matchFor: (rec) => matchFor(state, rec), now: nowMs() }, body as JobSearchRequest);
    if ('error' in r) throw fail('bad_request', 400, r.error);
    return json(r);
  },

  getJob: ({ state, params }) => {
    const rec = jobOr404(state, params.jobId!);
    const company = state.companyFor(rec.job);
    return json({ job: rec.job, company, match: matchFor(state, rec), tracker: state.data.tracker[rec.job.id] ?? null, networkCount: state.networkCount(rec.job.companyKey), h1bTag: h1bTagOf(rec, company) });
  },

  addExternalJob: async ({ state, body }) => {
    const b = body as { url?: string; text?: string; applyUrl?: string };
    const now = nowIso();
    if (!b.url && !b.text) throw fail('bad_request', 400, 'Paste a job link or the text of a posting.');
    let job: Job;
    if (b.url) {
      let u: URL;
      try { u = new URL(b.url); } catch { throw fail('bad_request', 400, 'That is not a web link. Paste the full address, starting with https://.'); }
      if (NEVER.test(u.hostname)) throw fail('forbidden_source', 422, `jobleft never reads ${u.hostname.replace(/^www\./, '')}, so nothing was sent there. Copy the posting text and paste it here instead.`);
      const dup = [...state.jobs.values()].find((r) => r.job.canonicalUrl === b.url || r.job.url === b.url);
      if (dup) {
        const t = patchTracker(state, dup.job.id, {});
        state.mutate('tracker', 'this job', (d) => { d[dup.job.id] = { ...d[dup.job.id]!, external: true }; });
        return json({ job: dup.job, tracker: { ...t, external: true }, alreadyAdded: true });
      }
      if (!isLoopback(b.url)) {
        if (isOffline(state)) throw fail('offline', 503, 'This computer is offline, so the page could not be read. Nothing was added.');
        throw fail('unsupported_source', 422, 'This test build reads job pages only from the stand-in employer site on this computer. Paste the posting text instead, or use a link from the README.');
      }
      let res: Response;
      try { res = await fetch(b.url, { signal: AbortSignal.timeout(10_000), redirect: 'manual' }); } catch { throw fail('offline', 503, 'The page did not answer. Check the link and try again. Nothing was added.'); }
      if (res.status === 404 || res.status === 410) throw fail('not_found', 404, 'That link answered "page not found". The posting may have closed. Nothing was added.');
      if (!res.ok) throw fail('unsupported_source', 422, `That page answered with an error (${res.status}). Nothing was added.`);
      const html = await res.text();
      const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
      if (!ld) throw fail('unsupported_source', 422, 'That page does not look like a job posting, so nothing was added. You can paste the posting text instead.');
      let p: { title?: string; hiringOrganization?: { name?: string }; description?: string; datePosted?: string; jobLocation?: Array<{ address?: { addressLocality?: string; addressRegion?: string } }>; employmentType?: string };
      try { p = JSON.parse(ld[1]!); } catch { throw fail('unsupported_source', 422, 'That page does not look like a job posting, so nothing was added.'); }
      if (!p.title || !p.hiringOrganization?.name) throw fail('unsupported_source', 422, 'That page does not look like a job posting, so nothing was added.');
      const locations = (p.jobLocation ?? []).map((l) => [l.address?.addressLocality, l.address?.addressRegion].filter(Boolean).join(', ')).filter(Boolean);
      const ext = sha256(b.url).slice(0, 12);
      job = toJob({ id: 'external:url', ats: 'greenhouse', board: 'external', company: p.hiringOrganization.name, postings: [] }, {
        externalId: ext, title: p.title, locations, workplace: null, employmentType: p.employmentType === 'FULL_TIME' ? 'full_time' : p.employmentType === 'CONTRACTOR' ? 'contract' : null,
        department: null, postedAt: p.datePosted ?? null, pay: null, description: (p.description ?? '').replace(/<[^>]+>/g, ''), hasApplyPage: false,
      }, { firstSeenAt: now, lastSeenAt: now });
      job = { ...job, id: `ext:${ext}`, ats: 'other', board: null, url: b.url, canonicalUrl: b.url, applyUrl: null, sources: [{ sourceId: 'external:url', name: 'Added by you from a link', url: b.url, credit: null, firstSeenAt: now, lastSeenAt: now }] };
    } else {
      const text = b.text!.trim();
      if (text.length < 40) throw fail('bad_request', 400, 'That text is too short to be a job posting. Paste the whole posting.');
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const title = lines[0]!.slice(0, 200);
      const compLine = /(?:^|\n)\s*(?:company|employer)\s*:\s*(.+)/i.exec(text)?.[1]?.trim() ?? /\bat\s+([A-Z][\w&.,' -]{2,60})/.exec(lines[0]!)?.[1]?.trim() ?? null;
      const ext = sha256(text).slice(0, 12);
      const dup = state.jobs.get(`ext:${ext}`);
      if (dup) return json({ job: dup.job, tracker: state.data.tracker[dup.job.id] ?? newEntry(dup.job.id, now), alreadyAdded: true });
      job = toJob({ id: 'external:text', ats: 'greenhouse', board: 'external', company: compLine ?? 'Company not stated', postings: [] }, {
        externalId: ext, title, locations: [], workplace: null, employmentType: null, department: null, postedAt: null, pay: null, description: text, hasApplyPage: false,
      }, { firstSeenAt: now, lastSeenAt: now });
      const url = b.applyUrl ?? `${boardsOrigin()}/pasted/${ext}`;
      job = { ...job, id: `ext:${ext}`, ats: null, board: null, url, canonicalUrl: url, applyUrl: b.applyUrl ?? null, sources: [{ sourceId: 'external:text', name: 'Pasted by you', url, credit: null, firstSeenAt: now, lastSeenAt: now }] };
    }
    state.mutate('externalJobs', 'the job', (d) => { d.push(job); });
    state.putJob(job, null);
    let entry!: TrackerEntry;
    state.mutate('tracker', 'the job', (d) => { const e = d[job.id] ?? newEntry(job.id, now); e.external = true; e.updatedAt = now; d[job.id] = e; entry = e; });
    return json({ job, tracker: entry });
  },

  keywordGaps: ({ state, params, query }) => {
    const rec = jobOr404(state, params.jobId!);
    const r = resumeOr404(state, query.resumeId!);
    return json(keywordGaps(rec.job, r.document, profileInputOf(state.data.profile), r.id));
  },

  listTracker: ({ state, query }) => json(trackerList(state, query.view!, query.status)),
  updateTracker: ({ state, params, body }) => json(patchTracker(state, params.jobId!, body as TrackerPatch)),

  listFilters: ({ state }) => json(state.data.filters),
  createFilter: ({ state, body }) => {
    const b = body as { name: string; filter: JobFilter; sort: SavedFilter['sort']; alert?: boolean; q?: string };
    const now = nowIso();
    const f: SavedFilter = { id: newId('flt'), name: b.name.trim(), filter: b.filter, sort: b.sort, alert: { enabled: b.alert ?? false, lastNotifiedAt: null }, createdAt: now, updatedAt: now, ...(b.q?.trim() ? { q: b.q.trim() } : {}) };
    state.mutate('filters', 'the saved filter', (d) => { d.push(f); });
    return json(f);
  },
  updateFilter: ({ state, params, body }) => {
    const b = body as { name: string; filter: JobFilter; sort: SavedFilter['sort']; alert?: boolean; q?: string };
    if (!state.data.filters.some((f) => f.id === params.filterId)) throw fail('not_found', 404, 'That saved filter was not found.');
    let out!: SavedFilter;
    state.mutate('filters', 'the saved filter', (d) => {
      const f = d.find((x) => x.id === params.filterId)!;
      f.name = b.name.trim(); f.filter = b.filter; f.sort = b.sort;
      if (b.alert !== undefined) f.alert.enabled = b.alert;
      if (b.q !== undefined) { if (b.q.trim()) f.q = b.q.trim(); else delete f.q; }
      f.updatedAt = nowIso();
      out = f;
    });
    return json(out);
  },
  deleteFilter: ({ state, params }) => {
    if (!state.data.filters.some((f) => f.id === params.filterId)) throw fail('not_found', 404, 'That saved filter was not found.');
    state.mutate('filters', 'the saved filter', (d) => { d.splice(d.findIndex((f) => f.id === params.filterId), 1); });
    return json({ ok: true });
  },

  getProfile: ({ state }) => json(state.data.profile ?? emptyProfile()),
  putProfile: ({ state, body }) => {
    const input = body as ProfileInput;
    const p: Profile = { id: 'default', ...input, version: profileVersion(input), updatedAt: nowIso() };
    state.set('profile', 'your profile', p);
    clearMatchCache();
    return json(p);
  },

  listResumes: ({ state }) => json(state.data.resumes),
  importResume: ({ state, raw, headers }) => {
    const name = decodeURIComponent(String(headers['x-jobleft-filename'] ?? 'resume'));
    const mime = String(headers['content-type'] ?? '').split(';')[0]!;
    const imp = importResumeBytes(raw ?? new Uint8Array(), name, mime, profileInputOf(state.data.profile));
    if (imp.report.outcome === 'failed') throw Object.assign(fail('bad_request', 400, imp.report.warnings[0] ?? 'The file could not be read.'), { details: { report: imp.report } });
    const now = nowIso();
    const r: Resume = {
      id: newId('res'), name: name.replace(/\.(pdf|docx)$/i, '').slice(0, 200) || 'Resume', targetTitle: null, isPrimary: !state.data.resumes.some((x) => x.isPrimary), kind: 'base',
      baseResumeId: null, jobId: null, version: 1, file: { fileName: name, mimeType: mime, bytes: raw?.length ?? 0, sha256: sha256(raw ?? new Uint8Array()) },
      document: imp.document, importReport: imp.report, atsReport: null, createdAt: now, updatedAt: now,
    };
    saveResume(state, r);
    return json({ resume: r, proposedProfile: imp.proposedProfile });
  },
  createResume: ({ state, body }) => {
    const b = body as { name: string; targetTitle?: string };
    const now = nowIso();
    const r: Resume = { id: newId('res'), name: b.name.trim(), targetTitle: b.targetTitle ?? null, isPrimary: !state.data.resumes.some((x) => x.isPrimary), kind: 'base', baseResumeId: null, jobId: null, version: 1, file: null, document: documentFromProfile(profileInputOf(state.data.profile)), importReport: null, atsReport: null, createdAt: now, updatedAt: now };
    saveResume(state, r);
    return json(r);
  },
  getResume: ({ state, params }) => json(resumeOr404(state, params.resumeId!)),
  updateResume: ({ state, params, body }) => {
    const r = structuredClone(resumeOr404(state, params.resumeId!));
    const b = body as { name?: string; targetTitle?: string | null; isPrimary?: boolean; document?: ResumeDocument };
    if (b.name !== undefined) r.name = b.name.trim();
    if (b.targetTitle !== undefined) r.targetTitle = b.targetTitle;
    if (b.document) { r.document = { ...b.document, header: r.document.header }; r.atsReport = null; }
    r.updatedAt = nowIso();
    state.mutate('resumes', 'the resume', (d) => {
      if (b.isPrimary) for (const x of d) x.isPrimary = false;
      const i = d.findIndex((x) => x.id === r.id);
      d[i] = { ...r, isPrimary: b.isPrimary ? true : r.isPrimary };
    });
    return json(state.data.resumes.find((x) => x.id === r.id));
  },
  deleteResume: ({ state, params, query }) => {
    const r = resumeOr404(state, params.resumeId!);
    const versions = state.data.resumes.filter((x) => x.baseResumeId === r.id);
    if (versions.length && query.withVersions !== 'true') throw fail('conflict', 409, `This resume has ${versions.length} tailored ${versions.length === 1 ? 'version' : 'versions'}. Delete them too, or keep the resume.`);
    const ids = [r.id, ...versions.map((v) => v.id)];
    state.mutate('resumes', 'the deletion', (d) => {
      const wasPrimary = d.find((x) => x.id === r.id)?.isPrimary;
      for (let i = d.length - 1; i >= 0; i--) if (ids.includes(d[i]!.id)) d.splice(i, 1);
      if (wasPrimary && d.length) d.find((x) => x.kind === 'base') && (d.find((x) => x.kind === 'base')!.isPrimary = true);
    });
    return json({ deleted: ids });
  },
  tailorResume: async ({ state, params, body }) => {
    const r = resumeOr404(state, params.resumeId!);
    const rec = jobOr404(state, (body as { jobId: string }).jobId);
    const prof = profileInputOf(state.data.profile);
    const mine = new Set(prof.skills.map((s) => s.name.toLowerCase()));
    const ai = await complete(state, [{ role: 'user', content: `Rewrite resume bullets for the job "${rec.job.title}" at ${rec.job.company}. Keep every fact true.` }], 'tailor');
    const changes: TailorProposal['changes'] = [];
    const jobSkillsHave = rec.job.skills.filter((s) => mine.has(s.toLowerCase()));
    for (const sec of r.document.sections) {
      if (sec.kind === 'skills' && sec.items[0]) {
        const tags = sec.items[0].tags;
        const ordered = [...jobSkillsHave.filter((s) => tags.some((t) => t.toLowerCase() === s.toLowerCase())), ...tags.filter((t) => !jobSkillsHave.some((s) => s.toLowerCase() === t.toLowerCase()))];
        const missingFromResume = jobSkillsHave.filter((s) => !tags.some((t) => t.toLowerCase() === s.toLowerCase()));
        const after = [...ordered, ...missingFromResume];
        if (after.join(', ') !== tags.join(', ')) changes.push({ id: newId('chg'), sectionId: sec.id, itemId: sec.items[0].id, field: 'tags', before: tags.join(', '), after: after.join(', '), warning: missingFromResume.length ? `Adds ${missingFromResume.join(', ')} from your profile.` : null });
      }
      if (sec.kind === 'summary' && sec.text) {
        const add = jobSkillsHave.slice(0, 3);
        if (add.length) changes.push({ id: newId('chg'), sectionId: sec.id, itemId: null, field: 'text', before: sec.text, after: `${sec.text.replace(/\.$/, '')}, with hands-on work in ${add.join(', ')}.`, warning: null });
      }
      if (sec.kind === 'experience') {
        for (const it of sec.items.slice(0, 1)) {
          const b0 = it.bullets[0];
          if (b0 && !/^Delivered/.test(b0)) changes.push({ id: newId('chg'), sectionId: sec.id, itemId: it.id, field: 'bullets[0]', before: b0, after: `Delivered: ${b0.charAt(0).toLowerCase()}${b0.slice(1)}`, warning: null });
        }
      }
    }
    const gaps = rec.job.skills.filter((s) => !mine.has(s.toLowerCase()));
    const violations: TailorProposal['violations'] = gaps.length ? [{ fact: gaps[0]!, kind: 'skill', where: 'Skills', reason: `The draft named ${gaps[0]}, which is not in your profile, so jobleft removed it.` }] : [];
    const p: TailorProposal = { id: newId('prop'), resumeId: r.id, jobId: rec.job.id, changes, gaps, violations, provider: `${state.data.ai.provider}:${ai.model}`, createdAt: nowIso(), costMicros: ai.costMicros, notice: null, refused: [] } as TailorProposal;
    state.mutate('proposals', 'the draft', (d) => { d.push(p); while (d.length > 50) d.shift(); });
    return json(p);
  },
  acceptTailoring: ({ state, params, body }) => {
    const base = resumeOr404(state, params.resumeId!);
    const b = body as { proposalId: string; acceptChangeIds: string[] };
    const p = state.data.proposals.find((x) => x.id === b.proposalId);
    if (!p) throw fail('not_found', 404, 'That draft was not found. Draft the tailored version again.');
    const doc = structuredClone(base.document);
    for (const c of p.changes) {
      if (!b.acceptChangeIds.includes(c.id)) continue;
      const sec = doc.sections.find((s) => s.id === c.sectionId);
      if (!sec) continue;
      if (c.field === 'text') sec.text = c.after;
      const it = c.itemId ? sec.items.find((x) => x.id === c.itemId) : null;
      if (it && c.field === 'tags') it.tags = c.after.split(/\s*,\s*/).filter(Boolean);
      if (it && c.field === 'bullets[0]') it.bullets[0] = c.after;
    }
    const rec = state.jobs.get(p.jobId);
    const now = nowIso();
    const r: Resume = { id: newId('res'), name: `${base.name} - ${rec?.job.company ?? 'job'}`.slice(0, 200), targetTitle: rec?.job.title ?? base.targetTitle, isPrimary: false, kind: 'tailored', baseResumeId: base.id, jobId: p.jobId, version: state.data.resumes.filter((x) => x.baseResumeId === base.id).length + 1, file: null, document: doc, importReport: null, atsReport: null, createdAt: now, updatedAt: now };
    saveResume(state, r);
    return json(r);
  },
  fitCheck: ({ state, params }) => json(fitCheck(resumeOr404(state, params.resumeId!).document)),
  exportResume: ({ state, params, query }) => {
    const r = resumeOr404(state, params.resumeId!);
    const base = r.name.replace(/[^\w.-]+/g, '_');
    if (query.format === 'docx') return file(`${base}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', renderDocx(r.document));
    return file(`${base}.pdf`, 'application/pdf', renderPdf(r.document).bytes);
  },
  atsCheck: ({ state, params }) => {
    const r = structuredClone(resumeOr404(state, params.resumeId!));
    r.atsReport = atsCheck(r.document, nowIso());
    saveResume(state, r);
    return json(r.atsReport);
  },

  listCoverLetters: ({ state, query }) => json(state.data.coverLetters.filter((c) => c.jobId === query.jobId)),
  createCoverLetter: async ({ state, body }) => {
    const b = body as { jobId: string; resumeId: string };
    const rec = jobOr404(state, b.jobId);
    resumeOr404(state, b.resumeId);
    const p = profileInputOf(state.data.profile);
    const ai = await complete(state, [{ role: 'user', content: `Write a short cover letter for ${rec.job.title} at ${rec.job.company}.` }], 'cover_letter');
    const name = [p.personal.firstName, p.personal.lastName].filter(Boolean).join(' ') || 'Your name';
    const have = rec.job.skills.filter((s) => p.skills.some((x) => x.name.toLowerCase() === s.toLowerCase()));
    const gaps = rec.job.skills.filter((s) => !have.includes(s));
    const w = p.work[0];
    const text = [
      `Dear ${rec.job.company} hiring team,`,
      '',
      `I am applying for the ${rec.job.title} role.${w ? ` I work as a ${w.title} at ${w.company}.` : ''}${have.length ? ` My work uses ${have.join(', ')}, which your posting names.` : ''}`,
      '',
      ai.text ? ai.text.split('\n')[0]!.slice(0, 400) : '',
      '',
      'Thank you for reading. I would be glad to talk.',
      '',
      name,
    ].join('\n');
    const now = nowIso();
    const c: CoverLetter = { id: newId('cl'), jobId: rec.job.id, resumeId: b.resumeId, text, violations: [], ready: true, createdAt: now, updatedAt: now, gaps, notice: null, provider: `${state.data.ai.provider}:${ai.model}`, costMicros: ai.costMicros } as CoverLetter;
    state.mutate('coverLetters', 'the cover letter', (d) => { d.push(c); });
    return json(c);
  },
  updateCoverLetter: async ({ state, params, body }) => {
    const b = body as { text?: string; instruction?: string };
    const old = state.data.coverLetters.find((c) => c.id === params.letterId);
    if (!old) throw fail('not_found', 404, 'That cover letter was not found.');
    let text = b.text ?? old.text;
    let cost: number | null = null;
    if (b.instruction) {
      const ai = await complete(state, [{ role: 'user', content: `Edit this letter: ${b.instruction}\n\n${text}` }], 'cover_letter_edit');
      cost = ai.costMicros;
      text = ai.text.trim() ? `${text}\n\nP.S. ${ai.text.split('\n')[0]!.slice(0, 200)}` : text;
    }
    let out!: CoverLetter;
    state.mutate('coverLetters', 'the cover letter', (d) => { const c = d.find((x) => x.id === params.letterId)!; c.text = text; c.updatedAt = nowIso(); (c as CoverLetter & { costMicros?: number | null }).costMicros = cost; out = c; });
    return json(out);
  },

  getMatch: ({ state, params }) => {
    const rec = jobOr404(state, params.jobId!);
    if (!hasProfile(state.data.profile)) throw fail('needs_profile', 409, 'Add your profile to see how well jobs match you.');
    const m = matchFor(state, rec);
    if (!m) throw fail('not_found', 404, 'This posting has too little information to score.');
    return json(m);
  },
  fitIndexStatus: ({ state }) => json({ state: 'ready', model: 'mock-fit', modelBytes: null, modelSource: null, indexed: state.jobs.size, waiting: 0, lastRun: null }),

  crawlStatus: ({ crawler }) => json(crawler.progress),
  crawlRun: ({ crawler, body }) => json(crawler.runNow((body as { boardIds?: string[] }).boardIds)),
  crawlReport: ({ state, crawler }) => json({ run: crawler.progress.lastRun ?? state.data.crawlRuns.at(-1) ?? null, boards: state.data.lastReport }),

  listBoards: ({ state, query }) => {
    let items = boardEntries(state);
    const q = query.q?.toLowerCase().trim();
    if (q) items = items.filter((b) => b.company.toLowerCase().includes(q) || b.board.includes(q));
    const view = query.view ?? 'all';
    if (view === 'followed') items = items.filter((b) => b.followed && !b.hidden && !b.disabled);
    if (view === 'user') items = items.filter((b) => b.origin === 'user');
    if (view === 'hidden') items = items.filter((b) => b.hidden);
    if (view === 'disabled') items = items.filter((b) => b.disabled);
    if (view === 'failing') items = items.filter((b) => b.state === 'failing' || b.state === 'unreachable');
    const start = query.cursor ? Number(Buffer.from(query.cursor, 'base64url').toString()) || 0 : 0;
    const limit = query.limit ? Number(query.limit) : 50;
    const page = items.slice(start, start + limit);
    return json({ items: page, total: items.length, nextCursor: start + limit < items.length ? Buffer.from(String(start + limit)).toString('base64url') : null });
  },
  resolveBoard: ({ state, body }) => {
    const url = (body as { url: string }).url.trim();
    let u: URL;
    try { u = new URL(url); } catch { return json({ candidates: [], reason: 'not_a_link', message: 'That is not a web link.', paidLookup: null }); }
    if (NEVER.test(u.hostname)) return json({ candidates: [], reason: 'forbidden_host', message: `jobleft never reads ${u.hostname}. Nothing was sent there.`, paidLookup: null });
    const all = state.boardFiles();
    let token: string | null = null;
    if (u.host === `127.0.0.1:${PORTS.boards}`) token = u.pathname.split('/').filter(Boolean)[0] ?? null;
    else if (/greenhouse\.io$|lever\.co$|ashbyhq\.com$/.test(u.hostname)) token = u.pathname.split('/').filter(Boolean)[0] ?? null;
    const b = token ? all.find((x) => x.board === token) : undefined;
    if (!b) return json({ candidates: [], reason: token ? 'no_board_found' : 'unsupported_provider', message: token ? 'This test build only knows the stand-in boards on this computer. No board was found for that link.' : 'jobleft does not recognise the job board behind this link.', paidLookup: null });
    const pref = state.data.boardPrefs[b.id];
    return json({ candidates: [{ boardId: b.id, ats: b.ats, board: b.board, region: null, company: b.company, openJobs: b.postings.length, alreadyAdded: pref ? pref.followed && !pref.hidden : true }], reason: null, message: `Found the ${b.company} board.`, paidLookup: null });
  },
  addBoard: ({ state, body }) => {
    const b = body as { ats: string; board: string };
    const id = `${b.ats}:${b.board}`.toLowerCase();
    const f = state.boardFiles().find((x) => x.id === id);
    if (!f) throw fail('not_found', 404, 'That board is not on the stand-in employer site.');
    const pref = state.data.boardPrefs[id];
    if (!pref || (pref.followed && !pref.hidden && !pref.disabled)) throw fail('conflict', 409, 'That board is already in your list.');
    state.mutate('boardPrefs', 'the board', (d) => { d[id] = { followed: true, hidden: false, disabled: false }; });
    return json(boardEntries(state).find((x) => x.id === id));
  },
  updateBoard: ({ state, params, body }) => {
    const id = params.boardId!;
    if (!state.boardFiles().some((x) => x.id === id)) throw fail('not_found', 404, 'That board was not found.');
    state.mutate('boardPrefs', 'the board', (d) => { d[id] = { ...(d[id] ?? { followed: true, hidden: false, disabled: false }), ...(body as object) }; });
    return json(boardEntries(state).find((x) => x.id === id));
  },
  exportBoards: ({ state }) => file('jobleft-boards.ndjson', 'application/x-ndjson', new Uint8Array(Buffer.from(boardEntries(state).map((b) => JSON.stringify(b)).join('\n') + '\n'))),
  listSources: ({ state }) => json(sourceList(state)),
  updateSource: ({ state, params, body }) => {
    const s = sourceList(state).find((x) => x.id === params.sourceId);
    if (!s) throw fail('not_found', 404, 'That source was not found.');
    if (!s.crawled && s.kind !== 'search_partner') throw fail('conflict', 409, s.reason ?? 'This source cannot be turned on.');
    state.mutate('sources', 'the source', (d) => { d[params.sourceId!] = { enabled: (body as { enabled: boolean }).enabled }; });
    return json(sourceList(state).find((x) => x.id === params.sourceId));
  },
  setSourceKey: ({ state, params, body }) => { state.secrets.set(`source:${params.sourceId}`, (body as { key: string }).key); return json(sourceList(state).find((x) => x.id === params.sourceId)); },
  deleteSourceKey: ({ state, params }) => { state.secrets.delete(`source:${params.sourceId}`); return json(sourceList(state).find((x) => x.id === params.sourceId)); },

  h1bLookup: ({ state, query }) => {
    const key = companyKey(query.company!);
    const c = state.companies.get(key);
    return json({ input: query.company, companyKey: c ? key : null, status: c?.h1b ? 'found' : 'unknown', summary: c?.h1b ?? null });
  },
  placeLookup: ({ query }) => {
    const text = query.text!;
    if (/^remote\b|^united states$|^usa?$/i.test(text.trim())) return json({ input: text, places: [], ambiguous: [], notACity: true });
    const hits = resolveCity(text);
    const toPlace = (c: typeof CITIES[number]) => ({ text: cityText(c), city: c.city, region: c.region, country: c.country, placeId: c.id, lat: c.lat, lon: c.lon });
    if (!hits.length) {
      const pre = CITIES.filter((c) => c.city.toLowerCase().startsWith(text.trim().toLowerCase())).slice(0, 8);
      return json({ input: text, places: [], ambiguous: pre.map(toPlace), notACity: false });
    }
    return json({ input: text, places: hits.length === 1 ? [toPlace(hits[0]!)] : [], ambiguous: hits.length > 1 ? hits.map(toPlace) : [], notACity: false });
  },
  getCompany: ({ state, params }) => json(companyView(state, params.companyKey!)),
  refreshCompany: async ({ state, params, body }) => {
    const b = body as { allowPaid: boolean; maxPriceMicros?: number };
    if (b.allowPaid) {
      if (!state.data.ai.meteredFetch.enabled) throw fail('conflict', 409, 'Paid lookups are off. Turn them on in Settings, AI provider, where the prices are shown first.');
      const res = await publikFetch(state, '/metered/search', { method: 'POST', body: JSON.stringify({ query: `${companyView(state, params.companyKey!).name} company funding` }) });
      if (res.status === 402) throw new ApiFail('insufficient_balance', 402, 'Your publik balance is too low for this lookup, so nothing was charged.', (await res.json().catch(() => null) as { error?: { link?: { label: string; url: string } } } | null)?.error?.link ?? null);
    } else if (isOffline(state)) throw fail('offline', 503, 'This computer is offline, so company facts could not be read again. The kept facts still show.');
    return json(companyView(state, params.companyKey!));
  },
  listDatasets: () => json(datasets()),
  updateDatasets: ({ state }) => {
    if (isOffline(state)) throw fail('offline', 503, 'This computer is offline, so jobleft could not check for newer data. The current data stays in use.');
    return json(datasets());
  },

  importNetwork: ({ state, raw }) => {
    const text = Buffer.from(raw ?? new Uint8Array()).toString('utf8');
    const r = mergeImport(state.data.contacts, text, nowIso());
    if (!r.summary.notAConnectionsFile) { state.set('contacts', 'your connections', r.contacts); clearMatchCache(); }
    return json(r.summary);
  },
  listContacts: ({ state, query }) => {
    let list = state.data.contacts;
    const today = nowIso().slice(0, 10);
    if (query.companyKey) list = list.filter((c) => c.companyKey === query.companyKey);
    if (query.stage) list = list.filter((c) => c.stage === query.stage);
    if (query.inPlan) list = list.filter((c) => c.inPlan === (query.inPlan === 'true'));
    if (query.due === 'true') list = list.filter((c) => c.followUpOn !== null && c.followUpOn <= today);
    if (query.q) { const q = query.q.toLowerCase(); list = list.filter((c) => `${c.firstName} ${c.lastName} ${c.company ?? ''} ${c.position ?? ''}`.toLowerCase().includes(q)); }
    return json(list.map((c) => ({ ...c, followUpDue: c.followUpOn !== null && c.followUpOn <= today })));
  },
  networkCoverage: ({ state }) => {
    const targets = new Map<string, string>();
    for (const e of Object.values(state.data.tracker)) {
      const r = state.jobs.get(e.jobId);
      if (r && (e.liked || e.status || e.external)) targets.set(r.job.companyKey, r.job.company);
    }
    for (const f of state.data.filters) for (const k of f.filter.companies ?? []) targets.set(k, companyView(state, k).name);
    const out = [...targets].map(([key, name]) => {
      const ranked = rankAt(state.data.contacts, key, null, nowMs());
      return { companyKey: key, companyName: name, count: ranked.length, topContactIds: ranked.slice(0, 3).map((x) => x.contactId) };
    });
    return json(out.sort((a, b) => b.count - a.count || a.companyName.localeCompare(b.companyName)));
  },
  rankContacts: ({ state, query }) => {
    const job = query.jobId ? state.jobs.get(query.jobId)?.job ?? null : null;
    return json(rankAt(state.data.contacts, query.companyKey!, job?.title ?? null, nowMs()));
  },
  updateContact: ({ state, params, body }) => {
    if (!state.data.contacts.some((c) => c.id === params.contactId)) throw fail('not_found', 404, 'That contact was not found.');
    let out!: NetworkContact;
    state.mutate('contacts', 'the contact', (d) => { const c = d.find((x) => x.id === params.contactId)!; Object.assign(c, body as object); c.updatedAt = nowIso(); out = c; });
    return json(out);
  },
  deleteContact: ({ state, params }) => {
    if (!state.data.contacts.some((c) => c.id === params.contactId)) throw fail('not_found', 404, 'That contact was not found.');
    state.mutate('contacts', 'the deletion', (d) => { d.splice(d.findIndex((c) => c.id === params.contactId), 1); });
    clearMatchCache();
    return json({ ok: true });
  },
  deleteNetwork: ({ state }) => { const n = state.data.contacts.length; state.set('contacts', 'the deletion', []); clearMatchCache(); return json({ ok: true, deleted: n }); },
  draftOutreach: async ({ state, params, body }) => {
    const c = state.data.contacts.find((x) => x.id === params.contactId);
    if (!c) throw fail('not_found', 404, 'That contact was not found.');
    const b = body as { variant: 'short' | 'long'; jobId?: string };
    const job = b.jobId ? state.jobs.get(b.jobId)?.job ?? null : null;
    const p = profileInputOf(state.data.profile);
    const me = p.work[0] ? `${p.work[0].title} at ${p.work[0].company}` : 'someone looking for my next role';
    const ai = await complete(state, [{ role: 'user', content: `Draft a ${b.variant} note to ${c.firstName} (${c.position ?? 'no title'} at ${c.company ?? 'unknown company'})${job ? ` about ${job.title}` : ''}. About me: ${me}.` }], `outreach_${b.variant}`);
    const limit = b.variant === 'short' ? 300 : null;
    let text = b.variant === 'short'
      ? `Hi ${c.firstName}, I am ${me}.${job ? ` I am applying for ${job.title} at ${job.company}.` : ''} Could I ask you two questions about your team? Thank you!`
      : `Hi ${c.firstName},\n\nI hope you are well. I am ${me}.${job ? ` I saw the ${job.title} opening at ${job.company} and I am applying.` : ''} I would value 15 minutes to hear how you like the team and what helps someone do well there.\n\n${ai.text.split('\n')[0]!.slice(0, 200)}\n\nThank you,\n${p.personal.firstName ?? ''}`;
    if (limit && text.length > limit) text = text.slice(0, limit - 1) + '…';
    return json({ contactId: c.id, jobId: job?.id ?? null, variant: b.variant, text, charLimit: limit, warnings: [], ready: true, provider: `${state.data.ai.provider}:${ai.model}`, costMicros: ai.costMicros });
  },

  getAiSettings: async ({ state }) => json(await aiSettingsView(state)),
  putAiSettings: async ({ state, body }) => {
    const u = body as { provider: AiSettings['provider']; localKind?: AiSettings['localKind']; vendor?: AiSettings['vendor']; baseUrl?: string; model?: string; meteredFetchEnabled?: boolean };
    const prev = state.data.ai;
    const next: AiSettings = { ...prev, provider: u.provider, localKind: u.localKind ?? (u.provider === 'local' ? prev.localKind ?? 'openai_compatible' : null), vendor: u.vendor ?? (u.provider === 'own_key' ? prev.vendor : null), baseUrl: u.baseUrl ?? (u.provider === 'local' || u.provider === 'custom' ? prev.baseUrl : null), model: u.model ?? null, updatedAt: nowIso() };
    if (u.meteredFetchEnabled !== undefined) next.meteredFetch = { ...prev.meteredFetch, enabled: u.meteredFetchEnabled };
    if (prev.baseUrl !== next.baseUrl || prev.provider !== next.provider) state.secrets.delete('ai');
    state.set('ai', 'the AI provider', next);
    const check = await runCheck(state);
    return json({ settings: await aiSettingsView(state), check });
  },
  setAiKey: async ({ state, body }) => { state.secrets.set('ai', (body as { key: string }).key); return json(await aiSettingsView(state)); },
  deleteAiKey: async ({ state }) => { state.secrets.delete('ai'); return json(await aiSettingsView(state)); },
  checkAi: async ({ state }) => json(await runCheck(state)),
  listModels: async ({ state }) => json({ models: await listModels(state) }),
  chat: (ctx) => handleChat(ctx),
  listChats: ({ state }) => json(state.data.chats.map((c) => ({ id: c.id, title: c.title, jobId: c.jobId, updatedAt: c.updatedAt }))),
  getChat: ({ state, params }) => { const c = state.data.chats.find((x) => x.id === params.chatId); if (!c) throw fail('not_found', 404, 'That conversation was not found.'); return json(c as ChatThread); },
  deleteChat: ({ state, params }) => {
    if (!state.data.chats.some((x) => x.id === params.chatId)) throw fail('not_found', 404, 'That conversation was not found.');
    state.mutate('chats', 'the deletion', (d) => { d.splice(d.findIndex((x) => x.id === params.chatId), 1); });
    return json({ ok: true });
  },
  decideProposal: ({ state, params, body }) => {
    const p = proposals.get(params.proposalId!);
    if (!p || Date.parse(p.expiresAt) < nowMs()) throw fail('not_found', 404, 'That suggestion expired. Ask again.');
    const approve = new Set((body as { approveActionIds: string[] }).approveActionIds);
    const applied: string[] = [], declined: string[] = [];
    for (const a of p.actions) {
      if (!approve.has(a.id) || !p.jobId) { declined.push(a.id); continue; }
      const pl = p.payload[a.id] as { status?: string; liked?: boolean; note?: string };
      const cur = state.data.tracker[p.jobId];
      if (pl.status) patchTracker(state, p.jobId, { status: pl.status as TrackerEntry['status'] });
      if (pl.liked) patchTracker(state, p.jobId, { liked: true });
      if (pl.note) patchTracker(state, p.jobId, { notes: [...(cur?.notes ?? []).map((n) => ({ id: n.id, text: n.text })), { text: pl.note }] });
      applied.push(a.id);
    }
    proposals.delete(p.id);
    return json({ applied, declined });
  },

  startPractice: async ({ state, body }) => {
    const rec = jobOr404(state, (body as { jobId: string }).jobId);
    await complete(state, [{ role: 'user', content: `Make practice questions for ${rec.job.title} at ${rec.job.company}.` }], 'practice_questions');
    const mine = new Set(profileInputOf(state.data.profile).skills.map((s) => s.name.toLowerCase()));
    const qs: PracticeSession['questions'] = [
      { id: newId('q'), text: `Tell me about a project you are proud of, and why it matters for a ${rec.job.title} role.`, target: null, gap: false },
      ...rec.job.skills.slice(0, 4).map((s) => ({ id: newId('q'), text: `Walk me through a time you used ${s}. What was hard, and what did you do?`, target: s, gap: !mine.has(s.toLowerCase()) })),
      { id: newId('q'), text: `Why do you want to work at ${rec.job.company}?`, target: null, gap: false },
    ];
    const s: PracticeSession = { id: newId('ps'), jobId: rec.job.id, company: rec.job.company, title: rec.job.title, questions: qs, createdAt: nowIso() };
    state.mutate('practiceSessions', 'the practice session', (d) => { d.push(s); while (d.length > 50) d.shift(); });
    return json(s);
  },
  practiceFeedback: async ({ state, body }) => {
    const b = body as { sessionId: string; questionId: string; answer: string };
    const s = state.data.practiceSessions.find((x) => x.id === b.sessionId);
    const q = s?.questions.find((x) => x.id === b.questionId);
    if (!s || !q) throw fail('not_found', 404, 'That practice question was not found. Start a new practice session.');
    const ai = await complete(state, [{ role: 'user', content: `Give feedback on this answer to "${q.text}": ${b.answer}` }], 'practice_feedback');
    const words = b.answer.trim().split(/\s+/).filter(Boolean).length;
    const hasNumber = /\d/.test(b.answer);
    const feedback = [
      words < 40 ? 'Your answer is short. Add the situation, what you did, and what happened.' : 'Good length. Keep the story in order: situation, action, result.',
      hasNumber ? 'You named a result with a number. Good.' : 'Add one measured result, if it is true, for example time saved or errors cut.',
      ai.text.split('\n')[0]!.slice(0, 300),
    ].filter(Boolean).join('\n');
    return json({ feedback, sampleAnswer: `In my role as [your title] at [your company], I [what you did]${q.target ? ` with ${q.target}` : ''}. The result was [a measured result].`, placeholders: ['[your title]', '[your company]', '[what you did]', '[a measured result]'] });
  },
  listPracticeItems: ({ state, query }) => json(state.data.practiceItems.filter((i) => !query.jobId || i.jobId === query.jobId)),
  savePracticeItem: ({ state, body }) => {
    const b = body as { jobId: string; kind: 'question' | 'debrief'; question?: string; answer?: string; feedback?: string; notes?: string };
    jobOr404(state, b.jobId);
    const now = nowIso();
    const item: PracticeItem = { id: newId('pi'), jobId: b.jobId, kind: b.kind, question: b.question ?? null, answer: b.answer ?? null, feedback: b.feedback ?? null, notes: b.notes ?? null, createdAt: now, updatedAt: now };
    state.mutate('practiceItems', 'the practice item', (d) => { d.push(item); });
    return json(item);
  },
  updatePracticeItem: ({ state, params, body }) => {
    if (!state.data.practiceItems.some((i) => i.id === params.itemId)) throw fail('not_found', 404, 'That item was not found.');
    let out!: PracticeItem;
    state.mutate('practiceItems', 'the practice item', (d) => { const i = d.find((x) => x.id === params.itemId)!; Object.assign(i, body as object); i.updatedAt = nowIso(); out = i; });
    return json(out);
  },
  deletePracticeItem: ({ state, params }) => {
    if (!state.data.practiceItems.some((i) => i.id === params.itemId)) throw fail('not_found', 404, 'That item was not found.');
    state.mutate('practiceItems', 'the deletion', (d) => { d.splice(d.findIndex((x) => x.id === params.itemId), 1); });
    return json({ ok: true });
  },
  cancelAi: ({ params }) => { const c = running.get(params.requestId!); if (c) c.abort(); return json({ cancelled: !!c }); },

  getPublik: async ({ state }) => json(await publikStatus(state)),
  connectPublik: async ({ state, body }) => {
    const b = body as { disclosureAccepted: true; disclosureVersion: number };
    const res = await publikFetch(state, '/installs', { method: 'POST', body: JSON.stringify({ app: 'jobleft', disclosureVersion: b.disclosureVersion }) });
    if (!res.ok) throw fail('provider_error', 502, 'publik could not connect this computer right now. Try again.');
    const j = await res.json() as { key: string };
    state.set('publik', 'the publik connection', { state: 'connected', key: j.key, disclosureVersion: b.disclosureVersion });
    return json(await publikStatus(state));
  },
  disconnectPublik: ({ state }) => {
    state.set('publik', 'the publik connection', { state: 'disconnected', key: null, disclosureVersion: state.data.publik.disclosureVersion });
    return json({ state: 'disconnected', wallet: null, disclosureVersion: state.data.publik.disclosureVersion });
  },
  refreshPublik: async ({ state }) => json(await publikStatus(state)),

  pairingCode: () => json({ code: String(Math.floor(100000 + Math.random() * 900000)), expiresAt: new Date(nowMs() + 5 * 60_000).toISOString() }),
  listPairings: ({ state }) => json(state.data.pairings as PairingInfo[]),
  deletePairing: ({ state, params }) => {
    if (!state.data.pairings.some((p) => p.extensionId === params.extensionId)) throw fail('not_found', 404, 'That extension is not paired.');
    state.mutate('pairings', 'the pairing', (d) => { d.splice(d.findIndex((p) => p.extensionId === params.extensionId), 1); });
    return json({ ok: true });
  },
};

// ------------------------------------------------------------------ reminders -> notifications

export function checkReminders(state: MockState): void {
  if (!state.data.settings.notifications.reminders) return;
  const now = nowMs();
  const today = nowIso().slice(0, 10);
  const have = new Set(state.data.notifications.map((n) => n.id));
  const add: Notification[] = [];
  for (const e of Object.values(state.data.tracker)) {
    const rec = state.jobs.get(e.jobId);
    for (const r of e.reminders) {
      if (r.done || Date.parse(r.at) > now || have.has(`rem_${r.id}`)) continue;
      add.push({ id: `rem_${r.id}`, kind: 'reminder', title: `Reminder: ${rec ? rec.job.company : 'a job'}`.slice(0, 120), body: `${r.text || 'Follow up'}${rec ? ` (${rec.job.title})` : ''}`.slice(0, 400), target: `/jobs/${e.jobId}`, createdAt: nowIso() });
    }
  }
  for (const c of state.data.contacts) {
    if (!c.followUpOn || c.followUpOn > today || have.has(`fu_${c.id}_${c.followUpOn}`)) continue;
    add.push({ id: `fu_${c.id}_${c.followUpOn}`, kind: 'follow_up', title: `Follow up with ${c.firstName} ${c.lastName}`.slice(0, 120), body: `You planned to follow up with ${c.firstName}${c.company ? ` at ${c.company}` : ''} today.`.slice(0, 400), target: '/network', createdAt: nowIso() });
  }
  if (add.length) { try { state.mutate('notifications', 'notifications', (d) => { d.push(...add); }); } catch { /* retried on the next tick */ } }
}

export { bandFor, emptyProfileInput, makePdf, makeDocx };
