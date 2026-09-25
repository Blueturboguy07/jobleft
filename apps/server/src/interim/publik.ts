// INTERIM stand-in for @jobleft/ai-engine PublikClient: the publik connection and the balance card.
//   * connect only after the person accepted the disclosure (version 1), and only with a publik app token
//     (none exists yet: gate G-publik), so a normal build answers a plain "not available" message;
//   * the key lives in the secret store only; the key-free state (balance, links) lives in srv_kv;
//   * nothing runs on its own: no balance check at start, no device id, no data-folder path is ever sent (O15);
//   * money is shown as a balance in dollars, never "credits".
// Wire format: the publik API contract (POST /installs, GET /wallet, POST /installs/revoke), as the ai-engine lane
// documents it. Tests point JOBLEFT_PUBLIK_BASE_URL at a loopback stand-in.

import { randomUUID } from 'node:crypto';
import { SECRET_NAMES, formatDollars, nowIso, type PublikConnection, type PublikWallet } from '@jobleft/contracts';
import { ApiFailure } from '../errors.ts';
import { outbound, outboundFailure } from '../net.ts';
import type { ServerSecretStore } from '../services/secrets.ts';
import type { Kv } from '../services/kv.ts';

export const PUBLIK_DISCLOSURE_VERSION = 1;
export const PUBLIK_DEFAULT_BASE_URL = 'https://publikhq.com/api/v1';
const PUBLIK_SITE = 'https://publikhq.com';
const FALLBACK_TOP_UP = 'https://publikhq.com/dashboard/api';

interface State { state: 'connected' | 'disconnected'; baseUrl: string | null; disclosureVersion: number | null; wallet: PublikWallet | null }
const EMPTY: State = { state: 'disconnected', baseUrl: null, disclosureVersion: null, wallet: null };

