// Anthropic Messages API with the person's OWN API key (never a Claude consumer-subscription sign-in).
// The key goes only to api.anthropic.com (or its loopback stand-in in tests), in the x-api-key header.

import type { JsonSchema } from '@jobleft/contracts';
import { AiError } from '../errors.ts';
import { classifyHttpFailure } from '../classify.ts';
import { ThinkStripper } from '../thinking.ts';
import { looksLikeHtml, send, sseEvents, tryJson, type HttpResponse } from '../transport.ts';
import type { AiChunk, AiMessage, AiRequest, ProviderDriver } from '../types.ts';

export const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicDriverOptions {
  model: string;
  /** API root, https://api.anthropic.com/v1 */
  root: string;
  key: () => Promise<string | null>;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
}

function toAnthropic(messages: AiMessage[]): { system: string | undefined; messages: Record<string, unknown>[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n') || undefined;
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }] });
      continue;
    }
    if (m.role === 'assistant' && 'toolCalls' in m && m.toolCalls.length > 0) {
      const content: Record<string, unknown>[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments ?? {} });
      out.push({ role: 'assistant', content });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return { system, messages: out };
}

export class AnthropicDriver implements ProviderDriver {
  readonly provider = 'own_key' as const;
  readonly model: string;
  private readonly o: AnthropicDriverOptions;
  private readonly label = 'Anthropic';

  constructor(o: AnthropicDriverOptions) {
    this.o = o;
    this.model = o.model;
  }

