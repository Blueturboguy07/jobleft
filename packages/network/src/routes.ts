// The network routes of the local API, free of any HTTP framework. apps/server (or this package's dev server)
// checks Host, Origin, the launch token, the media type, the body size and the contract, then calls
// handleNetworkRoute(). Errors are NetworkApiError with a code from ERROR_CODES and one plain sentence. No error
// message ever holds a network row, a name, an email or a note (docs/INTERFACES.md section 6.1 rule 9).

import type { Job, OutreachDraft, OutreachStage } from '@jobleft/contracts';
import { AiError, type AiClient } from '@jobleft/ai-engine';
import { decodeCsvBytes } from './text.ts';
import { draftFacts, draftFromTemplate, draftMessages, draftOutreach, type DraftVariant } from './draft.ts';
import { NetworkError, type NetworkService } from './service.ts';

export const NETWORK_ROUTES = [
  'importNetwork', 'listContacts', 'networkCoverage', 'rankContacts', 'updateContact', 'deleteContact', 'deleteNetwork',
  'draftOutreach', 'previewDraft', 'networkCompanies', 'explainCompanyMatch', 'networkPlan', 'planTopContacts',
] as const;
export type NetworkRouteName = (typeof NETWORK_ROUTES)[number];

export type NetworkErrorCode =
  | 'bad_request' | 'not_found' | 'conflict' | 'needs_provider' | 'insufficient_balance' | 'provider_error'
  | 'provider_timeout' | 'offline' | 'internal';

export class NetworkApiError extends Error {
  readonly code: NetworkErrorCode;
  readonly details: unknown;
  readonly link: { label: string; url: string } | null;
  constructor(code: NetworkErrorCode, message: string, details?: unknown, link: { label: string; url: string } | null = null) {
    super(message);
    this.name = 'NetworkApiError';
    this.code = code;
    this.details = details;
    this.link = link;
  }
}

/** Where AI text goes for a draft: the provider kind, a plain label, and whether the text leaves this computer. */
export interface AiDestination {
  provider: string;
  label: string;
  remote: boolean;
}

export interface NetworkRouteDeps {
  service: NetworkService;
  /** A job by id (the store). null when unknown. */
  job: (id: string) => Job | null;
  /** The short summary of the person for drafts: profileSummary(profile). Never contact details. */
  profileSummary: () => string;
  /** The chosen AI provider. Throws AiError('no_provider') when none is set. Never another provider. */
  ai: () => AiClient;
  /** Where the chosen provider sends text; null when none is set up. */
  aiDestination: () => AiDestination | null;
  /** Target companies: the companies of the jobs the person liked, applied to or tracks. */
  targets: () => Array<{ companyKey: string; companyName: string }>;
  /** true = no outbound request at all (JOBLEFT_OFFLINE=1). Drafts then need a local provider or the template. */
  offline?: boolean;
}

export interface NetworkRouteInput {
  params: Record<string, string>;
  /** Query values as strings (already checked against the route contract). */
  query: Record<string, string | undefined>;
  /** JSON body (already checked), or the raw bytes of an upload. */
  body: unknown;
}

function qBool(v: string | undefined): boolean | undefined {
  return v === 'true' ? true : v === 'false' ? false : undefined;
}

function qInt(v: string | undefined): number | undefined {
  return v !== undefined && /^\d{1,6}$/.test(v) ? Number(v) : undefined;
}

function jobOrThrow(deps: NetworkRouteDeps, jobId: unknown): Job | null {
  if (jobId === undefined || jobId === null || jobId === '') return null;
  const job = deps.job(String(jobId));
  if (!job) throw new NetworkApiError('not_found', 'No such job.');
  return job;
}

function contactOrThrow(deps: NetworkRouteDeps, id: string) {
  const c = deps.service.get(id);
  if (!c) throw new NetworkApiError('not_found', 'No such contact.');
  return c;
}

/** Maps an AI failure to the API error, in plain words. */
export function aiErrorToApi(e: unknown): NetworkApiError {
  if (e instanceof AiError) {
    switch (e.code) {
      case 'no_provider':
        return new NetworkApiError('needs_provider', 'No AI provider is set up. Set one up in Settings > AI (a model on this computer works), or use the plain template.');
      case 'insufficient_balance':
        return new NetworkApiError('insufficient_balance', e.message || 'Your publik balance ran out. Add money, then draft again.', undefined, e.topUpUrl ? { label: 'Add money', url: e.topUpUrl } : null);
      case 'timeout':
        return new NetworkApiError('provider_timeout', e.message || 'The AI provider did not answer in time.');
      case 'cancelled':
        return new NetworkApiError('provider_error', 'The draft was cancelled.');
      default:
        return new NetworkApiError('provider_error', e.message || 'The AI provider failed.');
    }
  }
  if (e instanceof NetworkApiError) return e;
  return new NetworkApiError('provider_error', 'The AI provider failed.');
}

