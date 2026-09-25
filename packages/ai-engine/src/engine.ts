// AiEngine: the person's ONE provider choice, its setup check, its key, and every AI call made with it.
// Rules (ai-engine O1 to O11):
//   * only the chosen provider is ever used: no fallback to another provider, no retry loop;
//   * a key belongs to one provider address and goes only there, in a header, never in a URL;
//   * keys live in the secret store; only their last 4 characters come back;
//   * a "local" provider must be on this computer (loopback), so local means nothing leaves the computer;
//   * every request ends (10 s to connect, 120 s of silence) and can be cancelled by id.

import { randomUUID } from 'node:crypto';
import type {
  AiProviderKind, AiSettings, AiSettingsUpdate, LocalServerKind, OwnKeyVendor, ProviderCheck, SecretStore,
} from '@jobleft/contracts';
import { formatDollars, nowIso, SECRET_NAMES } from '@jobleft/contracts';
import { makeClient } from './client.ts';
import { AiError, asAiError } from './errors.ts';
import { AnthropicDriver } from './providers/anthropic.ts';
import { OllamaDriver, sameOllamaModel } from './providers/ollama.ts';
import { OpenAiDriver, resolveOpenAiRoot } from './providers/openai.ts';
import { PUBLIK_DEFAULT_MODEL, PUBLIK_TIERS, PublikClient } from './publik.ts';
import { defaultAiSettings, memoryKvStore, type AiSettingsStore, type KvStore } from './state.ts';
import { DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS } from './transport.ts';
import type { AiClient, AiRequest, ProviderDriver } from './types.ts';
import {
  aiHostMapFromEnv, basePath, isLoopbackHost, LOCAL_DEFAULT_URLS, mapVendorUrl, normalizeBaseUrl, openAiRootCandidates, originOf,
  parseBaseUrl, shortHash, VENDOR_BASE_URLS,
} from './urls.ts';

export const NO_PROVIDER_MESSAGE = 'No AI provider is set up. jobleft works without one; set one up in Settings > AI to use this feature.';
/** The whole setup check ends within this time (ai-engine O3: each result within 60 seconds). */
export const CHECK_BUDGET_MS = 55_000;

export interface AiEngineOptions {
  settings: AiSettingsStore;
  secrets: SecretStore;
  /** JOBLEFT_PUBLIK_BASE_URL, else PUBLIK_DEFAULT_BASE_URL. */
  publikBaseUrl: string;
  /** The publik app token (G-publik). null until the owner approves one: connect then answers a plain error. */
  publikAppToken: string | null;
  /** Kept for the interface; the engine uses its own transport (connect, silence and cancel limits). */
  fetchImpl?: typeof fetch;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Key-free engine state: which address each saved key belongs to, found API roots, the publik connection. */
  state?: KvStore;
  /** Environment (JOBLEFT_OFFLINE, JOBLEFT_AI_HOST_MAP). Default: process.env. */
  env?: Record<string, string | undefined>;
  appVersion?: string;
}

interface EngineState {
  /** Last 4 characters of each saved key, by key slot (never the key). */
  keyHints: Record<string, string | null>;
  /** API root found for each OpenAI-compatible address. */
  roots: Record<string, string>;
}

const PROBLEM: Record<string, ProviderCheck['problem']> = {
  no_provider: 'no_provider', unreachable: 'unreachable', timeout: 'timeout', key_refused: 'key_refused',
  model_not_found: 'model_not_found', not_ai_server: 'not_ai_server', insufficient_balance: 'balance_too_low',
  offline: 'unreachable',
};

const VENDOR_LABEL: Record<OwnKeyVendor, string> = { openai: 'OpenAI', anthropic: 'Anthropic', openrouter: 'OpenRouter', google: 'Google' };
const LOCAL_LABEL: Record<LocalServerKind, string> = { ollama: 'Ollama', llamacpp: 'llama.cpp', mlx: 'MLX', lmstudio: 'LM Studio', openai_compatible: 'the local AI server' };

type Running = { controller: AbortController; provider: AiProviderKind };

