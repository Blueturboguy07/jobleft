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
import { AiError, type AiClient } from '@jobleft/ai-engine';
import { NetworkApiError, handleNetworkRoute, profileSummary, type NetworkRouteName } from '@jobleft/network';
import type { App, AppData } from './app.ts';
import { ApiFailure, notFound, notReady } from './errors.ts';
import { tmpName } from './home.ts';
import type { FileBody } from './http/respond.ts';
import { bodyToFile } from './http/body.ts';
import { addExternal } from './interim/external.ts';
import { detailOf } from './interim/jobs.ts';
import { createAiRouteHandlers, type AiRouteHandlers } from '@jobleft/ai-engine';
import { apiFailureOf } from './integ/engine.ts';
import { matchFor } from './integ/match.ts';
import { step } from './integ/resume.ts';
import { safeFileName } from './interim/resumes.ts';
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
const extensionOf = (app: App, d: AppData) => new ExtensionService(d, { hostMap: app.cfg.hostMap, offline: () => app.cfg.offline });
const today = () => nowIso().slice(0, 10);
const tmpFile = (p: string): FileBody['cleanup'] => () => { try { rmSync(p, { force: true }); } catch { /* ignore */ } };

function jobOr404(d: AppData, id: string) {
  const j = d.jobs.get(id);
  if (!j) notFound('That job');
  return j;
}

