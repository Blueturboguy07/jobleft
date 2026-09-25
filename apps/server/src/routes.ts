// The handler of every route in LOCAL_API (packages/contracts/src/api.ts). The dispatcher (server.ts) has already
// checked Host, Origin, the token, the media type, the body size and the body and query contracts, so a handler
// sees valid input only. The table is typed to cover every route: a route without a handler does not compile.

import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CONTRACTS_VERSION, EXTENSION_PROTOCOL_VERSION, LOCAL_API_VERSION, nowIso, parseDuration,
  type ChatStreamEvent, type RouteBody, type RouteName, type RouteQuery,
} from '@jobleft/contracts';
import type { App, AppData } from './app.ts';
import { ApiFailure, notFound, notReady } from './errors.ts';
import { tmpName } from './home.ts';
import type { FileBody } from './http/respond.ts';
import { bodyToFile } from './http/body.ts';
import { addExternal } from './interim/external.ts';
import { detailOf } from './interim/jobs.ts';
import { DOCX, PDF } from './interim/resumes.ts';
import { RESTORE_LIMIT, createBackup, deleteAllData, exportAll, freeBytes, restoreBackup } from './services/backup.ts';
import { ExtensionService } from './services/extension.ts';
import { APP_VERSION } from './version.ts';

export interface Ctx<K extends RouteName> {
  app: App;
  d: AppData;
  params: Record<string, string>;
  query: RouteQuery<K>;
  body: RouteBody<K>;
  req: IncomingMessage;
  res: ServerResponse;
  /** The paired extension's id on pairing routes (from its Origin), or the Origin id on `pair`. */
  extensionId: string | null;
  contentType: string | null;
  fileName: string | null;
  /** Aborts when the client goes away. */
  gone: AbortSignal;
}

export type Out =
  | { json: unknown; status?: number }
  | { file: FileBody }
  | { sse: (send: (e: ChatStreamEvent) => boolean, gone: AbortSignal) => Promise<void> };

export type Handler<K extends RouteName> = (c: Ctx<K>) => Out | Promise<Out>;
export type HandlerTable = { [K in RouteName]: Handler<K> };

/** Routes whose raw body the handler reads itself (streamed to disk). */
export const STREAMED_BODY = new Set<RouteName>(['restore']);

const ok = { json: { ok: true as const } };
const today = () => nowIso().slice(0, 10);
const tmpFile = (p: string): FileBody['cleanup'] => () => { try { rmSync(p, { force: true }); } catch { /* ignore */ } };

function jobOr404(d: AppData, id: string) {
  const j = d.jobs.get(id);
  if (!j) notFound('That job');
  return j;
}

