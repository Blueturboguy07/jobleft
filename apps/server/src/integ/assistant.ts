// i-ai (single builder): the real @jobleft/assistant in the server. The assistant reads and changes the person's records
// only through the documented local API, so it gets an IN-PROCESS client that runs the same route handlers the HTTP
// server runs (same contract checks, same errors), with no network hop and no token. The chat, conversation and
// practice routes are served by the assistant's own handlers (docs/INTERFACES.md, section "@jobleft/assistant").
import { LOCAL_API, LocalApiError, validate, type ApiError, type ChatStreamEvent, type RouteName } from '@jobleft/contracts';
import { Assistant, createAssistantHandlers, migrateAssistant, type AssistantHandlers, type AssistantRouteName } from '@jobleft/assistant';
import type { DatabaseSync } from 'node:sqlite';
import type { App, AppData } from '../app.ts';
import { ApiFailure } from '../errors.ts';
import { apiFailureOf } from './engine.ts';
import { HANDLERS, type Ctx, type Out } from '../routes.ts';

type DataApi = ConstructorParameters<typeof Assistant>[0]['api'];

/** Runs one route handler in process, the way the HTTP server would, and answers like the HTTP client would. */
export function inProcessApi(app: App, d: AppData): DataApi {
  return {
    async call(name: RouteName, input: { params?: Record<string, string>; query?: Record<string, string | undefined>; body?: unknown; contentType?: string; fileName?: string } = {}) {
      const spec = LOCAL_API[name] as { body?: unknown; query?: unknown; response?: unknown };
      const query: Record<string, string> = {};
      for (const [k, v] of Object.entries(input.query ?? {})) if (v !== undefined) query[k] = String(v);
      if (spec.query) {
        const v = validate(spec.query as never, query);
        if (!v.ok) throw new LocalApiError(400, { error: { code: 'bad_request', message: 'The query does not match what this request expects.', details: { issues: v.issues } } });
      }
      if (spec.body && typeof spec.body === 'object' && !(input.body instanceof Uint8Array)) {
        const v = validate(spec.body as never, input.body);
        if (!v.ok) throw new LocalApiError(400, { error: { code: 'bad_request', message: 'The request does not match its contract.', details: { issues: v.issues } } });
      }
      const gone = new AbortController();
      const ctx = {
        app, d, params: input.params ?? {}, query, body: input.body, req: undefined, res: undefined, extensionId: null,
        contentType: input.contentType ?? (input.body !== undefined ? 'application/json' : null), fileName: input.fileName ?? null, gone: gone.signal,
      } as unknown as Ctx<RouteName>;
      let out: Out;
      try {
        out = await (HANDLERS[name] as (c: Ctx<RouteName>) => Out | Promise<Out>)(ctx);
      } catch (e) {
        if (e instanceof ApiFailure) {
          const body: ApiError = { error: { code: e.code, message: e.message, ...(e.extra.details !== undefined ? { details: e.extra.details } : {}), ...(e.extra.link ? { link: e.extra.link } : {}) } } as ApiError;
          throw new LocalApiError(e.status, body);
        }
        throw new LocalApiError(500, { error: { code: 'internal', message: 'Something went wrong inside jobleft.' } });
      }
      if ('json' in out) {
        if ((out.status ?? 200) >= 400) throw new LocalApiError(out.status ?? 500, out.json as ApiError);
        return out.json as never;
      }
      if ('file' in out) return { fileName: out.file.fileName, mimeType: out.file.mimeType, bytes: out.file.bytes?.byteLength ?? 0 } as never;
      throw new LocalApiError(400, { error: { code: 'bad_request', message: 'That route streams; the assistant does not read streams.' } });
    },
  } as DataApi;
}

/** Builds the assistant once for a data folder. Its tables (owner "ai-engine") live in the app database. */
export function buildAssistant(app: App, d: AppData, db: DatabaseSync): Assistant {
  migrateAssistant(db);
  return new Assistant({ engine: d.ai.engine, api: inProcessApi(app, d), db, env: app.cfg.env ?? process.env });
}

/** Serves one assistant route through the assistant's own handler, turned into the server's answer. */
export async function assistantRoute<K extends AssistantRouteName>(c: Ctx<RouteName>, name: K): Promise<Out> {
  const a = c.d.assistant(c.app);
  // Everything that can fail before a stream starts (no provider, offline mode, a bad address) answers as JSON here,
  // so the person sees a plain error with its status instead of a stream that only carries an error event.
  if (name === 'chat') { try { a.engine.client(); } catch (e) { throw apiFailureOf(e); } }
  // JL-settings-8: publik states the charge of a streamed answer only in the balance, so the answer's done event gets
  // the balance drop, read after the answer (never an estimate; unknown stays null).
  const before = name === 'chat' ? await c.d.ai.publikBalance() : null;
  const handlers: AssistantHandlers = createAssistantHandlers(a);
  const r = await handlers[name]({ params: c.params, query: (c.query ?? {}) as unknown as Record<string, string>, body: c.body, signal: c.gone });
  if ('sse' in r) {
    const events = r.sse;
    return {
      sse: async (send: (e: ChatStreamEvent) => boolean) => {
        for await (const e of events) {
          // A paid answer's balance is read again in the background once it ends. Wait for that before "done", so the
          // balance chip, which re-reads on "done", shows the balance after the charge (JL-tracker-14).
          if (e.type === 'done') { try { await a.engine.idle(); } catch { /* the balance keeps its last value */ } }
          const out = e.type === 'done' && (e.costMicros === null || e.costMicros === undefined) && before !== null
            ? { ...e, costMicros: await c.d.ai.chargeSince(before) } : e;
          if (!send(out)) break;
        }
      },
    };
  }
  if (r.status >= 400) {
    const err = (r.json as { error?: { code?: string; message?: string; details?: unknown; link?: unknown } }).error ?? {};
    throw new ApiFailure((err.code ?? 'internal') as ApiFailure['code'], err.message ?? 'The assistant failed.', {
      ...(err.details !== undefined ? { details: err.details } : {}), ...(err.link ? { link: err.link as { label: string; url: string } } : {}),
    });
  }
  return { json: r.json, status: r.status };
}
