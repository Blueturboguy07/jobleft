// The mock's AI client: calls ONLY the provider the person chose (never a silent fallback), with time limits, and
// turns every failure into one plain sentence. The real one is @jobleft/ai-engine.
//   publik  -> the loopback publik stand-in (JOBLEFT_PUBLIK_BASE_URL, default http://127.0.0.1:47910/api/v1)
//   local   -> an OpenAI-compatible server on this computer (the AI stand-in is http://127.0.0.1:47911/v1)
//   custom  -> any OpenAI-compatible URL the person typed (the mock refuses non-loopback URLs: no live calls)
//   own_key -> refused in the mock: it never calls a real AI vendor

import type { MockState } from './state.ts';
import { PORTS } from './util.ts';

export class ApiFail extends Error {
  readonly code: string;
  readonly status: number;
  readonly link: { label: string; url: string } | null;
  constructor(code: string, status: number, message: string, link: { label: string; url: string } | null = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.link = link;
  }
}

export function publikBase(): string {
  return process.env.JOBLEFT_PUBLIK_BASE_URL ?? `http://127.0.0.1:${PORTS.publik}/api/v1`;
}

export function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
  } catch {
    return false;
  }
}

/**
 * true only when the "offline" switch is on (node mock/ctl.ts offline on). Everything the mock talks to lives on
 * this computer (127.0.0.1), so a computer with no network at all still runs the whole demo.
 */
export function isOffline(state: MockState): boolean {
  return state.offlineSwitch;
}

/** Removes the word "credit(s)" from text that came from another service (the app says "balance", never "credits"). */
export function scrubCredits(text: string): string {
  return text.replace(/\bcredits?\b/gi, 'balance');
}

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Target {
  kind: 'publik' | 'local' | 'custom';
  baseUrl: string;
  key: string | null;
  model: string;
  /** A plain name of where the text goes, for errors. */
  label: string;
}

export function targetFor(state: MockState): Target {
  const s = state.data.ai;
  if (!s.provider) throw new ApiFail('needs_provider', 409, 'Choose an AI provider in Settings first. You can use a model on this computer, the publik API or your own key.');
  if (s.provider === 'publik') {
    if (state.data.publik.state !== 'connected' || !state.data.publik.key) throw new ApiFail('needs_provider', 409, 'Connect to publik in Settings, or choose another AI provider.');
    return { kind: 'publik', baseUrl: publikBase(), key: state.data.publik.key, model: s.model ?? 'publik-balanced', label: 'publik' };
  }
  if (s.provider === 'own_key') throw new ApiFail('provider_error', 502, 'This test build does not call real AI vendors. Choose a model on this computer or the publik stand-in in Settings.');
  if (!s.baseUrl) throw new ApiFail('needs_provider', 409, 'Add the address of your AI server in Settings.');
  if (s.provider === 'custom' && !isLoopback(s.baseUrl)) throw new ApiFail('provider_error', 502, 'This test build only calls AI servers on this computer (127.0.0.1). Use the AI stand-in address from the README.');
  const host = new URL(s.baseUrl).host;
  return { kind: s.provider, baseUrl: s.baseUrl.replace(/\/+$/, ''), key: state.secrets.get('ai') ?? null, model: s.model ?? 'jobleft-standin-7b', label: s.provider === 'local' ? `the model on this computer at ${host}` : `the AI server at ${host}` };
}