  private async headers(): Promise<{ headers: Record<string, string>; keySet: boolean }> {
    const key = await this.o.key();
    const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION };
    if (key) headers['x-api-key'] = key;
    return { headers, keySet: !!key };
  }

  private fail(res: HttpResponse, raw: string, keySet: boolean): AiError {
    const body = tryJson(raw) as Record<string, any> | undefined;
    const type = String(body?.error?.type ?? '');
    if (res.status === 404 || (type === 'invalid_request_error' && /model/i.test(String(body?.error?.message ?? '')) && res.status === 400 && /not.?found|invalid model|does not exist/i.test(String(body?.error?.message ?? '')))) {
      return new AiError('model_not_found', `The model "${this.model.slice(0, 80)}" does not exist at Anthropic. Choose one of the models it lists.`);
    }
    if (res.status === 529 || type === 'overloaded_error') {
      return new AiError('provider_error', 'Anthropic is overloaded right now. Wait a minute, then try again.');
    }
    return classifyHttpFailure(res.status, res.headers['content-type'], raw, { label: this.label, model: this.model, keySet });
  }

  async *stream(req: AiRequest, opts: { json?: JsonSchema; signal: AbortSignal }): AsyncGenerator<AiChunk> {
    const { headers, keySet } = await this.headers();
    const { system, messages } = toAnthropic(req.messages);
    const body: Record<string, unknown> = { model: this.model, max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS, messages, stream: true };
    if (system) body.system = system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools?.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    void opts.json; // Structured answers use the instruction in the system message (see structured.ts).

    const res = await send({ method: 'POST', url: `${this.o.root}/messages`, headers, body: JSON.stringify(body), signal: opts.signal, connectTimeoutMs: this.o.connectTimeoutMs, idleTimeoutMs: this.o.idleTimeoutMs });
    if (res.status >= 400) throw this.fail(res, await res.text(), keySet);
    const ct = res.headers['content-type'] ?? '';
    if (!/text\/event-stream/i.test(ct)) {
      const raw = await res.text();
      if (looksLikeHtml(ct, raw)) throw new AiError('not_ai_server', 'The Anthropic address answered with a web page, not an AI answer.');
      throw new AiError('not_ai_server', 'The Anthropic address answered in a form that is not an AI answer.');
    }

    const stripper = new ThinkStripper();
    const blocks = new Map<number, { type: string; id: string; name: string; json: string }>();
    let emitted = 0;
    let stopReason: string | null = null;
    let stopped = false;
    let thinkingSeen = false;
    let toolCalls = 0;
    try {
      for await (const ev of sseEvents(res.chunks())) {
        const obj = tryJson(ev.data) as Record<string, any> | undefined;
        if (!obj || typeof obj !== 'object') throw new AiError('provider_error', 'Anthropic sent a broken answer that jobleft cannot read.');
        const type = obj.type ?? ev.event;
        if (type === 'error') throw new AiError('provider_error', 'Anthropic reported an error in the middle of the answer.');
        if (type === 'content_block_start') {
          const cb = obj.content_block ?? {};
          if (cb.type === 'thinking' || cb.type === 'redacted_thinking') thinkingSeen = true;
          blocks.set(Number(obj.index ?? 0), { type: String(cb.type ?? ''), id: String(cb.id ?? ''), name: String(cb.name ?? ''), json: '' });
        } else if (type === 'content_block_delta') {
          const d = obj.delta ?? {};
          if (d.type === 'text_delta' && typeof d.text === 'string') {
            const out = stripper.push(d.text);
            if (out) { emitted += out.length; yield { type: 'delta', text: out }; }
          } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
            const b = blocks.get(Number(obj.index ?? 0));
            if (b) b.json += d.partial_json;
          } else if (d.type === 'thinking_delta') {
            thinkingSeen = true;
          }
        } else if (type === 'content_block_stop') {
          const b = blocks.get(Number(obj.index ?? 0));
          if (b?.type === 'tool_use' && req.tools?.length) {
            let args: unknown = {};
            if (b.json.trim()) { try { args = JSON.parse(b.json); } catch { args = null; } }
            toolCalls++;
            yield { type: 'tool_call', call: { id: b.id || `call_${toolCalls}`, name: b.name, arguments: args, rawArguments: b.json } };
          }
        } else if (type === 'message_delta') {
          if (obj.delta?.stop_reason) stopReason = String(obj.delta.stop_reason);
        } else if (type === 'message_stop') {
          stopped = true;
          break;
        }
      }
    } catch (e) {
      const err = e instanceof AiError ? e : new AiError('provider_error', 'Anthropic closed the connection in the middle of the answer.');
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
    if (!stopped) {
      if (emitted === 0 && toolCalls === 0) throw new AiError('provider_error', 'Anthropic closed the connection before it answered.');
      yield { type: 'done', incomplete: true, costMicros: null, reason: { code: 'provider_error', message: 'Anthropic stopped before the end of the answer. The part already shown is incomplete.' } };
      return;
    }
    if (stopReason === 'max_tokens' && (emitted > 0 || toolCalls > 0 || !thinkingSeen)) {
      yield { type: 'done', incomplete: true, costMicros: null, reason: { code: 'bad_answer', message: 'The answer reached the length limit and was cut off. The part already shown is incomplete.' } };
      return;
    }
    if (emitted === 0 && toolCalls === 0) {
      yield { type: 'done', incomplete: true, costMicros: null, reason: { code: 'bad_answer', message: thinkingSeen ? 'The model spent its whole answer on thinking and gave no reply. Try again.' : 'The AI sent an empty answer. Try again.' } };
      return;
    }
    yield { type: 'done', incomplete: false, costMicros: null };
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const { headers, keySet } = await this.headers();
    const res = await send({ method: 'GET', url: `${this.o.root}/models?limit=100`, headers, signal, connectTimeoutMs: this.o.connectTimeoutMs, idleTimeoutMs: 30_000 });
    const raw = await res.text();
    if (res.status >= 400) throw this.fail(res, raw, keySet);
    if (looksLikeHtml(res.headers['content-type'], raw)) throw new AiError('not_ai_server', 'The Anthropic address answered with a web page, not a model list.');
    const parsed = tryJson(raw) as Record<string, any> | undefined;
    if (!Array.isArray(parsed?.data)) throw new AiError('not_ai_server', 'The Anthropic address did not answer with a model list.');
    return parsed!.data.map((m: any) => m?.id).filter((x: unknown): x is string => typeof x === 'string' && x.length > 0);
  }

  async embed(): Promise<Float32Array[]> {
    throw new AiError('provider_error', 'Anthropic does not make embeddings. Choose another provider for this step.');
  }
}
