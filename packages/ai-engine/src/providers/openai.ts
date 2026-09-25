// OpenAI-compatible chat API: custom addresses, local servers (llama.cpp, MLX, LM Studio, any /v1 server),
// own keys for OpenAI, OpenRouter and Google, and the publik API (which speaks the same dialect).

import type { AiProviderKind, JsonSchema } from '@jobleft/contracts';
import { AiError } from '../errors.ts';
import { classifyHttpFailure } from '../classify.ts';
import { ThinkStripper } from '../thinking.ts';
import { looksLikeHtml, send, sseEvents, tryJson, type HttpResponse } from '../transport.ts';
import type { AiChunk, AiMessage, AiRequest, AiToolCall, ProviderDriver } from '../types.ts';

export interface OpenAiDriverOptions {
  provider: AiProviderKind;
  model: string;
  /** The API root, for example http://127.0.0.1:1234/v1. */
  root: (signal?: AbortSignal) => Promise<string>;
  /** The key for this provider's own address, or null. Read at call time from the secret store. */
  key: () => Promise<string | null>;
  /** Words for messages: "the AI server at http://127.0.0.1:1234", "OpenAI". */
  label: string;
  /** OpenAI's own API wants max_completion_tokens; everything else takes max_tokens. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** Ask for JSON with response_format (json_schema) when a structured answer is wanted. */
  jsonMode?: 'json_schema' | 'json_object' | 'none';
  extraHeaders?: Record<string, string>;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Sees every answer's status and headers (publik reads its x-publik-* headers here). */
  onResponse?: (status: number, headers: Record<string, string>) => void;
  /** A provider-specific reading of a failed answer (publik 402). null = use the general rules. */
  classify?: (status: number, headers: Record<string, string>, raw: string) => AiError | null | Promise<AiError | null>;
  /** Cost of one answer from the response headers (publik), or null. */
  costFromHeaders?: (headers: Record<string, string>) => number | null;
}

type OpenAiMessage = Record<string, unknown>;

export function toOpenAiMessages(messages: AiMessage[]): OpenAiMessage[] {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.role === 'assistant' && 'toolCalls' in m && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArguments } })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

export class OpenAiDriver implements ProviderDriver {
  readonly provider: AiProviderKind;
  readonly model: string;
  private readonly o: OpenAiDriverOptions;

  constructor(o: OpenAiDriverOptions) {
    this.o = o;
    this.provider = o.provider;
    this.model = o.model;
  }

  private async headers(): Promise<{ headers: Record<string, string>; keySet: boolean }> {
    const key = await this.o.key();
    const headers: Record<string, string> = { accept: 'application/json, text/event-stream', ...this.o.extraHeaders };
    if (key) headers.authorization = `Bearer ${key}`;
    return { headers, keySet: !!key };
  }

  private async fail(res: HttpResponse, raw: string, keySet: boolean): Promise<AiError> {
    const special = await this.o.classify?.(res.status, res.headers, raw);
    if (special) return special;
    return classifyHttpFailure(res.status, res.headers['content-type'], raw, { label: this.o.label, model: this.model, keySet });
  }

