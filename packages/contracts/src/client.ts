// A small typed client for the LOCAL API, for the UI, the extension and tests. It sends the token in a header
// (never in the URL), sends JSON with content-type application/json, and turns error bodies into LocalApiError.

import { LAUNCH_TOKEN_HEADER, LOCAL_API, PAIRING_TOKEN_HEADER, buildPath, type ApiError, type RouteBody, type RouteName, type RouteResponse, type RouteSpec } from './api.ts';
import { validate } from './validate.ts';

export interface LocalApiClientOptions {
  /** e.g. "http://127.0.0.1:47821" */
  origin: string;
  /** The UI and the shell use the launch token; the extension uses its pairing token. */
  launchToken?: string;
  pairingToken?: string;
  fetchImpl?: typeof fetch;
  /** Check every JSON response against its contract (tests and development). */
  validateResponses?: boolean;
}

export class LocalApiError extends Error {
  readonly status: number;
  readonly body: ApiError | null;
  constructor(status: number, body: ApiError | null) {
    super(body?.error.message ?? `local API answered HTTP ${status}`);
    this.name = 'LocalApiError';
    this.status = status;
    this.body = body;
  }
}

export interface CallInput<K extends RouteName> {
  params?: Record<string, string>;
  query?: Record<string, string | undefined>;
  body?: RouteBody<K>;
  /** Media type of a raw body (for example "application/pdf"). */
  contentType?: string;
  /** File name header for raw uploads. */
  fileName?: string;
  signal?: AbortSignal;
}

export interface LocalApiClient {
  call<K extends RouteName>(name: K, input?: CallInput<K>): Promise<RouteResponse<K>>;
}

export function createLocalApiClient(opts: LocalApiClientOptions): LocalApiClient {
  const f = opts.fetchImpl ?? fetch;
  return {
    async call<K extends RouteName>(name: K, input: CallInput<K> = {}): Promise<RouteResponse<K>> {
      const r = LOCAL_API[name] as RouteSpec;
      const url = new URL(buildPath(r.path, input.params), opts.origin);
      for (const [k, v] of Object.entries(input.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
      const headers: Record<string, string> = { accept: 'application/json' };
      if (opts.launchToken) headers[LAUNCH_TOKEN_HEADER] = opts.launchToken;
      if (opts.pairingToken) headers[PAIRING_TOKEN_HEADER] = opts.pairingToken;
      let body: RequestInit['body'];
      if (input.body !== undefined) {
        if (input.body instanceof Uint8Array) {
          headers['content-type'] = input.contentType ?? 'application/octet-stream';
          if (input.fileName) headers['x-jobleft-filename'] = encodeURIComponent(input.fileName);
          body = input.body as unknown as RequestInit['body'];
        } else {
          headers['content-type'] = 'application/json';
          body = JSON.stringify(input.body);
        }
      }
      const res = await f(url, { method: r.method, headers, body, signal: input.signal });
      if (r.response === 'sse' || r.response === 'file') {
        if (!res.ok) throw new LocalApiError(res.status, await res.json().catch(() => null) as ApiError | null);
        return res as RouteResponse<K>;
      }
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new LocalApiError(res.status, data as ApiError | null);
      if (opts.validateResponses) {
        const v = validate(r.response, data);
        if (!v.ok) throw new Error(`${name}: response does not match its contract: ${JSON.stringify(v.issues.slice(0, 3))}`);
      }
      return data as RouteResponse<K>;
    },
  };
}
