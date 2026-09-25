// AI provider settings (as the local API returns them: keys are never returned), the setup check,
// chat messages and the chat stream events, and the Embedder interface used for fit indexing.

import { HttpUrlSchema, IdSchema, IsoDateTimeSchema, MicrosSchema } from './common.ts';
import { arr, bool, enm, lit, named, nullable, obj, str, union, type Infer } from './schema.ts';

/**
 * publik = the publik API (default); local = a model server on this computer (Ollama, llama.cpp, MLX, LM Studio,
 * any OpenAI-compatible server on loopback); custom = any OpenAI-compatible URL; own_key = the user's own key for a
 * named vendor. There is no Claude consumer-subscription sign-in.
 */
export const AiProviderKindSchema = enm(['publik', 'local', 'custom', 'own_key']);
export const LocalServerKindSchema = enm(['ollama', 'llamacpp', 'mlx', 'lmstudio', 'openai_compatible']);
export const OwnKeyVendorSchema = enm(['openai', 'anthropic', 'openrouter', 'google']);

/** Provider settings as the API returns them. The key itself is never returned: only its last 4 characters. */
export const AiSettingsSchema = named(obj({
  provider: nullable(AiProviderKindSchema),
  localKind: nullable(LocalServerKindSchema),
  vendor: nullable(OwnKeyVendorSchema),
  /** OpenAI-compatible base URL for local and custom providers. */
  baseUrl: nullable(HttpUrlSchema),
  model: nullable(str()),
  keySet: bool(),
  /** The last 4 characters of the saved key, or null. */
  keyHint: nullable(str({ maxLength: 4 })),
  /** Paid page fetch and web search through publik or the user's own key. Off until the user turns it on. */
  meteredFetch: obj({
    enabled: bool(),
    /** Prices shown before the user turns it on, per 1,000 requests. */
    pricesPer1000Micros: obj({ search: MicrosSchema, page: MicrosSchema, jsPage: MicrosSchema }),
  }),
  updatedAt: nullable(IsoDateTimeSchema),
}), 'AiSettings', 'AI provider settings (never the key)');

/** A settings change. Keys are saved through their own route and never echoed. */
export const AiSettingsUpdateSchema = named(obj({ provider: AiProviderKindSchema }, {
  localKind: LocalServerKindSchema,
  vendor: OwnKeyVendorSchema,
  baseUrl: HttpUrlSchema,
  model: str(),
  meteredFetchEnabled: bool(),
}), 'AiSettingsUpdate');

/** The result of testing a provider: works, or the real problem in plain words (ai-engine O3). */
export const ProviderCheckSchema = named(obj({
  ok: bool(),
  problem: nullable(enm([
    'no_provider', 'unreachable', 'timeout', 'key_refused', 'model_not_found', 'not_ai_server', 'balance_too_low', 'other',
  ])),
  message: str(),
  /** Models the server says it has (never a made-up list). */
  models: arr(str()),
  checkedAt: IsoDateTimeSchema,
}), 'ProviderCheck');

export const ChatMessageSchema = named(obj({
  role: enm(['user', 'assistant', 'system']),
  content: str({ maxLength: 200_000 }),
}), 'ChatMessage');

export const ChatRequestSchema = named(obj({
  /** Client-made id, used to cancel (POST /api/v1/ai/requests/:id/cancel). */
  requestId: IdSchema,
  messages: arr(ChatMessageSchema, { minItems: 1 }),
}, {
  /** Ask about this job (its facts are added by the server, not by the client). */
  jobId: IdSchema,
  preset: enm(['chat', 'fit', 'tailor', 'interview', 'debrief', 'profile']),
}), 'ChatRequest');

/** Error details inside the stream use the same shape as the API error body's inner object. */
const StreamErrorSchema = obj({ code: str(), message: str() }, { link: obj({ label: str(), url: HttpUrlSchema }) });

/**
 * Server-sent events of POST /api/v1/ai/chat. Each SSE `data:` line is one of these JSON objects.
 * The stream always ends with `done` or `error`. A stream cut short ends with done { incomplete: true }.
 */
export const ChatStreamEventSchema = named(union([
  obj({ type: lit('start'), requestId: IdSchema, provider: AiProviderKindSchema, model: str() }),
  obj({ type: lit('delta'), text: str() }),
  obj({ type: lit('done'), incomplete: bool(), costMicros: nullable(MicrosSchema) }),
  obj({ type: lit('error'), error: StreamErrorSchema }),
]), 'ChatStreamEvent');

export type AiProviderKind = Infer<typeof AiProviderKindSchema>;
export type LocalServerKind = Infer<typeof LocalServerKindSchema>;
export type OwnKeyVendor = Infer<typeof OwnKeyVendorSchema>;
export type AiSettings = Infer<typeof AiSettingsSchema>;
export type AiSettingsUpdate = Infer<typeof AiSettingsUpdateSchema>;
export type ProviderCheck = Infer<typeof ProviderCheckSchema>;
export type ChatMessage = Infer<typeof ChatMessageSchema>;
export type ChatRequest = Infer<typeof ChatRequestSchema>;
export type ChatStreamEvent = Infer<typeof ChatStreamEventSchema>;

/** Turns texts into vectors for fit indexing. Implemented by @jobleft/ai-engine (local bge-small by default). */
export interface Embedder {
  /** Model id, e.g. "bge-small-en-v1.5". Vectors from different models are never mixed in one ranking. */
  readonly model: string;
  readonly dims: number;
  /** L2-normalised vectors, one per text, in order. */
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

/** Stores secrets outside plain-text files (macOS Keychain, Windows Credential Manager). Implemented by @jobleft/ai-engine. */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/** Secret names used by the app. */
export const SECRET_NAMES = {
  publikKey: 'jobleft.publik.key',
  providerKey: (provider: string) => `jobleft.ai.${provider}.key`,
  sourceKey: (sourceId: string) => `jobleft.source.${sourceId}.key`,
} as const;
