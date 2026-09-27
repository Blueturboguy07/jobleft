// The service worker's talk with the app, bound to ONE app: the port the person typed with the pairing code.
// The code goes only to that port, the pairing token goes only to that port, and a port that stops answering gives
// "not running". It never scans other ports: another program there could pose as jobleft and collect the code or
// the token. No chrome.* here: fetch and the pairing store come in, so the tests see every request.

import { HealthSchema, PAIRING_TOKEN_HEADER, PairResponseSchema, validate } from '@jobleft/contracts';
import type { JsonSchema } from '@jobleft/contracts';

export interface Pairing { token: string; port: number; appVersion: string }

export interface AppClientDeps {
  fetch: typeof fetch;
  getPairing(): Promise<Pairing | null>;
  setPairing(p: Pairing | null): Promise<void>;
}

export class AppError extends Error {
  code: 'not_running' | 'unpaired' | 'refused' | 'bad_answer' | 'app_error';
  status: number;
  constructor(code: AppError['code'], message: string, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** The port the person typed, or null. The app can listen on any port of 127.0.0.1. */
export function parsePort(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,5}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 65535 ? n : null;
}

export function notRunningMessage(port: number): string {
  return `The jobleft app does not answer on port ${port}, the port this browser is paired with. Start the app, then try again. If the app now shows another port (Settings, Browser extension), unpair here and pair again with that port.`;
}

function errorMessage(data: unknown): string | null {
  const e = (data as { error?: { message?: unknown } } | null)?.error;
  return typeof e?.message === 'string' ? e.message : null;
}

export interface PairInfo { extensionId: string; extensionVersion: string; protocolVersion: number; browser: string }

export function createAppClient(deps: AppClientDeps) {
  async function request(port: number, path: string, init: { method: string; body?: unknown; token?: string | null; timeoutMs?: number }): Promise<{ status: number; data: unknown }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 8000);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.token) headers[PAIRING_TOKEN_HEADER] = init.token;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    try {
      const res = await deps.fetch(`http://127.0.0.1:${port}${path}`, {
        method: init.method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: ctrl.signal,
        credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      });
      const data: unknown = await res.json().catch(() => null);
      return { status: res.status, data };
    } catch {
      throw new AppError('not_running', notRunningMessage(port));
    } finally {
      clearTimeout(timer);
    }
  }

  /** The app version when a jobleft app answers on this port (no token, no code: health needs neither). */
  async function health(port: number): Promise<string | null> {
    try {
      const r = await request(port, '/api/v1/health', { method: 'GET', timeoutMs: 900 });
      const v = validate(HealthSchema, r.data);
      return r.status === 200 && v.ok ? v.value.version : null;
    } catch {
      return null;
    }
  }

  /** A call with the pairing token, to the paired port only. */
  async function call<T>(path: string, method: string, body: unknown, schema: JsonSchema, timeoutMs = 15000): Promise<T> {
    const p = await deps.getPairing();
    if (!p) throw new AppError('unpaired', 'This browser is not paired with the jobleft app. Pair it first.');
    const res = await request(p.port, path, { method, body, token: p.token, timeoutMs });
    if (res.status === 401) {
      await deps.setPairing(null);
      throw new AppError('unpaired', `The jobleft app on port ${p.port} does not know this browser any more (the pairing was removed). Pair again.`, 401);
    }
    if (res.status === 403) throw new AppError('refused', errorMessage(res.data) ?? 'The jobleft app refused the request.', 403);
    if (res.status < 200 || res.status >= 300) throw new AppError('app_error', errorMessage(res.data) ?? `The jobleft app answered with an error (HTTP ${res.status}).`, res.status);
    const v = validate(schema, res.data);
    if (!v.ok) throw new AppError('bad_answer', 'The jobleft app sent an answer this extension does not understand. Update the app or the extension.');
    return v.value as T;
  }

  /** Pairs with the app on the port the person typed. The code goes to that port and nowhere else. */
  async function pair(code: string, portText: string, info: PairInfo): Promise<{ ok: boolean; message: string }> {
    if (!/^\d{6}$/.test(code)) return { ok: false, message: 'Type the 6 digits the jobleft app shows.' };
    const port = parsePort(portText);
    if (port === null) return { ok: false, message: 'Type the port the jobleft app shows next to the code (Settings, Browser extension), for example 47821.' };
    const version = await health(port);
    if (!version) return { ok: false, message: `No jobleft app answers on port ${port}. Check that the app is running and that the port is the one it shows next to the code. The code was not sent.` };
    let r: { status: number; data: unknown };
    try {
      r = await request(port, '/api/v1/extension/pair', { method: 'POST', body: { code, ...info }, timeoutMs: 8000 });
    } catch {
      return { ok: false, message: `The jobleft app on port ${port} did not answer. Try again.` };
    }
    if (r.status !== 200) return { ok: false, message: errorMessage(r.data) ?? 'The code did not work. Check it, or make a new code in the app.' };
    const v = validate(PairResponseSchema, r.data);
    if (!v.ok) return { ok: false, message: 'The app sent an answer this extension does not understand.' };
    await deps.setPairing({ token: v.value.pairingToken, port, appVersion: v.value.appVersion });
    return { ok: true, message: `Paired with jobleft ${v.value.appVersion} on this computer (port ${port}).` };
  }

  /** Unpairs: tells the paired app (if it answers), then forgets the token either way. */
  async function unpair(): Promise<void> {
    const p = await deps.getPairing();
    if (p) {
      try { await request(p.port, '/api/v1/extension/pairing', { method: 'DELETE', token: p.token, timeoutMs: 3000 }); } catch { /* app closed */ }
    }
    await deps.setPairing(null);
  }

  return { request, health, call, pair, unpair };
}

export type AppClient = ReturnType<typeof createAppClient>;