/** One route of the ai-engine (settings, key, check, models, cancel, publik): its answer, or its error as the server's error. */
async function aiJson<K extends RouteName & keyof AiRouteHandlers>(c: Ctx<K>, name: K): Promise<Out> {
  const r = await createAiRouteHandlers(c.d.ai.engine)[name]({ params: c.params, query: c.query as Record<string, string>, body: c.body, signal: c.gone });
  if ('sse' in r) throw new ApiFailure('internal', 'That answer cannot be streamed.');
  if (r.status >= 400) throw apiFailureOf({ status: r.status, ...(r.json as object) });
  return { json: r.json };
/** The target companies of the Network tool: the companies of jobs the person liked, applied to or added. */
function networkTargets(d: AppData): Array<{ companyKey: string; companyName: string }> {
  const targets = new Map<string, string>();
  for (const v of ['liked', 'applied', 'external'] as const) for (const it of d.tracker.list(v).items) if (it.job.companyKey) targets.set(it.job.companyKey, it.job.company);
  return [...targets].map(([companyKey, companyName]) => ({ companyKey, companyName }));
}

/** Runs one Network route through the package's own handler and turns its error into the API error. */
async function network<K extends NetworkRouteName>(name: K, c: Ctx<K>): Promise<Out> {
  const { d, app } = c;
  const body = (c.body ?? {}) as { template?: boolean };
  let client: AiClient | null = null;
  let clientError: unknown = new AiError('no_provider', 'No AI provider is set up.');
  // A client is made only for a real AI draft. Making it sends nothing. A failure here is raised by the package at the
  // point where it needs the client, after its own checks (no provider, offline, first remote draft).
  if (name === 'draftOutreach' && !body.template && d.ai.destination()) {
    try { client = await d.ai.draftClient(); } catch (e) { clientError = e; }
  }
  try {
    const json = await handleNetworkRoute(name, { params: c.params, query: c.query as Record<string, string | undefined>, body: c.body }, {
      service: d.network,
      job: (id) => d.jobs.get(id),
      profileSummary: () => profileSummary(d.profile.exists() ? d.profile.get() : null),
      ai: () => { if (!client) throw clientError; return client; },
      aiDestination: () => d.ai.destination(),
      targets: () => networkTargets(d),
      offline: app.cfg.offline,
    });
    if (name === 'deleteNetwork' || name === 'deleteContact') d.notifications.dropPending('follow_up');
    if (name === 'updateContact') d.followUpReminders();
    return { json };
  } catch (e) {
    if (e instanceof NetworkApiError) {
      throw new ApiFailure(e.code, e.message, { ...(e.details !== undefined ? { details: e.details } : {}), ...(e.link ? { link: e.link } : {}) });
    }
    throw e;
  }
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
  devClock: ({ app, d, body }) => {
    if (!app.cfg.dev) notFound('That page');
    if (body.now !== undefined) { process.env.JOBLEFT_NOW = body.now; delete process.env.JOBLEFT_CLOCK_OFFSET; }
    else if (body.offset !== undefined) {
      try { parseDuration(body.offset); } catch { throw new ApiFailure('bad_request', 'offset must look like 72h, -30m, 3d, 90s or 1500ms.'); }
      process.env.JOBLEFT_CLOCK_OFFSET = body.offset; delete process.env.JOBLEFT_NOW;
    } else { delete process.env.JOBLEFT_NOW; delete process.env.JOBLEFT_CLOCK_OFFSET; }
    d.reminderTick(); // a test that moves the clock sees a due reminder now, not at the next 30-second tick
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
  keywordGaps: async ({ d, params, query }) => ({ json: await step(() => d.resumes.svc.keywordGaps(params.jobId!, query.resumeId)) }),

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
  importResume: async ({ d, body, contentType, fileName }) => {
    const r = await step(() => d.resumes.svc.import(body, safeFileName(fileName, 'resume'), contentType ?? 'application/octet-stream'));
    return { json: { resume: r.resume, proposedProfile: r.proposedProfile } };
  },
  createResume: ({ d, body }) => step(() => ({ json: d.resumes.svc.create(body) })),
  getResume: ({ d, params }) => { const r = d.resumes.get(params.resumeId!); if (!r) notFound('That resume'); return { json: r }; },
  updateResume: ({ d, params, body }) => step(() => ({ json: d.resumes.svc.update(params.resumeId!, body) })),
  deleteResume: ({ d, params, query }) => step(() => ({ json: { deleted: d.resumes.svc.delete(params.resumeId!, query.withVersions === 'true') } })),
  tailorResume: async ({ d, params, body }) => ({ json: await d.ai.metered(() => step(() => d.resumes.svc.tailor(params.resumeId!, body.jobId))) }),
  acceptTailoring: async ({ d, params, body }) => ({ json: await step(() => d.resumes.svc.accept(params.resumeId!, body.proposalId, body.acceptChangeIds)) }),
  fitCheck: async ({ d, params }) => ({ json: await step(() => d.resumes.svc.fitCheck(params.resumeId!)) }),
  exportResume: async ({ d, params, query }) => {
    const f = await step(() => d.resumes.svc.export(params.resumeId!, query.format));
    return { file: { fileName: f.fileName, mimeType: f.mimeType, bytes: Buffer.from(f.bytes) } };
  },
  atsCheck: async ({ d, params }) => ({ json: await step(() => d.resumes.svc.atsCheck(params.resumeId!)) }),
  listCoverLetters: ({ d, query }) => { jobOr404(d, query.jobId); return { json: d.resumes.svc.coverLetters(query.jobId) }; },
  createCoverLetter: async ({ d, body }) => { jobOr404(d, body.jobId); return { json: await d.ai.metered(() => step(() => d.resumes.svc.createCoverLetter(body.jobId, body.resumeId))) }; },
  updateCoverLetter: async ({ d, params, body }) => ({ json: await d.ai.metered(() => step(() => d.resumes.svc.updateCoverLetter(params.letterId!, body))) }),
  exportCoverLetter: async ({ d, params, query }) => {
    const f = await step(() => d.resumes.svc.exportCoverLetter(params.letterId!, query.format));
    return { file: { fileName: f.fileName, mimeType: f.mimeType, bytes: Buffer.from(f.bytes) } };
  },

  // ---------------------------------------------------------------- match and fit
  getMatch: ({ d, params }) => {
    const job = jobOr404(d, params.jobId!);
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

  // ---------------------------------------------------------------- network (the Network tool, @jobleft/network)
  importNetwork: (c) => network('importNetwork', c),
  listContacts: (c) => network('listContacts', c),
  networkCoverage: (c) => network('networkCoverage', c),
  rankContacts: (c) => network('rankContacts', c),
  updateContact: (c) => network('updateContact', c),
  deleteContact: (c) => network('deleteContact', c),
  deleteNetwork: (c) => network('deleteNetwork', c),
  draftOutreach: (c) => network('draftOutreach', c),
  previewDraft: (c) => network('previewDraft', c),
  networkCompanies: (c) => network('networkCompanies', c),
  explainCompanyMatch: (c) => network('explainCompanyMatch', c),
  networkPlan: (c) => network('networkPlan', c),
  planTopContacts: (c) => network('planTopContacts', c),

  // ---------------------------------------------------------------- AI and publik
  getAiSettings: (c) => aiJson(c, 'getAiSettings'),
  putAiSettings: (c) => aiJson(c, 'putAiSettings'),
  setAiKey: (c) => aiJson(c, 'setAiKey'),
  deleteAiKey: (c) => aiJson(c, 'deleteAiKey'),
  checkAi: (c) => aiJson(c, 'checkAi'),
  listModels: (c) => aiJson(c, 'listModels'),
  chat: async ({ d, body }) => {
    const job = body.jobId ? jobOr404(d, body.jobId) : null;
    return { sse: await d.ai.prepareChat(body, job) };
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
  cancelAi: (c) => aiJson(c, 'cancelAi'),
  getPublik: (c) => aiJson(c, 'getPublik'),
  connectPublik: (c) => aiJson(c, 'connectPublik'),
  disconnectPublik: (c) => aiJson(c, 'disconnectPublik'),
  refreshPublik: (c) => aiJson(c, 'refreshPublik'),

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
  extensionCheck: ({ d }) => ({ json: new ExtensionService(d).status() }),
  extensionPage: ({ app, d, body }) => ({ json: extensionOf(app, d).page(body) }),
  extensionAddJob: async ({ app, d, body }) => ({ json: await extensionOf(app, d).addJob(body) }),
  fill: async ({ app, d, body }) => ({ json: await extensionOf(app, d).fill(body) }),
  extensionDrafts: ({ app, d, body }) => ({ json: extensionOf(app, d).drafts(body) }),
  review: ({ app, d, body, extensionId }) => ({ json: extensionOf(app, d).review(body, extensionId) }),
};

export const SERVER_INFO = { contracts: CONTRACTS_VERSION };
