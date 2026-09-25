// Route handlers for the routes this lane implements (docs/INTERFACES.md section 6.4, owner "ai-engine"), for apps/server
// to mount behind its security rules (section 6.1), and for the dev server (dev/serve.ts). `createAssistantHandlers`
// returns EVERY ai-engine route: the settings, key, check, models and cancel routes come from `@jobleft/ai-engine`
// unchanged; `chat`, the conversation routes, `decideProposal`, the practice routes and the publik card are this lane's.

import { LOCAL_API, LocalApiError, validate, type ChatRequest } from '@jobleft/contracts';
import { AiError, createAiRouteHandlers, toApiError, type RouteResult } from '@jobleft/ai-engine';
import { ApiFailure, type Assistant } from './assistant.ts';

export interface RouteInput {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
}

export const ASSISTANT_ROUTES = [
  'getAiSettings', 'putAiSettings', 'setAiKey', 'deleteAiKey', 'checkAi', 'listModels', 'chat', 'cancelAi',
  'listChats', 'getChat', 'deleteChat', 'decideProposal', 'startPractice', 'practiceFeedback', 'listPracticeItems',
  'savePracticeItem', 'updatePracticeItem', 'deletePracticeItem', 'getPublik', 'connectPublik', 'disconnectPublik', 'refreshPublik',
] as const;
export type AssistantRouteName = (typeof ASSISTANT_ROUTES)[number];
export type AssistantHandlers = Record<AssistantRouteName, (input: RouteInput) => Promise<RouteResult>>;

function invalid(issues: Array<{ path: string; message: string }>): RouteResult {
  return { status: 400, json: { error: { code: 'bad_request', message: 'The request does not match its contract.', details: issues.slice(0, 10) } } };
}

function checkBody(name: keyof typeof LOCAL_API, body: unknown): RouteResult | null {
  const route = LOCAL_API[name] as { body?: unknown };
  if (!route.body || typeof route.body !== 'object') return null;
  const r = validate(route.body as never, body);
  return r.ok ? null : invalid(r.issues);
}

function failure(e: unknown): RouteResult {
  if (e instanceof ApiFailure) return { status: e.status, json: e.body };
  if (e instanceof LocalApiError) return { status: e.status, json: e.body ?? { error: { code: 'internal', message: 'The app could not read that record.' } } };
  if (e instanceof AiError) { const { status, body } = toApiError(e); return { status, json: body }; }
  return { status: 500, json: { error: { code: 'internal', message: 'Something failed inside jobleft. Nothing was changed.' } } };
}

async function guard(fn: () => Promise<RouteResult>): Promise<RouteResult> {
  try { return await fn(); } catch (e) { return failure(e); }
}

export function createAssistantHandlers(a: Assistant): AssistantHandlers {
  const base = createAiRouteHandlers(a.engine);
  const publik = () => guard(async () => ({ status: 200, json: await a.publikStatus() }));
  return {
    getAiSettings: base.getAiSettings, putAiSettings: base.putAiSettings, setAiKey: base.setAiKey, deleteAiKey: base.deleteAiKey,
    checkAi: base.checkAi, listModels: base.listModels,
    cancelAi: ({ params }) => guard(async () => ({ status: 200, json: { cancelled: a.cancel(String(params.requestId ?? '')) } })),
    chat: ({ body, signal }) => guard(async () => {
      const bad = checkBody('chat', body);
      if (bad) return bad;
      try { a.engine.client(); } catch (e) { if (e instanceof AiError && e.code === 'no_provider') throw e; }
      return { status: 200, sse: a.chatEvents(body as ChatRequest, { signal }) };
    }),
    listChats: () => guard(async () => ({ status: 200, json: a.listChats() })),
    getChat: ({ params }) => guard(async () => ({ status: 200, json: a.getChat(String(params.chatId)) })),
    deleteChat: ({ params }) => guard(async () => { a.deleteChat(String(params.chatId)); return { status: 200, json: { ok: true } }; }),
    decideProposal: ({ params, body }) => guard(async () => {
      const bad = checkBody('decideProposal', body);
      if (bad) return bad;
      return { status: 200, json: await a.decideProposal(String(params.proposalId), (body as { approveActionIds: string[] }).approveActionIds) };
    }),
    startPractice: ({ body }) => guard(async () => {
      const bad = checkBody('startPractice', body);
      if (bad) return bad;
      const b = body as { jobId: string; restart?: boolean };
      return { status: 200, json: await a.startPractice(b.jobId, b.restart === true) };
    }),
    practiceFeedback: ({ body, signal }) => guard(async () => {
      const bad = checkBody('practiceFeedback', body);
      if (bad) return bad;
      return { status: 200, json: await a.practiceFeedback(body as { sessionId: string; questionId: string; answer: string }, signal) };
    }),
    listPracticeItems: ({ query }) => guard(async () => ({ status: 200, json: await a.listPracticeItems(query.jobId || undefined) })),
    savePracticeItem: ({ body }) => guard(async () => {
      const bad = checkBody('savePracticeItem', body);
      if (bad) return bad;
      return { status: 200, json: await a.savePracticeItem(body as Parameters<Assistant['savePracticeItem']>[0]) };
    }),
    updatePracticeItem: ({ params, body }) => guard(async () => {
      const bad = checkBody('updatePracticeItem', body);
      if (bad) return bad;
      return { status: 200, json: a.updatePracticeItem(String(params.itemId), body as Parameters<Assistant['updatePracticeItem']>[1]) };
    }),
    deletePracticeItem: ({ params }) => guard(async () => { a.deletePracticeItem(String(params.itemId)); return { status: 200, json: { ok: true } }; }),
    getPublik: publik,
    refreshPublik: () => guard(async () => { await a.engine.publik.refresh(); return { status: 200, json: await a.publikStatus() }; }),
    connectPublik: async (input) => {
      const r = await base.connectPublik(input);
      return r.status === 200 && 'json' in r ? { status: 200, json: { ...(r.json as object), usage: a.usage.list(), usageTotalMicros: a.usage.totalMicros() } } : r;
    },
    disconnectPublik: async (input) => {
      const r = await base.disconnectPublik(input);
      return r.status === 200 && 'json' in r ? { status: 200, json: { ...(r.json as object), usage: a.usage.list(), usageTotalMicros: a.usage.totalMicros() } } : r;
    },
  };
}
