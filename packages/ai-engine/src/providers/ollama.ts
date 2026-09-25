// Ollama through its native API (/api/tags, /api/show, /api/chat, /api/embed).
// Rules: detect the daemon, list only installed models, NEVER pull a model, and send the `think` option only to
// models whose /api/show capabilities include "thinking" (spike S3: a hard-coded think:true breaks every other model).
// Thinking text (message.thinking) is never shown; only message.content is.

import type { JsonSchema } from '@jobleft/contracts';
import { AiError } from '../errors.ts';
import { classifyHttpFailure } from '../classify.ts';
import { ThinkStripper } from '../thinking.ts';
import { looksLikeHtml, ndjsonLines, send, tryJson, type HttpResponse } from '../transport.ts';
import type { AiChunk, AiMessage, AiRequest, ProviderDriver } from '../types.ts';

export interface OllamaModelInfo {
  capabilities: string[] | null;
  family: string | null;
  /** The longest context the model can read, in tokens (model_info "<arch>.context_length"), or null. */
  contextLength?: number | null;
}

/** Ollama's usual context when none is set. Longer prompts get a larger num_ctx, so Ollama never cuts them silently. */
const DEFAULT_OLLAMA_CTX = 4096;

/** The num_ctx to ask for, or a plain refusal when the text cannot fit the model at all (ai-engine O13). */
export function contextPlan(model: string, promptChars: number, maxTokens: number | undefined, thinking: boolean, info: OllamaModelInfo | null): number | undefined {
  const likely = Math.ceil(promptChars / 4) + 64;        // about 4 characters per token in English
  const generous = Math.ceil(promptChars / 3) + 64;      // room for denser text
  const need = generous + (maxTokens ?? 1024) + (thinking ? 2048 : 0);
  const limit = info?.contextLength ?? null;
  if (limit !== null && likely + 64 > limit) {
    throw new AiError('provider_error', `The text is too long for the model "${model.slice(0, 80)}" (about ${likely.toLocaleString('en-US')} tokens; it reads at most ${limit.toLocaleString('en-US')}). Use a shorter text or a model with a longer context.`);
  }
  if (need <= DEFAULT_OLLAMA_CTX) return undefined;
  let ctx = DEFAULT_OLLAMA_CTX;
  while (ctx < need) ctx *= 2;
  return limit !== null ? Math.min(ctx, limit) : ctx;
}

export interface OllamaDriverOptions {
  model: string;
  /** Daemon address, for example http://127.0.0.1:11434 (no /v1, no /api). */
  base: string;
  key: () => Promise<string | null>;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
}

/** Ollama names without a tag mean ":latest". */
export function sameOllamaModel(a: string, b: string): boolean {
  const n = (s: string) => (s.includes(':') ? s : `${s}:latest`).toLowerCase();
  return n(a) === n(b);
}

/** The think value for a model: none for models without the capability; "low" for gpt-oss (it cannot turn thinking off); false otherwise. */
export function thinkOption(model: string, info: OllamaModelInfo | null): boolean | 'low' | undefined {
  if (!info?.capabilities?.includes('thinking')) return undefined;
  if (/gpt-?oss/i.test(model) || /gptoss/i.test(info.family ?? '')) return 'low';
  return false;
}

function toOllamaMessages(messages: AiMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: m.name };
    if (m.role === 'assistant' && 'toolCalls' in m && m.toolCalls.length > 0) {
      return { role: 'assistant', content: m.content, tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments ?? {} } })) };
    }
    return { role: m.role, content: m.content };
  });
}

export class OllamaDriver implements ProviderDriver {
  readonly provider = 'local' as const;
  readonly model: string;
  private readonly o: OllamaDriverOptions;
  private readonly label: string;
  private infoCache = new Map<string, OllamaModelInfo | null>();

  constructor(o: OllamaDriverOptions) {
    this.o = o;
    this.model = o.model;
    this.label = `Ollama at ${new URL(o.base).origin}`;
  }

  private async headers(): Promise<{ headers: Record<string, string>; keySet: boolean }> {
    const key = await this.o.key();
    return { headers: key ? { authorization: `Bearer ${key}` } : {}, keySet: !!key };
  }

  private fail(res: HttpResponse, raw: string, keySet: boolean, model: string | null): AiError {
    const text = raw.toLowerCase();
    if ((res.status === 404 || res.status === 400) && /not found|try pulling|no such model/.test(text)) {
      return new AiError('model_not_found', `The model "${(model ?? '').slice(0, 80)}" is not installed in Ollama. jobleft never downloads models: install it with "ollama pull", or choose an installed model.`);
    }
    if (res.status === 400 && /does not support (chat|generate)/.test(text)) {
      return new AiError('model_not_found', `The model "${(model ?? '').slice(0, 80)}" cannot chat (it is an embedding model). Choose a chat model.`);
    }
    return classifyHttpFailure(res.status, res.headers['content-type'], raw, { label: this.label, model, keySet });
  }

