// @jobleft/ai-engine: every AI call goes through here.
//   * providers: publik API, a local model server (Ollama native; llama.cpp, MLX, LM Studio and any loopback
//     OpenAI-compatible server), a custom OpenAI-compatible URL, the user's own key (OpenAI, Anthropic, OpenRouter,
//     Google). No Claude consumer-subscription sign-in. No silent fallback to another provider (ai-engine O10).
//   * the publik connection (POST /installs after the disclosure), the balance in dollars, the one top-up link
//   * secrets in the OS secret store (macOS Keychain) or an encrypted 0600 file, never in plain-text files
//   * structured answers with a line-based fallback for small models; nothing is invented when an answer is bad
//   * stand-in servers for tests: a publik stand-in and an OpenAI/Ollama/Anthropic-style model stand-in
// Interface: docs/INTERFACES.md, section "@jobleft/ai-engine". How to run it: packages/ai-engine/README.md.

export const PACKAGE_NAME = '@jobleft/ai-engine';

export { AiError, asAiError, isAiError, toApiError, type AiErrorCode } from './errors.ts';
export type {
  AiChunk, AiClient, AiCompletion, AiMessage, AiRequest, AiTool, AiToolCall, JsonRequest, ProviderDriver,
} from './types.ts';
export {
  PUBLIK_APP_SLUG, PUBLIK_DEFAULT_BASE_URL, PUBLIK_DEFAULT_MODEL, PUBLIK_DISCLOSURE, PUBLIK_DISCLOSURE_VERSION,
  PUBLIK_JUSTIFICATION, PUBLIK_TIERS, PublikClient, type PublikClientOptions,
} from './publik.ts';
export { AiEngine, CHECK_BUDGET_MS, NO_PROVIDER_MESSAGE, type AiEngineOptions } from './engine.ts';
export {
  defaultAiSettings, fileKvStore, kvSettingsStore, memoryKvStore, METERED_PRICES_PER_1000_MICROS,
  type AiSettingsStore, type KvStore,
} from './state.ts';
export { encryptedFileSecretStore, keychainSecretStore, memorySecretStore, osSecretStore } from './secrets.ts';
export { extractJson, jsonInstruction, parseScoresHeader, readFieldLines, readStructured, withJsonInstruction } from './structured.ts';
export { stripThinking, ThinkStripper } from './thinking.ts';
export { DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS } from './transport.ts';
export { isLoopbackHost, LOCAL_DEFAULT_URLS, normalizeBaseUrl, VENDOR_BASE_URLS } from './urls.ts';
export { thinkOption } from './providers/ollama.ts';
export { chatEvents, createAiRouteHandlers, type AiRouteHandlers, type RouteResult } from './routes.ts';
export { createLocalEmbedder, WordPieceTokenizer, type LocalEmbedderOptions } from './embedder.ts';
export { createEngineFromEnv, resolveHome } from './setup.ts';
