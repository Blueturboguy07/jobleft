// The UI lane's mock of the local API (apps/server stands in for it later). Run: node apps/ui/mock/server.ts --help
// It follows docs/INTERFACES.md section 6: loopback only, Host and Origin checks, the launch token in a header,
// JSON-only writes, body limits, validation of every body and query against packages/contracts, and the error shape.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JSON_BODY_LIMIT, LAUNCH_TOKEN_HEADER, LOCAL_API, RAW_BODY_LIMIT, matchRoute, nowIso, nowMs, validate, type JsonSchema, type ProfileInput, type RouteSpec,
} from '@jobleft/contracts';
import { ApiFail, scrubCredits } from './ai-client.ts';
import { Crawler } from './crawl.ts';
import { connectionsCsv, generate } from './fixtures.ts';
import { toJob } from './jobs.ts';
import { makePdf } from './docs.ts';
import { HANDLERS, checkReminders, hasProfile, type Ctx } from './routes.ts';
import { MockState, SaveError } from './state.ts';
import { parseArgs, writeJsonAtomic } from './util.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = resolve(HERE, '..');

const HELP = `jobleft UI mock of the local API

Usage: node apps/ui/mock/server.ts [options]

  --home DIR           Data folder of the mock (default: apps/ui/.mock-home)
  --port N             Port (default: first free of 47821-47830)
  --token T            Launch token (default: a new random one)
  --boards N           Fixture employer boards to create on first start (default 40)
  --per-board N        Average postings per board (default 30)
  --jobs N             Create about N postings and import them at once, no first crawl (for 50,000-job tests)
  --seed N             Fixture seed (default 7)
  --persona            Load the made-up persona Jordan Testwell (profile) on first start
  --crawl-delay-ms N   Wait between boards during a refresh (default: 1500 in the very first refresh, so it takes about a minute and the feed fills as boards arrive; 150 in later ones)
  --no-crawl           Do not refresh on launch
  --reset              Delete this mock data folder's state and boards first
  --ui-dir DIR         Built UI to serve at / (default: apps/ui/dist)
  --dev                Enable POST /api/v1/dev/clock
`;

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, code: string, message: string, more: Record<string, unknown> = {}): void {
  sendJson(res, status, { error: { code, message: scrubCredits(message), ...more } });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

// Every asset comes from this origin: no remote script, style, font, image or connection is allowed.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";

function serveStatic(uiDir: string, url: URL, res: ServerResponse): void {
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  let path = normalize(join(uiDir, rel || 'index.html'));
  if (!path.startsWith(uiDir)) { res.writeHead(403); res.end(); return; }
  if (!existsSync(path) || statSync(path).isDirectory()) path = join(uiDir, 'index.html');
  if (!existsSync(path)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('The jobleft UI is not built yet. Run: pnpm --filter @jobleft/ui build');
    return;
  }
  const isIndex = path.endsWith('index.html');
  res.writeHead(200, {
    'content-type': MIME[extname(path)] ?? 'application/octet-stream',
    'cache-control': isIndex ? 'no-store' : 'public, max-age=31536000, immutable',
    'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  });
  res.end(readFileSync(path));
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | 'too_large'> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => { size += c.length; if (size > limit) over = true; else chunks.push(c); });
    req.on('end', () => resolveBody(over ? 'too_large' : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function tokenOk(given: string | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- persona and fixtures

const PERSONA: ProfileInput = {
  personal: { firstName: 'Jordan', middleName: null, lastName: 'Testwell', email: 'jordan.testwell@example.com', phone: '555-0100', addressLine: null, city: 'Austin', region: 'TX', postalCode: null, country: 'US', links: [] },
  summary: 'Software engineer with about three years of backend and full-stack work.',
  education: [{ id: 'edu1', school: 'Hill Country State University', degree: 'B.S.', major: 'Computer Science', gpa: null, startDate: '2017-08', endDate: '2021-05', current: false, achievements: [], coursework: [] }],
  work: [
    { id: 'w1', company: 'Pinecrest Software', title: 'Software Engineer', employmentType: 'full_time', location: 'Austin, TX', startDate: '2023-06', endDate: null, current: true, summary: null, bullets: ['Cut the nightly batch job time by 30% by moving it to a queue.', 'Raised test coverage of the billing service from 52% to 81%.', 'Built a React dashboard used by 40 support agents.'] },
    { id: 'w2', company: 'Lakeshore Data', title: 'Junior Developer', employmentType: 'full_time', location: 'Dallas, TX', startDate: '2021-06', endDate: '2023-05', current: false, summary: null, bullets: ['Wrote SQL reports for the finance team.', 'Fixed 120 bugs in a Node.js API.'] },
  ],
  projects: [], certifications: [],
  skills: ['TypeScript', 'JavaScript', 'Python', 'React', 'Node.js', 'SQL', 'PostgreSQL', 'Docker', 'AWS', 'GraphQL'].map((name) => ({ name, years: null, source: 'user' as const })),
  preferences: { jobFunctions: ['Software Engineering'], targetTitles: ['Software Engineer'], employmentTypes: ['full_time'], workModels: ['onsite', 'hybrid', 'remote'], levels: ['entry', 'mid', 'senior'], countries: ['US'], places: [], minAnnualPayUsd: null, industries: [], companyStages: [], roleTypes: [], excludedCompanies: [] },
  workAuthorization: { usAuthorized: 'yes', needsSponsorship: 'no', usCitizen: null, hasSecurityClearance: null, authorizedCountries: [] },
  eeo: { disability: null, veteran: null, gender: null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null },
};

function personaResumePdf(): Uint8Array {
  const p = PERSONA;
  return makePdf([
    { text: 'Jordan Testwell', size: 18, bold: true },
    { text: 'jordan.testwell@example.com | 555-0100 | Austin, TX', size: 9.5 },
    { text: 'Summary', bold: true, gapBefore: 8 }, { text: p.summary! },
    { text: 'Experience', bold: true, gapBefore: 8 },
    ...p.work.flatMap((w) => [{ text: `${w.title}, ${w.company}`, bold: true }, { text: `${w.startDate} - ${w.current ? 'Present' : w.endDate}` }, ...w.bullets.map((b) => ({ text: `- ${b}` }))]),
    { text: 'Education', bold: true, gapBefore: 8 }, { text: 'Hill Country State University, B.S. in Computer Science' }, { text: '2017-08 - 2021-05' },
    { text: 'Skills', bold: true, gapBefore: 8 }, { text: p.skills.map((s) => s.name).join(', ') },
    { text: 'VOLUNTEERING', bold: true, gapBefore: 8 }, { text: 'Weekend coding club mentor' },
  ]).bytes;
}

function ensureFixtures(state: MockState, args: Record<string, string | true>): { created: boolean } {
  const marker = join(state.home, '.jobleft-ui-mock');
  if (existsSync(join(state.home, 'companies.json'))) return { created: false };
  writeFileSync(marker, 'This folder is a jobleft UI mock data folder. It holds made-up data only.\n');
  const seed = Number(args.seed ?? 7);
  const jobs = args.jobs ? Number(args.jobs) : null;
  const boards = jobs ? Math.max(1, Math.ceil(jobs / 50)) : Number(args.boards ?? 40);
  const perBoard = jobs ? 50 : Number(args['per-board'] ?? 30);
  const g = generate({ seed, boards, postingsPerBoard: perBoard, now: nowMs() });
  for (const b of g.boards) writeJsonAtomic(join(state.dirs.boards, `${b.id.replace(':', '__')}.json`), b);
  writeJsonAtomic(join(state.home, 'companies.json'), g.companies);
  mkdirSync(join(state.home, 'fixtures'), { recursive: true });
  writeFileSync(join(state.home, 'fixtures', 'Connections.csv'), connectionsCsv(g.companies, seed));
  writeFileSync(join(state.home, 'fixtures', 'Jordan_Testwell_Resume.pdf'), personaResumePdf());
  writeFileSync(join(state.home, 'fixtures', 'not-a-resume.pdf'), makePdf([]).bytes);
  state.loadCompanies();
  if (jobs) {
    // import at once, as the documented import path would
    const now = nowIso();
    for (const b of g.boards) for (const p of b.postings) state.putJob(toJob(b, p, { firstSeenAt: now, lastSeenAt: now }), b.id);
    state.saveJobs();
  }
  return { created: true };
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); return; }
  const home = resolve(String(args.home ?? join(UI_ROOT, '.mock-home')));
  if (args.reset && existsSync(home)) {
    if (!existsSync(join(home, '.jobleft-ui-mock')) && existsSync(join(home, 'state'))) {
      console.error(`Refusing to reset ${home}: it is not a jobleft UI mock folder.`);
      process.exit(1);
    }
    for (const d of ['state', 'boards', 'files', 'fixtures', 'companies.json', '.jobleft-ui-mock']) rmSync(join(home, d), { recursive: true, force: true });
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const state = new MockState(home);
  const fx = ensureFixtures(state, args);
  if (args.persona && !hasProfile(state.data.profile)) {
    const p = { id: 'default', ...PERSONA, version: 'persona-1', updatedAt: nowIso() };
    state.set('profile', 'the persona', p);
  }
  const token = String(args.token ?? randomBytes(24).toString('base64url'));
  const uiDir = resolve(String(args['ui-dir'] ?? join(UI_ROOT, 'dist')));
  const dev = !!args.dev;
  const firstRun = state.jobs.size === 0;
  let changeTick = 0;
  const crawler = new Crawler(state, { delayMs: Number(args['crawl-delay-ms'] ?? 150), firstRunDelayMs: Number(args['crawl-delay-ms'] ?? 1500), now: nowMs, onChange: () => { changeTick++; } });

  const server = createServer(async (req, res) => {
    const port = (server.address() as { port: number }).port;
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return sendError(res, 403, 'forbidden_host', 'This address is not allowed.');
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return sendError(res, 403, 'forbidden_origin', 'Requests from other web pages are not allowed.');
    const url = new URL(req.url ?? '/', `http://${host}`);

    // mock-only controls (same token)
    if (url.pathname.startsWith('/__mock/')) {
      if (!tokenOk(req.headers[LAUNCH_TOKEN_HEADER] as string | undefined, token)) return sendError(res, 401, 'unauthorized', 'Missing or wrong token.');
      if (url.pathname === '/__mock/offline' && req.method === 'POST') {
        const b = await readBody(req, 1000);
        state.offlineSwitch = b !== 'too_large' && /true/.test(b.toString());
        return sendJson(res, 200, { offline: state.offlineSwitch });
      }
      if (url.pathname === '/__mock/state') return sendJson(res, 200, { jobs: state.jobs.size, changeTick, offline: state.offlineSwitch, crawl: crawler.progress });
      return sendError(res, 404, 'not_found', 'Not found.');
    }

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 404, 'not_found', 'Not found.');
      return serveStatic(uiDir, url, res);
    }
    const m = matchRoute(req.method ?? 'GET', url.pathname);
    if (!m) return sendError(res, 404, 'not_found', 'There is no such route.');
    const spec = LOCAL_API[m.name] as RouteSpec;
    if (spec.auth === 'pairing') return sendError(res, 404, 'not_found', 'Extension routes are not part of the UI mock.');
    if (spec.auth !== 'none' && !tokenOk(req.headers[LAUNCH_TOKEN_HEADER] as string | undefined, token)) return sendError(res, 401, 'unauthorized', 'Missing or wrong token. Open jobleft from its launcher.');
    if (spec.devOnly && !dev) return sendError(res, 404, 'not_found', 'There is no such route.');

    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) query[k] = v;
    if (spec.query) {
      const v = validate(spec.query, query);
      if (!v.ok) return sendError(res, 400, 'bad_request', 'The request does not match what this route accepts.', { details: v.issues.slice(0, 5) });
    }
    let body: unknown = undefined;
    let raw: Uint8Array | null = null;
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      const ctype = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      const rawSpec = spec.body && 'raw' in spec.body ? (spec.body as { raw: readonly string[] }).raw : null;
      if (rawSpec) {
        if (!rawSpec.includes(ctype)) return sendError(res, 415, 'unsupported_media_type', `This route accepts ${rawSpec.join(' or ')}.`);
        const b = await readBody(req, RAW_BODY_LIMIT);
        if (b === 'too_large') return sendError(res, 413, 'payload_too_large', 'The file is larger than 10 MB. Nothing was stored.');
        raw = new Uint8Array(b);
      } else {
        const b = await readBody(req, JSON_BODY_LIMIT);
        if (b === 'too_large') return sendError(res, 413, 'payload_too_large', 'The request is too large. Nothing was stored.');
        if (b.length || spec.body) {
          if (ctype !== 'application/json') return sendError(res, 415, 'unsupported_media_type', 'Send JSON (application/json).');
          try { body = b.length ? JSON.parse(b.toString('utf8')) : {}; } catch { return sendError(res, 400, 'bad_request', 'The request body is not valid JSON.'); }
          if (spec.body) {
            const v = validate(spec.body as JsonSchema, body);
            if (!v.ok) return sendError(res, 400, 'bad_request', 'The request does not match what this route accepts.', { details: v.issues.slice(0, 5) });
          }
        }
      }
    }
    const handler = HANDLERS[m.name];
    if (!handler) return sendError(res, 404, 'not_found', 'This route is not part of the UI mock.');
    const ctx: Ctx = { state, crawler, dev, params: m.params, query, body, raw, headers: req.headers, res };
    try {
      const out = await handler(ctx);
      if (out.kind === 'sse') return;
      if (out.kind === 'file') {
        res.writeHead(200, { 'content-type': out.mime, 'content-disposition': `attachment; filename="${out.fileName.replace(/"/g, '')}"`, 'cache-control': 'no-store' });
        res.end(Buffer.from(out.bytes));
        return;
      }
      sendJson(res, out.status ?? 200, out.body);
    } catch (err) {
      if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
      if (err instanceof ApiFail) return sendError(res, err.status, err.code, err.message, { ...(err.link ? { link: err.link } : {}), ...((err as ApiFail & { details?: unknown }).details ? { details: (err as ApiFail & { details?: unknown }).details } : {}) });
      if (err instanceof SaveError) return sendError(res, 500, 'internal', err.message);
      console.error(`[mock] ${m.name} failed:`, (err as Error).message);
      return sendError(res, 500, 'internal', 'Something went wrong in jobleft. Nothing was changed. Try again.');
    }
  });

  const want = args.port ? [Number(args.port)] : Array.from({ length: 10 }, (_, i) => 47821 + i);
  let port = 0;
  for (const p of want) {
    const ok = await new Promise<boolean>((r) => {
      const failed = () => r(false);
      server.once('error', failed);
      server.listen(p, '127.0.0.1', () => { server.off('error', failed); r(true); });
    });
    if (!ok) server.removeAllListeners('error');
    if (ok) { port = p; break; }
  }
  if (!port) { console.error('No free port in 47821-47830. Is another jobleft running? Stop it first.'); process.exit(1); }
  const runFile = join(state.dirs.run, 'server.json');
  writeFileSync(runFile, JSON.stringify({ pid: process.pid, port, token, version: '0.1.0-ui-mock', startedAt: nowIso() }), { mode: 0o600 });
  const uiUrl = `http://127.0.0.1:${port}/#token=${token}`;
  console.log(`jobleft UI mock is running (data folder: ${home})`);
  if (fx.created) console.log(`Created fixture boards and companies${args.jobs ? ` and imported ${state.jobs.size} jobs` : ''}. Test files: ${join(home, 'fixtures')}`);
  console.log(`Open: ${uiUrl}`);
  if (!existsSync(join(uiDir, 'index.html'))) console.log('Note: the UI is not built. Run: pnpm --filter @jobleft/ui build');

  const reminders = setInterval(() => checkReminders(state), 10_000);
  reminders.unref();
  if (!args['no-crawl'] && (firstRun || state.data.settings.crawl.catchUpOnLaunch)) {
    setTimeout(() => { void crawler.run(firstRun ? 'first_run' : 'launch_catch_up'); }, 300);
  } else crawler.schedule();

  const stop = () => {
    try { state.saveJobs(); } catch { /* keep the previous file */ }
    try { unlinkSync(runFile); } catch { /* ignore */ }
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

void main();
