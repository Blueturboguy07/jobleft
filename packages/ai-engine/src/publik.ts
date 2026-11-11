// The publik connection (ai-engine O2, O6, O7) on top of Sign in with publik: this computer's publik key comes from
// the sign-in gate (the publik module, apps/server/src/publik.ts, keeps it in the publik credential file), never
// from a mint of its own. "Connect" is the person's answer "pay for AI with my publik plan" (the module's
// setChoice('publik')); "disconnect" is "use my own key" (setChoice('own_key')): nothing spends the balance after it.
// This client reads the balance in dollars, gives the one top-up link, and turns gateway failures into plain words.
// Contract: ~/publik-api-research/CONTRACT.md sections 1, 3.2 and 12; memo R21 sections 2.1 to 2.6.

import type { PublikConnection, PublikWallet } from '@jobleft/contracts';
import { formatDollars, nowIso, nowMs } from '@jobleft/contracts';
import { AiError } from './errors.ts';
import { memoryKvStore, type KvStore } from './state.ts';
import { looksLikeHtml, send, tryJson } from './transport.ts';

/** Version of the two-sentence disclosure shown before the app connects to publik. */
export const PUBLIK_DISCLOSURE_VERSION = 1;
/** The compiled default. Tests and development point JOBLEFT_PUBLIK_BASE_URL at a local stand-in. */
export const PUBLIK_DEFAULT_BASE_URL = 'https://publikhq.com/api/v1';
/** The three publik tiers. publik-balanced is the default. */
export const PUBLIK_TIERS = ['publik-fast', 'publik-balanced', 'publik-smart'] as const;
export const PUBLIK_DEFAULT_MODEL = 'publik-balanced';

/** The disclosure, shown before connecting (version PUBLIK_DISCLOSURE_VERSION). Two sentences. */
export const PUBLIK_DISCLOSURE = [
  'jobleft can send its AI requests to the publik API: each request is priced per use and paid in dollars from your publik balance. Your balance starts at $0.00; linking a publik account gives $0.05 of free use, once.',
  'Your prompts go through publik\'s servers to the AI model\'s provider, publik does not train on them, and you can change to a local model or your own key at any time.',
] as const;

/** Why it costs money (publik CONTRACT section 12 and 13). Shown on the balance card after connecting. */
export const PUBLIK_JUSTIFICATION =
  'The AI model behind publik charges per use; publik charges a fixed, published price per tier, a little above what the model costs publik, which keeps publik running and pays the app\'s developer. Nothing is charged behind your back, and every call is listed on your publik dashboard.';

const PUBLIK_SITE = 'https://publikhq.com';
const FALLBACK_TOP_UP = 'https://publikhq.com/dashboard/api';
/**
 * How old the kept wallet may be before latest() reads the balance again. An unlinked (anonymous) computer is read
 * sooner: the person is on publikhq.com linking it, and the screen must show the link and the plan money without a
 * click. A linked one changes only when an AI step runs (which updates the wallet itself) or when money is added.
 */
export const WALLET_STALE_MS = { anonymous: 5_000, claimed: 20_000 } as const;
/** latest() reads publik at most this often, whatever the screens ask, and gives up fast when publik is slow. */
const LATEST_GAP_MS = 5_000;
const LATEST_CONNECT_TIMEOUT_MS = 3_000;
const LATEST_IDLE_TIMEOUT_MS = 8_000;

/** The key-free facts this client keeps (the kept wallet, where it came from). The key itself stays with the sign-in. */
interface PublikState {
  installId: string | null;
  baseUrl: string | null;
  disclosureVersion: number | null;
  wallet: PublikWallet | null;
  connectedAt: string | null;
}

const EMPTY: PublikState = { installId: null, baseUrl: null, disclosureVersion: null, wallet: null, connectedAt: null };