/** Runs one network route. Returns the JSON response body. */
export async function handleNetworkRoute(name: NetworkRouteName, input: NetworkRouteInput, deps: NetworkRouteDeps): Promise<unknown> {
  const s = deps.service;
  try {
    switch (name) {
      case 'importNetwork': {
        const raw = input.body;
        const decoded = raw instanceof Uint8Array ? decodeCsvBytes(raw) : { text: String(raw ?? ''), warnings: [] as string[] };
        const summary = s.import(decoded.text);
        return { ...summary, warnings: [...decoded.warnings, ...summary.warnings] };
      }
      case 'listContacts': {
        const q = input.query;
        return s.list({
          ...(q.companyKey !== undefined ? { companyKey: q.companyKey } : {}),
          ...(q.stage ? { stage: q.stage as OutreachStage } : {}),
          ...(q.q ? { q: q.q } : {}),
          ...(qBool(q.due) !== undefined ? { due: qBool(q.due)! } : {}),
          ...(qBool(q.inPlan) !== undefined ? { inPlan: qBool(q.inPlan)! } : {}),
          ...(qBool(q.noCompany) ? { noCompany: true } : {}),
          ...(qInt(q.limit) !== undefined ? { limit: qInt(q.limit)! } : {}),
          ...(qInt(q.offset) !== undefined ? { offset: qInt(q.offset)! } : {}),
        });
      }
      case 'networkCoverage':
        return s.coverage(deps.targets());
      case 'rankContacts': {
        const job = jobOrThrow(deps, input.query.jobId);
        return s.rank(String(input.query.companyKey ?? ''), job);
      }
      case 'updateContact': {
        const b = (input.body ?? {}) as { stage?: OutreachStage; note?: string | null; followUpOn?: string | null; inPlan?: boolean };
        return s.update(input.params.contactId!, b);
      }
      case 'deleteContact': {
        if (!s.delete(input.params.contactId!)) throw new NetworkApiError('not_found', 'No such contact.');
        return { ok: true };
      }
      case 'deleteNetwork':
        return { ok: true, deleted: s.deleteAll() };
      case 'networkCompanies':
        return s.companies();
      case 'explainCompanyMatch':
        return s.explain(String(input.query.companyKey ?? ''), input.query.companyName ?? null);
      case 'networkPlan':
        return s.plan();
      case 'planTopContacts': {
        const b = input.body as { companyKey: string; count: number; jobId?: string };
        return s.addTopToPlan(b.companyKey, b.count, jobOrThrow(deps, b.jobId));
      }
      case 'previewDraft': {
        const b = input.body as { variant: DraftVariant; jobId?: string };
        const contact = contactOrThrow(deps, input.params.contactId!);
        const job = jobOrThrow(deps, b.jobId);
        const facts = draftFacts({ contact, job, profileSummary: deps.profileSummary(), variant: b.variant });
        const dest = deps.aiDestination();
        return {
          destination: dest,
          needsConfirmation: !!dest && dest.remote && !s.remoteApproved(dest.label),
          sends: { contact: facts.contact, job: facts.job, aboutMe: facts.aboutMe },
          messages: draftMessages(facts),
          charLimit: facts.charLimit,
        };
      }
      case 'draftOutreach': {
        const b = input.body as { variant: DraftVariant; jobId?: string; template?: boolean; confirmRemote?: boolean };
        const contact = contactOrThrow(deps, input.params.contactId!);
        const job = jobOrThrow(deps, b.jobId);
        const summary = deps.profileSummary();
        if (b.template) return draftFromTemplate({ contact, job, profileSummary: summary, variant: b.variant }) satisfies OutreachDraft;
        const dest = deps.aiDestination();
        if (!dest) throw aiErrorToApi(new AiError('no_provider', 'no provider'));
        if (dest.remote && deps.offline) throw new NetworkApiError('offline', 'jobleft is offline, so a remote AI provider cannot be used. Choose a model on this computer or use the plain template.');
        if (dest.remote && !s.remoteApproved(dest.label)) {
          if (!b.confirmRemote) {
            const facts = draftFacts({ contact, job, profileSummary: summary, variant: b.variant });
            throw new NetworkApiError('conflict', `Before the first draft with ${dest.label}, confirm that it may receive this contact's name, title and company, the job, and a short summary of you. Nothing else is sent.`, {
              needsConfirmation: true, destination: dest, sends: { contact: facts.contact, job: facts.job, aboutMe: facts.aboutMe },
            });
          }
          s.approveRemote(dest.label);
        }
        let ai: AiClient;
        try { ai = deps.ai(); } catch (e) { throw aiErrorToApi(e); }
        try {
          return await draftOutreach({ contact, job, profileSummary: summary, variant: b.variant, ai });
        } catch (e) {
          throw aiErrorToApi(e);
        }
      }
    }
  } catch (e) {
    if (e instanceof NetworkApiError) throw e;
    if (e instanceof NetworkError) throw new NetworkApiError(e.code, e.message);
    if (e instanceof AiError) throw aiErrorToApi(e);
    throw new NetworkApiError('internal', 'Something went wrong in the Network tool.');
  }
  throw new NetworkApiError('not_found', 'No such route.');
}