  async *stream(req: AiRequest, opts: { json?: JsonSchema; signal: AbortSignal }): AsyncGenerator<AiChunk> {
    const root = await this.o.root(opts.signal);
    const { headers, keySet } = await this.headers();
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAiMessages(req.messages),
      stream: true,
    };
    if (req.maxTokens) body[this.o.maxTokensField ?? 'max_tokens'] = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    const jsonMode = this.o.jsonMode ?? 'json_schema';
    if (opts.json && jsonMode === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: 'answer', schema: opts.json, strict: false } };
    if (opts.json && jsonMode === 'json_object') body.response_format = { type: 'json_object' };

    const post = () => send({
      method: 'POST', url: `${root}/chat/completions`, headers, body: JSON.stringify(body), signal: opts.signal,
      connectTimeoutMs: this.o.connectTimeoutMs, idleTimeoutMs: this.o.idleTimeoutMs,
    });
    let res = await post();
    if (res.status >= 400) {
      const raw = await res.text();
      // A server that does not know response_format refuses it with a 400 (nothing was generated or charged):
      // ask once more without it. This is the only second request, and only for this reason.
      if (body.response_format && res.status === 400 && /response_format|json_schema|json_object|grammar|schema/i.test(raw)) {
        delete body.response_format;
        res = await post();
        if (res.status >= 400) throw await this.fail(res, await res.text(), keySet);
      } else {
        throw await this.fail(res, raw, keySet);
      }
    }
    this.o.onResponse?.(res.status, res.headers);
    const cost = this.o.costFromHeaders?.(res.headers) ?? null;
    const ct = res.headers['content-type'] ?? '';

    if (!/text\/event-stream/i.test(ct)) {
      // A server that ignored stream:true (or a stand-in that answers with a page).
      const raw = await res.text();
      if (looksLikeHtml(ct, raw)) throw new AiError('not_ai_server', `${capLabel(this.o.label)} answered with a web page, not an AI answer. This address is not an AI server; check the address.`);
      const parsed = tryJson(raw) as Record<string, any> | undefined;
      const choice = parsed?.choices?.[0];
      if (!choice || typeof choice !== 'object') {
        throw new AiError('not_ai_server', `${capLabel(this.o.label)} answered in a form that is not an AI answer. Check the address.`);
      }
      const stripper = new ThinkStripper();
      const text = stripper.push(String(choice.message?.content ?? '')) + stripper.flush();
      if (text) yield { type: 'delta', text };
      const calls = (choice.message?.tool_calls ?? []) as any[];
      if (req.tools?.length) {
        for (const c of calls) {
          const rawArgs = String(c?.function?.arguments ?? '');
          yield { type: 'tool_call', call: { id: String(c?.id ?? `call_${Math.random().toString(36).slice(2)}`), name: String(c?.function?.name ?? ''), arguments: parseArgs(rawArgs), rawArguments: rawArgs } };
        }
      }
      yield finish(choice.finish_reason, text.length > 0 || calls.length > 0, stripper.dropped > 0, cost);
      return;
    }

    const stripper = new ThinkStripper();
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let emitted = 0;
    let sawDone = false;
    let finishReason: string | null = null;
    let reasoningSeen = false;
    try {
      for await (const ev of sseEvents(res.chunks())) {
        const data = ev.data.trim();
        if (data === '[DONE]') { sawDone = true; break; }
        const obj = tryJson(data) as Record<string, any> | undefined;
        if (obj === undefined || obj === null || typeof obj !== 'object') {
          throw new AiError('provider_error', `${capLabel(this.o.label)} sent a broken answer that jobleft cannot read.`);
        }
        if (obj.error) {
          throw new AiError('provider_error', `${capLabel(this.o.label)} reported an error in the middle of the answer.`);
        }
        const choice = obj.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? choice.message ?? {};
        if (typeof delta.reasoning_content === 'string' || typeof delta.reasoning === 'string') reasoningSeen = true;
        if (typeof delta.content === 'string' && delta.content) {
          const out = stripper.push(delta.content);
          if (out) { emitted += out.length; yield { type: 'delta', text: out }; }
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : calls.size;
            const cur = calls.get(idx) ?? { id: '', name: '', args: '' };
            if (tc.id) cur.id = String(tc.id);
            if (tc.function?.name) cur.name += String(tc.function.name);
            if (tc.function?.arguments) cur.args += String(tc.function.arguments);
            calls.set(idx, cur);
          }
        }
        if (choice.finish_reason) finishReason = String(choice.finish_reason);
      }
    } catch (e) {
      const err = e instanceof AiError ? e : new AiError('provider_error', `${capLabel(this.o.label)} closed the connection in the middle of the answer.`);
      if (err.code === 'cancelled') throw err;
      const tail = stripper.flush();
      if (tail) { emitted += tail.length; yield { type: 'delta', text: tail }; }
      if (emitted > 0) {
        yield { type: 'done', incomplete: true, costMicros: cost, reason: { code: err.code, message: `${err.message} The part already shown is incomplete.` } };
        return;
      }
      throw err;
    }
    const tail = stripper.flush();
    if (tail) { emitted += tail.length; yield { type: 'delta', text: tail }; }
    if (req.tools?.length) {
      for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
        yield { type: 'tool_call', call: { id: c.id || `call_${Math.random().toString(36).slice(2)}`, name: c.name, arguments: parseArgs(c.args), rawArguments: c.args } };
      }
    }
    if (!sawDone && !finishReason) {
      if (emitted === 0 && calls.size === 0) throw new AiError('provider_error', `${capLabel(this.o.label)} closed the connection before it answered.`);
      yield { type: 'done', incomplete: true, costMicros: cost, reason: { code: 'provider_error', message: `${capLabel(this.o.label)} stopped before the end of the answer. The part already shown is incomplete.` } };
      return;
    }
    yield finish(finishReason, emitted > 0 || calls.size > 0, reasoningSeen || stripper.dropped > 0, cost);
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const root = await this.o.root(signal);
    const { headers, keySet } = await this.headers();
    const res = await send({ method: 'GET', url: `${root}/models`, headers, signal, connectTimeoutMs: this.o.connectTimeoutMs, idleTimeoutMs: Math.min(this.o.idleTimeoutMs ?? 30_000, 30_000) });
    const raw = await res.text();
    if (res.status >= 400) throw await this.fail(res, raw, keySet);
    return parseModelList(res.headers['content-type'], raw, this.o.label);
  }

  async embed(texts: string[], model: string, signal?: AbortSignal): Promise<Float32Array[]> {
    const root = await this.o.root(signal);
    const { headers, keySet } = await this.headers();
    const res = await send({ method: 'POST', url: `${root}/embeddings`, headers, body: JSON.stringify({ model, input: texts }), signal, connectTimeoutMs: this.o.connectTimeoutMs, idleTimeoutMs: this.o.idleTimeoutMs });
    const raw = await res.text();
    if (res.status >= 400) throw await this.fail(res, raw, keySet);
    this.o.onResponse?.(res.status, res.headers);
    const parsed = tryJson(raw) as Record<string, any> | undefined;
    const data = parsed?.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new AiError('bad_answer', `${capLabel(this.o.label)} did not return one embedding per text, so jobleft cannot use the answer.`);
    }
    const sorted = [...data].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0));
    return sorted.map((d) => {
      if (!Array.isArray(d?.embedding) || !d.embedding.every((x: unknown) => typeof x === 'number' && Number.isFinite(x))) {
        throw new AiError('bad_answer', `${capLabel(this.o.label)} returned an embedding jobleft cannot read.`);
      }
      return Float32Array.from(d.embedding as number[]);
    });
  }
}

