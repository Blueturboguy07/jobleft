// The UI's only door to data: the LOCAL API (createLocalApiClient from @jobleft/contracts), same origin as the page.
// The launch token comes from the URL fragment (#token=...), is removed from the address bar at once, and is kept
// only in memory and sessionStorage (never in a URL or a cookie). Every failure becomes one plain sentence.

import {
  LAUNCH_TOKEN_HEADER, LOCAL_API, LocalApiError, buildPath, createLocalApiClient, type CallInput, type ChatRequest, type ChatStreamEvent,
  type RouteName, type RouteResponse, type RouteSpec,
} from '@jobleft/contracts';
import { takeTokenFromFragment } from '../index.ts';

const TOKEN_KEY = 'jobleft.token';
let token: string | null = null;

function safeSession(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

/** Reads the token once. Returns false when the page was opened without one. */
export function initToken(): boolean {
  const hash = window.location.hash;
  if (/(^#|&)token=/.test(hash)) {
    const t = takeTokenFromFragment(hash);
    token = t.token;
    try { safeSession()?.setItem(TOKEN_KEY, token ?? ''); } catch { /* memory only */ }
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/jobs`);
  } else {
    token = safeSession()?.getItem(TOKEN_KEY) ?? null;
  }
  return !!token;
}

export function hasToken(): boolean {
  return !!token;
}

const client = createLocalApiClient({
  origin: window.location.origin,
  get launchToken() { return token ?? undefined; },
} as Parameters<typeof createLocalApiClient>[0]);

export interface UiError {
  code: string;
  status: number | null;
  message: string;
  link: { label: string; url: string } | null;
  details?: unknown;
}

/** Text from another service must never say "credits" (money is a balance in dollars). */
export function scrub(text: string): string {
  return text.replace(/\bcredits?\b/gi, 'balance');
}

const TECH = /(\{|\}|\bat\s+\S+\s*\(|Error:|\bHTTP\b|ECONN|stack|undefined|null|NaN|\[object)/;

const FRIENDLY: Record<string, string> = {
  unreachable: "jobleft's local service is not answering. Your data is safe on this Mac. Try again in a moment.",
  unauthorized: 'This window has lost its connection to jobleft. Close it and open jobleft again.',
  internal: 'Something went wrong inside jobleft. Nothing was changed. Try again.',
  payload_too_large: 'That is too large. Nothing was stored.',
  rate_limited: 'Too many requests at once. Wait a moment and try again.',
};

export function toUiError(e: unknown): UiError {
  if ((e as UiError)?.code && 'message' in (e as object) && 'link' in (e as object)) return e as UiError;
  if (e instanceof LocalApiError) {
    const b = e.body?.error;
    const code = b?.code ?? (e.status === 401 ? 'unauthorized' : 'internal');
    let message = b?.message ? scrub(b.message) : FRIENDLY[code] ?? FRIENDLY.internal!;
    if (TECH.test(message) && code !== 'bad_request') message = FRIENDLY[code] ?? FRIENDLY.internal!;
    if (code === 'unauthorized') message = FRIENDLY.unauthorized!;
    return { code, status: e.status, message, link: b?.link ?? null, details: b?.details };
  }
  if (e instanceof DOMException && e.name === 'AbortError') return { code: 'cancelled', status: null, message: 'Stopped.', link: null };
  return { code: 'unreachable', status: null, message: FRIENDLY.unreachable!, link: null };
}

export async function call<K extends RouteName>(name: K, input?: CallInput<K>): Promise<RouteResponse<K>> {
  try {
    return await client.call(name, input);
  } catch (e) {
    const err = toUiError(e);
    // a call that cannot reach the local service tells the banner at once (it does not wait for its next check)
    if (err.code === 'unreachable') window.dispatchEvent(new Event('jl-unreachable'));
    throw err;
  }
}

/** Downloads a 'file' route (backup, exports) with the name the server gives. */
export async function download<K extends RouteName>(name: K, input?: CallInput<K>): Promise<string> {
  const res = (await call(name, input)) as unknown as Response;
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const fileName = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'jobleft-download';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return fileName;
}

/** Streams a chat request. Calls onEvent for each ChatStreamEvent. Resolves when the stream ends. */
export async function streamChat(body: ChatRequest, onEvent: (e: ChatStreamEvent) => void, signal: AbortSignal): Promise<void> {
  const r = LOCAL_API.chat as RouteSpec;
  let res: Response;
  try {
    res = await fetch(buildPath(r.path), {
      method: 'POST', signal, body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', [LAUNCH_TOKEN_HEADER]: token ?? '' },
    });
  } catch (e) {
    throw toUiError(e);
  }
  if (!res.ok || !res.body) {
    const b = await res.json().catch(() => null);
    throw toUiError(new LocalApiError(res.status, b));
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let ended = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim()) as ChatStreamEvent;
            if (ev.type === 'done' || ev.type === 'error') ended = true;
            if (ev.type === 'error') ev.error.message = scrub(ev.error.message);
            onEvent(ev);
          } catch { /* skip a broken line */ }
        }
      }
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') { if (!ended) onEvent({ type: 'done', incomplete: true, costMicros: null, chatId: null }); return; }
    throw toUiError(e);
  }
  if (!ended) onEvent({ type: 'done', incomplete: true, costMicros: null, chatId: null });
}

/** Opens a link in the person's browser (the employer's posting, a top-up page). Never inside the app. */
export { openExternal } from '../lib/external.ts';
