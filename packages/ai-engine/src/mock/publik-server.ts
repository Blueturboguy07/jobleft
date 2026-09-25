// Stand-in publik API (test tool), written from ~/publik-api-research/CONTRACT.md sections 1, 3.2 and 12 and memo
// R21 sections 2.1 to 2.6. It connects an app (POST /installs), holds ONE dollar balance, charges a fixed price per
// metered call, answers "balance too low" (402 with one top_up_url), and logs every request with its headers.
// Base URL: http://127.0.0.1:<port>/api/v1. It never contacts anything else.

import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { answerFor, pieces, readBody, RequestLog, sendJson, sleep } from './common.ts';

export const STANDIN_APP_TOKEN = 'pat_jobleft_devstandin0000000000000000000000';
export const PUBLIK_MODES = ['ok', 'stall', 'half', 'unavailable', 'revoked'] as const;
export type PublikMode = (typeof PUBLIK_MODES)[number];

export interface MockPublikOptions {
  port?: number;
  /** Starting balance in US dollars (default 5.00). */
  balanceUsd?: number;
  /** Price of one metered call in US dollars (default 0.01). */
  priceUsd?: number;
  appToken?: string;
  log?: string | null;
}

export interface MockPublikServer {
  port: number;
  baseUrl: string;
  log: RequestLog;
  state(): { balanceMicros: number; priceMicros: number; claimState: 'anonymous' | 'claimed'; charges: number; keys: number; liveKeys: number };
  setBalanceMicros(m: number): void;
  close(): Promise<void>;
}

const TIERS = ['publik-fast', 'publik-balanced', 'publik-smart'];
const COMPAT: Record<string, string> = { 'gpt-4o-mini': 'publik-fast', 'gpt-4o': 'publik-balanced', 'publik-default': 'publik-balanced', 'claude-haiku-4-5': 'publik-fast', 'claude-sonnet-4-5': 'publik-balanced' };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function rand(n: number, chars = 'abcdefghijklmnopqrstuvwxyz0123456789'): string {
  const bytes = randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += chars[bytes[i]! % chars.length];
  return s;
}

