// The publik connection (ai-engine O2, O6, O7): provisioning with POST /installs after the disclosure (no key is
// typed, copied or shown), the balance in dollars, the one top-up link, and disconnect (the key is revoked at
// publik and deleted from this computer; nothing spends the balance afterwards).
// Contract: ~/publik-api-research/CONTRACT.md sections 1, 3.2 and 12; memo R21 sections 2.1 to 2.6.

import { randomUUID } from 'node:crypto';
import { arch as osArch, release as osRelease } from 'node:os';
import type { PublikConnection, PublikWallet, SecretStore } from '@jobleft/contracts';
import { formatDollars, nowIso, nowMs, SECRET_NAMES } from '@jobleft/contracts';
import { AiError } from './errors.ts';
import { memoryKvStore, type KvStore } from './state.ts';
import { looksLikeHtml, send, tryJson } from './transport.ts';

/** Version of the two-sentence disclosure shown before the app connects to publik. */
export const PUBLIK_DISCLOSURE_VERSION = 1;
/** The compiled default. Tests and development point JOBLEFT_PUBLIK_BASE_URL at a local stand-in. */
export const PUBLIK_DEFAULT_BASE_URL = 'https://publikhq.com/api/v1';
export const PUBLIK_APP_SLUG = 'jobleft';
/** The three publik tiers. publik-balanced is the default. */
export const PUBLIK_TIERS = ['publik-fast', 'publik-balanced', 'publik-smart'] as const;
export const PUBLIK_DEFAULT_MODEL = 'publik-balanced';

/** The disclosure, shown before connecting (version PUBLIK_DISCLOSURE_VERSION). Two sentences. */
export const PUBLIK_DISCLOSURE = [
  'jobleft can send its AI requests to the publik API: each request is priced per use and paid in dollars from your publik balance, which starts with a small free amount.',
  'Your prompts go through publik\'s servers to the AI model\'s provider, publik does not train on them, and you can change to a local model or your own key at any time.',
] as const;

/** Why it costs money (publik CONTRACT section 12 and 13). Shown on the balance card after connecting. */
export const PUBLIK_JUSTIFICATION =
  'The AI model behind publik charges per use; publik charges a fixed, published price per tier, a little above what the model costs publik, which keeps publik running and pays the app\'s developer. Nothing is charged behind your back, and every call is listed on your publik dashboard.';

const KEY_FORMAT = /^pk_(live|test)_[a-z0-9]{12}_[a-z0-9]{32}$/;
const PUBLIK_SITE = 'https://publikhq.com';
const FALLBACK_TOP_UP = 'https://publikhq.com/dashboard/api';

interface PublikState {
  state: 'connected' | 'disconnected';
  installId: string | null;
  baseUrl: string | null;
  disclosureVersion: number | null;
  wallet: PublikWallet | null;
  connectedAt: string | null;
}

const EMPTY: PublikState = { state: 'disconnected', installId: null, baseUrl: null, disclosureVersion: null, wallet: null, connectedAt: null };

export interface PublikClientOptions {
  baseUrl: string;
  appToken: string | null;
  secrets: SecretStore;
  /** Kept for the interface; the client uses its own transport (connect and silence limits). */
  fetchImpl?: typeof fetch;
  /** Where the key-free connection state lives (install id, last balance, links). Default: memory. */
  state?: KvStore;
  appVersion?: string;
  connectTimeoutMs?: number;
}

