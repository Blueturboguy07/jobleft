// @jobleft/ai-engine: every AI call goes through here.
//   * providers: publik API (default), a local model server, a custom OpenAI-compatible URL, the user's own key.
//     No Claude consumer-subscription sign-in. No silent fallback to another provider (ai-engine O10).
//   * the publik connection (POST /installs after the disclosure), the wallet, the one top-up link
//   * secrets in the OS secret store, never in plain-text files
//   * embeddings for fit indexing (local bge-small-en-v1.5 by default)
//   * the assistant (chat presets, action proposals that need approval) and interview practice
// Status: interface stubs (foundation). Bodies throw until the ai-engine lane implements them.
// Interface: docs/INTERFACES.md, section "@jobleft/ai-engine".

import type {
  AiProviderKind, AiSettings, AiSettingsUpdate, ChatMessage, Embedder, JsonSchema, Infer, ProviderCheck,
  PublikConnection, SecretStore,
} from '@jobleft/contracts';

export const PACKAGE_NAME = '@jobleft/ai-engine';
/** Version of the two-sentence disclosure shown before the app connects to publik. */
export const PUBLIK_DISCLOSURE_VERSION = 1;
/** The compiled default. Tests and development point JOBLEFT_PUBLIK_BASE_URL at a local stand-in. */
export const PUBLIK_DEFAULT_BASE_URL = 'https://publikhq.com/api/v1';

function notImplemented(what: string): never {
  throw new Error(`not implemented yet: ${what} (lane: @jobleft/ai-engine)`);
}

export type AiErrorCode =
  | 'no_provider' | 'unreachable' | 'timeout' | 'key_refused' | 'model_not_found' | 'not_ai_server'
  | 'insufficient_balance' | 'provider_error' | 'bad_answer' | 'cancelled';

/** Every provider failure, in plain words. `topUpUrl` is set only for insufficient_balance. */
export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly topUpUrl: string | null;
  constructor(code: AiErrorCode, message: string, topUpUrl: string | null = null) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.topUpUrl = topUpUrl;
  }
}

export type AiChunk =
  | { type: 'delta'; text: string }
  | { type: 'done'; incomplete: boolean; costMicros: number | null };

export interface AiCompletion { text: string; incomplete: boolean; costMicros: number | null; model: string }

export interface AiRequest {
  messages: ChatMessage[];
  /** Used to cancel; cancelling stops the upstream request too. */
  requestId?: string;
  maxTokens?: number;
  signal?: AbortSignal;
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
  json<S extends JsonSchema>(req: AiRequest & { schema: S; lineFallback?: (text: string) => Infer<S> | null }): Promise<Infer<S>>;
  listModels(): Promise<string[]>;
}

/** Where AiEngine keeps the (key-free) settings. The server backs it with the store. */
export interface AiSettingsStore {
  load(): AiSettings;
  save(s: AiSettings): void;
}

export interface AiEngineOptions {
  settings: AiSettingsStore;
  secrets: SecretStore;
  /** JOBLEFT_PUBLIK_BASE_URL, else PUBLIK_DEFAULT_BASE_URL. */
  publikBaseUrl: string;
  /** The publik app token (G-publik). null until the owner approves one: connect then answers a plain error. */
  publikAppToken: string | null;
  fetchImpl?: typeof fetch;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
}

/** The publik connection: provisioning, wallet, top-up link. The key never leaves the secret store. */
export class PublikClient {
  constructor(opts: { baseUrl: string; appToken: string | null; secrets: SecretStore; fetchImpl?: typeof fetch }) { void opts; }
  async status(): Promise<PublikConnection> { return notImplemented('PublikClient.status'); }
  /** POST /installs after the person accepted the disclosure. No key is typed or shown. */
  async connect(disclosureVersion: number): Promise<PublikConnection> { return notImplemented('PublikClient.connect'); }
  /** Deletes the key from the secret store; nothing spends the balance after this returns. */
  async disconnect(): Promise<PublikConnection> { return notImplemented('PublikClient.disconnect'); }
  async refresh(): Promise<PublikConnection> { return notImplemented('PublikClient.refresh'); }
  /** Updates the kept wallet from x-publik-* response headers after a paid call. */
  observeHeaders(headers: Headers): void { void headers; notImplemented('PublikClient.observeHeaders'); }
}

export class AiEngine {
  readonly publik: PublikClient;
  constructor(opts: AiEngineOptions) {
    this.publik = new PublikClient({ baseUrl: opts.publikBaseUrl, appToken: opts.publikAppToken, secrets: opts.secrets, fetchImpl: opts.fetchImpl });
  }
  settings(): AiSettings { return notImplemented('AiEngine.settings'); }
  /** Saves the choice and runs the setup check. */
  async updateSettings(update: AiSettingsUpdate): Promise<{ settings: AiSettings; check: ProviderCheck }> { return notImplemented('AiEngine.updateSettings'); }
  async setKey(key: string): Promise<AiSettings> { return notImplemented('AiEngine.setKey'); }
  async deleteKey(): Promise<AiSettings> { return notImplemented('AiEngine.deleteKey'); }
  async check(): Promise<ProviderCheck> { return notImplemented('AiEngine.check'); }
  /** The chosen provider. Throws AiError('no_provider') when none is set. Never another provider. */
  client(): AiClient { return notImplemented('AiEngine.client'); }
  /** Cancels a running request (and its upstream call). */
  cancel(requestId: string): boolean { return notImplemented('AiEngine.cancel'); }
}

/** macOS Keychain (`security` CLI) or Windows Credential Manager. Secrets never touch a plain-text file. */
export function osSecretStore(service = 'jobleft'): SecretStore { void service; return notImplemented('osSecretStore'); }

/** In-memory secrets for tests. */
export function memorySecretStore(): SecretStore {
  const m = new Map<string, string>();
  return {
    async get(name) { return m.get(name) ?? null; },
    async set(name, value) { m.set(name, value); },
    async delete(name) { m.delete(name); },
  };
}

export interface LocalEmbedderOptions {
  /** $JOBLEFT_HOME/models (the model is downloaded once, verified by sha256, then used offline). */
  modelDir: string;
  /** 8 was best on an M4 Pro (spike S2). */
  threads?: number;
}

/** bge-small-en-v1.5 fp32 on ONNX Runtime, CPU, batch 16, CLS pooling, L2-normalised, 384 dims (spike S2). */
export async function createLocalEmbedder(opts: LocalEmbedderOptions): Promise<Embedder> {
  return notImplemented('createLocalEmbedder');
}

/** The line-based fallback for small models (the jobsync "SCORES:" header idea). null when absent. */
export function parseScoresHeader(text: string): Record<string, number> | null {
  return notImplemented('parseScoresHeader');
}