  /** Model details from /api/show (capabilities and family). null when the daemon does not say. */
  async modelInfo(model: string, signal?: AbortSignal): Promise<OllamaModelInfo | null> {
    if (this.infoCache.has(model)) return this.infoCache.get(model)!;
    const { headers, keySet } = await this.headers();
    const res = await send({ method: 'POST', url: `${this.o.base}/api/show`, headers, body: JSON.stringify({ model }), signal, connectTimeoutMs: this.o.connectTimeoutMs, idleTimeoutMs: 30_000 });
    const raw = await res.text();
    if (res.status >= 400) throw this.fail(res, raw, keySet, model);
    const parsed = tryJson(raw) as Record<string, any> | undefined;
    if (!parsed || typeof parsed !== 'object') {
      throw new AiError('not_ai_server', `${this.label} answered in a form that is not an Ollama answer. Check the address.`);
    }
    const info: OllamaModelInfo = {
      capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities.filter((c: unknown) => typeof c === 'string') : null,
      family: typeof parsed.details?.family === 'string' ? parsed.details.family : null,
      contextLength: null,
    };
    if (parsed.model_info && typeof parsed.model_info === 'object') {
      for (const [k, v] of Object.entries(parsed.model_info as Record<string, unknown>)) {
        if (k.endsWith('.context_length') && typeof v === 'number' && v > 0) info.contextLength = v;
      }
    }
    this.infoCache.set(model, info);
    return info;
  }

  async *stream(req: AiRequest, opts: { json?: JsonSchema; signal: AbortSignal }): AsyncGenerator<AiChunk> {
    const info = await this.modelInfo(this.model, opts.signal);
    if (info?.capabilities && !info.capabilities.includes('completion') && info.capabilities.includes('embedding')) {
      throw new AiError('model_not_found', `The model "${this.model.slice(0, 80)}" only makes embeddings and cannot chat. Choose a chat model.`);
    }
    const think = thinkOption(this.model, info);
    const { headers, keySet } = await this.headers();
    const options: Record<string, number> = {};
    if (req.maxTokens) options.num_predict = think === undefined ? req.maxTokens : req.maxTokens + 4096;
    const promptChars = req.messages.reduce((n, m) => n + m.content.length, 0) + (opts.json ? JSON.stringify(opts.json).length : 0);
    const numCtx = contextPlan(this.model, promptChars, req.maxTokens, think !== undefined, info);
    if (numCtx !== undefined) options.num_ctx = numCtx;
    if (req.temperature !== undefined) options.temperature = req.temperature;
    const body: Record<string, unknown> = { model: this.model, messages: toOllamaMessages(req.messages), stream: true };
    if (Object.keys(options).length) body.options = options;
    if (think !== undefined) body.think = think;
    if (opts.json) body.format = opts.json;
    if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

    const post = () => send({ method: 'POST', url: `${this.o.base}/api/chat`, headers, body: JSON.stringify(body), signal: opts.signal, connectTimeoutMs: this.o.connectTimeoutMs, idleTimeoutMs: this.o.idleTimeoutMs });
    let res = await post();
    if (res.status >= 400) {
      const raw = await res.text();
      // An older Ollama without schema outputs refuses a schema in `format`: ask once more with format "json".
      if (opts.json && res.status === 400 && /format|schema/i.test(raw) && typeof body.format === 'object') {
        body.format = 'json';
        res = await post();
        if (res.status >= 400) throw this.fail(res, await res.text(), keySet, this.model);
      } else {
        throw this.fail(res, raw, keySet, this.model);
      }
    }
    const ct = res.headers['content-type'] ?? '';
    if (/text\/html/i.test(ct)) {
      const raw = await res.text();
      if (looksLikeHtml(ct, raw)) throw new AiError('not_ai_server', `${this.label} answered with a web page, not an AI answer. Check the address.`);
    }

    const stripper = new ThinkStripper();
    let emitted = 0;
    let done = false;
    let doneReason: string | null = null;
    let thinkingSeen = false;
    let toolCalls = 0;
    try {
      for await (const line of ndjsonLines(res.chunks())) {
        const obj = line as Record<string, any>;
        if (!obj || typeof obj !== 'object' || '__bad' in obj) {
          throw new AiError('provider_error', `${this.label} sent a broken answer that jobleft cannot read.`);
        }
        if (typeof obj.error === 'string') {
          throw new AiError('provider_error', `${this.label} reported an error in the middle of the answer.`);
        }
        const msg = obj.message ?? {};
        if (typeof msg.thinking === 'string' && msg.thinking) thinkingSeen = true;
        if (typeof msg.content === 'string' && msg.content) {
          const out = stripper.push(msg.content);
          if (out) { emitted += out.length; yield { type: 'delta', text: out }; }
        }
        if (Array.isArray(msg.tool_calls) && req.tools?.length) {
          for (const tc of msg.tool_calls) {
            const args = tc?.function?.arguments ?? {};
            toolCalls++;
            yield { type: 'tool_call', call: { id: `call_${toolCalls}`, name: String(tc?.function?.name ?? ''), arguments: args, rawArguments: JSON.stringify(args) } };
          }
        }
        if (obj.done === true) { done = true; doneReason = typeof obj.done_reason === 'string' ? obj.done_reason : null; break; }
      }
    } catch (e) {
      const err = e instanceof AiError ? e : new AiError('provider_error', `${this.label} closed the connection in the middle of the answer.`);
      if (err.code === 'cancelled') throw err;
      const tail = stripper.flush();
      if (tail) { emitted += tail.length; yield { type: 'delta', text: tail }; }
      if (emitted > 0) {
        yield { type: 'done', incomplete: true, costMicros: null, reason: { code: err.code, message: `${err.message} The part already shown is incomplete.` } };
        return;
      }
      throw err;
    }
    const tail = stripper.flush();
    if (tail) { emitted += tail.length; yield { type: 'delta', text: tail }; }
    if (!done) {
      if (emitted === 0 && toolCalls === 0) throw new AiError('provider_error', `${this.label} closed the connection before it answered.`);
      yield { type: 'done', incomplete: true, costMicros: null, reason: { code: 'provider_error', message: `${this.label} stopped before the end of the answer. The part already shown is incomplete.` } };
      return;
    }
    if (doneReason === 'length' && (emitted > 0 || toolCalls > 0 || !(thinkingSeen || stripper.dropped > 0))) {
      yield { type: 'done', incomplete: true, costMicros: null, reason: { code: 'bad_answer', message: 'The answer reached the length limit and was cut off. The part already shown is incomplete.' } };
      return;
    }
    if (emitted === 0 && toolCalls === 0) {
      yield {
        type: 'done', incomplete: true, costMicros: null,
        reason: {
          code: 'bad_answer',
          message: thinkingSeen || stripper.dropped > 0
            ? 'The model spent its whole answer on thinking and gave no reply. Try again, or choose a model that does not think first.'
            : 'The AI sent an empty answer. Try again.',
        },
      };
      return;
    }
    yield { type: 'done', incomplete: false, costMicros: null };
  }

