// A minimal OpenAI-compatible AiClient for the resume CLI, used until the ai-engine lane's AiEngine is wired in.
// It implements the @jobleft/ai-engine AiClient interface, so the resume code cannot tell the difference.
// Rules kept here: the chosen provider only (no fallback), no retry (one charge per step), every call ends
// (10 s to connect, a total time limit), a key goes only to its own provider in a header, and error messages never
// quote the prompt or the answer. publik money is read from the x-publik-* headers and shown as "balance".

import type { AiChunk, AiClient, AiCompletion, AiRequest } from '@jobleft/ai-engine';
import { AiError } from '@jobleft/ai-engine';
import type { AiProviderKind, Infer, JsonSchema } from '@jobleft/contracts';
import { validate } from '@jobleft/contracts';

export interface HttpAiOptions {
  provider: AiProviderKind;
  baseUrl: string;
  model: string;
  key: string | null;
  /** Total time for one answer (default 120 s). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopback(url: string): boolean {
  try { return LOOPBACK.has(new URL(url).hostname); } catch { return false; }
}

/** Checks a provider address before anything is sent (resume O13: a local model means nothing leaves the laptop). */
export function checkProviderUrl(provider: AiProviderKind, url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return 'The provider address is not a valid URL.'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'The provider address must start with http:// or https://.';
  if (/(^|\.)publikhq\.com$/i.test(u.hostname)) return 'This build of the resume tools does not call publikhq.com. Point the publik provider at a local stand-in (http://127.0.0.1:<port>/api/v1).';
  if (provider === 'local' && !isLoopback(url)) return 'A local model must run on this computer (127.0.0.1 or localhost).';
  if (provider === 'publik' && !isLoopback(url)) return 'In this build the publik provider must be a local stand-in on 127.0.0.1.';
  return null;
}

export class HttpAiClient implements AiClient {
  readonly provider: AiProviderKind;
  readonly model: string;
  readonly #base: string;
  readonly #key: string | null;
  readonly #timeout: number;
  readonly #fetch: typeof fetch;
  /** Last balance the publik stand-in reported (micros), or null. */
  lastBalanceMicros: number | null = null;
  lastChargeMicros: number | null = null;
  topUpUrl: string | null = null;

  constructor(o: HttpAiOptions) {
    const problem = checkProviderUrl(o.provider, o.baseUrl);
    if (problem) throw new AiError('not_ai_server', problem);
    this.provider = o.provider;
    this.model = o.model;
    this.#base = o.baseUrl.replace(/\/+$/, '');
    this.#key = o.key;
    this.#timeout = o.timeoutMs ?? 120_000;
    this.#fetch = o.fetchImpl ?? fetch;
  }

  #headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.#key) h.authorization = `Bearer ${this.#key}`;
    return h;
  }

  async #post(path: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; headers: Headers; json: unknown | null }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), this.#timeout);
    const onAbort = () => ctrl.abort(new Error('cancelled'));
    signal?.addEventListener('abort', onAbort);
    try {
      let res: Response;
      try {
        res = await this.#fetch(this.#base + path, { method: 'POST', headers: this.#headers(), body: JSON.stringify(body), signal: ctrl.signal, redirect: 'error' });
      } catch {
        if (ctrl.signal.aborted) {
          const why = String((ctrl.signal.reason as Error | undefined)?.message ?? '');
          throw why === 'cancelled' ? new AiError('cancelled', 'The request was cancelled.') : new AiError('timeout', `The AI provider did not answer within ${Math.round(this.#timeout / 1000)} seconds.`);
        }
        throw new AiError('unreachable', 'The AI provider could not be reached.');
      }
      let text = '';
      try { text = await res.text(); } catch {
        if (ctrl.signal.aborted) throw new AiError('timeout', `The AI provider did not answer within ${Math.round(this.#timeout / 1000)} seconds.`);
        throw new AiError('provider_error', 'The AI provider stopped in the middle of its answer.');
      }
      let json: unknown | null = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: res.status, headers: res.headers, json };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  #observe(h: Headers): void {
    const bal = h.get('x-publik-balance');
    const charge = h.get('x-publik-charge-micros');
    if (bal !== null && /^-?\d+$/.test(bal)) this.lastBalanceMicros = Number(bal);
    this.lastChargeMicros = charge !== null && /^\d+$/.test(charge) ? Number(charge) : null;
  }

  async complete(req: AiRequest): Promise<AiCompletion> {
    const { status, headers, json } = await this.#post('/chat/completions', {
      model: this.model, messages: req.messages, max_tokens: req.maxTokens ?? 900, temperature: 0.2, stream: false,
    }, req.signal);
    this.#observe(headers);
    const err = (json as { error?: { code?: string; message?: string; link?: string; top_up_url?: string } } | null)?.error;
    if (status === 402) {
      this.topUpUrl = err?.link ?? err?.top_up_url ?? null;
      throw new AiError('insufficient_balance', 'Your publik balance ran out.', this.topUpUrl);
    }
    if (status === 401 || status === 403) throw new AiError('key_refused', 'The AI provider refused the key.');
    if (status === 404) throw new AiError(json ? 'model_not_found' : 'not_ai_server', json ? 'The AI provider does not have this model.' : 'The address is not an AI server.');
    if (status === 408 || status === 504) throw new AiError('timeout', 'The AI provider timed out.');
    if (status >= 400) throw new AiError('provider_error', `The AI provider answered with an error (HTTP ${status}).`);
    const choice = (json as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }> } | null)?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string') throw new AiError('bad_answer', 'The AI answer was not in the expected form.');
    const usageCost = (json as { usage?: { cost_micros?: number } } | null)?.usage?.cost_micros;
    const costMicros = this.lastChargeMicros ?? (typeof usageCost === 'number' ? usageCost : null);
    return { text: content, incomplete: choice?.finish_reason === 'length', costMicros: this.provider === 'publik' ? costMicros ?? 0 : costMicros, model: this.model };
  }

  async *chat(req: AiRequest): AsyncIterable<AiChunk> {
    const r = await this.complete(req);
    yield { type: 'delta', text: r.text };
    yield { type: 'done', incomplete: r.incomplete, costMicros: r.costMicros };
  }

  async json<S extends JsonSchema>(req: AiRequest & { schema: S; lineFallback?: (text: string) => Infer<S> | null }): Promise<Infer<S>> {
    const r = await this.complete(req);
    const m = /\{[\s\S]*\}|\[[\s\S]*\]/.exec(r.text);
    if (m) {
      try {
        const v = validate(req.schema, JSON.parse(m[0]));
        if (v.ok) return v.value as Infer<S>;
      } catch { /* fall through */ }
    }
    const fb = req.lineFallback?.(r.text) ?? null;
    if (fb !== null) return fb;
    throw new AiError('bad_answer', 'The AI answer was not in the expected form.');
  }

  async listModels(): Promise<string[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await this.#fetch(`${this.#base}/models`, { headers: this.#headers(), signal: ctrl.signal, redirect: 'error' });
      const j = await res.json() as { data?: Array<{ id?: string }> };
      return (j.data ?? []).map((d) => d.id).filter((x): x is string => typeof x === 'string');
    } catch {
      throw new AiError('unreachable', 'The AI provider could not be reached.');
    } finally {
      clearTimeout(timer);
    }
  }
}