function finish(reason: unknown, gotContent: boolean, thinkingSeen: boolean, cost: number | null): AiChunk {
  const r = typeof reason === 'string' ? reason : null;
  if (r === 'length' || r === 'max_tokens') {
    return { type: 'done', incomplete: true, costMicros: cost, reason: { code: 'bad_answer', message: 'The answer reached the length limit and was cut off. The part already shown is incomplete.' } };
  }
  if (r === 'content_filter') {
    return { type: 'done', incomplete: true, costMicros: cost, reason: { code: 'provider_error', message: 'The provider stopped the answer (content filter). The part already shown is incomplete.' } };
  }
  if (!gotContent) {
    return {
      type: 'done', incomplete: true, costMicros: cost,
      reason: {
        code: 'bad_answer',
        message: thinkingSeen
          ? 'The model spent its whole answer on thinking and gave no reply. Try again, or choose a model that does not think first.'
          : 'The AI sent an empty answer. Try again.',
      },
    };
  }
  return { type: 'done', incomplete: false, costMicros: cost };
}

export function parseModelList(contentType: string | undefined, raw: string, label: string): string[] {
  if (looksLikeHtml(contentType, raw)) {
    throw new AiError('not_ai_server', `${capLabel(label)} answered with a web page, not a model list. This address is not an AI server; check the address.`);
  }
  const parsed = tryJson(raw) as Record<string, any> | undefined;
  const list = Array.isArray(parsed?.data) ? parsed!.data : Array.isArray(parsed?.models) ? parsed!.models : Array.isArray(parsed) ? parsed : null;
  if (!list) throw new AiError('not_ai_server', `${capLabel(label)} did not answer with a model list. This address may not be an AI server; check the address.`);
  const ids = list
    .map((m: any) => (typeof m === 'string' ? m : typeof m?.id === 'string' ? m.id : typeof m?.name === 'string' ? m.name : typeof m?.model === 'string' ? m.model : null))
    .filter((x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 300);
  return [...new Set<string>(ids)];
}

function capLabel(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Finds the API root of an OpenAI-compatible server from the address the person typed: tries ".../v1/models"
 * then ".../models". The first candidate that answers like an API (JSON, or a key refusal) wins; when none does,
 * the first candidate is used and the setup check names the problem. Sends at most two GET requests.
 */
export async function resolveOpenAiRoot(candidates: string[], key: string | null, o: { connectTimeoutMs?: number; signal?: AbortSignal }): Promise<string> {
  if (candidates.length === 1) return candidates[0]!;
  for (const cand of candidates) {
    let res: HttpResponse;
    try {
      res = await send({ method: 'GET', url: `${cand}/models`, headers: key ? { authorization: `Bearer ${key}` } : {}, signal: o.signal, connectTimeoutMs: o.connectTimeoutMs, idleTimeoutMs: 15_000 });
    } catch (e) {
      if (e instanceof AiError && (e.code === 'unreachable' || e.code === 'cancelled')) throw e;
      continue;
    }
    const raw = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) return cand;
    if (res.status < 400 && !looksLikeHtml(res.headers['content-type'], raw) && tryJson(raw) !== undefined) return cand;
  }
  return candidates[0]!;
}

export type { AiToolCall };