function int(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

export class PublikService {
  private readonly kv: Kv;
  private readonly secrets: ServerSecretStore;
  private readonly baseUrl: string;
  private readonly appToken: string | null;
  private readonly offline: () => boolean;
  private readonly appVersion: string;

  constructor(opts: { kv: Kv; secrets: ServerSecretStore; baseUrl: string; appToken: string | null; offline: () => boolean; appVersion: string }) {
    this.kv = opts.kv; this.secrets = opts.secrets; this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.offline = opts.offline; this.appVersion = opts.appVersion;
    // No real publik app token exists yet (gate G-publik). Until one ships with the app, a token from the
    // environment is used only with a loopback publik stand-in, so a test can never send anything to publikhq.com.
    let loopback = false;
    try { const h = new URL(this.baseUrl).hostname; loopback = h === '127.0.0.1' || h === 'localhost' || h === '[::1]'; } catch { /* not a URL */ }
    this.appToken = opts.appToken && loopback ? opts.appToken : null;
  }

  private load(): State { return { ...EMPTY, ...(this.kv.get<State>('publik') ?? {}) }; }
  private save(s: State): void { this.kv.set('publik', s); }

  private allowedLink(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    try {
      const u = new URL(v);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      return u.origin === PUBLIK_SITE || u.origin === new URL(this.baseUrl).origin ? u.toString() : null;
    } catch { return null; }
  }

  walletFrom(body: unknown): PublikWallet {
    const o = (body && typeof body === 'object' ? body : {}) as Record<string, any>;
    const balance = int(o.balance_micros ?? o.available_micros);
    if (balance === null) throw new ApiFailure('provider_error', 'publik sent a balance that jobleft cannot read. Nothing was changed.');
    const claimState = o.claim_state === 'claimed' ? 'claimed' : 'anonymous';
    const planRaw = typeof o.plan === 'string' ? o.plan : o.plan?.id;
    const claimUrl = this.allowedLink(o.claim_url);
    const addCreditUrl = this.allowedLink(o.add_credit_url);
    const starter = int(o.starter?.remaining_micros ?? o.starter_remaining_micros);
    const resets = typeof o.week?.resets_at === 'string' && Number.isFinite(Date.parse(o.week.resets_at)) ? new Date(Date.parse(o.week.resets_at)).toISOString() : null;
    return {
      claimState,
      balanceMicros: balance,
      starterRemainingMicros: starter !== null && starter > 0 ? starter : null,
      plan: planRaw === 'basic' || planRaw === 'pro' ? planRaw : 'none',
      week: { usedMicros: Math.max(0, int(o.week?.used_micros) ?? 0), budgetMicros: int(o.week?.budget_micros), resetsAt: resets },
      topUpUrl: this.allowedLink(o.top_up_url) ?? (claimState === 'anonymous' ? claimUrl : addCreditUrl) ?? FALLBACK_TOP_UP,
      claimUrl,
      addCreditUrl,
      updatedAt: nowIso(),
    };
  }

  async status(): Promise<PublikConnection> {
    const s = this.load();
    if (s.state === 'connected' && await this.secrets.get(SECRET_NAMES.publikKey)) {
      return { state: 'connected', wallet: s.wallet, disclosureVersion: s.disclosureVersion };
    }
    return { state: 'disconnected', wallet: null, disclosureVersion: null };
  }

  async connect(disclosureVersion: number): Promise<PublikConnection> {
    if (disclosureVersion !== PUBLIK_DISCLOSURE_VERSION) throw new ApiFailure('bad_request', 'Show the current publik disclosure and accept it before connecting.');
    const current = await this.status();
    if (current.state === 'connected') return current;
    if (!this.appToken) {
      throw new ApiFailure('not_ready', 'Connecting to publik is not available in this build yet (it has no publik app token). Nothing was sent. Choose a local model or your own key instead.');
    }
    let res: Response;
    try {
      res = await outbound(`${this.baseUrl}/installs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.appToken}` },
        body: JSON.stringify({
          app_token: this.appToken, app_slug: 'jobleft', app_version: this.appVersion,
          os: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
          device_name: process.platform === 'darwin' ? 'jobleft on macOS' : 'jobleft',
          install_id: randomUUID(), disclosure_version: disclosureVersion, dialects: ['chat_completions'],
        }),
      }, { offline: this.offline() });
    } catch (e) { throw outboundFailure(e, 'publik'); }
    const raw = await res.text();
    let body: Record<string, any> | undefined;
    try { body = JSON.parse(raw) as Record<string, any>; } catch { body = undefined; }
    if (res.status !== 200 && res.status !== 201) {
      throw new ApiFailure('provider_error', `publik refused the connection request (HTTP ${res.status}), so nothing was connected.`);
    }
    const key = typeof body?.key === 'string' ? body.key : null;
    if (!key || key.length > 500) throw new ApiFailure('provider_error', 'publik sent an answer that jobleft cannot use, so nothing was connected.');
    await this.secrets.set(SECRET_NAMES.publikKey, key);
    let wallet: PublikWallet | null = null;
    try { if (body?.wallet) wallet = this.walletFrom({ claim_url: body.claim_url, ...body.wallet }); } catch { wallet = null; }
    this.save({ state: 'connected', baseUrl: this.baseUrl, disclosureVersion, wallet });
    if (!wallet) { try { await this.refresh(); } catch { /* shown as unknown until the next refresh */ } }
    return this.status();
  }

  async refresh(): Promise<PublikConnection> {
    const s = this.load();
    const key = await this.secrets.get(SECRET_NAMES.publikKey);
    if (s.state !== 'connected' || !key) return this.status();
    let res: Response;
    try {
      res = await outbound(`${s.baseUrl ?? this.baseUrl}/wallet`, { method: 'GET', headers: { authorization: `Bearer ${key}` } }, { offline: this.offline() });
    } catch (e) { throw outboundFailure(e, 'publik'); }
    const raw = await res.text();
    if (res.status >= 400) throw new ApiFailure('provider_error', `publik did not return the balance (HTTP ${res.status}). Nothing was changed.`);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { throw new ApiFailure('provider_error', 'publik sent a balance that jobleft cannot read. Nothing was changed.'); }
    this.save({ ...s, wallet: this.walletFrom(body) });
    return this.status();
  }

  async disconnect(): Promise<PublikConnection> {
    const s = this.load();
    const key = await this.secrets.get(SECRET_NAMES.publikKey);
    if (key && !this.offline()) {
      try {
        const res = await outbound(`${s.baseUrl ?? this.baseUrl}/installs/revoke`, { method: 'POST', headers: { authorization: `Bearer ${key}` } }, { offline: false, connectMs: 5000 });
        await res.text().catch(() => '');
      } catch { /* offline: the key is still deleted here */ }
    }
    await this.secrets.delete(SECRET_NAMES.publikKey);
    this.save({ ...EMPTY });
    return { state: 'disconnected', wallet: null, disclosureVersion: null };
  }

  /** The gateway for chat through publik, or null when not connected. */
  async gateway(): Promise<{ baseUrl: string; key: string } | null> {
    const s = this.load();
    if (s.state !== 'connected') return null;
    const key = await this.secrets.get(SECRET_NAMES.publikKey);
    return key ? { baseUrl: s.baseUrl ?? this.baseUrl, key } : null;
  }

  /** A 402 answer as one plain sentence in dollars with exactly one link (INTERFACES 6.2). */
  balanceFailure(raw: string): ApiFailure {
    let e: Record<string, any> = {};
    try { const b = JSON.parse(raw) as Record<string, any>; e = (b.error && typeof b.error === 'object' ? b.error : b) as Record<string, any>; } catch { /* keep empty */ }
    const available = int(e.available_micros);
    const link = this.allowedLink(e.top_up_url) ?? this.load().wallet?.topUpUrl ?? FALLBACK_TOP_UP;
    const amount = available !== null ? formatDollars(Math.max(0, available)) : null;
    const msg = amount ? `Your publik balance is too low for this request (${amount} left). Add money at the link below, then try again.` : 'Your publik balance is too low for this request. Add money at the link below, then try again.';
    return new ApiFailure('insufficient_balance', msg, { link: { label: 'Add to your publik balance', url: link } });
  }
}