/** A key never rides in the address (it would land in logs and error messages): "https://user:pass@host" is refused. */
function refuseCredentialsInUrl(typed: string): void {
  let u: URL;
  try { u = new URL(typed); } catch { return; }
  if (u.username || u.password) throw new AiError('bad_request', 'The address must not hold a user name, password or key. Put the key in the key field. Nothing was saved.');
}

export class AiEngine {
  readonly publik: PublikClient;
  private readonly store: AiSettingsStore;
  private readonly secrets: SecretStore;
  private readonly kv: KvStore;
  private readonly env: Record<string, string | undefined>;
  private readonly connectTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly hostMap: Map<string, string>;
  private readonly running = new Map<string, Running>();
  private readonly background = new Set<Promise<unknown>>();

  constructor(opts: AiEngineOptions) {
    this.store = opts.settings;
    this.secrets = opts.secrets;
    this.kv = opts.state ?? memoryKvStore();
    this.env = opts.env ?? process.env;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.hostMap = aiHostMapFromEnv(this.env);
    this.publik = new PublikClient({
      baseUrl: opts.publikBaseUrl, appToken: opts.publikAppToken, secrets: opts.secrets, fetchImpl: opts.fetchImpl,
      state: this.kv, appVersion: opts.appVersion, connectTimeoutMs: this.connectTimeoutMs,
    });
    // Disconnect stops every running publik request at once: nothing spends the balance afterwards (O2).
    this.publik.onDisconnect(() => {
      for (const [id, r] of this.running) if (r.provider === 'publik') { r.controller.abort(); this.running.delete(id); }
    });
  }

  // ------------------------------------------------------------------ state

  private engineState(): EngineState {
    const s = this.kv.getJson<EngineState>('ai.engine');
    return { keyHints: { ...(s?.keyHints ?? {}) }, roots: { ...(s?.roots ?? {}) } };
  }
  private saveEngineState(s: EngineState): void {
    this.kv.setJson('ai.engine', s);
  }

  /** The key slot of a provider choice: the key saved for it goes only to this address. null = no key (publik). */
  keySlot(s: Pick<AiSettings, 'provider' | 'vendor' | 'baseUrl'>): string | null {
    if (s.provider === 'own_key' && s.vendor) return `own_key.${s.vendor}`;
    if ((s.provider === 'custom' || s.provider === 'local') && s.baseUrl) return `${s.provider}@${shortHash(originOf(s.baseUrl))}`;
    return null;
  }

  private secretName(slot: string): string {
    return SECRET_NAMES.providerKey(slot);
  }

  /** Provider settings (never the key: only its last 4 characters). */
  settings(): AiSettings {
    const s = this.store.load();
    const slot = this.keySlot(s);
    const hints = this.engineState().keyHints;
    const has = slot !== null && Object.prototype.hasOwnProperty.call(hints, slot);
    return { ...s, keySet: has, keyHint: has ? hints[slot!] ?? null : null };
  }

  private saveSettings(s: AiSettings): void {
    const { keySet: _k, keyHint: _h, ...rest } = s;
    this.store.save({ ...rest, keySet: false, keyHint: null });
  }

  // ------------------------------------------------------------------ choosing a provider