function int(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function iso(v: unknown): string | null {
  return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null;
}

/** The next midnight UTC (publik starts its daily spending limit again then). */
export function nextUtcMidnight(now: number = nowMs()): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

/** When the daily limit starts again, from publik's answer: resets_at, else Retry-After (snapped to midnight UTC). */
export function dailyResetFrom(resetsAt: unknown, retryAfter: unknown, now: number = nowMs()): string {
  const at = iso(resetsAt);
  if (at) return at;
  const secs = int(retryAfter);
  const midnight = nextUtcMidnight(now);
  if (secs === null || secs <= 0) return midnight;
  const t = now + secs * 1000;
  return Math.abs(t - Date.parse(midnight)) <= 120_000 ? midnight : new Date(t).toISOString();
}

/** "today at 7:00 PM CDT" in the person's time zone (JOBLEFT_TZ, else this computer's zone). */
function localClock(at: string, now: number = nowMs()): string {
  const tz = process.env.JOBLEFT_TZ || undefined;
  const fmt = (o: Intl.DateTimeFormatOptions, t: number) => {
    try { return new Date(t).toLocaleString('en-US', { ...o, ...(tz ? { timeZone: tz } : {}) }); } catch { return new Date(t).toLocaleString('en-US', o); }
  };
  const t = Date.parse(at);
  const day = (x: number) => fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }, x);
  const when = day(t) === day(now) ? 'today' : day(t) === day(now + 86_400_000) ? 'tomorrow' : fmt({ weekday: 'long' }, t);
  return `${when} at ${fmt({ hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }, t)}`;
}

/**
 * The words for publik's daily spending limit, the same for every AI step (chat, drafts, practice feedback, paid
 * lookups). publik refuses a step that would go over the limit; smaller steps may still fit, and nothing is charged
 * for a refused step.
 */
export function publikDailyLimitText(d: { capMicros: number | null; usedMicros: number | null; resetsAt: string; claimState: 'anonymous' | 'claimed' }): string {
  const amounts = d.capMicros !== null
    ? ` (${formatDollars(d.capMicros)} a day${d.usedMicros !== null ? `, ${formatDollars(d.usedMicros)} used so far` : ''})`
    : '';
  const midnight = /T00:00:00(\.000)?Z$/.test(d.resetsAt) ? ' (midnight UTC)' : '';
  return `This AI step would go over today's publik spending limit for this computer${amounts}, so publik did not run it and nothing was charged. `
    + `Your balance is not used up: smaller AI steps may still run. The limit starts again ${localClock(d.resetsAt)}${midnight}.`
    + (d.claimState === 'anonymous' ? ' Linking this computer to a publik account (Settings > Balance) raises the limit.' : '');
}

