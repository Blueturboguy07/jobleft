// The LOCAL API: the only way the UI and the extension talk to the app. It is served by apps/server on
// loopback only. Every route below is listed with its method, path, auth, request and response contract,
// and the lane that implements it. docs/INTERFACES.md explains the security rules in full.
//
// Security (plan section 6, "Local API has no login"; ai-engine O14; network O11):
//   * bind 127.0.0.1 only; the Host header must be 127.0.0.1:<port> or localhost:<port> (DNS rebinding);
//   * no permissive CORS: requests with an Origin header are refused unless the Origin is the app's own UI origin,
//     or chrome-extension://<paired id> on the extension routes;
//   * every route except `health` and `pair` needs LAUNCH_TOKEN_HEADER (the UI and the shell) or
//     PAIRING_TOKEN_HEADER (the extension routes). Tokens never travel in a URL query;
//   * state-changing routes accept only application/json bodies (or the raw upload types listed), so a plain
//     cross-site form post is refused before any work;
//   * error bodies never echo keys, resume text or network rows.

import { HttpUrlSchema, IdSchema, IsoDateTimeSchema, MicrosSchema } from './common.ts';
import {
  AiSettingsSchema, AiSettingsUpdateSchema, ChatRequestSchema, ChatThreadSchema, PracticeItemSchema, PracticeSessionSchema,
  ProviderCheckSchema,
} from './ai.ts';
import { CompanySchema } from './company.ts';
import {
  DraftRequestSchema, DraftResponseSchema, ExtensionStatusSchema, FillRequestSchema, FillResponseSchema, PageInfoRequestSchema,
  PageInfoSchema, PairingCodeSchema, PairingInfoSchema, PairRequestSchema, PairResponseSchema, ReviewResponseSchema,
  ReviewResultSchema,
} from './extension.ts';
import { JobFilterSchema, JobSearchRequestSchema, JobSearchResponseSchema, JobSortSchema, SavedFilterSchema } from './filter.ts';
import { JobSchema, JobSummarySchema, CrawlAtsIdSchema } from './job.ts';
import { MatchResultSchema } from './match.ts';
import {
  CoffeeChatPlanEntrySchema, CompanyCoverageSchema, CompanyMatchExplanationSchema, ContactRankSchema, DraftPreviewSchema,
  NetworkCompanyGroupSchema, NetworkContactSchema, NetworkImportSummarySchema, OutreachDraftSchema, OutreachStageSchema,
} from './network.ts';
import { ProfileInputSchema, ProfileSchema } from './profile.ts';
import {
  AtsReportSchema, CoverLetterSchema, KeywordGapReportSchema, ResumeDocumentSchema, ResumeSchema, TailorProposalSchema,
} from './resume.ts';
import {
  BoardEntrySchema, BoardResolveResponseSchema, CrawlBoardReportSchema, CrawlProgressSchema, CrawlRunSummarySchema,
  DatasetInfoSchema, ExternalJobRequestSchema, FitIndexStatusSchema, H1bLookupSchema, NotificationSchema, PlaceLookupSchema,
  SourceInfoSchema, StorageInfoSchema,
} from './sources.ts';
import { TrackerEntrySchema, TrackerPatchSchema, TrackerStatusSchema, TrackerViewSchema } from './tracker.ts';
import { PublikConnectionSchema } from './wallet.ts';
import {
  anyValue, arr, bool, enm, int, lit, named, nullable, obj, rec, str, type Infer, type JsonSchema,
} from './schema.ts';

// ---------------------------------------------------------------- constants

export const LOCAL_API_VERSION = 1;
export const LOCAL_API_BASE = '/api/v1';
/** The launch token: made by the shell (or app:up) at each launch, given to the server in JOBLEFT_LAUNCH_TOKEN. */
export const LAUNCH_TOKEN_HEADER = 'x-jobleft-token';
/** The extension's pairing token (extension routes only). */
export const PAIRING_TOKEN_HEADER = 'x-jobleft-pairing';
/** File name of a raw upload (resume import). */
export const FILE_NAME_HEADER = 'x-jobleft-filename';
/** The UI address carries the launch token in the URL FRAGMENT (never sent to a server): http://127.0.0.1:<port>/#token=<t> */
export const UI_TOKEN_FRAGMENT_KEY = 'token';
/** The server listens on the first free port of DEFAULT_PORT .. DEFAULT_PORT + PORT_SPAN - 1 (JOBLEFT_PORT overrides). */
export const DEFAULT_PORT = 47821;
export const PORT_SPAN = 10;
/** Largest JSON body the server reads; larger answers 413. Raw uploads (resume, CSV) allow RAW_BODY_LIMIT. */
export const JSON_BODY_LIMIT = 1_048_576;
export const RAW_BODY_LIMIT = 10 * 1_048_576;

// ---------------------------------------------------------------- errors