  /** Installed models (GET /api/tags). Never pulls. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const { headers, keySet } = await this.headers();
    const res = await send({ method: 'GET', url: `${this.o.base}/api/tags`, headers, signal, connectTimeoutMs: this.o.connectTimeoutMs, idleTimeoutMs: 30_000 });
    const raw = await res.text();
    if (res.status >= 400) throw this.fail(res, raw, keySet, null);
    if (looksLikeHtml(res.headers['content-type'], raw)) {
      throw new AiError('not_ai_server', `${this.label} answered with a web page. This address is not an Ollama server; check the address.`);
    }
    const parsed = tryJson(raw) as Record<string, any> | undefined;
    if (!parsed || !Array.isArray(parsed.models)) {
      throw new AiError('not_ai_server', `${this.label} did not answer like Ollama. Check the address, or choose another kind of local server.`);
    }
    const names = parsed.models
      .map((m: any) => (typeof m?.name === 'string' ? m.name : typeof m?.model === 'string' ? m.model : null))
      .filter((x: unknown): x is string => typeof x === 'string' && x.length > 0);
    return [...new Set<string>(names)];
  }

  async embed(texts: string[], model: string, signal?: AbortSignal): Promise<Float32Array[]> {
    const { headers, keySet } = await this.headers();
    const res = await send({ method: 'POST', url: `${this.o.base}/api/embed`, headers, body: JSON.stringify({ model, input: texts }), signal, connectTimeoutMs: this.o.connectTimeoutMs, idleTimeoutMs: this.o.idleTimeoutMs });
    const raw = await res.text();
    if (res.status >= 400) throw this.fail(res, raw, keySet, model);
    const parsed = tryJson(raw) as Record<string, any> | undefined;
    const list = parsed?.embeddings;
    if (!Array.isArray(list) || list.length !== texts.length) {
      throw new AiError('bad_answer', `${this.label} did not return one embedding per text, so jobleft cannot use the answer.`);
    }
    return list.map((v: unknown) => {
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
        throw new AiError('bad_answer', `${this.label} returned an embedding jobleft cannot read.`);
      }
      return Float32Array.from(v as number[]);
    });
  }

  /** Daemon version (GET /api/version), or null when the address is not Ollama. */
  async version(signal?: AbortSignal): Promise<string | null> {
    const res = await send({ method: 'GET', url: `${this.o.base}/api/version`, signal, connectTimeoutMs: this.o.connectTimeoutMs, idleTimeoutMs: 15_000 });
    const raw = await res.text();
    const parsed = tryJson(raw) as Record<string, any> | undefined;
    return res.status < 400 && typeof parsed?.version === 'string' ? parsed.version : null;
  }
}