export async function startMockPublikServer(opts: MockPublikOptions = {}): Promise<MockPublikServer> {
  const appToken = opts.appToken ?? STANDIN_APP_TOKEN;
  let balance = Math.round((opts.balanceUsd ?? 5) * 1_000_000);
  let price = Math.round((opts.priceUsd ?? 0.01) * 1_000_000);
  let claimState: 'anonymous' | 'claimed' = 'anonymous';
  let weekUsed = 0;
  let charges = 0;
  let mode: PublikMode = 'ok';
  const log = new RequestLog('publik', opts.log ?? null);
  const installs = new Map<string, { keyHash: string; revoked: boolean; claimCode: string }>();
  const keys = new Map<string, { installId: string; revoked: boolean; reprovision: boolean }>();
  const sockets = new Set<Socket>();
  let port = 0;
  const base = () => `http://127.0.0.1:${port}/api/v1`;
  const claimCode = `${rand(4, ALPHABET)}-${rand(4, ALPHABET)}`;
  const claimUrl = `https://publikhq.com/claim/${claimCode}`;
  const addCreditUrl = 'https://publikhq.com/dashboard/api/add';
  const resetsAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const topUp = () => (claimState === 'anonymous' ? claimUrl : addCreditUrl);

  const wallet = (installId: string | null) => ({
    install_id: installId, app_slug: 'jobleft', claim_state: claimState,
    balance_micros: balance,
    starter: { remaining_micros: 0, expires_at: null },
    plan: { id: 'none', label: 'No plan', monthly_micros: 0 },
    week: { used_micros: weekUsed, budget_micros: null, resets_at: resetsAt, window_days: 7 },
    daily_cap_micros: 2_000_000, spent_today_micros: weekUsed,
    claim_code: claimState === 'anonymous' ? claimCode : null,
    claim_url: claimState === 'anonymous' ? claimUrl : null,
    add_credit_url: addCreditUrl,
    plans_url: 'https://publikhq.com/developers#plans',
    price_epoch: 'stand-in',
  });
  const meterHeaders = (model: string | null): Record<string, string> => ({
    'x-publik-request-id': `req_${rand(12)}`,
    ...(model ? { 'x-publik-model': model } : {}),
    'x-publik-balance': String(balance),
    'x-publik-week-used': String(weekUsed),
    'x-publik-week-budget': 'none',
    'x-publik-week-resets-at': resetsAt,
    'x-publik-claim-state': claimState,
  });
  const common = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  const err = (res: http.ServerResponse, status: number, type: string, message: string, extra: Record<string, unknown> = {}) =>
    sendJson(res, status, { error: { type, message, ...extra } }, { ...common, 'x-publik-request-id': `req_${rand(12)}`, ...(status === 401 || status === 402 || status === 403 || status === 429 ? { 'x-should-retry': 'false' } : {}) });

  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const entry = log.add(req, raw);
    let body: Record<string, any> = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }

    // ---- admin for testers
    if (path.startsWith('/__admin')) {
      if (path === '/__admin/log') return sendJson(res, 200, log.entries);
      if (req.method === 'POST') {
        if (path === '/__admin/balance') balance = Math.round(typeof body.micros === 'number' ? body.micros : Number(body.usd ?? 0) * 1_000_000);
        else if (path === '/__admin/add') balance += Math.round(typeof body.micros === 'number' ? body.micros : Number(body.usd ?? 0) * 1_000_000);
        else if (path === '/__admin/price') price = Math.round(typeof body.micros === 'number' ? body.micros : Number(body.usd ?? 0) * 1_000_000);
        else if (path === '/__admin/claim') claimState = body.claimed === false ? 'anonymous' : 'claimed';
        else if (path === '/__admin/mode') {
          if (!(PUBLIK_MODES as readonly string[]).includes(body.mode)) return sendJson(res, 400, { error: `mode must be one of ${PUBLIK_MODES.join(', ')}` });
          mode = body.mode;
        } else if (path === '/__admin/revoke-all') { for (const k of keys.values()) { k.revoked = true; k.reprovision = body.reprovision === true; } }
        else return sendJson(res, 404, { error: 'no such admin route' });
      }
      return sendJson(res, 200, { balanceMicros: balance, balanceUsd: (balance / 1_000_000).toFixed(6), priceMicros: price, claimState, mode, charges, keys: keys.size, liveKeys: [...keys.values()].filter((k) => !k.revoked).length });
    }

    if (!path.startsWith('/api/v1/')) return err(res, 404, 'not_found', 'Not found.');
    const route = path.slice('/api/v1'.length);

    // ---- provisioning (no key auth)
    if (route === '/installs' && req.method === 'POST') {
      if (raw.length > 4096) return err(res, 413, 'invalid_field', 'Body too large.');
      const token = body.app_token ?? ((req.headers.authorization ?? '').startsWith('Bearer pat_') ? (req.headers.authorization as string).slice(7) : null);
      if (typeof token !== 'string' || !/^pat_([a-z0-9]+(?:[a-z0-9-]{0,62}[a-z0-9])?)_([a-z0-9]{32})$/.test(token)) return err(res, 400, 'invalid_field', 'app_token is malformed.', { field: 'app_token' });
      const slug = body.app_slug ?? body.app;
      if (typeof slug !== 'string' || token.split('_')[1] !== slug) return err(res, 400, 'invalid_field', 'app_slug does not match the token.', { field: 'app_slug' });
      const os = body.os ?? body.platform;
      if (!['macos', 'windows', 'linux', 'web', 'ios', 'android'].includes(os)) return err(res, 400, 'invalid_field', 'os is not valid.', { field: 'os' });
      if (typeof body.install_id !== 'string' || !UUID_V4.test(body.install_id)) return err(res, 400, 'invalid_field', 'install_id must be a v4 UUID.', { field: 'install_id' });
      if (!Number.isInteger(body.disclosure_version) || body.disclosure_version < 1) return err(res, 400, 'invalid_field', 'disclosure_version must be an integer >= 1.', { field: 'disclosure_version' });
      if (token !== appToken) return err(res, 401, 'invalid_app_token', 'The app token is not valid.');
      const existing = installs.get(body.install_id);
      if (existing && !existing.revoked) {
        log.note(entry, 'replay: no new key', 200);
        return sendJson(res, 200, { install_id: body.install_id, key: null, starter_micros: 0, claim_state: claimState, base_url: base() }, common);
      }
      const keyId = rand(12);
      const key = `pk_test_${keyId}_${rand(32)}`;
      const keyHash = createHash('sha256').update(key).digest('hex');
      installs.set(body.install_id, { keyHash, revoked: false, claimCode });
      keys.set(key, { installId: body.install_id, revoked: false, reprovision: false });
      log.note(entry, `minted key id ${keyId}`, 201);
      return sendJson(res, 201, {
        install_id: body.install_id, key, key_id: keyId, base_url: base(),
        models: { fast: 'publik-fast', balanced: 'publik-balanced', smart: 'publik-smart' },
        dialects: ['chat_completions', 'responses', 'messages'],
        claim_code: claimCode, claim_url: claimUrl, claim_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        starter_micros: 0, balance_micros: balance, starting_credit_micros: 0,
        wallet: wallet(body.install_id),
        disclosure: { version: body.disclosure_version, cost: 'stand-in', data_path: 'stand-in' },
      }, common);
    }

    // ---- everything else needs a key
    const auth = req.headers.authorization ?? '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : String(req.headers['x-api-key'] ?? '');
    const k = keys.get(presented);
    if (!k) { log.note(entry, 'invalid key', 401); return err(res, 401, 'invalid_api_key', 'Invalid API key.'); }
    if (k.revoked || mode === 'revoked') { log.note(entry, 'revoked key', 403); return err(res, 403, 'key_revoked', 'This key was revoked.', { reprovision: k.reprovision }); }

    if (route === '/installs/revoke' && req.method === 'POST') {
      k.revoked = true;
      const inst = installs.get(k.installId);
      if (inst) inst.revoked = true;
      log.note(entry, 'key revoked by the app', 204);
      res.writeHead(204, common); res.end(); return;
    }
    if ((route === '/wallet' || route === '/balance') && req.method === 'GET') {
      const w = wallet(k.installId);
      return sendJson(res, 200, route === '/balance' ? { ...w, available_micros: balance, top_up_url: topUp() } : w, common);
    }
    if (route === '/models' && req.method === 'GET') {
      return sendJson(res, 200, { object: 'list', data: [...TIERS.map((id) => ({ id, object: 'model', tier: id.slice(7), resolves_to: id })), ...Object.entries(COMPAT).map(([id, t]) => ({ id, object: 'model', tier: t.slice(7), resolves_to: t }))] }, common);
    }

    const metered = req.method === 'POST' && ['/chat/completions', '/embeddings', '/fetch', '/search'].includes(route);
    if (!metered) return err(res, 404, 'not_found', 'Not found.');
    if (mode === 'unavailable') { log.note(entry, 'gateway unavailable', 503); return sendJson(res, 503, { error: { type: 'gateway_unavailable', message: 'Try again later.' } }, { ...common, 'retry-after': '30' }); }
    let model: string | null = null;
    if (route === '/chat/completions') {
      const asked = String(body.model ?? '');
      model = TIERS.includes(asked) ? asked : COMPAT[asked] ?? null;
      if (!model) { log.note(entry, 'unknown model', 400); return err(res, 400, 'unknown_model', `Unknown model. Use ${TIERS.join(', ')}.`); }
      if (model === 'publik-smart' && claimState === 'anonymous') {
        log.note(entry, 'model requires claim', 402);
        return err(res, 402, 'model_requires_claim', 'publik-smart needs a claimed install.', { top_up_url: claimUrl, claim_url: claimUrl });
      }
    }
    if (balance < price) {
      log.note(entry, `402 insufficient: balance ${balance} < price ${price}`, 402);
      return err(res, 402, 'insufficient_credit', 'Not enough publik balance for this request.', {
        available_micros: balance, required_micros: price, claim_state: claimState, top_up_url: topUp(),
        claim_url: claimState === 'anonymous' ? claimUrl : null, add_credit_url: addCreditUrl, plans_url: 'https://publikhq.com/developers#plans',
        week: { used_micros: weekUsed, budget_micros: null, resets_at: resetsAt },
      });
    }
    // One charge per admitted request, at admission (reserve and settle together in this stand-in).
    balance -= price;
    weekUsed += price;
    charges++;
    log.note(entry, `charged ${price} micros; balance now ${balance}`, 200);

    if (route === '/embeddings') {
      const input: string[] = Array.isArray(body.input) ? body.input : [String(body.input ?? '')];
      return sendJson(res, 200, { object: 'list', data: input.map((_t, index) => ({ object: 'embedding', index, embedding: [0.5, 0.5, 0.5, 0.5] })) }, { ...common, ...meterHeaders(null), 'x-publik-charge-micros': String(price) });
    }
    if (route === '/fetch') return sendJson(res, 200, { url: body.url ?? null, html: '<html><body>stand-in page</body></html>', cost_micros: price }, { ...common, ...meterHeaders(null), 'x-publik-charge-micros': String(price) });
    if (route === '/search') return sendJson(res, 200, { results: [], cost_micros: price }, { ...common, ...meterHeaders(null), 'x-publik-charge-micros': String(price) });

    const text = answerFor(body);
    if (body.stream !== true) {
      return sendJson(res, 200, { id: 'standin', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }, { ...common, ...meterHeaders(model), 'x-publik-charge-micros': String(price) });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', ...common, ...meterHeaders(model), 'x-publik-reserved-micros': String(price) });
    res.flushHeaders();
    if (mode === 'stall') { log.note(entry, 'stalled after headers'); return; }
    const ps = pieces(text);
    for (let i = 0; i < ps.length; i++) {
      if (res.destroyed) { log.note(entry, 'client closed the connection'); return; }
      if (mode === 'half' && i === Math.floor(ps.length / 2)) { log.note(entry, 'dropped the connection half way'); req.socket.destroy(); return; }
      res.write(`data: ${JSON.stringify({ id: 'standin', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: ps[i] }, finish_reason: null }] })}\n\n`);
      await sleep(2);
    }
    res.write(`data: ${JSON.stringify({ id: 'standin', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(opts.port ?? 0, '127.0.0.1', () => resolve()); });
  port = (server.address() as AddressInfo).port;
  return {
    port,
    baseUrl: base(),
    log,
    state: () => ({ balanceMicros: balance, priceMicros: price, claimState, charges, keys: keys.size, liveKeys: [...keys.values()].filter((x) => !x.revoked).length }),
    setBalanceMicros(m: number) { balance = m; },
    close: () => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}