export const ERROR_CODES = [
  'bad_request', 'unauthorized', 'forbidden_origin', 'forbidden_host', 'not_found', 'conflict', 'payload_too_large',
  'unsupported_media_type', 'too_early', 'rate_limited', 'needs_profile', 'needs_provider', 'not_ready',
  'insufficient_balance', 'provider_error', 'provider_timeout', 'unsupported_source', 'forbidden_source', 'offline',
  'internal',
  // Added by the server lane (additive): a save that the disk refused (full, read-only). Nothing was stored.
  'write_failed',
] as const;
export const ErrorCodeSchema = enm(ERROR_CODES);

/** HTTP status for each error code. */
export const ERROR_STATUS: Readonly<Record<(typeof ERROR_CODES)[number], number>> = {
  bad_request: 400, unauthorized: 401, forbidden_origin: 403, forbidden_host: 403, not_found: 404, conflict: 409,
  payload_too_large: 413, unsupported_media_type: 415, too_early: 425, rate_limited: 429, needs_profile: 409,
  needs_provider: 409, not_ready: 503, insufficient_balance: 402, provider_error: 502, provider_timeout: 504,
  unsupported_source: 422, forbidden_source: 422, offline: 503, internal: 500, write_failed: 507,
};

/**
 * Every error answer has this body. `message` is one plain sentence for a person (no stack trace, no key, no
 * resume text). `link` is at most ONE link (for insufficient_balance: the publik top-up link).
 */
export const ApiErrorSchema = named(obj({
  error: obj({ code: ErrorCodeSchema, message: str({ minLength: 1 }) }, {
    details: anyValue(),
    retryAfterSeconds: int({ minimum: 0 }),
    link: obj({ label: str(), url: HttpUrlSchema }),
  }),
}), 'ApiError', 'The body of every error answer');

export type ErrorCode = Infer<typeof ErrorCodeSchema>;
export type ApiError = Infer<typeof ApiErrorSchema>;

// ---------------------------------------------------------------- small shared bodies

const Ok = named(obj({ ok: lit(true) }), 'Ok');
const QInt = str({ pattern: '^[0-9]{1,6}$' });
const QBool = enm(['true', 'false']);

export const HealthSchema = named(obj({
  app: lit('jobleft'),
  version: str(),
  apiVersion: int({ minimum: 1 }),
  extensionProtocol: int({ minimum: 1 }),
}), 'Health');

export const JobDetailSchema = named(obj({
  job: JobSchema,
  company: nullable(CompanySchema),
  /** null with no profile. */
  match: nullable(MatchResultSchema),
  tracker: nullable(TrackerEntrySchema),
  networkCount: nullable(int({ minimum: 1 })),
  h1bTag: nullable(enm(['likely_by_history', 'post_says_yes', 'post_says_no'])),
}), 'JobDetail');

export const TrackerListSchema = named(obj({
  items: arr(obj({ entry: TrackerEntrySchema, job: JobSummarySchema })),
  counts: obj({
    liked: int({ minimum: 0 }), applied: int({ minimum: 0 }), external: int({ minimum: 0 }), hidden: int({ minimum: 0 }),
    closed: int({ minimum: 0 }),
    byStatus: obj({
      applied: int({ minimum: 0 }), interviewing: int({ minimum: 0 }), offer_received: int({ minimum: 0 }),
      rejected: int({ minimum: 0 }), archived: int({ minimum: 0 }),
    }),
  }),
}), 'TrackerList');

export const AppSettingsSchema = named(obj({
  crawl: obj({
    /** Hours between scheduled refreshes of each board while the app or the tray runs. */
    intervalHours: int({ minimum: 1, maximum: 168 }),
    catchUpOnLaunch: bool(),
    runInTray: bool(),
  }),
  notifications: obj({ reminders: bool(), alerts: bool() }),
}), 'AppSettings');

// ---------------------------------------------------------------- the route table

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** none = public (health, pair); launch = UI and shell; pairing = extension; either = launch or pairing. */
export type RouteAuth = 'none' | 'launch' | 'pairing' | 'either';
export type RouteOwner =
  | 'server' | 'store' | 'crawler' | 'boards' | 'sources-ats' | 'sources-other' | 'static-data' | 'ai-engine'
  | 'resume' | 'match' | 'network' | 'extension';

export interface RouteSpec {
  method: HttpMethod;
  /** Path under the origin, with :params. */
  path: string;
  auth: RouteAuth;
  owner: RouteOwner;
  summary: string;
  /** Query string contract (all values are strings on the wire). */
  query?: JsonSchema;
  /** JSON body contract, or raw bytes with the listed media types. */
  body?: JsonSchema | { raw: readonly string[] };
  /** JSON response contract, 'sse' (text/event-stream of ChatStreamEvent), or 'file' (a download). */
  response: JsonSchema | 'sse' | 'file';
  /** Only when JOBLEFT_DEV=1. */
  devOnly?: boolean;
}

function route<const R extends RouteSpec>(r: R): R { return r; }

