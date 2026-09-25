// A local mock of the company-fact sources and of a paid search endpoint, for testing (static-data O11, O12, O15).
// Loopback only. Every request is logged (method, path, query, user-agent), so a tester can search the log for any
// personal text and count how many lookups ran.
//
//   /wiki/Special:EntityData/<Q>.json      Wikidata items from test/fixtures/facts (recorded, trimmed, CC0)
//   /submissions/CIK<10 digits>.json      SEC submissions from test/fixtures/facts (public domain)
//   /api/v1/lei-records...                GLEIF records from test/fixtures/facts (CC0)
//   /search?q=<query>                     paid search: charges the test balance; results depend on --scenario
//   /balance                              the test balance in micros and in dollars
// With fail=true every free-source route answers 503 (a failed refresh).

import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { formatDollars } from '@jobleft/contracts';
import { PACKAGE_DIR } from '../paths.ts';

export type SearchScenario = 'empty' | 'other-company' | 'match';
export const FIXTURE_DIR = join(PACKAGE_DIR, 'test', 'fixtures', 'facts');

export interface MockFacts { server: Server; origin: string; close(): Promise<void>; balance(): number; requests(): string[] }

export async function startMockFacts(opts: { port?: number; scenario?: SearchScenario; fail?: boolean; balanceMicros?: number; priceMicros?: number; logFile?: string; log?: (l: string) => void }): Promise<MockFacts> {
  let balance = opts.balanceMicros ?? 1_000_000;
  const price = opts.priceMicros ?? 5_000;
  const scenario = opts.scenario ?? 'empty';
  const lines: string[] = [];
  const log = (l: string) => {
    lines.push(l);
    opts.log?.(l);
    if (opts.logFile) appendFileSync(opts.logFile, l + '\n');
  };
  const fixture = (name: string): string | null => {
    const p = join(FIXTURE_DIR, name);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    log(`${new Date().toISOString()} ${req.method} ${url.pathname}${url.search} ua="${req.headers['user-agent'] ?? ''}"`);
    const send = (code: number, body: string, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(body); };
    if (url.pathname === '/robots.txt') return send(200, 'User-agent: *\nDisallow:\n', 'text/plain');
    if (url.pathname === '/balance') return send(200, JSON.stringify({ balanceMicros: balance, balance: formatDollars(balance) }));
    if (url.pathname === '/search') {
      const q = url.searchParams.get('q') ?? '';
      if (balance < price) return send(402, JSON.stringify({ error: { code: 'insufficient_balance', message: 'Your balance ran out.' } }));
      balance -= price;
      return send(200, JSON.stringify({ costMicros: price, results: searchResults(scenario, q) }));
    }
    if (opts.fail) return send(503, JSON.stringify({ error: 'mock outage' }));
    let m = /^\/wiki\/Special:EntityData\/(Q\d+)\.json$/.exec(url.pathname);
    if (m) { const f = fixture(`wikidata-${m[1]}.json`); return f ? send(200, f) : send(404, '{}'); }
    m = /^\/submissions\/CIK(\d{10})\.json$/.exec(url.pathname);
    if (m) { const f = fixture(`sec-CIK${m[1]}.json`); return f ? send(200, f) : send(404, '{}'); }
    m = /^\/api\/v1\/lei-records\/([A-Z0-9]{20})$/.exec(url.pathname);
    if (m) { const f = fixture(`gleif-${m[1]}.json`); return f ? send(200, f) : send(404, JSON.stringify({ errors: [{ status: '404' }] })); }
    if (url.pathname === '/api/v1/lei-records') {
      const name = (url.searchParams.get('filter[entity.legalName]') ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '-');
      const f = fixture(`gleif-name-${name}.json`);
      return send(200, f ?? JSON.stringify({ data: [] }));
    }
    return send(404, '{}');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(opts.port ?? 4780, '127.0.0.1', () => resolve()); });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port ?? 4780;
  return { server, origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())), balance: () => balance, requests: () => [...lines] };
}

/** Canned search results. "other-company" describes a different company with the same short name. */
export function searchResults(scenario: SearchScenario, query: string): Array<{ title: string; url: string; snippet: string }> {
  const name = query.replace(/\s+(funding round investors|company news)$/i, '').trim() || 'Company';
  if (scenario === 'empty') return [];
  if (scenario === 'other-company') {
    return [
      { title: `${name} GmbH opens a new bakery in Graz, Austria`, url: 'https://example.org/graz-bakery', snippet: `${name} GmbH, a family bakery chain based in Graz, Austria, raised $40M in a Series B round led by Alpine Growth Partners.` },
      { title: `${name} Pty Ltd wins a mining services contract`, url: 'https://example.net/perth-mining', snippet: `${name} Pty Ltd of Perth, Australia, founded in 1998, supplies drilling services to mines in Western Australia.` },
    ];
  }
  return [
    { title: `${name} raises new funding`, url: 'https://news.example.com/funding', snippet: `${name} (${name.toLowerCase().replace(/[^a-z0-9]/g, '')}.com), based in San Francisco, raised $40M in a Series B round.` },
  ];
}