export const HANDLERS: HandlerTable = {
  // ---------------------------------------------------------------- app
  health: () => ({ json: { app: 'jobleft', version: APP_VERSION, apiVersion: LOCAL_API_VERSION, extensionProtocol: EXTENSION_PROTOCOL_VERSION } }),
  getSettings: ({ d }) => ({ json: d.settings.get() }),
  putSettings: ({ d, body }) => ({ json: d.settings.put(body) }),
  storage: ({ app, d }) => {
    let dbBytes = 0;
    for (const suffix of ['', '-wal']) {
      try { dbBytes += statSync(app.cfg.layout.db + suffix).size; } catch { /* no file */ }
    }
    const c = d.jobs.counts();
    return { json: { dataDir: app.cfg.home, dbPath: app.cfg.layout.db, dbBytes, jobs: c.jobs, openJobs: c.openJobs } };
  },
  backup: async ({ app, d }) => {
    const b = await createBackup(d, app.cfg.layout);
    return { file: { fileName: b.fileName, mimeType: 'application/zip', path: b.path, size: b.size, cleanup: tmpFile(b.path) } };
  },
  restore: async ({ app, req }) => {
    const upload = join(app.cfg.layout.tmp, `${tmpName('upload')}.zip`);
    const declared = Number(req.headers['content-length'] ?? NaN);
    if (Number.isFinite(declared) && declared > freeBytes(app.cfg.layout.tmp) - 64 * 1024 * 1024) {
      throw new ApiFailure('write_failed', 'There is not enough free disk space to check this backup. Nothing was changed.', { details: { reason: 'full' } });
    }
    try {
      await bodyToFile(req, upload, RESTORE_LIMIT);
      const restored = await restoreBackup(app, upload);
      return { json: { restored } };
    } finally {
      rmSync(upload, { force: true });
    }
  },
  exportAll: async ({ app, d }) => {
    const e = await exportAll(d, app.cfg.layout);
    return { file: { fileName: e.fileName, mimeType: 'application/zip', path: e.path, size: e.size, cleanup: tmpFile(e.path) } };
  },
  deleteAllData: async ({ app }) => { await deleteAllData(app); return ok; },
  listNotifications: ({ d }) => ({ json: d.notifications.pending() }),
  ackNotification: ({ d, params }) => {
    if (!d.notifications.ack(params.notificationId!)) notFound('That notification');
    return ok;
  },
  exportJobs: ({ d }) => {
    const ids = new Set<string>();
    for (const v of ['liked', 'applied', 'external', 'closed'] as const) for (const it of d.tracker.list(v).items) ids.add(it.entry.jobId);
    const lines: string[] = [];
    for (const id of ids) { const j = d.jobs.get(id); if (j) lines.push(JSON.stringify(j)); }
    return { file: { fileName: `jobleft-saved-jobs-${today()}.ndjson`, mimeType: 'application/x-ndjson', bytes: Buffer.from(lines.join('\n') + (lines.length ? '\n' : '')) } };
  },
  devClock: ({ app, body }) => {
    if (!app.cfg.dev) notFound('That page');
    if (body.now !== undefined) { process.env.JOBLEFT_NOW = body.now; delete process.env.JOBLEFT_CLOCK_OFFSET; }
    else if (body.offset !== undefined) {
      try { parseDuration(body.offset); } catch { throw new ApiFailure('bad_request', 'offset must look like 72h, -30m, 3d, 90s or 1500ms.'); }
      process.env.JOBLEFT_CLOCK_OFFSET = body.offset; delete process.env.JOBLEFT_NOW;
    } else { delete process.env.JOBLEFT_NOW; delete process.env.JOBLEFT_CLOCK_OFFSET; }
    return { json: { now: nowIso() } };
  },

  // ---------------------------------------------------------------- jobs
  listJobs: ({ d, query }) => ({
    json: d.feed.search(
      { sort: query.sort ?? 'recommended', q: query.q, cursor: query.cursor, limit: query.limit ? Math.min(100, Math.max(1, Number(query.limit))) : undefined, filter: query.status ? { status: query.status } : {} },
      { hasProfile: () => d.profile.exists(), networkCount: (k) => d.network.countFor(k) },
    ),
  }),
  searchJobs: ({ d, body }) => ({ json: d.feed.search(body, { hasProfile: () => d.profile.exists(), networkCount: (k) => d.network.countFor(k) }) }),
  getJob: ({ d, params }) => {
    jobOr404(d, params.jobId!);
    const job = d.feed.job(params.jobId!)!;
    const tracker = d.tracker.get(job.id);
    const h = d.feed.h1b(job);
    const match = d.profile.exists() ? d.feed.match(d.profile.get(), job) : null;
    let company = null;
    try { company = d.staticData().getCompany({ companyKey: job.companyKey }, { name: job.company }); } catch { company = null; }
    return { json: { ...detailOf(job, { company, match, tracker, networkCount: d.network.countFor(job.companyKey), h1bTag: h.tag }), ...(h.note ? { h1bNote: h.note } : {}) } };
  },
  addExternalJob: async ({ app, d, body }) => {
    const id = await addExternal(body, { crawlStore: d.crawlStore, hostMap: app.cfg.hostMap, offline: () => app.cfg.offline });
    const tracker = d.tracker.patch(id, {}, { external: true });
    return { json: { job: jobOr404(d, id), tracker } };
  },
  keywordGaps: () => notReady('Keyword gaps (the resume engine)'),

  // ---------------------------------------------------------------- tracker and filters
  listTracker: ({ d, query }) => ({ json: d.tracker.list(query.view, query.status) }),
  updateTracker: ({ d, params, body }) => ({ json: d.tracker.patch(params.jobId!, body) }),
  listFilters: ({ d }) => ({ json: d.filters.list() }),
  createFilter: ({ d, body }) => ({ json: d.filters.create(body) }),
  updateFilter: ({ d, params, body }) => ({ json: d.filters.update(params.filterId!, body) }),
  deleteFilter: ({ d, params }) => { if (!d.filters.delete(params.filterId!)) notFound('That saved filter'); return ok; },

  // ---------------------------------------------------------------- profile and resumes
  getProfile: ({ d }) => ({ json: d.profile.get() }),
  putProfile: ({ d, body }) => {
    const saved = d.profile.put(body);
    try { d.afterProfileSaved(); } catch { /* the first-run choice never fails a save */ }
    return { json: saved };
  },
  listResumes: ({ d }) => ({ json: d.resumes.list() }),
  importResume: ({ d, body, contentType, fileName }) => ({ json: d.resumes.import(body, fileName, contentType === PDF ? PDF : DOCX) }),
  createResume: ({ d, body }) => ({ json: d.resumes.create(body) }),
  getResume: ({ d, params }) => { const r = d.resumes.get(params.resumeId!); if (!r) notFound('That resume'); return { json: r }; },
  updateResume: ({ d, params, body }) => ({ json: d.resumes.update(params.resumeId!, body) }),
  deleteResume: ({ d, params, query }) => ({ json: { deleted: d.resumes.delete(params.resumeId!, query.withVersions === 'true') } }),
  tailorResume: () => notReady('Resume tailoring (the resume engine)'),
  acceptTailoring: () => notReady('Resume tailoring (the resume engine)'),
  fitCheck: () => notReady('The one-page check (the resume engine)'),
  exportResume: ({ d, params, query }) => {
    // Until the resume engine renders documents, an uploaded resume comes back as the very file the person uploaded
    // (byte for byte) when its type is the format asked for. Anything else needs the resume engine.
    const r = d.resumes.get(params.resumeId!);
    if (!r) notFound('That resume');
    const f = d.resumes.file(r.id);
    const want = query.format === 'pdf' ? PDF : DOCX;
    if (!f || f.mimeType !== want) return notReady(`Making a ${query.format === 'pdf' ? 'PDF' : 'Word file'} from this resume (the resume engine)`);
    return { file: { fileName: f.fileName, mimeType: f.mimeType, bytes: f.bytes } };
  },
  atsCheck: () => notReady('The ATS check (the resume engine)'),
  listCoverLetters: ({ d, query }) => { jobOr404(d, query.jobId); return { json: [] }; },
  createCoverLetter: () => notReady('Cover letters (the resume engine)'),
  updateCoverLetter: () => notReady('Cover letters (the resume engine)'),

  // ---------------------------------------------------------------- match and fit
  getMatch: ({ d, params }) => {
    jobOr404(d, params.jobId!);
    if (!d.profile.exists()) throw new ApiFailure('needs_profile', 'The match score needs your profile. Fill in your profile first.');
    const m = d.feed.match(d.profile.get(), d.feed.job(params.jobId!)!);
    if (!m) return notReady('The match score for this job');
    return { json: m };
  },
  fitIndexStatus: ({ d }) => ({ json: { state: 'model_missing', model: null, modelBytes: null, modelSource: null, indexed: 0, waiting: d.jobs.counts().openJobs, lastRun: null } }),

  // ---------------------------------------------------------------- crawl and boards
  crawlStatus: ({ d }) => ({ json: d.boards.status() }),
  crawlRun: async ({ d, body }) => ({ json: await d.boards.runNow(body.boardIds) }),
  crawlReport: ({ d }) => ({ json: d.boards.report() }),
  listBoards: ({ d, query }) => ({ json: d.boards.list({ q: query.q, view: query.view, cursor: query.cursor, limit: query.limit ? Math.min(100, Math.max(1, Number(query.limit))) : undefined }) }),
  resolveBoard: () => notReady('Finding the board behind a link (the boards lane)'),
  addBoard: ({ d, body }) => ({ json: d.boards.add(body) }),
  updateBoard: ({ d, params, body }) => ({ json: d.boards.update(params.boardId!, body) }),
  exportBoards: ({ d }) => {
    const lines = d.boards.exportLines();
    return { file: { fileName: `jobleft-boards-${today()}.ndjson`, mimeType: 'application/x-ndjson', bytes: Buffer.from(lines.join('\n') + (lines.length ? '\n' : '')) } };
  },
  listSources: () => ({ json: [] }),
  updateSource: () => notFound('That source'),
  setSourceKey: () => notFound('That source'),
  deleteSourceKey: () => notFound('That source'),

  // ---------------------------------------------------------------- static data
  h1bLookup: ({ d, query }) => ({ json: d.staticData().h1bLookup({ company: query.company }) }),
  placeLookup: ({ d, query }) => ({ json: d.staticData().placeLookup({ text: query.text }) }),
  getCompany: ({ d, params }) => ({ json: d.staticData().getCompany({ companyKey: params.companyKey! }) }),
  refreshCompany: async ({ d, params, body }) => ({ json: await d.staticData().refreshCompany({ companyKey: params.companyKey! }, body) }),
  listDatasets: ({ d }) => ({ json: d.staticData().listDatasets() }),
  updateDatasets: async ({ d }) => ({ json: await d.staticData().updateDatasets() }),

  // ---------------------------------------------------------------- network
  importNetwork: ({ d, body }) => {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { throw new ApiFailure('bad_request', 'The file is not UTF-8 text. Nothing was imported.'); }
    return { json: d.network.import(text) };
  },
  listContacts: ({ d, query }) => ({ json: d.network.list({ companyKey: query.companyKey, stage: query.stage, q: query.q, due: query.due === undefined ? undefined : query.due === 'true', inPlan: query.inPlan === undefined ? undefined : query.inPlan === 'true', today: today() }) }),
  networkCoverage: ({ d }) => {
    const targets = new Map<string, string>();
    for (const v of ['liked', 'applied', 'external'] as const) for (const it of d.tracker.list(v).items) targets.set(it.job.companyKey, it.job.company);
    return { json: d.network.coverage([...targets].map(([companyKey, companyName]) => ({ companyKey, companyName }))) };
  },
  rankContacts: ({ d, query }) => ({ json: d.network.rank(query.companyKey, query.jobId ? d.jobs.get(query.jobId) : null) }),
  updateContact: ({ d, params, body }) => ({ json: d.network.update(params.contactId!, body) }),
  deleteContact: ({ d, params }) => { if (!d.network.delete(params.contactId!)) notFound('That contact'); return ok; },
  deleteNetwork: ({ d }) => ({ json: { ok: true, deleted: d.network.deleteAll() } }),
  draftOutreach: () => notReady('Message drafts (the network tool)'),

  // ---------------------------------------------------------------- AI and publik
  getAiSettings: async ({ d }) => ({ json: await d.ai.settings() }),
  putAiSettings: async ({ d, body }) => ({ json: await d.ai.update(body) }),
  setAiKey: async ({ d, body }) => ({ json: await d.ai.setKey(body.key) }),
  deleteAiKey: async ({ d }) => ({ json: await d.ai.deleteKey() }),
  checkAi: async ({ d }) => ({ json: await d.ai.check() }),
  listModels: async ({ d }) => ({ json: { models: await d.ai.models() } }),
  chat: async ({ d, body }) => {
    const job = body.jobId ? jobOr404(d, body.jobId) : null;
    const run = await d.ai.prepare(body, job);
    return { sse: run };
  },
  listChats: ({ d }) => ({ json: d.chats.list() }),
  getChat: ({ d, params }) => { const c = d.chats.get(params.chatId!); if (!c) notFound('That conversation'); return { json: c }; },
  deleteChat: ({ d, params }) => { if (!d.chats.delete(params.chatId!)) notFound('That conversation'); return ok; },
  decideProposal: () => notFound('That proposal'),
  startPractice: () => notReady('Interview practice (the AI engine)'),
  practiceFeedback: () => notReady('Interview practice (the AI engine)'),
  listPracticeItems: () => ({ json: [] }),
  savePracticeItem: () => notReady('The personal question bank (the AI engine)'),
  updatePracticeItem: () => notFound('That practice item'),
  deletePracticeItem: () => notFound('That practice item'),
  cancelAi: ({ d, params }) => ({ json: { cancelled: d.ai.cancel(params.requestId!) } }),
  getPublik: async ({ d }) => ({ json: await d.publik.status() }),
  connectPublik: async ({ d, body }) => ({ json: await d.publik.connect(body.disclosureVersion) }),
  disconnectPublik: async ({ d }) => ({ json: await d.publik.disconnect() }),
  refreshPublik: async ({ d }) => ({ json: await d.publik.refresh() }),

  // ---------------------------------------------------------------- extension
  pairingCode: ({ d }) => ({ json: d.pairing.newCode() }),
  pair: ({ d, body, extensionId }) => {
    if (!extensionId) throw new ApiFailure('forbidden_origin', 'Only a browser extension can pair.');
    return { json: d.pairing.pair(body, extensionId, APP_VERSION) };
  },
  listPairings: ({ d }) => ({ json: d.pairing.list() }),
  deletePairing: ({ d, params }) => { if (!d.pairing.remove(params.extensionId!)) notFound('That paired extension'); return ok; },
  unpair: ({ d, extensionId }) => { d.pairing.remove(extensionId!); return ok; },
  extensionStatus: ({ d }) => ({ json: new ExtensionService(d).status() }),
  fill: ({ d, body }) => ({ json: new ExtensionService(d).fill(body) }),
  review: ({ d, body, extensionId }) => ({ json: new ExtensionService(d).review(body, extensionId) }),
};

export const SERVER_INFO = { contracts: CONTRACTS_VERSION };