export const LOCAL_API = {
  // ---- app
  health: route({ method: 'GET', path: '/api/v1/health', auth: 'none', owner: 'server', summary: 'Liveness and versions. Reveals no data.', response: HealthSchema }),
  getSettings: route({ method: 'GET', path: '/api/v1/settings', auth: 'launch', owner: 'server', summary: 'App settings', response: AppSettingsSchema }),
  putSettings: route({ method: 'PUT', path: '/api/v1/settings', auth: 'launch', owner: 'server', summary: 'Change app settings', body: AppSettingsSchema, response: AppSettingsSchema }),
  storage: route({ method: 'GET', path: '/api/v1/storage', auth: 'launch', owner: 'store', summary: 'Where the data lives and how big it is', response: StorageInfoSchema }),
  backup: route({ method: 'POST', path: '/api/v1/backup', auth: 'launch', owner: 'server', summary: 'Download one backup file of everything, uploaded files included (never a key or a token)', response: 'file' }),
  restore: route({ method: 'POST', path: '/api/v1/restore', auth: 'launch', owner: 'server', summary: 'Restore a backup file; a damaged or foreign file is refused and nothing changes', body: { raw: ['application/zip', 'application/octet-stream'] }, response: obj({ restored: rec(int({ minimum: 0 })) }) }),
  exportAll: route({ method: 'GET', path: '/api/v1/export', auth: 'launch', owner: 'server', summary: 'Download all personal data as readable files (no keys)', response: 'file' }),
  deleteAllData: route({ method: 'POST', path: '/api/v1/data/delete', auth: 'launch', owner: 'server', summary: 'Delete every personal record and file in the data folder', body: obj({ confirm: lit('delete everything') }), response: Ok }),
  listNotifications: route({ method: 'GET', path: '/api/v1/notifications', auth: 'launch', owner: 'server', summary: 'Notifications waiting for the shell to show', response: arr(NotificationSchema) }),
  ackNotification: route({ method: 'POST', path: '/api/v1/notifications/:notificationId/ack', auth: 'launch', owner: 'server', summary: 'Mark a notification shown (it is never shown again)', response: Ok }),
  exportJobs: route({ method: 'GET', path: '/api/v1/export/jobs', auth: 'launch', owner: 'store', summary: 'Download saved jobs with their source credits (NDJSON)', response: 'file' }),
  devClock: route({ method: 'POST', path: '/api/v1/dev/clock', auth: 'launch', owner: 'server', summary: 'Time-skip for tests', devOnly: true, body: obj({}, { offset: str(), now: IsoDateTimeSchema }), response: obj({ now: IsoDateTimeSchema }) }),

  // ---- jobs and search
  listJobs: route({
    method: 'GET', path: '/api/v1/jobs', auth: 'launch', owner: 'store', summary: 'Simple search with the saved default filter',
    query: obj({}, { q: str({ maxLength: 500 }), sort: JobSortSchema, cursor: str(), limit: QInt, status: enm(['open', 'closed']) }),
    response: JobSearchResponseSchema,
  }),
  searchJobs: route({ method: 'POST', path: '/api/v1/jobs/search', auth: 'launch', owner: 'store', summary: 'Search with the full filter set', body: JobSearchRequestSchema, response: JobSearchResponseSchema }),
  getJob: route({ method: 'GET', path: '/api/v1/jobs/:jobId', auth: 'launch', owner: 'store', summary: 'One job with company, match, tracker and network count', response: JobDetailSchema }),
  addExternalJob: route({ method: 'POST', path: '/api/v1/jobs/external', auth: 'launch', owner: 'sources-other', summary: 'Add a job from a URL or pasted text (External tab)', body: ExternalJobRequestSchema, response: obj({ job: JobSchema, tracker: TrackerEntrySchema }) }),
  keywordGaps: route({ method: 'GET', path: '/api/v1/jobs/:jobId/keyword-gaps', auth: 'launch', owner: 'resume', summary: 'Keyword gaps of a resume for a job', query: obj({ resumeId: IdSchema }), response: KeywordGapReportSchema }),

  // ---- tracker and saved filters
  listTracker: route({ method: 'GET', path: '/api/v1/tracker', auth: 'launch', owner: 'store', summary: 'Liked, Applied, External, hidden and closed views', query: obj({ view: TrackerViewSchema }, { status: TrackerStatusSchema }), response: TrackerListSchema }),
  updateTracker: route({ method: 'PATCH', path: '/api/v1/tracker/:jobId', auth: 'launch', owner: 'store', summary: 'Like, hide, set status, notes, reminders', body: TrackerPatchSchema, response: TrackerEntrySchema }),
  listFilters: route({ method: 'GET', path: '/api/v1/filters', auth: 'launch', owner: 'store', summary: 'Saved filters', response: arr(SavedFilterSchema) }),
  createFilter: route({ method: 'POST', path: '/api/v1/filters', auth: 'launch', owner: 'store', summary: 'Save a filter', body: obj({ name: str({ minLength: 1, maxLength: 120 }), filter: JobFilterSchema, sort: JobSortSchema }, { alert: bool() }), response: SavedFilterSchema }),
  updateFilter: route({ method: 'PUT', path: '/api/v1/filters/:filterId', auth: 'launch', owner: 'store', summary: 'Change a saved filter', body: obj({ name: str({ minLength: 1, maxLength: 120 }), filter: JobFilterSchema, sort: JobSortSchema }, { alert: bool() }), response: SavedFilterSchema }),
  deleteFilter: route({ method: 'DELETE', path: '/api/v1/filters/:filterId', auth: 'launch', owner: 'store', summary: 'Delete a saved filter', response: Ok }),

  // ---- profile, resumes, cover letters
  getProfile: route({ method: 'GET', path: '/api/v1/profile', auth: 'launch', owner: 'store', summary: 'The profile', response: ProfileSchema }),
  putProfile: route({ method: 'PUT', path: '/api/v1/profile', auth: 'launch', owner: 'store', summary: 'Replace the editable profile', body: ProfileInputSchema, response: ProfileSchema }),
  listResumes: route({ method: 'GET', path: '/api/v1/resumes', auth: 'launch', owner: 'resume', summary: 'Base resumes and tailored versions', response: arr(ResumeSchema) }),
  importResume: route({
    method: 'POST', path: '/api/v1/resumes/import', auth: 'launch', owner: 'resume', summary: 'Upload a PDF or Word resume; returns it and a proposed profile to confirm',
    body: { raw: ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'] },
    response: obj({ resume: ResumeSchema, proposedProfile: ProfileInputSchema }),
  }),
  createResume: route({ method: 'POST', path: '/api/v1/resumes', auth: 'launch', owner: 'resume', summary: 'Create a base resume from the profile', body: obj({ name: str({ minLength: 1, maxLength: 200 }) }, { targetTitle: str() }), response: ResumeSchema }),
  getResume: route({ method: 'GET', path: '/api/v1/resumes/:resumeId', auth: 'launch', owner: 'resume', summary: 'One resume', response: ResumeSchema }),
  updateResume: route({ method: 'PATCH', path: '/api/v1/resumes/:resumeId', auth: 'launch', owner: 'resume', summary: 'Rename, set target title, make primary, edit the document', body: obj({}, { name: str({ minLength: 1, maxLength: 200 }), targetTitle: nullable(str()), isPrimary: bool(), document: ResumeDocumentSchema }), response: ResumeSchema }),
  deleteResume: route({ method: 'DELETE', path: '/api/v1/resumes/:resumeId', auth: 'launch', owner: 'resume', summary: 'Delete a resume; a base with versions needs withVersions=true (else 409)', query: obj({}, { withVersions: QBool }), response: obj({ deleted: arr(IdSchema) }) }),
  tailorResume: route({ method: 'POST', path: '/api/v1/resumes/:resumeId/tailor', auth: 'launch', owner: 'resume', summary: 'Draft a tailored version for a job (nothing saved yet)', body: obj({ jobId: IdSchema }), response: TailorProposalSchema }),
  acceptTailoring: route({ method: 'POST', path: '/api/v1/resumes/:resumeId/versions', auth: 'launch', owner: 'resume', summary: 'Save a tailored version with the accepted changes', body: obj({ proposalId: IdSchema, acceptChangeIds: arr(IdSchema) }), response: ResumeSchema }),
  fitCheck: route({ method: 'GET', path: '/api/v1/resumes/:resumeId/fit-check', auth: 'launch', owner: 'resume', summary: 'Does it fit one page, and what would be left out', response: obj({ fitsOnePage: bool(), leftOut: arr(str()) }) }),
  exportResume: route({ method: 'GET', path: '/api/v1/resumes/:resumeId/export', auth: 'launch', owner: 'resume', summary: 'Download as a one-page PDF or a Word file', query: obj({ format: enm(['pdf', 'docx']) }), response: 'file' }),
  atsCheck: route({ method: 'POST', path: '/api/v1/resumes/:resumeId/ats-check', auth: 'launch', owner: 'resume', summary: 'Grade the exported PDF', response: AtsReportSchema }),
  listCoverLetters: route({ method: 'GET', path: '/api/v1/cover-letters', auth: 'launch', owner: 'resume', summary: 'Cover letters for a job', query: obj({ jobId: IdSchema }), response: arr(CoverLetterSchema) }),
  createCoverLetter: route({ method: 'POST', path: '/api/v1/cover-letters', auth: 'launch', owner: 'resume', summary: 'Draft a cover letter (truth-gated)', body: obj({ jobId: IdSchema, resumeId: IdSchema }), response: CoverLetterSchema }),
  updateCoverLetter: route({ method: 'PATCH', path: '/api/v1/cover-letters/:letterId', auth: 'launch', owner: 'resume', summary: 'Edit by hand (text) or by request (instruction); truth rules hold', body: obj({}, { text: str(), instruction: str({ maxLength: 2000 }) }), response: CoverLetterSchema }),
  exportCoverLetter: route({ method: 'GET', path: '/api/v1/cover-letters/:letterId/export', auth: 'launch', owner: 'resume', summary: 'Download a cover letter as a one-page PDF or a Word file (added in contracts 1.1.0)', query: obj({ format: enm(['pdf', 'docx']) }), response: 'file' }),

  // ---- match and fit index
  getMatch: route({ method: 'GET', path: '/api/v1/match/:jobId', auth: 'launch', owner: 'match', summary: 'Match score of a job (409 needs_profile without a profile)', response: MatchResultSchema }),
  fitIndexStatus: route({ method: 'GET', path: '/api/v1/index/status', auth: 'launch', owner: 'store', summary: 'Fit indexing: indexed, waiting, last run, model', response: FitIndexStatusSchema }),

  // ---- crawl, boards, sources
  crawlStatus: route({ method: 'GET', path: '/api/v1/crawl/status', auth: 'launch', owner: 'boards', summary: 'Crawl progress (boards done of total)', response: CrawlProgressSchema }),
  crawlRun: route({ method: 'POST', path: '/api/v1/crawl/run', auth: 'launch', owner: 'boards', summary: 'Start a refresh now (all due boards, or the listed ones)', body: obj({}, { boardIds: arr(str()) }), response: obj({ started: bool(), message: str(), nextAllowedAt: nullable(IsoDateTimeSchema) }) }),
  crawlReport: route({ method: 'GET', path: '/api/v1/crawl/report', auth: 'launch', owner: 'boards', summary: 'Last run, per board, with reasons', response: obj({ run: nullable(CrawlRunSummarySchema), boards: arr(CrawlBoardReportSchema) }) }),
  listBoards: route({
    method: 'GET', path: '/api/v1/boards', auth: 'launch', owner: 'boards', summary: 'Directory and user boards',
    query: obj({}, { q: str({ maxLength: 200 }), view: enm(['all', 'followed', 'user', 'hidden', 'disabled', 'failing']), cursor: str(), limit: QInt }),
    response: obj({ items: arr(BoardEntrySchema), total: int({ minimum: 0 }), nextCursor: nullable(str()) }),
  }),
  resolveBoard: route({ method: 'POST', path: '/api/v1/boards/resolve', auth: 'launch', owner: 'boards', summary: 'Find the board behind a careers or job link (adds nothing)', body: obj({ url: str({ maxLength: 4096 }) }, { acceptPaidLookup: bool() }), response: BoardResolveResponseSchema }),
  addBoard: route({ method: 'POST', path: '/api/v1/boards', auth: 'launch', owner: 'boards', summary: 'Add a confirmed board (409 conflict when already added)', body: obj({ ats: CrawlAtsIdSchema, board: str({ minLength: 1 }) }, { region: str() }), response: BoardEntrySchema }),
  updateBoard: route({ method: 'PATCH', path: '/api/v1/boards/:boardId', auth: 'launch', owner: 'boards', summary: 'Follow, hide or disable a board', body: obj({}, { followed: bool(), hidden: bool(), disabled: bool() }), response: BoardEntrySchema }),
  exportBoards: route({ method: 'GET', path: '/api/v1/boards/export', auth: 'launch', owner: 'boards', summary: 'Download the directory and user boards (NDJSON)', response: 'file' }),
  listSources: route({ method: 'GET', path: '/api/v1/sources', auth: 'launch', owner: 'sources-other', summary: 'Every source: crawled or not, why, status', response: arr(SourceInfoSchema) }),
  updateSource: route({ method: 'PATCH', path: '/api/v1/sources/:sourceId', auth: 'launch', owner: 'sources-other', summary: 'Turn a source on or off', body: obj({ enabled: bool() }), response: SourceInfoSchema }),
  setSourceKey: route({ method: 'PUT', path: '/api/v1/sources/:sourceId/key', auth: 'launch', owner: 'sources-other', summary: 'Save the key a source needs (kept in the secret store, never echoed)', body: obj({ key: str({ minLength: 1, maxLength: 1000 }) }), response: SourceInfoSchema }),
  deleteSourceKey: route({ method: 'DELETE', path: '/api/v1/sources/:sourceId/key', auth: 'launch', owner: 'sources-other', summary: 'Forget a source key', response: SourceInfoSchema }),

  // ---- static data and company facts
  h1bLookup: route({ method: 'GET', path: '/api/v1/lookup/h1b', auth: 'launch', owner: 'static-data', summary: 'H-1B filing summary for a company name (found or unknown, never "no")', query: obj({ company: str({ minLength: 1, maxLength: 300 }) }), response: H1bLookupSchema }),
  placeLookup: route({ method: 'GET', path: '/api/v1/lookup/place', auth: 'launch', owner: 'static-data', summary: 'Resolve a place text', query: obj({ text: str({ minLength: 1, maxLength: 500 }) }), response: PlaceLookupSchema }),
  getCompany: route({ method: 'GET', path: '/api/v1/companies/:companyKey', auth: 'launch', owner: 'static-data', summary: 'Company facts (kept, sourced, dated)', response: CompanySchema }),
  refreshCompany: route({ method: 'POST', path: '/api/v1/companies/:companyKey/refresh', auth: 'launch', owner: 'static-data', summary: 'Read company facts again; paid lookups only with allowPaid and a price cap', body: obj({ allowPaid: bool() }, { maxPriceMicros: MicrosSchema }), response: CompanySchema }),
  listDatasets: route({ method: 'GET', path: '/api/v1/data-sources', auth: 'launch', owner: 'static-data', summary: 'Shipped datasets with date, licence and attribution', response: arr(DatasetInfoSchema) }),
  updateDatasets: route({ method: 'POST', path: '/api/v1/data-sources/update', auth: 'launch', owner: 'static-data', summary: 'Fetch newer dataset releases; a bad release keeps the old data', response: arr(DatasetInfoSchema) }),

  // ---- network tool
  importNetwork: route({ method: 'POST', path: '/api/v1/network/import', auth: 'launch', owner: 'network', summary: 'Import Connections.csv (raw text body)', body: { raw: ['text/csv', 'text/plain'] }, response: NetworkImportSummarySchema }),
  listContacts: route({ method: 'GET', path: '/api/v1/network/contacts', auth: 'launch', owner: 'network', summary: 'Contacts, filtered', query: obj({}, { companyKey: str(), stage: OutreachStageSchema, q: str({ maxLength: 200 }), due: QBool, inPlan: QBool, noCompany: QBool, limit: QInt, offset: QInt }), response: arr(NetworkContactSchema) }),
  networkCoverage: route({ method: 'GET', path: '/api/v1/network/coverage', auth: 'launch', owner: 'network', summary: 'Target companies with and without connections', response: arr(CompanyCoverageSchema) }),
  rankContacts: route({ method: 'GET', path: '/api/v1/network/rank', auth: 'launch', owner: 'network', summary: 'Who to message first at a company, with reasons', query: obj({ companyKey: str({ minLength: 1 }) }, { jobId: IdSchema }), response: arr(ContactRankSchema) }),
  updateContact: route({ method: 'PATCH', path: '/api/v1/network/contacts/:contactId', auth: 'launch', owner: 'network', summary: 'Stage, note, follow-up date, plan', body: obj({}, { stage: OutreachStageSchema, note: nullable(str({ maxLength: 20000 })), followUpOn: nullable(str({ format: 'date' })), inPlan: bool() }), response: NetworkContactSchema }),
  deleteContact: route({ method: 'DELETE', path: '/api/v1/network/contacts/:contactId', auth: 'launch', owner: 'network', summary: 'Delete one contact and everything about it', response: Ok }),
  deleteNetwork: route({ method: 'DELETE', path: '/api/v1/network', auth: 'launch', owner: 'network', summary: 'Delete all network data (the user\'s own file is untouched)', response: obj({ ok: lit(true), deleted: int({ minimum: 0 }) }, { logCleared: bool() }) }),
  draftOutreach: route({ method: 'POST', path: '/api/v1/network/contacts/:contactId/draft', auth: 'launch', owner: 'network', summary: 'Draft a short message (sends only this contact, this job and a short summary)', body: obj({ variant: enm(['short', 'long']) }, { jobId: IdSchema, template: bool(), confirmRemote: bool() }), response: OutreachDraftSchema }),
  previewDraft: route({ method: 'POST', path: '/api/v1/network/contacts/:contactId/draft/preview', auth: 'launch', owner: 'network', summary: 'What a draft would send and to whom (nothing is sent)', body: obj({ variant: enm(['short', 'long']) }, { jobId: IdSchema }), response: DraftPreviewSchema }),
  networkCompanies: route({ method: 'GET', path: '/api/v1/network/companies', auth: 'launch', owner: 'network', summary: 'Companies in the network with counts; blank and placeholder companies grouped apart', response: arr(NetworkCompanyGroupSchema) }),
  explainCompanyMatch: route({ method: 'GET', path: '/api/v1/network/match', auth: 'launch', owner: 'network', summary: 'How a company count was made: names counted and near names not counted, with reasons', query: obj({ companyKey: str({ minLength: 1 }) }, { companyName: str({ maxLength: 300 }) }), response: CompanyMatchExplanationSchema }),
  networkPlan: route({ method: 'GET', path: '/api/v1/network/plan', auth: 'launch', owner: 'network', summary: 'The coffee-chat plan by company, in rank order, with a next step each', response: arr(CoffeeChatPlanEntrySchema) }),
  planTopContacts: route({ method: 'POST', path: '/api/v1/network/plan', auth: 'launch', owner: 'network', summary: 'Put the top N people at a company into the coffee-chat plan', body: obj({ companyKey: str({ minLength: 1 }), count: int({ minimum: 1, maximum: 50 }) }, { jobId: IdSchema }), response: arr(NetworkContactSchema) }),

  // ---- AI and publik
  getAiSettings: route({ method: 'GET', path: '/api/v1/ai/settings', auth: 'launch', owner: 'ai-engine', summary: 'Provider settings (never the key)', response: AiSettingsSchema }),
  putAiSettings: route({ method: 'PUT', path: '/api/v1/ai/settings', auth: 'launch', owner: 'ai-engine', summary: 'Choose a provider; runs the setup check', body: AiSettingsUpdateSchema, response: obj({ settings: AiSettingsSchema, check: ProviderCheckSchema }) }),
  setAiKey: route({ method: 'PUT', path: '/api/v1/ai/key', auth: 'launch', owner: 'ai-engine', summary: 'Save the key of the current provider (secret store; only the last 4 characters come back)', body: obj({ key: str({ minLength: 1, maxLength: 1000 }) }), response: AiSettingsSchema }),
  deleteAiKey: route({ method: 'DELETE', path: '/api/v1/ai/key', auth: 'launch', owner: 'ai-engine', summary: 'Forget the key', response: AiSettingsSchema }),
  checkAi: route({ method: 'POST', path: '/api/v1/ai/check', auth: 'launch', owner: 'ai-engine', summary: 'Test the provider now', response: ProviderCheckSchema }),
  listModels: route({ method: 'GET', path: '/api/v1/ai/models', auth: 'launch', owner: 'ai-engine', summary: 'Models the provider says it has', response: obj({ models: arr(str()) }) }),
  chat: route({ method: 'POST', path: '/api/v1/ai/chat', auth: 'launch', owner: 'ai-engine', summary: 'Chat (streams ChatStreamEvent)', body: ChatRequestSchema, response: 'sse' }),
  listChats: route({ method: 'GET', path: '/api/v1/ai/chats', auth: 'launch', owner: 'ai-engine', summary: 'Saved conversations (on the laptop)', response: arr(obj({ id: IdSchema, title: str(), jobId: nullable(IdSchema), updatedAt: IsoDateTimeSchema })) }),
  getChat: route({ method: 'GET', path: '/api/v1/ai/chats/:chatId', auth: 'launch', owner: 'ai-engine', summary: 'One conversation', response: ChatThreadSchema }),
  deleteChat: route({ method: 'DELETE', path: '/api/v1/ai/chats/:chatId', auth: 'launch', owner: 'ai-engine', summary: 'Delete a conversation for real', response: Ok }),
  decideProposal: route({ method: 'POST', path: '/api/v1/ai/proposals/:proposalId', auth: 'launch', owner: 'ai-engine', summary: 'Approve some actions of an assistant proposal; the rest are declined', body: obj({ approveActionIds: arr(IdSchema) }), response: obj({ applied: arr(IdSchema), declined: arr(IdSchema) }) }),
  startPractice: route({ method: 'POST', path: '/api/v1/practice/sessions', auth: 'launch', owner: 'ai-engine', summary: 'Interview practice made for one job', body: obj({ jobId: IdSchema }), response: PracticeSessionSchema }),
  practiceFeedback: route({ method: 'POST', path: '/api/v1/practice/feedback', auth: 'launch', owner: 'ai-engine', summary: 'Feedback on an answer (no invented achievements; placeholders marked)', body: obj({ sessionId: IdSchema, questionId: IdSchema, answer: str({ maxLength: 20000 }) }), response: obj({ feedback: str(), sampleAnswer: nullable(str()), placeholders: arr(str()) }) }),
  listPracticeItems: route({ method: 'GET', path: '/api/v1/practice/items', auth: 'launch', owner: 'ai-engine', summary: 'The personal question bank', query: obj({}, { jobId: IdSchema }), response: arr(PracticeItemSchema) }),
  savePracticeItem: route({ method: 'POST', path: '/api/v1/practice/items', auth: 'launch', owner: 'ai-engine', summary: 'Save a question, answer or debrief for a job', body: obj({ jobId: IdSchema, kind: enm(['question', 'debrief']) }, { question: str(), answer: str(), feedback: str(), notes: str() }), response: PracticeItemSchema }),
  updatePracticeItem: route({ method: 'PATCH', path: '/api/v1/practice/items/:itemId', auth: 'launch', owner: 'ai-engine', summary: 'Edit a saved practice item', body: obj({}, { question: nullable(str()), answer: nullable(str()), feedback: nullable(str()), notes: nullable(str()) }), response: PracticeItemSchema }),
  deletePracticeItem: route({ method: 'DELETE', path: '/api/v1/practice/items/:itemId', auth: 'launch', owner: 'ai-engine', summary: 'Delete a saved practice item', response: Ok }),
  cancelAi: route({ method: 'POST', path: '/api/v1/ai/requests/:requestId/cancel', auth: 'launch', owner: 'ai-engine', summary: 'Cancel a running AI request (stops upstream too)', response: obj({ cancelled: bool() }) }),
  getPublik: route({ method: 'GET', path: '/api/v1/publik', auth: 'launch', owner: 'ai-engine', summary: 'publik connection and balance', response: PublikConnectionSchema }),
  connectPublik: route({ method: 'POST', path: '/api/v1/publik/connect', auth: 'launch', owner: 'ai-engine', summary: 'Connect after the disclosure (no key is typed)', body: obj({ disclosureAccepted: lit(true), disclosureVersion: int({ minimum: 1 }) }), response: PublikConnectionSchema }),
  disconnectPublik: route({ method: 'POST', path: '/api/v1/publik/disconnect', auth: 'launch', owner: 'ai-engine', summary: 'Disconnect: the key is deleted and nothing spends the balance', response: PublikConnectionSchema }),
  refreshPublik: route({ method: 'POST', path: '/api/v1/publik/refresh', auth: 'launch', owner: 'ai-engine', summary: 'Read the balance again', response: PublikConnectionSchema }),

  // ---- extension
  pairingCode: route({ method: 'POST', path: '/api/v1/extension/pairing-code', auth: 'launch', owner: 'server', summary: 'Show a 6-digit pairing code (5 minutes)', response: PairingCodeSchema }),
  pair: route({ method: 'POST', path: '/api/v1/extension/pair', auth: 'none', owner: 'server', summary: 'Pair the extension with a code (Origin must be the extension)', body: PairRequestSchema, response: PairResponseSchema }),
  listPairings: route({ method: 'GET', path: '/api/v1/extension/pairings', auth: 'launch', owner: 'server', summary: 'Paired extensions (the person sees each one)', response: arr(PairingInfoSchema) }),
  deletePairing: route({ method: 'DELETE', path: '/api/v1/extension/pairings/:extensionId', auth: 'launch', owner: 'server', summary: 'Unpair one extension; its token stops working at once', response: Ok }),
  unpair: route({ method: 'DELETE', path: '/api/v1/extension/pairing', auth: 'pairing', owner: 'server', summary: 'The extension unpairs itself', response: Ok }),
  extensionStatus: route({ method: 'GET', path: '/api/v1/extension/status', auth: 'pairing', owner: 'server', summary: 'Paired state and profile completeness', response: ExtensionStatusSchema }),
  fill: route({ method: 'POST', path: '/api/v1/extension/fill', auth: 'pairing', owner: 'server', summary: 'Values for the form fields of an application page', body: FillRequestSchema, response: FillResponseSchema }),
  review: route({ method: 'POST', path: '/api/v1/extension/review', auth: 'pairing', owner: 'server', summary: 'What the user reviewed and whether the user submitted', body: ReviewResultSchema, response: ReviewResponseSchema }),
  extensionPage: route({ method: 'POST', path: '/api/v1/extension/page', auth: 'pairing', owner: 'server', summary: 'Which job a page address is, whether the person applied, and the resumes to attach (the address only; no page text)', body: PageInfoRequestSchema, response: PageInfoSchema }),
  extensionDrafts: route({ method: 'POST', path: '/api/v1/extension/drafts', auth: 'pairing', owner: 'server', summary: 'Draft answers for open questions after the person saw the price (never written into a form by the app)', body: DraftRequestSchema, response: DraftResponseSchema }),
} as const;

export type LocalApi = typeof LOCAL_API;
export type RouteName = keyof LocalApi;

/** The JSON body type of a route (Uint8Array for raw uploads, undefined when there is no body). */
export type RouteBody<K extends RouteName> = LocalApi[K] extends { body: infer B }
  ? B extends { raw: readonly string[] } ? Uint8Array : Infer<B>
  : undefined;
/** The query type of a route (undefined when there is no query). */
export type RouteQuery<K extends RouteName> = LocalApi[K] extends { query: infer Q } ? Infer<Q> : undefined;
/** The JSON response type of a route (Response for 'sse' and 'file'). */
export type RouteResponse<K extends RouteName> = LocalApi[K]['response'] extends 'sse' | 'file'
  ? Response
  : Infer<LocalApi[K]['response']>;

/** Path params of a route, e.g. { jobId: string } for '/api/v1/jobs/:jobId'. */
export type RouteParams<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? { [K in Name]: string } & RouteParams<`/${Rest}`>
  : P extends `${string}:${infer Name}` ? { [K in Name]: string } : {};

/** Fills the :params of a path. Every value is URI-encoded. */
export function buildPath(path: string, params: Record<string, string> = {}): string {
  return path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined) throw new Error(`missing path param "${name}" for ${path}`);
    return encodeURIComponent(v);
  });
}