  /** Saves the choice and runs the setup check. */
  async updateSettings(update: AiSettingsUpdate): Promise<{ settings: AiSettings; check: ProviderCheck }> {
    const prev = this.store.load();
    const next: AiSettings = { ...defaultAiSettings(), meteredFetch: { ...prev.meteredFetch }, provider: update.provider, updatedAt: nowIso() };
    const same = prev.provider === update.provider;
    switch (update.provider) {
      case 'publik': {
        const model = update.model ?? (same ? prev.model : null) ?? PUBLIK_DEFAULT_MODEL;
        if (!/^publik-[a-z0-9-]+$/.test(model)) throw new AiError('bad_request', `Choose a publik tier: ${PUBLIK_TIERS.join(', ')}.`);
        next.model = model;
        break;
      }
      case 'local': {
        const kind: LocalServerKind = update.localKind ?? (same ? prev.localKind : null) ?? 'ollama';
        const typed = update.baseUrl ?? (same && prev.localKind === kind ? prev.baseUrl : null) ?? LOCAL_DEFAULT_URLS[kind];
        if (!typed) throw new AiError('bad_request', 'Type the address of the local AI server, for example http://127.0.0.1:8080.');
        refuseCredentialsInUrl(typed);
        const base = normalizeBaseUrl(typed);
        if (!isLoopbackHost(parseBaseUrl(base).hostname)) {
          throw new AiError('bad_request', 'A local provider must run on this computer (127.0.0.1 or localhost). For a server elsewhere, choose "custom address".');
        }
        next.localKind = kind;
        next.baseUrl = kind === 'ollama' ? ollamaBase(base) : base;
        next.model = update.model ?? (same && prev.baseUrl === next.baseUrl && prev.localKind === kind ? prev.model : null);
        break;
      }
      case 'custom': {
        const typed = update.baseUrl ?? (same ? prev.baseUrl : null);
        if (!typed) throw new AiError('bad_request', 'Type the address of the AI server, for example https://example.org/v1.');
        refuseCredentialsInUrl(typed);
        next.baseUrl = normalizeBaseUrl(typed);
        next.model = update.model ?? (same && prev.baseUrl === next.baseUrl ? prev.model : null);
        break;
      }
      case 'own_key': {
        const vendor = update.vendor ?? (same ? prev.vendor : null);
        if (!vendor) throw new AiError('bad_request', 'Choose whose key this is: openai, anthropic, openrouter or google.');
        next.vendor = vendor;
        next.baseUrl = VENDOR_BASE_URLS[vendor];
        next.model = update.model ?? (same && prev.vendor === vendor ? prev.model : null);
        break;
      }
      default:
        throw new AiError('bad_request', 'Choose a provider: publik, local, custom or own_key.');
    }
    if (next.model !== null) {
      next.model = next.model.trim();
      if (!next.model || next.model.length > 200 || /[\r\n]/.test(next.model)) throw new AiError('bad_request', 'The model name is not valid.');
    }
    if (update.meteredFetchEnabled !== undefined) next.meteredFetch = { ...next.meteredFetch, enabled: update.meteredFetchEnabled };
    this.saveSettings(next);
    const check = await this.check();
    return { settings: this.settings(), check };
  }

  /** Turns paid page fetch and web search on or off without changing the provider (off until the person turns it on). */
  setMeteredFetch(enabled: boolean): AiSettings {
    const s = this.store.load();
    this.saveSettings({ ...s, meteredFetch: { ...s.meteredFetch, enabled }, updatedAt: nowIso() });
    return this.settings();
  }

  /** No provider: every AI feature says so and offers to set one up. */
  clearProvider(): AiSettings {
    const s = this.store.load();
    this.saveSettings({ ...defaultAiSettings(), meteredFetch: s.meteredFetch, updatedAt: nowIso() });
    return this.settings();
  }

  // ------------------------------------------------------------------ keys

  /** Saves the key of the current provider (secret store; only the last 4 characters come back). */
  async setKey(key: string): Promise<AiSettings> {
    const s = this.settings();
    if (!s.provider) throw new AiError('no_provider', 'Choose a provider first, then save its key.');
    if (s.provider === 'publik') throw new AiError('bad_request', 'publik connects without a key: use Connect publik. Nothing needs to be typed.');
    const slot = this.keySlot(s);
    if (!slot) throw new AiError('bad_request', 'Choose the provider address first, then save its key.');
    const k = typeof key === 'string' ? key.trim() : '';
    if (!k) throw new AiError('bad_request', 'The key is empty.');
    if (k.length > 1000 || /[\s\u0000-\u001f\u007f]/.test(k)) throw new AiError('bad_request', 'The key has spaces or control characters in it. Paste only the key.');
    await this.secrets.set(this.secretName(slot), k);
    const st = this.engineState();
    // Show no more than the last 4 characters, and nothing at all of a short key.
    st.keyHints[slot] = k.length >= 12 ? k.slice(-4) : null;
    this.saveEngineState(st);
    return this.settings();
  }

  /** Forgets the key of the current provider. */
  async deleteKey(): Promise<AiSettings> {
    const s = this.settings();
    const slot = this.keySlot(s);
    if (slot) {
      await this.secrets.delete(this.secretName(slot));
      const st = this.engineState();
      delete st.keyHints[slot];
      this.saveEngineState(st);
    }
    return this.settings();
  }