/** This computer's publik credential, as Sign in with publik stored it (the publik module's credential file). */
export interface PublikSignInCredential {
  key: string;
  baseUrl: string;
  installId: string;
  claimUrl: string | null;
  /** The person's answer to "how does this app pay for AI": connect your plan, use my own key, or not answered yet. */
  choice: 'publik' | 'own_key' | null;
}

/**
 * Where the key comes from: Sign in with publik. The server passes the publik module (readCredential, setChoice,
 * provision); tests and the CLI pass a memory one. The engine never mints a key itself.
 */
export interface PublikSignIn {
  /** The stored credential, or null before this computer signed in. Read on every call; never cached here. */
  credential(): PublikSignInCredential | null;
  /** Stores the answer to the plan screen. null = ask again at the next start. */
  setChoice(choice: 'publik' | 'own_key' | null): void;
  /** Makes this computer's install when there is none (POST /installs through the module). Throws a readable message. */
  provision(): Promise<PublikSignInCredential>;
}

/** A sign-in that lives in memory (tests, the CLI): `mint` stands in for the module's provision(). */
export function memoryPublikSignIn(initial: PublikSignInCredential | null = null, mint?: () => Promise<PublikSignInCredential>): PublikSignIn & { current: PublikSignInCredential | null } {
  const s = {
    current: initial,
    credential: () => s.current,
    setChoice(choice: 'publik' | 'own_key' | null) { if (s.current) s.current = { ...s.current, choice }; },
    async provision() {
      if (!mint) throw new Error('Sign in with publik happens when the jobleft app starts. Start jobleft, or set PUBLIK_API_KEY for development.');
      s.current = { ...(await mint()), choice: s.current?.choice ?? null };
      return s.current;
    },
  };
  return s;
}

export interface PublikClientOptions {
  baseUrl: string;
  signIn: PublikSignIn;
  /** Kept for the interface; the client uses its own transport (connect and silence limits). */
  fetchImpl?: typeof fetch;
  /** Where the key-free connection state lives (install id, last balance, links). Default: memory. */
  state?: KvStore;
  appVersion?: string;
  connectTimeoutMs?: number;
  /** true while the app is in offline mode: latest() then reads nothing over the network. */
  offline?: () => boolean;
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

export class PublikClient {
  private readonly baseUrl: string;
  private readonly signIn: PublikSignIn;
  private readonly kv: KvStore;
  private readonly appVersion: string;
  private readonly connectTimeoutMs: number | undefined;
  private readonly offline: () => boolean;
  private connecting = false;
  private readonly disconnectListeners = new Set<() => void>();
  /** The balance read latest() has under way (every caller waits for the same one), and when the last one started. */
  private reading: Promise<PublikConnection> | null = null;
  private lastReadAt = 0;