/** Finds the route for a method and a path. Returns null when none matches. Literal segments win over params. */
export function matchRoute(method: string, pathname: string): { name: RouteName; params: Record<string, string> } | null {
  const segs = pathname.split('/').filter(Boolean);
  let best: { name: RouteName; params: Record<string, string>; literals: number } | null = null;
  for (const [name, r] of Object.entries(LOCAL_API) as Array<[RouteName, RouteSpec]>) {
    if (r.method !== method) continue;
    const rs = r.path.split('/').filter(Boolean);
    if (rs.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let literals = 0;
    let ok = true;
    for (let i = 0; i < rs.length; i++) {
      const a = rs[i]!, b = segs[i]!;
      if (a.startsWith(':')) {
        try { params[a.slice(1)] = decodeURIComponent(b); } catch { ok = false; break; }
      } else if (a === b) literals++;
      else { ok = false; break; }
    }
    if (ok && (!best || literals > best.literals)) best = { name, params, literals };
  }
  return best ? { name: best.name, params: best.params } : null;
}

export type Health = Infer<typeof HealthSchema>;
export type JobDetail = Infer<typeof JobDetailSchema>;
export type TrackerList = Infer<typeof TrackerListSchema>;
export type AppSettings = Infer<typeof AppSettingsSchema>;