  /** Forgets every saved provider key and disconnects publik (used by "delete all data"). */
  async forgetAllKeys(): Promise<number> {
    const st = this.engineState();
    let n = 0;
    for (const slot of Object.keys(st.keyHints)) { await this.secrets.delete(this.secretName(slot)); n++; }
    for (const v of Object.keys(VENDOR_BASE_URLS)) await this.secrets.delete(this.secretName(`own_key.${v}`));
    st.keyHints = {};
    this.saveEngineState(st);
    if ((await this.publik.status()).state === 'connected') { await this.publik.disconnect(); n++; }
    else await this.secrets.delete(SECRET_NAMES.publikKey);
    return n;
  }

  private keyGetter(s: AiSettings): () => Promise<string | null> {
    const slot = this.keySlot(s);
    if (!slot) return async () => null;
    const name = this.secretName(slot);
    return () => this.secrets.get(name);
  }

  // ------------------------------------------------------------------ the client

  private offline(): boolean {
    return this.env.JOBLEFT_OFFLINE === '1';
  }

  private vendorRoot(vendor: OwnKeyVendor): string {
    return mapVendorUrl(VENDOR_BASE_URLS[vendor], this.hostMap);
  }

  private rootResolver(base: string, key: () => Promise<string | null>): (signal?: AbortSignal) => Promise<string> {
    return async (signal) => {
      const known = this.engineState().roots[base];
      if (known) return known;
      const root = await resolveOpenAiRoot(openAiRootCandidates(base), await key(), { connectTimeoutMs: this.connectTimeoutMs, signal });
      const st = this.engineState();
      st.roots[base] = root;
      this.saveEngineState(st);
      return root;
    };
  }

  private driverFor(s: AiSettings, model: string): ProviderDriver {
    const t = { connectTimeoutMs: this.connectTimeoutMs, idleTimeoutMs: this.idleTimeoutMs };
    const key = this.keyGetter(s);
    switch (s.provider) {
      case 'publik':
        return new OpenAiDriver({
          ...t, provider: 'publik', model, label: 'publik',
          root: async () => {
            const g = await this.publik.gatewayKey();
            if (!g) throw new AiError('no_provider', 'publik is not connected. Connect publik in Settings > AI, or choose another provider.');
            return g.baseUrl;
          },
          key: async () => (await this.publik.gatewayKey())?.key ?? null,
          maxTokensField: 'max_tokens',
          classify: (status, headers, raw) => this.publik.failure(status, headers, raw),
          onResponse: (_status, headers) => this.publik.observeHeaders(headers),
          costFromHeaders: (h) => PublikClient.costFromHeaders(h),
        });
      case 'local':
        if (s.localKind === 'ollama') return new OllamaDriver({ ...t, model, base: ollamaBase(s.baseUrl!), key });
        return new OpenAiDriver({ ...t, provider: 'local', model, key, root: this.rootResolver(s.baseUrl!, key), label: `${LOCAL_LABEL[s.localKind ?? 'openai_compatible']} at ${originOf(s.baseUrl!)}` });
      case 'custom':
        return new OpenAiDriver({ ...t, provider: 'custom', model, key, root: this.rootResolver(s.baseUrl!, key), label: `the AI server at ${originOf(s.baseUrl!)}` });
      case 'own_key': {
        const vendor = s.vendor!;
        if (vendor === 'anthropic') return new AnthropicDriver({ ...t, model, key, root: this.vendorRoot('anthropic') });
        return new OpenAiDriver({
          ...t, provider: 'own_key', model, key, root: async () => this.vendorRoot(vendor), label: VENDOR_LABEL[vendor],
          maxTokensField: vendor === 'openai' ? 'max_completion_tokens' : 'max_tokens',
          extraHeaders: vendor === 'openrouter' ? { 'x-title': 'jobleft' } : undefined,
        });
      }
      default:
        throw new AiError('no_provider', NO_PROVIDER_MESSAGE);
    }
  }

  private networkAddress(s: AiSettings): string | null {
    if (s.provider === 'publik') return null;
    if (s.provider === 'own_key' && s.vendor) return this.vendorRoot(s.vendor);
    return s.baseUrl;
  }