  constructor(opts: PublikClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.signIn = opts.signIn;
    this.kv = opts.state ?? memoryKvStore();
    this.appVersion = opts.appVersion ?? '0.1.0';
    this.connectTimeoutMs = opts.connectTimeoutMs;
    this.offline = opts.offline ?? (() => false);
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

  /** A base URL publik gave (the module's credential): kept when it is on the configured origin or publikhq.com. */
  private acceptBase(given: string | null | undefined): string {
    const base = typeof given === 'string' ? given.replace(/\/+$/, '') : '';
    if (!base) return this.baseUrl;
    try {
      const o = new URL(base).origin;
      if (o === new URL(this.baseUrl).origin || o === PUBLIK_SITE) return base;
    } catch { /* keep the configured address */ }
    return this.baseUrl;
  }

  /** Connected = signed in and the person chose to pay for AI with the publik plan (the module's choice "publik"). */
  private connectedCredential(): PublikSignInCredential | null {
    const c = this.signIn.credential();
    return c && c.choice === 'publik' ? c : null;
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
    const c = this.connectedCredential();
    if (!c) return { state: 'disconnected', wallet: null, disclosureVersion: null };
    const s = this.load();
    // A kept wallet belongs to the install it was read for; a new install (a re-provision) starts without one.
    const wallet = s.installId === c.installId ? s.wallet : null;
    return { state: 'connected', wallet, disclosureVersion: s.disclosureVersion ?? PUBLIK_DISCLOSURE_VERSION };
  }

  /**
   * The connection for a screen: status(), plus a quick balance read (GET /wallet) when the kept wallet can be old:
   * there is none, or it is older than WALLET_STALE_MS for its claim state. So the screen shows a link made on
   * publikhq.com, and the plan money, without a click ("Read the balance again") and without an AI step.
   * The read is short (3 s to connect) and at most one per 5 s; several callers at once wait for the same one;
   * when it fails, or in offline mode, the kept wallet is shown as before, with its own "last read" time.
   */
  async latest(): Promise<PublikConnection> {
    const current = await this.status();
    if (current.state !== 'connected' || this.offline()) return current;
    if (this.reading) return this.reading;
    const now = nowMs();
    const w = current.wallet;
    const age = w ? now - Date.parse(w.updatedAt) : Infinity;
    if (Number.isFinite(age) && age < WALLET_STALE_MS[w!.claimState]) return current;
    if (now - this.lastReadAt < LATEST_GAP_MS) return current;
    this.lastReadAt = now;
    this.reading = this.refresh({ connectTimeoutMs: LATEST_CONNECT_TIMEOUT_MS, idleTimeoutMs: LATEST_IDLE_TIMEOUT_MS })
      .catch(() => this.status())
      .finally(() => { this.reading = null; });
    return this.reading;
  }

  /**
   * Connect your plan: the person's answer to the gate's question, after the disclosure. No key is typed or shown;
   * this computer's key came from Sign in with publik. Before the gate ran (a dev run, a test), the sign-in's
   * provision() makes the install first.
   */
  async connect(disclosureVersion: number): Promise<PublikConnection> {
    if (!Number.isInteger(disclosureVersion) || disclosureVersion !== PUBLIK_DISCLOSURE_VERSION) {
      throw new AiError('bad_request', 'Show the current publik disclosure and accept it before connecting.');
    }
    const current = await this.status();
    if (current.state === 'connected') return current; // one connection, one key: never a second install
    if (this.connecting) throw new AiError('bad_request', 'publik is already connecting. Wait a moment.');
    this.connecting = true;
    try {
      let c = this.signIn.credential();
      if (!c) {
        try { c = await this.signIn.provision(); } catch (e) {
          if (e instanceof AiError) throw e;
          const msg = e instanceof Error ? e.message : String(e);
          if (/not reachable|fetch failed|abort|timeout/i.test(msg) || e instanceof TypeError) throw new AiError('unreachable', 'publik cannot be reached right now, so nothing was connected. Check your connection and try again.');
          throw new AiError('not_ready', `${msg} Nothing was connected.`.replace(/\.\s+Nothing/, '. Nothing'));
        }
      }
      this.signIn.setChoice('publik');
      const prior = this.load();
      // The kept wallet survives a disconnect and reconnect of the same install (JL-settings-9: same balance).
      const wallet = prior.installId === c.installId ? prior.wallet : null;
      this.save({ installId: c.installId, baseUrl: this.acceptBase(c.baseUrl), disclosureVersion, wallet, connectedAt: nowIso() });
    } finally {
      this.connecting = false;
    }
    if (!this.load().wallet) {
      try { await this.refresh(); } catch { /* the balance shows as unknown until the next refresh */ }
    }
    return this.status();
  }

  /**
   * Use my own key: nothing spends the balance after this returns. This computer stays signed in (the key stays with
   * the sign-in, so Connect returns to the same install and balance, JL-settings-9); the app just stops using it.
   */
  async disconnect(): Promise<PublikConnection> {
    for (const stop of this.disconnectListeners) { try { stop(); } catch { /* ignore */ } }
    this.signIn.setChoice('own_key');
    return { state: 'disconnected', wallet: null, disclosureVersion: null };
  }

  /** Forgets the kept wallet and the answer to the plan screen (delete all data): the next start asks again. */
  forget(): void {
    this.save({ ...EMPTY });
    this.signIn.setChoice(null);
  }

  /** Reads the balance again (GET /wallet). */
  async refresh(limits: { connectTimeoutMs?: number; idleTimeoutMs?: number } = {}): Promise<PublikConnection> {
    const c = this.connectedCredential();
    if (!c) return this.status();
    const s = this.load();
    const base = s.installId === c.installId && s.baseUrl ? s.baseUrl : this.acceptBase(c.baseUrl);
    const res = await send({
      method: 'GET', url: `${base}/wallet`, headers: { authorization: `Bearer ${c.key}` },
      connectTimeoutMs: limits.connectTimeoutMs ?? this.connectTimeoutMs, idleTimeoutMs: limits.idleTimeoutMs ?? 30_000,
    });
    const raw = await res.text();
    if (res.status >= 400) throw await this.failure(res.status, res.headers, raw);
    if (looksLikeHtml(res.headers['content-type'], raw)) throw new AiError('not_ai_server', 'The publik address answered with a web page, not a balance. Check the publik address.');
    const wallet = this.walletFrom(tryJson(raw));
    const now = this.load();
    // A refusal for the daily limit is remembered until the limit starts again.
    const prev = now.installId === c.installId ? now.wallet?.daily : undefined;
    if (prev?.reachedAt && Date.parse(prev.resetsAt) > nowMs() && wallet.daily) wallet.daily = { ...wallet.daily, reachedAt: prev.reachedAt, resetsAt: prev.resetsAt };
    this.save({ ...now, installId: c.installId, baseUrl: base, wallet });
    return this.status();
  }

  /**
   * Updates the kept wallet from x-publik-* response headers after a paid call. `balance: false` (the headers of a
   * streamed answer, written before the charge) skips x-publik-balance: there it is the balance minus a temporary
   * hold, which the app must never show as spent money. The other fields are kept.
   */
  observeHeaders(headers: Headers | Record<string, string | undefined>, opts: { balance?: boolean } = {}): void {
    const get = (name: string): string | undefined => {
      if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
      return (headers as Record<string, string | undefined>)[name];
    };
    const s = this.load();
    if (!this.connectedCredential() || !s.wallet) return;
    const w: PublikWallet = { ...s.wallet, week: { ...s.wallet.week } };
    let changed = false;
    const balance = int(get('x-publik-balance') ?? get('x-publik-balance-micros'));
    if (balance !== null && opts.balance !== false) { w.balanceMicros = balance; changed = true; }
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
    const c = this.connectedCredential();
    if (!c) return null;
    const s = this.load();
    return { key: c.key, baseUrl: s.installId === c.installId && s.baseUrl ? s.baseUrl : this.acceptBase(c.baseUrl) };
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
      if (available !== null && this.connectedCredential() && s.wallet) {
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
      // The key is dead: nothing spends with it, and the next start signs this computer in again (the module makes
      // a new install when publik answers 401 to its key).
      for (const stop of this.disconnectListeners) { try { stop(); } catch { /* ignore */ } }
      this.signIn.setChoice(null);
      this.save({ ...EMPTY });
      return new AiError('key_refused', e.reprovision === true
        ? 'publik retired this connection because it was not used for a long time, so publik is now disconnected. Quit and open jobleft again to sign in.'
        : 'This computer was removed from your publik account, so publik is now disconnected. Quit and open jobleft again to sign in.');
    }
    if (status === 401) return new AiError('key_refused', 'publik no longer accepts this connection. Quit and open jobleft again to sign in.');
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
      if (this.connectedCredential() && s.wallet) this.save({ ...s, wallet: { ...s.wallet, daily } });
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
