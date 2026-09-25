// The one provider interface. Every provider (publik, Ollama, local and custom OpenAI-compatible servers, own keys)
// gives the same AiClient, so callers never branch on the provider.

import type { AiProviderKind, ChatMessage, Infer, JsonSchema } from '@jobleft/contracts';
import type { AiErrorCode } from './errors.ts';

/** A tool the model may call. `parameters` is a JSON Schema for the arguments. */
export interface AiTool {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** A tool call the model made (only when the request passed `tools`). */
export interface AiToolCall {
  id: string;
  name: string;
  /** The parsed arguments, or null when the model sent arguments that are not JSON (see `rawArguments`). */
  arguments: unknown;
  rawArguments: string;
}

/** A chat message. ChatMessage from the contracts, plus tool calls and tool results for tool use. */
export type AiMessage =
  | ChatMessage
  | { role: 'assistant'; content: string; toolCalls: AiToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export type AiChunk =
  | { type: 'delta'; text: string }
  /** Only when the request passed `tools`. */
  | { type: 'tool_call'; call: AiToolCall }
  | {
    type: 'done';
    /** true when the answer stopped early (cut off by the length limit, or the stream broke part way). */
    incomplete: boolean;
    /** What publik charged, when publik said so; null = unknown. Never an estimate. */
    costMicros: number | null;
    /** Why the answer is incomplete, in plain words (absent when complete). */
    reason?: { code: AiErrorCode; message: string };
  };

export interface AiCompletion {
  text: string;
  incomplete: boolean;
  costMicros: number | null;
  model: string;
  /** Tool calls, when the request passed `tools`. */
  toolCalls?: AiToolCall[];
  reason?: { code: AiErrorCode; message: string };
}

export interface AiRequest {
  messages: AiMessage[];
  /** Used to cancel; cancelling stops the upstream request too. */
  requestId?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  tools?: AiTool[];
}

export interface JsonRequest<S extends JsonSchema> extends AiRequest {
  schema: S;
  /** Reads a plain-text answer when the model did not write JSON (small models). null = cannot read it. */
  lineFallback?: (text: string) => Infer<S> | null;
}

/** One provider, ready to use. Every call ends: a dead provider fails within 10 s, a silent stream after 120 s. */
export interface AiClient {
  readonly provider: AiProviderKind;
  readonly model: string;
  chat(req: AiRequest): AsyncIterable<AiChunk>;
  complete(req: AiRequest): Promise<AiCompletion>;
  /**
   * A structured answer checked against a contract schema. Small models: `lineFallback` parses a plain-text
   * answer. An answer that fits neither throws AiError('bad_answer'); nothing is invented to fill the gap.
   */
  json<S extends JsonSchema>(req: JsonRequest<S>): Promise<Infer<S>>;
  listModels(signal?: AbortSignal): Promise<string[]>;
  /** Embeddings from this provider with the named embedding model. Throws AiError when the provider has none. */
  embed(texts: string[], opts: { model: string; signal?: AbortSignal }): Promise<Float32Array[]>;
}

/** What a provider driver implements. AiClient is built on top of it (see client.ts). */
export interface ProviderDriver {
  readonly provider: AiProviderKind;
  readonly model: string;
  /** Streams one answer. `json` asks for a JSON answer that fits the schema when the server supports it. */
  stream(req: AiRequest, opts: { json?: JsonSchema; signal: AbortSignal }): AsyncIterable<AiChunk>;
  listModels(signal?: AbortSignal): Promise<string[]>;
  embed(texts: string[], model: string, signal?: AbortSignal): Promise<Float32Array[]>;
}