  private assertAllowedOffline(s: AiSettings): void {
    if (!this.offline()) return;
    const addr = s.provider === 'publik' ? 'https://publikhq.com' : this.networkAddress(s);
    if (!addr || !isLoopbackHost(new URL(addr).hostname)) {
      throw new AiError('offline', 'jobleft is in offline mode, so it sends no AI request over the network. Choose a local model, or turn offline mode off.');
    }
  }

  /** The chosen provider. Throws AiError('no_provider') when none is set. Never another provider. */
  client(): AiClient {
    const s = this.settings();
    if (!s.provider) throw new AiError('no_provider', NO_PROVIDER_MESSAGE);
    this.assertAllowedOffline(s);
    if (s.provider === 'own_key' && !s.keySet) throw new AiError('key_refused', `Save your ${VENDOR_LABEL[s.vendor!]} key first. jobleft sends nothing to ${VENDOR_LABEL[s.vendor!]} without it.`);
    if (!s.model) throw new AiError('model_not_found', 'No model is chosen for this provider. Choose one in Settings > AI (the setup check lists them).');
    return this.clientFor(s, s.model);
  }

  private clientFor(s: AiSettings, model: string): AiClient {
    const driver = this.driverFor(s, model);
    const provider = s.provider!;
    return makeClient(driver, {
      begin: (req: AiRequest) => this.begin(req, provider),
      after: provider === 'publik' ? () => this.track(this.publik.refresh().catch(() => undefined)) : undefined,
      guard: provider === 'publik'
        ? async () => { if (!(await this.publik.gatewayKey())) throw new AiError('no_provider', 'publik is not connected. Connect publik in Settings > AI, or choose another provider.'); }
        : undefined,
    });
  }

  private begin(req: AiRequest, provider: AiProviderKind): { signal: AbortSignal; end(): void } {
    const controller = new AbortController();
    const id = req.requestId ?? randomUUID();
    const onOuter = () => controller.abort();
    if (req.signal) {
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener('abort', onOuter, { once: true });
    }
    this.running.set(id, { controller, provider });
    return {
      signal: controller.signal,
      end: () => {
        req.signal?.removeEventListener('abort', onOuter);
        if (this.running.get(id)?.controller === controller) this.running.delete(id);
        controller.abort(); // closes the connection if the caller stopped reading early
      },
    };
  }

  /** Cancels a running request (and its upstream call). */
  cancel(requestId: string): boolean {
    const r = this.running.get(requestId);
    if (!r) return false;
    r.controller.abort();
    this.running.delete(requestId);
    return true;
  }

  private track(p: Promise<unknown>): void {
    this.background.add(p);
    void p.finally(() => this.background.delete(p));
  }