function contractOs(): 'macos' | 'windows' | 'linux' {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

export class PublikClient {
  private readonly baseUrl: string;
  private readonly appToken: string | null;
  private readonly secrets: SecretStore;
  private readonly kv: KvStore;
  private readonly appVersion: string;
  private readonly connectTimeoutMs: number | undefined;
  private connecting = false;
  private readonly disconnectListeners = new Set<() => void>();

  constructor(opts: PublikClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.appToken = opts.appToken;
    this.secrets = opts.secrets;
    this.kv = opts.state ?? memoryKvStore();
    this.appVersion = opts.appVersion ?? '0.1.0';
    this.connectTimeoutMs = opts.connectTimeoutMs;
  }

  private load(): PublikState {
    return { ...EMPTY, ...(this.kv.getJson<PublikState>('ai.publik') ?? {}) };
  }
  private save(s: PublikState): void {
    this.kv.setJson('ai.publik', s);
  }

  /** A link publik sent, kept only when it is on publikhq.com or on the configured publik address (a stand-in). */
  private allowedLink(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    let u: URL;
    try { u = new URL(v); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.origin === PUBLIK_SITE || u.origin === new URL(this.baseUrl).origin) return u.toString();
    return null;
  }

  /** The API root to use: publik's answer when it is on the same origin or publikhq.com, else the configured one. */
  private gatewayBase(s: PublikState = this.load()): string {
    return s.baseUrl ?? this.baseUrl;
  }

  /** Maps a GET /wallet body (R21 section 2.3) to the contract. Refuses a body without a balance (never a $0.00 guess). */
  walletFrom(body: unknown): PublikWallet {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, any>;
    const balance = int(b.balance_micros ?? b.available_micros);
    if (balance === null) throw new AiError('provider_error', 'publik sent a balance that jobleft cannot read. Nothing was changed; try again later.');
    const claimState = b.claim_state === 'claimed' ? 'claimed' : 'anonymous';
    const planRaw = typeof b.plan === 'string' ? b.plan : b.plan?.id;
    const plan = planRaw === 'basic' || planRaw === 'pro' ? planRaw : 'none';
    const starter = int(b.starter?.remaining_micros ?? b.starter_remaining_micros);
    const claimUrl = this.allowedLink(b.claim_url);
    const addCreditUrl = this.allowedLink(b.add_credit_url);
    // The daily limit, when publik reports it (JL-network-19). Never a guessed amount: unknown stays null.
    const dailyCap = int(b.daily_cap_micros ?? b.daily?.cap_micros);
    const dailyUsed = int(b.spent_today_micros ?? b.daily?.used_micros ?? b.daily?.spent_micros);
    const topUpUrl = this.allowedLink(b.top_up_url) ?? (claimState === 'anonymous' ? claimUrl : addCreditUrl) ?? claimUrl ?? addCreditUrl ?? FALLBACK_TOP_UP;
    return {
      claimState,
      balanceMicros: balance,
      starterRemainingMicros: starter !== null && starter > 0 ? starter : null,
      plan,
      week: {
        usedMicros: Math.max(0, int(b.week?.used_micros) ?? 0),
        budgetMicros: int(b.week?.budget_micros),
        resetsAt: iso(b.week?.resets_at),
      },
      topUpUrl,
      claimUrl,
      addCreditUrl,
      updatedAt: nowIso(),
      daily: {
        capMicros: dailyCap !== null && dailyCap >= 0 ? dailyCap : null,
        usedMicros: dailyUsed !== null && dailyUsed >= 0 ? dailyUsed : null,
        resetsAt: iso(b.daily?.resets_at) ?? nextUtcMidnight(),
        reachedAt: null,
      },
    };
  }

  /** The connection as the app shows it. Reads no network; call refresh() for a new balance. */
  async status(): Promise<PublikConnection> {
    if (this.connecting) return { state: 'connecting', wallet: null, disclosureVersion: null };
    const s = this.load();
    if (s.state === 'connected') {
      const key = await this.secrets.get(SECRET_NAMES.publikKey);
      if (!key) {
        // The key is gone (deleted outside the app): the connection is gone too.
        this.save({ ...EMPTY });
        return { state: 'disconnected', wallet: null, disclosureVersion: null };
      }
      return { state: 'connected', wallet: s.wallet, disclosureVersion: s.disclosureVersion };
    }
    return { state: 'disconnected', wallet: null, disclosureVersion: null };
  }

  /** POST /installs after the person accepted the disclosure. No key is typed or shown. */
  async connect(disclosureVersion: number): Promise<PublikConnection> {
    if (!Number.isInteger(disclosureVersion) || disclosureVersion !== PUBLIK_DISCLOSURE_VERSION) {
      throw new AiError('bad_request', 'Show the current publik disclosure and accept it before connecting.');
    }
    // No app token: say so before anything is read or sent (a status read would turn into "unreachable").
    if (!this.appToken) {
      throw new AiError('not_ready', 'Connecting to publik is not available in this build yet (it has no publik app token). Choose a local model or your own key instead.');
    }
    const current = await this.status();
    if (current.state === 'connected') return current; // one connection, one key: never a second mint
    if (this.connecting) throw new AiError('bad_request', 'publik is already connecting. Wait a moment.');
    this.connecting = true;
    try {
      // Nothing half-done is kept: the key is saved only after a valid answer, and state only after the key.
      await this.secrets.delete(SECRET_NAMES.publikKey);
      let installId = randomUUID();
      let answer = await this.mint(installId, disclosureVersion);
      if (answer.status === 200 && (answer.body?.key === null || answer.body?.key === undefined)) {
        installId = randomUUID(); // a replay without a saved key: mint once more with a new install id (R21 section 2.1)
        answer = await this.mint(installId, disclosureVersion);
      }
      const body = answer.body;
      if (answer.status !== 201 && answer.status !== 200) throw this.mintFailure(answer.status, answer.raw, answer.contentType);
      const key = typeof body?.key === 'string' ? body.key : null;
      if (!key || !KEY_FORMAT.test(key)) {
        throw new AiError('provider_error', 'publik sent an answer that jobleft cannot use, so nothing was connected. Try again later.');
      }
      const responseBase = typeof body?.base_url === 'string' ? body.base_url.replace(/\/+$/, '') : null;
      let baseUrl = this.baseUrl;
      if (responseBase) {
        try {
          const o = new URL(responseBase).origin;
          if (o === new URL(this.baseUrl).origin || o === PUBLIK_SITE) baseUrl = responseBase;
        } catch { /* keep the configured address */ }
      }
      await this.secrets.set(SECRET_NAMES.publikKey, key);
      let wallet: PublikWallet | null = null;
      try {
        if (body?.wallet && typeof body.wallet === 'object' && (body.wallet.balance_micros !== undefined || body.wallet.available_micros !== undefined)) {
          wallet = this.walletFrom({ claim_url: body.claim_url, ...body.wallet });
        } else if (body?.balance_micros !== undefined) {
          wallet = this.walletFrom(body);
        }
      } catch { wallet = null; }
      this.save({ state: 'connected', installId, baseUrl, disclosureVersion, wallet, connectedAt: nowIso() });
    } finally {
      this.connecting = false;
    }
    if (!this.load().wallet) {
      try { await this.refresh(); } catch { /* the balance shows as unknown until the next refresh */ }
    }
    return this.status();
  }

  private async mint(installId: string, disclosureVersion: number): Promise<{ status: number; body: Record<string, any> | undefined; raw: string; contentType: string | undefined }> {
    const res = await send({
      method: 'POST',
      url: `${this.baseUrl}/installs`,
      // The contract accepts the public app token in the header or in the body; both are sent (it is not a secret).
      headers: { authorization: `Bearer ${this.appToken}` },
      body: JSON.stringify({
        app_token: this.appToken,
        app_slug: PUBLIK_APP_SLUG,
        app_version: this.appVersion.slice(0, 32),
        os: contractOs(),
        os_version: osRelease().slice(0, 32),
        arch: osArch().slice(0, 16),
        // A coarse name only: a computer's own name often holds its owner's name.
        device_name: `jobleft on ${contractOs() === 'macos' ? 'macOS' : contractOs() === 'windows' ? 'Windows' : 'Linux'}`,
        install_id: installId,
        disclosure_version: disclosureVersion,
        dialects: ['chat_completions', 'embeddings'],
      }),
      connectTimeoutMs: this.connectTimeoutMs,
      idleTimeoutMs: 30_000,
    });
    const raw = await res.text();
    return { status: res.status, body: tryJson(raw) as Record<string, any> | undefined, raw, contentType: res.headers['content-type'] };
  }

  private mintFailure(status: number, raw: string, contentType: string | undefined): AiError {
    if (looksLikeHtml(contentType, raw)) return new AiError('not_ai_server', 'The publik address answered with a web page, so nothing was connected. Check the publik address.');
    if (status === 401 || status === 403) return new AiError('provider_error', 'publik did not accept this build of jobleft, so nothing was connected. Update jobleft, or choose another provider.');
    if (status === 429) return new AiError('provider_error', 'publik is limiting new connections from this network right now, so nothing was connected. Try again later.');
    if (status >= 500) return new AiError('provider_error', 'publik is not available right now, so nothing was connected. Try again in a few minutes.');
    return new AiError('provider_error', `publik refused the connection request (HTTP ${status}), so nothing was connected.`);
  }

  /** Deletes the key from the secret store; nothing spends the balance after this returns. */
  async disconnect(): Promise<PublikConnection> {
    for (const stop of this.disconnectListeners) { try { stop(); } catch { /* ignore */ } }
    const s = this.load();
    const key = await this.secrets.get(SECRET_NAMES.publikKey);
    if (key) {
      // Revoke at publik first (best effort, 5 s): the key then stops working even if a copy survived somewhere.
      try {
        const res = await send({ method: 'POST', url: `${this.gatewayBase(s)}/installs/revoke`, headers: { authorization: `Bearer ${key}` }, connectTimeoutMs: Math.min(this.connectTimeoutMs ?? 5000, 5000), idleTimeoutMs: 5000 });
        await res.text().catch(() => '');
      } catch { /* offline: the key is still deleted here, and publik's idle sweep revokes it later */ }
    }
    await this.secrets.delete(SECRET_NAMES.publikKey);
    if (await this.secrets.get(SECRET_NAMES.publikKey)) {
      throw new AiError('not_ready', 'jobleft could not delete the publik key from this computer. Unlock the Keychain and try again.');
    }
    this.save({ ...EMPTY });
    return { state: 'disconnected', wallet: null, disclosureVersion: null };
  }

  /** Reads the balance again (GET /wallet). */
  async refresh(): Promise<PublikConnection> {
    const s = this.load();
    const key = await this.secrets.get(SECRET_NAMES.publikKey);
    if (s.state !== 'connected' || !key) return this.status();
    const res = await send({ method: 'GET', url: `${this.gatewayBase(s)}/wallet`, headers: { authorization: `Bearer ${key}` }, connectTimeoutMs: this.connectTimeoutMs, idleTimeoutMs: 30_000 });
    const raw = await res.text();
    if (res.status >= 400) throw await this.failure(res.status, res.headers, raw);
    if (looksLikeHtml(res.headers['content-type'], raw)) throw new AiError('not_ai_server', 'The publik address answered with a web page, not a balance. Check the publik address.');
    const wallet = this.walletFrom(tryJson(raw));
    const now = this.load();
    // A refusal for the daily limit is remembered until the limit starts again.
    const prev = now.wallet?.daily;
    if (prev?.reachedAt && Date.parse(prev.resetsAt) > nowMs() && wallet.daily) wallet.daily = { ...wallet.daily, reachedAt: prev.reachedAt, resetsAt: prev.resetsAt };
    if (now.state === 'connected') this.save({ ...now, wallet });
    return this.status();
  }

  /** Updates the kept wallet from x-publik-* response headers after a paid call. */
  observeHeaders(headers: Headers | Record<string, string | undefined>): void {
    const get = (name: string): string | undefined => {
      if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
      return (headers as Record<string, string | undefined>)[name];
    };
    const s = this.load();
    if (s.state !== 'connected' || !s.wallet) return;
    const w: PublikWallet = { ...s.wallet, week: { ...s.wallet.week } };
    let changed = false;
    const balance = int(get('x-publik-balance') ?? get('x-publik-balance-micros'));
    if (balance !== null) { w.balanceMicros = balance; changed = true; }
    const claim = get('x-publik-claim-state');
    if (claim === 'claimed' || claim === 'anonymous') {
      if (w.claimState !== claim) {
        w.claimState = claim;
        w.topUpUrl = (claim === 'claimed' ? w.addCreditUrl : w.claimUrl) ?? w.topUpUrl;
      }
      changed = true;
    }
    const starter = int(get('x-publik-starter-remaining'));
    if (starter !== null) { w.starterRemainingMicros = starter > 0 ? starter : null; changed = true; }
    const used = int(get('x-publik-week-used'));
    if (used !== null) { w.week.usedMicros = Math.max(0, used); changed = true; }
    const budget = get('x-publik-week-budget');
    if (budget !== undefined) { w.week.budgetMicros = budget === 'none' ? null : int(budget); changed = true; }
    const resets = iso(get('x-publik-week-resets-at'));
    if (resets) { w.week.resetsAt = resets; changed = true; }
    if (!changed) return;
    w.updatedAt = nowIso();
    this.save({ ...s, wallet: w });
  }

  /** The cost publik stamped on a non-streamed answer (x-publik-charge-micros), or null. Never an estimate. */
  static costFromHeaders(headers: Record<string, string>): number | null {
    return int(headers['x-publik-charge-micros']);
  }

  /** @internal The key for gateway calls. Only the AI engine's publik driver calls this; it never leaves the process. */
  async gatewayKey(): Promise<{ key: string; baseUrl: string } | null> {
    const s = this.load();
    if (s.state !== 'connected') return null;
    const key = await this.secrets.get(SECRET_NAMES.publikKey);
    return key ? { key, baseUrl: this.gatewayBase(s) } : null;
  }

  /** @internal Called on disconnect (the engine stops running publik requests). */
  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  /**
   * A failed gateway answer, in plain words. 402: one message with the balance in dollars and exactly one link
   * (top_up_url). 403 key_revoked: the connection is removed from this computer. Never publik's own wording.
   */
  async failure(status: number, headers: Record<string, string>, raw: string): Promise<AiError> {
    const body = tryJson(raw) as Record<string, any> | undefined;
    const e = (body?.error && typeof body.error === 'object' ? body.error : body?.type === 'error' ? body.error : {}) ?? {};
    const type = String(e.type ?? e.code ?? '');
    if (status === 402 && type === 'model_requires_claim') {
      const link = this.allowedLink(e.top_up_url) ?? this.allowedLink(e.claim_url) ?? this.load().wallet?.claimUrl ?? FALLBACK_TOP_UP;
      return new AiError('needs_claim', 'publik-smart needs a publik account linked to this computer. Link this computer at the link below, or choose publik-balanced.', link);
    }
    if (status === 402) {
      const s = this.load();
      const available = int(e.available_micros);
      const claimState = e.claim_state === 'claimed' || e.claim_state === 'anonymous' ? e.claim_state : s.wallet?.claimState ?? 'anonymous';
      const link = this.allowedLink(e.top_up_url)
        ?? (claimState === 'anonymous' ? this.allowedLink(e.claim_url) : this.allowedLink(e.add_credit_url))
        ?? s.wallet?.topUpUrl ?? FALLBACK_TOP_UP;
      if (available !== null && s.state === 'connected' && s.wallet) {
        this.save({ ...s, wallet: { ...s.wallet, balanceMicros: available, claimState, topUpUrl: link, updatedAt: nowIso() } });
      }
      const amount = available !== null ? formatDollars(available) : null;
      const first = available !== null && available <= 0
        ? `Your publik balance ran out (${amount} left).`
        : amount !== null
          ? `Your publik balance is too low for this request (${amount} left).`
          : 'Your publik balance is too low for this request.';
      const next = claimState === 'anonymous' ? 'Link this computer and pick a plan at the link below' : 'Add a plan or a pack at the link below';
      return new AiError('insufficient_balance', `${first} ${next}, then send your message again.`, link);
    }
    if (status === 403 && type === 'key_revoked') {
      await this.secrets.delete(SECRET_NAMES.publikKey);
      this.save({ ...EMPTY });
      return new AiError('key_refused', e.reprovision === true
        ? 'publik retired this connection because it was not used for a long time, so publik is now disconnected. Connect again to use it.'
        : 'This computer was removed from your publik account, so publik is now disconnected. Connect again to use it.');
    }
    if (status === 401) return new AiError('key_refused', 'publik no longer accepts this connection. Disconnect publik and connect again.');
    if (status === 400 && /unknown_model/.test(type)) return new AiError('model_not_found', `publik does not have this model. Choose ${PUBLIK_TIERS.join(', ')}.`);
    if (status === 429 && type === 'daily_cap_reached') {
      // Not "you reached the limit": publik refused THIS step because it would go over; smaller ones may still fit.
      const s = this.load();
      const prev = s.wallet?.daily ?? null;
      const resetsAt = dailyResetFrom(e.resets_at, headers['retry-after']);
      const daily = {
        capMicros: int(e.daily_cap_micros ?? e.cap_micros) ?? prev?.capMicros ?? null,
        usedMicros: int(e.spent_today_micros ?? e.used_micros) ?? prev?.usedMicros ?? null,
        resetsAt, reachedAt: nowIso(),
      };
      if (s.state === 'connected' && s.wallet) this.save({ ...s, wallet: { ...s.wallet, daily } });
      return new AiError('provider_error', publikDailyLimitText({ ...daily, claimState: s.wallet?.claimState ?? 'anonymous' }));
    }
    if (status === 429) return new AiError('provider_error', 'publik is limiting requests right now. Wait a minute, then try again.');
    if (status === 413) return new AiError('provider_error', 'The request is too large for publik (the limit is 4 MB). Try a shorter text.');
    if (status === 503 || status === 502) return new AiError('provider_error', 'publik is not available right now. Nothing was charged. Try again in a minute.');
    if (looksLikeHtml(headers['content-type'], raw)) return new AiError('not_ai_server', 'The publik address answered with a web page, not an AI answer. Check the publik address.');
    if (status >= 500) return new AiError('provider_error', `publik had an internal error (HTTP ${status}). Try again later.`);
    return new AiError('provider_error', `publik refused the request (HTTP ${status}).`);
  }
}
