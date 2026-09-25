// An interim AI client for this package's own CLI and dev server, until the server wires @jobleft/ai-engine
// (AiEngine.client()). It speaks the OpenAI chat-completions dialect to ONE address the person chose, and in this
// build that address must be on this computer (127.0.0.1, localhost or ::1): a local model server, a local mock, or
// a local publik stand-in. It never contacts publikhq.com and never falls back to another provider.
// publik money is shown as "balance" in dollars, from the x-publik-* answer headers.

import { AiError, type AiChunk, type AiClient, type AiCompletion, type AiRequest } from '@jobleft/ai-engine';
import type { AiProviderKind, JsonSchema, Infer } from '@jobleft/contracts';
import type { AiDestination } from '../routes.ts';

export type BridgeProvider = 'local' | 'custom' | 'publik';

export interface BridgeConfig {
  provider: BridgeProvider | null;
  /** OpenAI-style base URL ("http://127.0.0.1:11434/v1"); for publik, the publik API base ("http://127.0.0.1:4032/api/v1"). */
  baseUrl: string | null;
  model: string | null;
}

export interface WalletSeen {
  balanceMicros: number | null;
  lastChargeMicros: number | null;
  at: string | null;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Normalises and checks a base URL: http(s), on this computer, trailing slash removed, "/v1" added for OpenAI-style servers. */
export function normalizeBaseUrl(raw: string, provider: BridgeProvider): string {
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  let u: URL;
  try { u = new URL(s); } catch { throw new AiError('provider_error', `"${raw}" is not a web address.`); }
  if (!LOOPBACK.has(u.hostname)) {
    throw new AiError('provider_error', 'This build of the Network tool talks only to AI servers on this computer (127.0.0.1 or localhost). Other addresses come with the app\'s AI settings.');
  }
  let path = u.pathname.replace(/\/+$/, '');
  if (provider !== 'publik' && !/\/v\d+$/.test(path)) path += '/v1';
  return `${u.protocol}//${u.host}${path}`;
}

export function bridgeDestination(cfg: BridgeConfig): AiDestination | null {
  if (!cfg.provider || !cfg.baseUrl) return null;
  const host = (() => { try { return new URL(cfg.baseUrl!).host; } catch { return cfg.baseUrl!; } })();
  if (cfg.provider === 'local') return { provider: 'local', label: `the model on this computer at ${host}`, remote: false };
  if (cfg.provider === 'publik') return { provider: 'publik', label: `publik (stand-in at ${host})`, remote: true };
  return { provider: 'custom', label: `the AI server at ${host}`, remote: true };
}

function int(v: string | null): number | null {
  if (v === null || !/^-?\d+$/.test(v.trim())) return null;
  return Number(v);
}

export interface BridgeOptions {
  fetchImpl?: typeof fetch;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** Called with the wallet facts from a publik answer. */
  onWallet?: (w: WalletSeen) => void;
}

/** The interim client. Throws AiError('no_provider') when no provider is chosen. */
export function createBridgeClient(cfg: BridgeConfig, opts: BridgeOptions = {}): AiClient {
  if (!cfg.provider || !cfg.baseUrl) throw new AiError('no_provider', 'No AI provider is set up.');
  const provider = cfg.provider;
  const base = normalizeBaseUrl(cfg.baseUrl, provider);
  let model = cfg.model || (provider === 'publik' ? 'publik-balanced' : '');
  const doFetch = opts.fetchImpl ?? fetch;
  const origin = new URL(base).host;

  async function call(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const ctl = new AbortController();
    const total = setTimeout(() => ctl.abort(new Error('timeout')), opts.totalTimeoutMs ?? 90_000);
    const onAbort = () => ctl.abort(new Error('cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await doFetch(`${base}${path}`, { ...init, signal: ctl.signal, redirect: 'manual' });
    } catch (e) {
      if (signal?.aborted) throw new AiError('cancelled', 'The draft was cancelled.');
      const msg = String((e as Error)?.message ?? e);
      if (ctl.signal.aborted) throw new AiError('timeout', `The AI server at ${origin} did not answer in time.`);
      if (/ECONNREFUSED|fetch failed|ENOTFOUND|EHOSTUNREACH|ECONNRESET/i.test(msg + String((e as { cause?: unknown }).cause ?? ''))) {
        throw new AiError('unreachable', `Nothing answers at ${origin}. Start the AI server there, or choose another provider.`);
      }
      throw new AiError('provider_error', `The AI server at ${origin} failed: ${msg.slice(0, 120)}`);
    } finally {
      clearTimeout(total);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** No model chosen: use the server's only model, or name the choices. Never a guess among several. */
  async function ensureModel(signal?: AbortSignal): Promise<void> {
    if (model) return;
    const res = await call('/models', { method: 'GET', headers: { accept: 'application/json' } }, signal);
    const body = res.ok ? await res.json().catch(() => null) as { data?: Array<{ id?: string }> } | null : null;
    const ids = (body?.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean);
    if (ids.length === 1) { model = ids[0]!; return; }
    throw new AiError('model_not_found', ids.length
      ? `Choose a model (ai use ... --model <name>). The server at ${origin} has: ${ids.slice(0, 12).join(', ')}.`
      : `Choose a model (ai use ... --model <name>). The server at ${origin} lists none.`);
  }

  async function complete(req: AiRequest): Promise<AiCompletion> {
    await ensureModel(req.signal);
    const res = await call('/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ model, messages: req.messages, max_tokens: req.maxTokens ?? 400, temperature: 0.3, stream: false }),
    }, req.signal);
    const balance = int(res.headers.get('x-publik-balance') ?? res.headers.get('x-publik-balance-micros'));
    const charge = int(res.headers.get('x-publik-charge-micros'));
    if (provider === 'publik' && (balance !== null || charge !== null)) {
      opts.onWallet?.({ balanceMicros: balance, lastChargeMicros: charge, at: new Date().toISOString() });
    }
    const text = await res.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* handled below */ }
    if (res.status === 402) {
      const b = (body as { error?: { add_credit_url?: string; top_up_url?: string; link?: string } } | null)?.error;
      const url = b?.top_up_url ?? b?.add_credit_url ?? b?.link ?? null;
      const left = balance !== null ? ` (${(Math.max(0, balance) / 1e6).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} left)` : '';
      throw new AiError('insufficient_balance', `Your publik balance ran out${left}. Add money, then draft again.`, url && /^https?:\/\//.test(url) ? url : null);
    }
    if (res.status === 401 || res.status === 403) throw new AiError('key_refused', `The AI server at ${origin} refused the request (${res.status}).`);
    if (res.status === 404) throw new AiError('model_not_found', `The AI server at ${origin} has no model "${model}".`);
    if (res.status >= 400) throw new AiError('provider_error', `The AI server at ${origin} answered ${res.status}.`);
    const choice = (body as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>; model?: string } | null)?.choices?.[0];
    if (!body || !choice || typeof choice.message?.content !== 'string') {
      throw new AiError('not_ai_server', `The server at ${origin} did not answer like an AI server.`);
    }
    return {
      text: choice.message.content,
      incomplete: choice.finish_reason === 'length',
      costMicros: charge,
      model: String((body as { model?: string }).model ?? model),
    };
  }

  return {
    provider: provider as AiProviderKind,
    get model() { return model || '(server default)'; },
    complete,
    async *chat(req: AiRequest): AsyncIterable<AiChunk> {
      const c = await complete(req);
      yield { type: 'delta', text: c.text };
      yield { type: 'done', incomplete: c.incomplete, costMicros: c.costMicros };
    },
    async json<S extends JsonSchema>(_req: AiRequest & { schema: S }): Promise<Infer<S>> {
      throw new AiError('provider_error', 'Structured answers are not part of the Network tool.');
    },
    async listModels(): Promise<string[]> {
      const res = await call('/models', { method: 'GET', headers: { accept: 'application/json' } });
      if (!res.ok) return [];
      const body = await res.json().catch(() => null) as { data?: Array<{ id?: string }> } | null;
      return (body?.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean);
    },
  };
}