  /** Waits for background work (the balance re-read after a paid call). The CLI calls it before it exits. */
  async idle(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  // ------------------------------------------------------------------ the setup check

  /** Tests the chosen provider now and names the real problem in plain words (ai-engine O3). */
  async check(): Promise<ProviderCheck> {
    const s = this.settings();
    const checkedAt = nowIso();
    if (!s.provider) return { ok: false, problem: 'no_provider', message: NO_PROVIDER_MESSAGE, models: [], checkedAt };
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), CHECK_BUDGET_MS);
    let models: string[] = [];
    try {
      this.assertAllowedOffline(s);
      if (s.provider === 'publik') return await this.checkPublik(s, checkedAt);
      if (s.provider === 'own_key' && !s.keySet) {
        return { ok: false, problem: 'other', message: `Save your ${VENDOR_LABEL[s.vendor!]} key, then check again. jobleft sends nothing to ${VENDOR_LABEL[s.vendor!]} without it.`, models, checkedAt };
      }
      if ((s.provider === 'custom' || s.provider === 'local') && s.localKind !== 'ollama') {
        // Find the API root again: the server behind the address may have changed since the last check.
        const st = this.engineState();
        delete st.roots[s.baseUrl!];
        this.saveEngineState(st);
      }
      const listClient = this.driverFor(s, s.model ?? '');
      try {
        models = await listClient.listModels(budget.signal);
      } catch (e) {
        const err = asAiError(e);
        // Some servers have no model list (404): go on to the chat test when a model is chosen.
        if (!(err.code === 'not_ai_server' && s.model && err.httpStatus === 404)) throw err;
      }
      let model = s.model;
      const isOllama = s.provider === 'local' && s.localKind === 'ollama';
      if (isOllama && models.length === 0) {
        return { ok: false, problem: 'model_not_found', message: 'Ollama is running but has no models installed. jobleft never downloads models: install one (for example "ollama pull qwen2.5:7b"), then check again.', models, checkedAt };
      }
      if (!model) {
        if (models.length === 1) {
          model = models[0]!;
          this.saveSettings({ ...this.store.load(), model, updatedAt: nowIso() });
        } else {
          const list = models.length ? ` This server has: ${models.slice(0, 12).join(', ')}${models.length > 12 ? ', ...' : ''}.` : '';
          return { ok: false, problem: 'other', message: `Choose a model.${list}`, models, checkedAt };
        }
      } else if (models.length > 0) {
        const found = isOllama ? models.find((m) => sameOllamaModel(m, model!)) : models.find((m) => m === model);
        if (!found) {
          return { ok: false, problem: 'model_not_found', message: `The model "${model.slice(0, 80)}" is not on this server. Choose one of: ${models.slice(0, 12).join(', ')}${models.length > 12 ? ', ...' : ''}.`, models, checkedAt };
        }
      }
      // A real chat request: a model list alone does not prove that chat works (O3).
      const client = this.clientFor({ ...s, model }, model);
      const first = await firstAnswer(client, budget.signal);
      const label = this.describe({ ...s, model });
      return {
        ok: true, problem: null,
        message: first === 'empty' ? `Works: ${label} took a chat request (the test answer was empty, which some thinking models do).` : `Works: ${label} answered a test message.`,
        models, checkedAt,
      };
    } catch (e) {
      const err = budget.signal.aborted && asAiError(e).code === 'cancelled'
        ? new AiError('timeout', `The provider did not finish the test within ${Math.round(CHECK_BUDGET_MS / 1000)} seconds. A local model may still be loading; check again in a minute.`)
        : asAiError(e);
      const out: ProviderCheck = { ok: false, problem: PROBLEM[err.code] ?? 'other', message: this.checkMessage(s, err), models, checkedAt };
      if (err.topUpUrl) out.link = { label: err.code === 'needs_claim' ? 'Link this computer' : 'Add money', url: err.topUpUrl };
      return out;
    } finally {
      clearTimeout(timer);
    }
  }

  private checkMessage(s: AiSettings, err: AiError): string {
    if (s.provider === 'local' && s.localKind === 'ollama' && err.code === 'unreachable') {
      return `Ollama is not running at ${originOf(s.baseUrl!)}. Start Ollama (open the Ollama app, or run "ollama serve"), then check again.`;
    }
    return err.message;
  }

  private async checkPublik(s: AiSettings, checkedAt: string): Promise<ProviderCheck> {
    const g = await this.publik.gatewayKey();
    if (!g) return { ok: false, problem: 'other', message: 'publik is not connected yet. Connect publik (no key needed), or choose another provider.', models: [], checkedAt };
    const conn = await this.publik.refresh();
    const wallet = conn.wallet;
    const driver = this.driverFor(s, s.model ?? PUBLIK_DEFAULT_MODEL);
    let models = (await driver.listModels()).filter((m) => m.startsWith('publik-'));
    if (models.length === 0) models = [...PUBLIK_TIERS];
    const model = s.model ?? PUBLIK_DEFAULT_MODEL;
    if (!models.includes(model)) {
      return { ok: false, problem: 'model_not_found', message: `publik does not have the model "${model.slice(0, 80)}". Choose one of: ${models.join(', ')}.`, models, checkedAt };
    }
    if (!wallet) return { ok: false, problem: 'other', message: 'publik is connected, but it did not say the balance. Check again in a minute.', models, checkedAt };
    if (wallet.balanceMicros <= 0) {
      const next = wallet.claimState === 'anonymous' ? 'Link this computer and pick a plan at the link below' : 'Add a plan or a pack at the link below';
      return { ok: false, problem: 'balance_too_low', message: `Your publik balance ran out (${formatDollars(wallet.balanceMicros)} left). ${next}.`, models, checkedAt, link: { label: 'Add money', url: wallet.topUpUrl } };
    }
    if (model === 'publik-smart' && wallet.claimState === 'anonymous') {
      return { ok: false, problem: 'other', message: 'publik-smart needs a publik account linked to this computer. Link this computer at the link below, or choose publik-balanced.', models, checkedAt, link: { label: 'Link this computer', url: wallet.claimUrl ?? wallet.topUpUrl } };
    }
    return { ok: true, problem: null, message: `Works: publik is connected. Balance: ${formatDollars(wallet.balanceMicros)}. Model: ${model}.`, models, checkedAt };
  }

  /** Models the provider says it has (never a made-up list). */
  async listModels(): Promise<string[]> {
    const s = this.settings();
    if (!s.provider) throw new AiError('no_provider', NO_PROVIDER_MESSAGE);
    this.assertAllowedOffline(s);
    const models = await this.driverFor(s, s.model ?? PUBLIK_DEFAULT_MODEL).listModels();
    return s.provider === 'publik' ? models.filter((m) => m.startsWith('publik-')) : models;
  }

  /** "publik (publik-balanced)", "Ollama at http://127.0.0.1:11434 (qwen2.5:7b)": the active-provider label. */
  describe(s: AiSettings = this.settings()): string {
    const model = s.model ? ` (${s.model})` : '';
    switch (s.provider) {
      case 'publik': return `publik${model}`;
      case 'local': return `${LOCAL_LABEL[s.localKind ?? 'openai_compatible']} at ${originOf(s.baseUrl!)}${model}`;
      case 'custom': return `the AI server at ${originOf(s.baseUrl!)}${model}`;
      case 'own_key': return `${VENDOR_LABEL[s.vendor!]} with your own key${model}`;
      default: return 'no provider';
    }
  }

  /** Local model servers that answer on this computer now (Ollama, LM Studio, llama.cpp or MLX ports). */
  async detectLocal(): Promise<Array<{ kind: LocalServerKind; baseUrl: string; models: string[] }>> {
    const probes: Array<{ kind: LocalServerKind; baseUrl: string }> = [
      { kind: 'ollama', baseUrl: LOCAL_DEFAULT_URLS.ollama! },
      { kind: 'lmstudio', baseUrl: LOCAL_DEFAULT_URLS.lmstudio! },
      { kind: 'llamacpp', baseUrl: LOCAL_DEFAULT_URLS.llamacpp! },
    ];
    const found: Array<{ kind: LocalServerKind; baseUrl: string; models: string[] }> = [];
    await Promise.all(probes.map(async (p) => {
      try {
        if (p.kind === 'ollama') {
          const d = new OllamaDriver({ model: '', base: p.baseUrl, key: async () => null, connectTimeoutMs: 1500, idleTimeoutMs: 3000 });
          found.push({ ...p, models: await d.listModels() });
        } else {
          const d = new OpenAiDriver({ provider: 'local', model: '', key: async () => null, root: async () => p.baseUrl, label: p.kind, connectTimeoutMs: 1500, idleTimeoutMs: 3000 });
          found.push({ ...p, models: await d.listModels() });
        }
      } catch { /* nothing there */ }
    }));
    return found.sort((a, b) => a.kind.localeCompare(b.kind));
  }
}

/** Ollama's daemon address without a trailing /v1 or /api. */
function ollamaBase(base: string): string {
  const u = parseBaseUrl(base);
  return `${u.origin}${basePath(u).replace(/\/(v1|api)$/, '')}`;
}

/** Reads a test chat until its first answer text (then stops it), so the check is quick and costs little. */
async function firstAnswer(client: AiClient, signal: AbortSignal): Promise<'text' | 'empty'> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener('abort', stop, { once: true });
  try {
    for await (const c of client.chat({ messages: [{ role: 'user', content: 'Reply with the word ready' }], maxTokens: 256, signal: controller.signal })) {
      if (c.type === 'delta' && c.text.trim()) return 'text';
      if (c.type === 'done') {
        if (c.reason && c.reason.code !== 'bad_answer') throw new AiError(c.reason.code, c.reason.message);
        return 'empty';
      }
    }
    return 'empty';
  } finally {
    signal.removeEventListener('abort', stop);
    controller.abort();
  }
}
