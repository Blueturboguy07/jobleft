// Stand-in publik API on http://127.0.0.1:47910/api/v1 (never publikhq.com). It holds ONE dollar balance, charges a
// fixed price per AI call, and writes every charge to a ledger file, so a test can compare charges with clicks.
// Run: node apps/ui/mock/publik.ts --balance 4.37 --price 0.01 --dir <folder>
// Admin: POST /__admin/balance {"usd":0}  GET /__admin/ledger  GET /__admin/state

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORTS, parseArgs, trafficLogger, readJson, sleep, writeJsonAtomic } from './util.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const port = Number(args.port ?? PORTS.publik);
const dir = resolve(String(args.dir ?? join(HERE, '..', '.mock-home', 'publik-standin')));
mkdirSync(dir, { recursive: true });
const stateFile = join(dir, 'publik-state.json');
const ledgerFile = join(dir, 'ledger.ndjson');
const legacyWording = !!args['legacy-wording'];
const logTraffic = trafficLogger(args.traffic ? String(args.traffic) : join(dir, '..', 'traffic', 'publik.ndjson'));

interface S { balanceMicros: number; priceMicros: number; searchPriceMicros: number; keys: string[]; claimState: 'anonymous' | 'claimed' }
const s: S = readJson<S>(stateFile, { balanceMicros: 5_000_000, priceMicros: 10_000, searchPriceMicros: 5_000, keys: [], claimState: 'anonymous' });
if (args.balance !== undefined) s.balanceMicros = Math.round(Number(args.balance) * 1_000_000);
if (args.price !== undefined) s.priceMicros = Math.round(Number(args.price) * 1_000_000);
const save = () => writeJsonAtomic(stateFile, s);
save();

const TOP_UP = 'https://publik.invalid/claim/STANDIN';

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
}

function weekUsed(): number {
  if (!existsSync(ledgerFile)) return 0;
  const since = Date.now() - 7 * 86_400_000;
  let n = 0;
  for (const l of readFileSync(ledgerFile, 'utf8').split('\n')) {
    if (!l) continue;
    try { const e = JSON.parse(l) as { at: string; micros: number }; if (Date.parse(e.at) >= since) n += e.micros; } catch { /* skip */ }
  }
  return n;
}

function wallet() {
  return {
    claimState: s.claimState, balanceMicros: s.balanceMicros, starterRemainingMicros: s.claimState === 'anonymous' ? Math.min(s.balanceMicros, 500_000) : null,
    plan: 'none', week: { usedMicros: weekUsed(), budgetMicros: null, resetsAt: null }, topUpUrl: TOP_UP, claimUrl: s.claimState === 'anonymous' ? TOP_UP : null,
    addCreditUrl: null, updatedAt: new Date().toISOString(),
  };
}

function authed(req: IncomingMessage): boolean {
  const h = String(req.headers.authorization ?? '');
  return h.startsWith('Bearer ') && s.keys.includes(h.slice(7));
}

function charge(kind: string, micros: number): boolean {
  if (s.balanceMicros < micros) return false;
  s.balanceMicros -= micros;
  save();
  appendFileSync(ledgerFile, JSON.stringify({ at: new Date().toISOString(), kind, micros, balanceAfterMicros: s.balanceMicros }) + '\n');
  return true;
}

function tooLow(res: ServerResponse): void {
  send(res, 402, { error: { code: 'insufficient_balance', message: legacyWording ? 'You are out of credits. Buy more credits to continue.' : 'Your balance is too low for this request.', link: { label: 'Add money to your balance', url: TOP_UP } } });
}

const server = createServer(async (req, res) => {
  logTraffic(req);
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const p = url.pathname.replace(/^\/api\/v1/, '');
  if (url.pathname.startsWith('/__admin/')) {
    if (url.pathname === '/__admin/balance' && req.method === 'POST') { const b = JSON.parse((await readBody(req)) || '{}') as { usd?: number }; s.balanceMicros = Math.round(Number(b.usd ?? 0) * 1_000_000); save(); return send(res, 200, wallet()); }
    if (url.pathname === '/__admin/ledger') { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.end(existsSync(ledgerFile) ? readFileSync(ledgerFile) : ''); return; }
    if (url.pathname === '/__admin/state') return send(res, 200, { ...wallet(), priceMicros: s.priceMicros, keys: s.keys.length });
    return send(res, 404, { error: { code: 'not_found', message: 'no such admin route' } });
  }
  if (p === '/installs' && req.method === 'POST') {
    const key = `pk_test_standin_${randomBytes(16).toString('hex')}`;
    s.keys.push(key); save();
    return send(res, 200, { key, wallet: wallet() });
  }
  if (!authed(req)) return send(res, 401, { error: { code: 'unauthorized', message: 'Unknown key.' } });
  if (p === '/wallet') return send(res, 200, wallet());
  if (p === '/prices') return send(res, 200, { perCallMicros: s.priceMicros, searchMicros: s.searchPriceMicros });
  if (p === '/models') return send(res, 200, { object: 'list', data: [{ id: 'publik-fast' }, { id: 'publik-balanced' }, { id: 'publik-smart' }] });
  if (p === '/metered/search' && req.method === 'POST') {
    if (!charge('search', s.searchPriceMicros)) return tooLow(res);
    return send(res, 200, { results: [] }, { 'x-publik-charge-micros': String(s.searchPriceMicros) });
  }
  if (p === '/chat/completions' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}') as { stream?: boolean; messages?: Array<{ content: string }>; model?: string };
    if (!charge('ai', s.priceMicros)) return tooLow(res);
    const text = `Here is a short answer from the publik stand-in model. I read ${body.messages?.length ?? 0} messages. A real model would answer your question in full here.`;
    const h = { 'x-publik-charge-micros': String(s.priceMicros), 'x-publik-balance-micros': String(s.balanceMicros) };
    if (!body.stream) return send(res, 200, { model: body.model ?? 'publik-balanced', choices: [{ message: { role: 'assistant', content: text } }] }, h);
    res.writeHead(200, { 'content-type': 'text/event-stream', ...h });
    for (const w of text.split(/(?<= )/)) { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`); await sleep(25); }
    res.end('data: [DONE]\n\n');
    return;
  }
  send(res, 404, { error: { code: 'not_found', message: 'no such route' } });
});

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${port} is already in use, so the stand-in publik API cannot start.`);
  else console.error(`The stand-in publik API cannot start: ${e.message}`);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => console.log(`Stand-in publik API on http://127.0.0.1:${port}/api/v1 (balance $${(s.balanceMicros / 1e6).toFixed(2)}, $${(s.priceMicros / 1e6).toFixed(2)} per AI call, ledger ${ledgerFile})`));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
