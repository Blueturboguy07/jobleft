// Builds the one AiClient from a provider driver: streaming chat, whole answers, structured answers and embeddings.
// Every call is registered so it can be cancelled by id, and every call ends (the transport's limits).

import type { Infer, JsonSchema } from '@jobleft/contracts';
import { AiError } from './errors.ts';
import { readStructured, withJsonInstruction } from './structured.ts';
import type { AiChunk, AiClient, AiCompletion, AiRequest, AiToolCall, JsonRequest, ProviderDriver } from './types.ts';

export interface ClientHooks {
  /** Registers a running request. `signal` aborts the upstream call; `end` must be called when it stops. */
  begin(req: AiRequest): { signal: AbortSignal; end(): void };
  /** Runs after each finished call (publik re-reads the balance here). */
  after?(): void;
  /** Checked before each call (the provider may have been disconnected since the client was made). */
  guard?(): Promise<void>;
}

export function makeClient(driver: ProviderDriver, hooks: ClientHooks): AiClient {
  async function* chat(req: AiRequest): AsyncGenerator<AiChunk> {
    await hooks.guard?.();
    const { signal, end } = hooks.begin(req);
    try {
      yield* driver.stream(req, { signal });
    } finally {
      end();
      hooks.after?.();
    }
  }

  async function collect(req: AiRequest, json?: JsonSchema): Promise<AiCompletion> {
    await hooks.guard?.();
    const { signal, end } = hooks.begin(req);
    let text = '';
    let incomplete = false;
    let costMicros: number | null = null;
    let reason: AiCompletion['reason'];
    const toolCalls: AiToolCall[] = [];
    try {
      for await (const c of driver.stream(req, { signal, json })) {
        if (c.type === 'delta') text += c.text;
        else if (c.type === 'tool_call') toolCalls.push(c.call);
        else if (c.type === 'done') { incomplete = c.incomplete; costMicros = c.costMicros; reason = c.reason; }
      }
    } finally {
      end();
      hooks.after?.();
    }
    const out: AiCompletion = { text, incomplete, costMicros, model: driver.model };
    if (req.tools?.length) out.toolCalls = toolCalls;
    if (reason) out.reason = reason;
    return out;
  }

  return {
    provider: driver.provider,
    model: driver.model,
    chat,
    complete: (req) => collect(req),
    async json<S extends JsonSchema>(req: JsonRequest<S>): Promise<Infer<S>> {
      const { schema, lineFallback, ...rest } = req;
      const done = await collect({ ...rest, messages: withJsonInstruction(rest.messages, schema) }, schema);
      if (done.incomplete && done.reason?.code === 'bad_answer' && !done.text.trim()) {
        throw new AiError('bad_answer', `${done.reason.message.replace(/\s*Try again[^.]*\.?$/, '')} jobleft cannot use this answer. Try again.`);
      }
      return readStructured(done.text, schema, { incomplete: done.incomplete, lineFallback });
    },
    async listModels(signal?: AbortSignal) {
      await hooks.guard?.();
      return driver.listModels(signal);
    },
    async embed(texts: string[], opts: { model: string; signal?: AbortSignal }) {
      await hooks.guard?.();
      if (texts.length === 0) return [];
      const { signal, end } = hooks.begin({ messages: [], signal: opts.signal });
      try {
        return await driver.embed(texts, opts.model, signal);
      } finally {
        end();
        hooks.after?.();
      }
    },
  };
}
