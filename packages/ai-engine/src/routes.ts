// The logic of the local API routes this lane owns (docs/INTERFACES.md section 6.4, owner "ai-engine"), for
// apps/server to mount behind its security rules (section 6.1). The standalone dev server (serve.ts) uses them too.
// Chat history, job context and practice live with the store and the assistant; `chat` here streams one answer.

import type { AiProviderKind, ChatRequest, ChatStreamEvent, OwnKeyVendor } from '@jobleft/contracts';
import { LOCAL_API, validate } from '@jobleft/contracts';
import type { AiEngine } from './engine.ts';
import { AiError, asAiError, toApiError } from './errors.ts';

export type RouteResult =
  | { status: number; json: unknown }
  | { status: 200; sse: AsyncIterable<ChatStreamEvent> };

export interface RouteInput {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
}

export type AiRouteHandlers = Record<
  'getAiSettings' | 'putAiSettings' | 'setAiKey' | 'deleteAiKey' | 'checkAi' | 'listModels' | 'chat' | 'cancelAi'
  | 'getPublik' | 'connectPublik' | 'disconnectPublik' | 'refreshPublik',
  (input: RouteInput) => Promise<RouteResult>
>;

function bad(issues: Array<{ path: string; message: string }>): RouteResult {
  return { status: 400, json: { error: { code: 'bad_request', message: 'The request does not match its contract.', details: issues.slice(0, 10) } } };
}

function checkBody(name: keyof typeof LOCAL_API, body: unknown): RouteResult | null {
  const route = LOCAL_API[name] as { body?: unknown };
  if (!route.body || typeof route.body !== 'object' || !('type' in (route.body as object) || 'anyOf' in (route.body as object))) return null;
  const r = validate(route.body as never, body);
  return r.ok ? null : bad(r.issues);
}

async function guard(fn: () => Promise<RouteResult>): Promise<RouteResult> {
  try {
    return await fn();
  } catch (e) {
    const { status, body } = toApiError(e);
    return { status, json: body };
  }
}

/**
 * The chat stream: start, deltas, then exactly one done or error. A stream cut short ends with done and
 * incomplete: true (the partial text stays). The caller keeps the person's message; nothing here deletes it.
 */
export async function* chatEvents(engine: AiEngine, req: ChatRequest, opts: { signal?: AbortSignal } = {}): AsyncGenerator<ChatStreamEvent> {
  let client;
  try {
    client = engine.client();
  } catch (e) {
    const { body } = toApiError(e);
    yield { type: 'error', error: body.error.link ? { code: body.error.code, message: body.error.message, link: body.error.link } : { code: body.error.code, message: body.error.message } };
    return;
  }
  yield { type: 'start', requestId: req.requestId, provider: client.provider, model: client.model };
  let sent = 0;
  try {
    for await (const c of client.chat({ messages: req.messages, requestId: req.requestId, signal: opts.signal })) {
      if (c.type === 'delta') { sent += c.text.length; yield { type: 'delta', text: c.text }; }
      else if (c.type === 'done') {
        yield { type: 'done', incomplete: c.incomplete, costMicros: c.costMicros, chatId: null };
        return;
      }
    }
    yield { type: 'done', incomplete: true, costMicros: null, chatId: null };
  } catch (e) {
    const err = asAiError(e);
    // Cancelled by the person: never an error. The part already shown (if any) stays, marked incomplete. (Before a
    // first delta the same cancel used to surface as a "provider_error" toast; seen on Windows, where the cancel
    // lands before the first token.)
    if (err.code === 'cancelled') { yield { type: 'done', incomplete: true, costMicros: null, chatId: null }; return; }
    const { body } = toApiError(err);
    yield { type: 'error', error: body.error.link ? { code: body.error.code, message: body.error.message, link: body.error.link } : { code: body.error.code, message: body.error.message } };
  }
}

export function createAiRouteHandlers(engine: AiEngine): AiRouteHandlers {
  return {
    getAiSettings: () => guard(async () => ({ status: 200, json: engine.settings() })),
    putAiSettings: ({ body }) => guard(async () => checkBody('putAiSettings', body) ?? { status: 200, json: await engine.updateSettings(body as never) }),
    setAiKey: ({ body }) => guard(async () => {
      const invalid = checkBody('setAiKey', body);
      if (invalid) return invalid;
      const b = body as { key: string; provider?: AiProviderKind; vendor?: OwnKeyVendor; baseUrl?: string };
      return { status: 200, json: await engine.setKey(b.key, b.provider ? { provider: b.provider, vendor: b.vendor ?? null, baseUrl: b.baseUrl ?? null } : undefined) };
    }),
    deleteAiKey: () => guard(async () => ({ status: 200, json: await engine.deleteKey() })),
    checkAi: () => guard(async () => ({ status: 200, json: await engine.check() })),
    listModels: () => guard(async () => ({ status: 200, json: { models: await engine.listModels() } })),
    chat: ({ body, signal }) => guard(async () => {
      const invalid = checkBody('chat', body);
      if (invalid) return invalid;
      engine.client(); // a missing provider answers 409 needs_provider before the stream starts
      return { status: 200, sse: chatEvents(engine, body as ChatRequest, { signal }) };
    }),
    cancelAi: ({ params }) => guard(async () => ({ status: 200, json: { cancelled: engine.cancel(String(params.requestId ?? '')) } })),
    getPublik: () => guard(async () => ({ status: 200, json: await engine.publik.status() })),
    connectPublik: ({ body }) => guard(async () => {
      const invalid = checkBody('connectPublik', body);
      if (invalid) return invalid;
      const b = body as { disclosureAccepted: true; disclosureVersion: number };
      if (b.disclosureAccepted !== true) throw new AiError('bad_request', 'Accept the publik disclosure first.');
      return { status: 200, json: await engine.publik.connect(b.disclosureVersion) };
    }),
    disconnectPublik: () => guard(async () => ({ status: 200, json: await engine.publik.disconnect() })),
    refreshPublik: () => guard(async () => ({ status: 200, json: await engine.publik.refresh() })),
  };
}