function netFail(t: Target, err: unknown): ApiFail {
  const name = (err as Error)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return new ApiFail('provider_timeout', 504, `${cap(t.label)} did not answer in time. Try again in a moment.`);
  return new ApiFail('provider_error', 502, `${cap(t.label)} did not answer. Check that it is running, then try again.`);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function failFromResponse(t: Target, res: Response): Promise<ApiFail> {
  type ErrBody = { error?: { code?: string; message?: string; link?: { label: string; url: string } } };
  let body: ErrBody | null = null;
  try { body = (await res.json()) as ErrBody; } catch { body = null; }
  if (res.status === 402) {
    const link = body?.error?.link ?? null;
    return new ApiFail('insufficient_balance', 402, 'Your publik balance is too low for this step, so nothing was charged. Add money to your balance to continue.', link ?? { label: 'Add money to your balance', url: 'https://publik.invalid/top-up' });
  }
  if (res.status === 401 || res.status === 403) return new ApiFail('provider_error', 502, `${cap(t.label)} refused the key. Check the key in Settings.`);
  if (res.status === 404) return new ApiFail('provider_error', 502, `${cap(t.label)} does not know the model "${t.model}". Pick another model in Settings.`);
  return new ApiFail('provider_error', 502, `${cap(t.label)} had a problem (${scrubCredits(body?.error?.message ?? 'no details')}). Try again.`);
}

export interface Completion {
  text: string;
  costMicros: number | null;
  model: string;
}

function headers(t: Target): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (t.key) h.authorization = `Bearer ${t.key}`;
  return h;
}

function checkReach(state: MockState, t: Target): void {
  if (!isLoopback(t.baseUrl) && isOffline(state)) throw new ApiFail('offline', 503, 'This computer is offline, so the AI step could not start. Your data is safe; try again when you are back online.');
  if (t.kind === 'publik' && isOffline(state)) throw new ApiFail('offline', 503, 'This computer is offline, so publik cannot be reached. Try again when you are back online, or use a model on this computer.');
}

export async function complete(state: MockState, messages: ChatMsg[], task: string): Promise<Completion> {
  const t = targetFor(state);
  checkReach(state, t);
  let res: Response;
  try {
    res = await fetch(`${t.baseUrl}/chat/completions`, {
      method: 'POST', headers: headers(t), signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ model: t.model, messages: [{ role: 'system', content: `task: ${task}` }, ...messages], stream: false }),
    });
  } catch (err) { throw netFail(t, err); }
  if (!res.ok) throw await failFromResponse(t, res);
  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }>; model?: string };
  const charge = res.headers.get('x-publik-charge-micros');
  return { text: json.choices?.[0]?.message?.content ?? '', costMicros: charge ? Number(charge) : null, model: json.model ?? t.model };
}

/** Streams deltas. Calls onDelta for each piece; resolves with the cost when the stream ends. */
export async function stream(state: MockState, messages: ChatMsg[], task: string, signal: AbortSignal, onDelta: (s: string) => void): Promise<{ costMicros: number | null; incomplete: boolean; model: string; provider: Target['kind'] }> {
  const t = targetFor(state);
  checkReach(state, t);
  let res: Response;
  try {
    res = await fetch(`${t.baseUrl}/chat/completions`, {
      method: 'POST', headers: headers(t), signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      body: JSON.stringify({ model: t.model, messages: [{ role: 'system', content: `task: ${task}` }, ...messages], stream: true }),
    });
  } catch (err) { throw netFail(t, err); }
  if (!res.ok || !res.body) throw await failFromResponse(t, res);
  const charge = res.headers.get('x-publik-charge-micros');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let done = false;
  try {
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { done = true; continue; }
        try {
          const j = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
          const d = j.choices?.[0]?.delta?.content;
          if (d) onDelta(d);
        } catch { /* skip a bad line */ }
      }
    }
  } catch {
    return { costMicros: charge ? Number(charge) : null, incomplete: true, model: t.model, provider: t.kind };
  }
  return { costMicros: charge ? Number(charge) : null, incomplete: !done, model: t.model, provider: t.kind };
}

export async function listModels(state: MockState): Promise<string[]> {
  const t = targetFor(state);
  checkReach(state, t);
  let res: Response;
  try {
    res = await fetch(`${t.baseUrl}/models`, { headers: headers(t), signal: AbortSignal.timeout(10_000) });
  } catch (err) { throw netFail(t, err); }
  if (!res.ok) throw await failFromResponse(t, res);
  const j = await res.json() as { data?: Array<{ id: string }> };
  return (j.data ?? []).map((m) => m.id);
}
