// The STAND-IN APP: a small local server that plays the jobleft app for the extension, so the extension can be
// paired, filled and checked before the real app (apps/server) is built. It is a test tool and is not shipped.
//
// It follows the local API rules of docs/INTERFACES.md section 6.1 for the routes the extension uses:
//   127.0.0.1 only; Host must be 127.0.0.1:<port> or localhost:<port>; an Origin other than the app's own page or the
//   paired extension is refused (and "null" always); no CORS headers at all; JSON-only writes; 1 MiB body limit;
//   tokens only in headers (a token in a URL is refused); constant-time token checks; one error shape.
// It makes NO outbound request. Drafts come from a facts-only template; the "publik" provider is SIMULATED (a fake
// balance in dollars kept in this app's data file; nothing is charged anywhere).
//
//   node scripts/standin-app.ts [--home <dir>] [--port <n>] [--reset]
// Prints the address of its page, with the launch token in the fragment (#token=...).

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PORT, DraftRequestSchema, EXTENSION_PROTOCOL_VERSION, FillRequestSchema, JSON_BODY_LIMIT, PageInfoRequestSchema, PairRequestSchema,
  PORT_SPAN, ProfileInputSchema, RAW_BODY_LIMIT, ReviewResultSchema, validate,
} from '@jobleft/contracts';
import type { DraftResponse, FillRequest, FormField, PageInfo, PairingInfo, Profile, ProfileInput, TrackerEntry } from '@jobleft/contracts';
import { answerFill, openQuestions } from '../src/answer.ts';
import { contactLeaks, templateDraft } from '../src/drafts.ts';
import { pageKey } from '../src/pagekey.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const VERSION = '0.1.0-standin';

// ------------------------------------------------------------------ arguments

const args = process.argv.slice(2);
const arg = (name: string): string | null => (args.includes(name) ? args[args.indexOf(name) + 1] ?? null : null);
const home = arg('--home') ?? process.env.JOBLEFT_HOME ?? join(repoRoot, '.jobleft-dev', 'extension-standin');
const fixedPort = arg('--port') ? Number(arg('--port')) : null;
const reset = args.includes('--reset');

// ------------------------------------------------------------------ state

interface StoredResume { id: string; name: string; fileName: string; mimeType: string; isDefault: boolean; jobId: string | null; updatedAt: string; base64: string }
interface StoredJob { id: string; title: string | null; company: string | null; url: string; external: boolean }
interface StoredPairing { extensionId: string; tokenHash: string; browser: string; extensionVersion: string; pairedAt: string; lastSeenAt: string | null }
interface Tracked { jobId: string; pageUrl: string; appliedAt: string; resumeId: string | null; createdAt: string; updatedAt: string }
interface DraftProvider { kind: 'local' | 'publik_sim' | 'none'; priceMicros: number; balanceMicros: number }
interface State { profile: Profile; resumes: StoredResume[]; jobs: StoredJob[]; tracker: Tracked[]; pairings: StoredPairing[]; drafts: DraftProvider }

const statePath = join(home, 'data', 'standin-state.json');
const logPath = join(home, 'logs', 'requests.log');

function nowIso(): string { return new Date().toISOString(); }

/** A small valid one-page PDF with a few lines of text (the test resumes). */
function makePdf(lines: string[]): string {
  const esc = (s: string): string => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const text = lines.map((l, i) => `BT /F1 ${i === 0 ? 16 : 11} Tf 72 ${740 - i * 22} Td (${esc(l)}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1').toString('base64');
}

function seed(): State {
  const t = nowIso();
  const profile: Profile = {
    id: 'default',
    personal: {
      firstName: 'Jordan', middleName: null, lastName: 'Testwell', email: 'jordan.testwell@example.com', phone: '555-0100',
      addressLine: null, city: 'Austin', region: 'TX', postalCode: null, country: 'US',
      links: [
        { label: 'LinkedIn', url: 'https://www.linkedin.com/in/jordan-testwell-example' },
        { label: 'Portfolio', url: 'https://example.com/jordan-testwell' },
      ],
    },
    summary: 'Software engineer who builds internal tools and web services.',
    education: [{
      id: 'edu1', school: 'Sample State University', degree: 'B.S.', major: 'Computer Science', gpa: null,
      startDate: '2017-08', endDate: '2021-05', current: false, achievements: [], coursework: [],
    }],
    work: [
      { id: 'w1', company: 'Northwind Sample Labs', title: 'Software Engineer', employmentType: 'full_time', location: 'Austin, TX', startDate: '2023-06', endDate: null, current: true, summary: null, bullets: ['Builds internal tools for the support team.'] },
      { id: 'w2', company: 'Contoso Example Co', title: 'Junior Developer', employmentType: 'full_time', location: 'Dallas, TX', startDate: '2021-06', endDate: '2023-05', current: false, summary: null, bullets: ['Maintained the billing web pages.'] },
    ],
    projects: [],
    certifications: [],
    skills: [{ name: 'TypeScript', years: 3, source: 'user' }, { name: 'PostgreSQL', years: 2, source: 'user' }, { name: 'React', years: null, source: 'user' }],
    preferences: {
      jobFunctions: ['Software Engineer'], targetTitles: ['Software Engineer'], employmentTypes: ['full_time'], workModels: ['remote', 'hybrid'],
      levels: ['mid'], countries: ['US'], places: [], minAnnualPayUsd: 120000, industries: [], companyStages: [], roleTypes: ['ic'], excludedCompanies: [],
    },
    workAuthorization: { usAuthorized: null, needsSponsorship: null, usCitizen: null, hasSecurityClearance: null, authorizedCountries: [] },
    eeo: { disability: null, veteran: null, gender: null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null },
    version: 'v1',
    updatedAt: t,
  };
  const practice = 'http://127.0.0.1:47900';
  const jobs: StoredJob[] = [
    { id: 'job-a', title: 'Software Engineer', company: 'Acme Practice Co', url: `${practice}/practice/job-a.html`, external: false },
    { id: 'job-b', title: 'Backend Engineer', company: 'Acme Practice Co', url: `${practice}/practice/job-b.html`, external: false },
  ];
  const resumes: StoredResume[] = [
    { id: 'res-default', name: 'Default resume', fileName: 'Jordan_Testwell_Resume.pdf', mimeType: 'application/pdf', isDefault: true, jobId: null, updatedAt: t, base64: makePdf(['Jordan Testwell', 'Resume (default version)', 'Software Engineer, Northwind Sample Labs']) },
    { id: 'res-job-a', name: 'Tailored for job A', fileName: 'Jordan_Testwell_Resume_SoftwareEngineer.pdf', mimeType: 'application/pdf', isDefault: false, jobId: 'job-a', updatedAt: t, base64: makePdf(['Jordan Testwell', 'Resume (tailored for job A: Software Engineer)']) },
    { id: 'res-job-b', name: 'Tailored for job B', fileName: 'Jordan_Testwell_Resume_BackendEngineer.pdf', mimeType: 'application/pdf', isDefault: false, jobId: 'job-b', updatedAt: t, base64: makePdf(['Jordan Testwell', 'Resume (tailored for job B: Backend Engineer)']) },
  ];
  return { profile, resumes, jobs, tracker: [], pairings: [], drafts: { kind: 'local', priceMicros: 10_000, balanceMicros: 5_000_000 } };
}

mkdirSync(join(home, 'data'), { recursive: true, mode: 0o700 });
mkdirSync(join(home, 'logs'), { recursive: true, mode: 0o700 });
let S: State = !reset && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) as State : seed();
function save(): void {
  writeFileSync(statePath, JSON.stringify(S, null, 1), { mode: 0o600 });
  chmodSync(statePath, 0o600);
}
save();

// ------------------------------------------------------------------ security helpers

const launchToken = randomBytes(32).toString('base64url');
let port = 0;
let code: { code: string; expiresAt: number; wrong: number } | null = null;

function sha(s: string): string { return createHash('sha256').update(s).digest('hex'); }

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(sha(a));
  const y = Buffer.from(sha(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function log(req: IncomingMessage, status: number, note = ''): void {
  // No personal data: method, path (no query), status, who asked.
  const origin = req.headers.origin ? (String(req.headers.origin).startsWith('chrome-extension://') ? 'extension' : String(req.headers.origin)) : 'no-origin';
  const line = `${nowIso()} ${req.method} ${(req.url ?? '').split('?')[0]} ${status} ${origin}${note ? ` ${note}` : ''}\n`;
  appendFileSync(logPath, line, { mode: 0o600 });
}

type Code = 'bad_request' | 'unauthorized' | 'forbidden_origin' | 'forbidden_host' | 'not_found' | 'conflict' | 'payload_too_large' | 'unsupported_media_type' | 'insufficient_balance' | 'rate_limited' | 'internal';
const STATUS: Record<Code, number> = { bad_request: 400, unauthorized: 401, forbidden_origin: 403, forbidden_host: 403, not_found: 404, conflict: 409, payload_too_large: 413, unsupported_media_type: 415, insufficient_balance: 402, rate_limited: 429, internal: 500 };

class ApiErr extends Error {
  code: Code;
  details: unknown;
  constructor(code: Code, message: string, details?: unknown) { super(message); this.code = code; this.details = details; }
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  });
  res.end(data);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new ApiErr('payload_too_large', 'The request body is too large.');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function json<T>(req: IncomingMessage, schema?: Parameters<typeof validate>[0]): Promise<T> {
  const type = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw new ApiErr('unsupported_media_type', 'Send JSON (content-type application/json).');
  const raw = await readBody(req, JSON_BODY_LIMIT);
  let v: unknown;
  try { v = JSON.parse(raw.toString('utf8')); } catch { throw new ApiErr('bad_request', 'The body is not valid JSON.'); }
  if (schema) {
    const r = validate(schema, v);
    if (!r.ok) throw new ApiErr('bad_request', 'The body does not match its contract.', r.issues.slice(0, 10).map((i) => i.path));
  }
  return v as T;
}

type Who = { kind: 'launch' } | { kind: 'pairing'; pairing: StoredPairing } | { kind: 'none' };

/** Host, Origin and token checks (INTERFACES 6.1). Returns who is calling. */
function gate(req: IncomingMessage, auth: 'none' | 'launch' | 'pairing' | 'page'): Who {
  const host = String(req.headers.host ?? '');
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new ApiErr('forbidden_host', 'This address is not the jobleft app.');
  if ((req.url ?? '').includes('?') && /token|pairing/i.test((req.url ?? '').split('?')[1] ?? '')) throw new ApiErr('unauthorized', 'A token in a URL is refused.');
  const origin = req.headers.origin === undefined ? null : String(req.headers.origin);
  const own = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  if (origin === 'null') throw new ApiErr('forbidden_origin', 'This caller is not allowed.');
  if (auth === 'page' || auth === 'none') {
    if (origin && !own.includes(origin) && !origin.startsWith('chrome-extension://')) throw new ApiErr('forbidden_origin', 'This caller is not allowed.');
    return { kind: 'none' };
  }
  if (auth === 'launch') {
    if (origin && !own.includes(origin)) throw new ApiErr('forbidden_origin', 'This caller is not allowed.');
    const t = req.headers['x-jobleft-token'];
    if (typeof t !== 'string' || !sameToken(t, launchToken)) throw new ApiErr('unauthorized', 'The app token is missing or wrong.');
    return { kind: 'launch' };
  }
  const t = req.headers['x-jobleft-pairing'];
  if (typeof t !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(t)) throw new ApiErr('unauthorized', 'This browser is not paired.');
  const p = S.pairings.find((x) => sameToken(sha(t), x.tokenHash));
  if (!p) throw new ApiErr('unauthorized', 'This browser is not paired.');
  if (origin && origin !== `chrome-extension://${p.extensionId}`) throw new ApiErr('forbidden_origin', 'This caller is not allowed.');
  p.lastSeenAt = nowIso();
  return { kind: 'pairing', pairing: p };
}

// ------------------------------------------------------------------ app logic

function jobForUrl(url: string): StoredJob | null {
  const k = pageKey(url);
  if (!k) return null;
  return S.jobs.find((j) => pageKey(j.url) === k) ?? null;
}

function resumeFor(job: StoredJob | null, picked: string | null): StoredResume | null {
  if (picked) {
    const r = S.resumes.find((x) => x.id === picked);
    if (r) return r;
  }
  if (job) {
    const tailored = S.resumes.filter((r) => r.jobId === job.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (tailored) return tailored;
  }
  return S.resumes.find((r) => r.isDefault) ?? null;
}

function missingFields(): string[] {
  const p = S.profile.personal;
  const out: string[] = [];
  if (!p.firstName || !p.lastName) out.push('name');
  if (!p.email) out.push('email');
  if (!p.phone) out.push('phone number');
  if (!p.city) out.push('city');
  if (!S.resumes.some((r) => r.isDefault)) out.push('default resume');
  return out;
}

function draftOffer(): { provider: string; local: boolean; maxPriceMicrosPerDraft: number; balanceMicros: number | null } | null {
  if (S.drafts.kind === 'none') return null;
  if (S.drafts.kind === 'local') return { provider: 'Local template (no AI, on this computer)', local: true, maxPriceMicrosPerDraft: 0, balanceMicros: null };
  return { provider: 'publik API (SIMULATED by the stand-in)', local: false, maxPriceMicrosPerDraft: S.drafts.priceMicros, balanceMicros: S.drafts.balanceMicros };
}

function makeDrafts(fields: FormField[], job: StoredJob | null): Array<{ fieldId: string; text: string; provider: string }> {
  const out: Array<{ fieldId: string; text: string; provider: string }> = [];
  for (const f of fields) {
    let text = templateDraft(f, S.profile, job ? { title: job.title, company: job.company } : null);
    if (f.maxLength && text.length > f.maxLength) text = text.slice(0, f.maxLength);
    if (!text || contactLeaks(text, S.profile).length) continue;
    out.push({ fieldId: f.fieldId, text, provider: S.drafts.kind === 'local' ? 'Local template' : 'publik API (simulated)' });
  }
  return out;
}

function trackerEntry(t: Tracked, job: StoredJob | null): TrackerEntry {
  return {
    jobId: t.jobId, liked: false, hidden: false, external: job?.external ?? true, status: 'applied', statusHistory: [{ status: 'applied', at: t.appliedAt }],
    appliedAt: t.appliedAt, resumeId: t.resumeId, notes: [], reminders: [], createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
}

function pairingInfo(p: StoredPairing): PairingInfo {
  return { extensionId: p.extensionId, browser: p.browser, extensionVersion: p.extensionVersion, pairedAt: p.pairedAt, lastSeenAt: p.lastSeenAt };
}

// ------------------------------------------------------------------ routes

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const m = req.method ?? 'GET';

  if (m === 'OPTIONS') throw new ApiErr('forbidden_origin', 'Cross-site requests are not allowed.');
  if (m === 'GET' && (path === '/' || path === '/index.html')) {
    gate(req, 'page');
    send(res, 200, readFileSync(join(here, 'standin-ui.html'), 'utf8'), 'text/html; charset=utf-8');
    return;
  }
  if (m === 'GET' && path === '/api/v1/health') {
    gate(req, 'none');
    send(res, 200, { app: 'jobleft', version: VERSION, apiVersion: 1, extensionProtocol: EXTENSION_PROTOCOL_VERSION });
    return;
  }

  // ---- extension pairing
  if (m === 'POST' && path === '/api/v1/extension/pairing-code') {
    gate(req, 'launch');
    code = { code: String(randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: Date.now() + 5 * 60_000, wrong: 0 };
    send(res, 200, { code: code.code, expiresAt: new Date(code.expiresAt).toISOString() });
    return;
  }
  if (m === 'POST' && path === '/api/v1/extension/pair') {
    gate(req, 'none');
    const body = await json<{ code: string; extensionId: string; extensionVersion: string; protocolVersion: number; browser: string }>(req, PairRequestSchema);
    const origin = req.headers.origin === undefined ? null : String(req.headers.origin);
    if (origin !== `chrome-extension://${body.extensionId}`) throw new ApiErr('forbidden_origin', 'Only the extension itself can pair.');
    if (!code || Date.now() > code.expiresAt) throw new ApiErr('unauthorized', 'There is no pairing code, or it expired. Make a new code in the app.');
    if (!sameToken(body.code, code.code)) {
      code.wrong += 1;
      if (code.wrong >= 5) code = null;
      throw new ApiErr('unauthorized', code ? 'The code is wrong.' : 'The code is wrong. It was used up by 5 wrong tries: make a new code in the app.');
    }
    code = null;
    const token = randomBytes(32).toString('base64url');
    S.pairings = S.pairings.filter((p) => p.extensionId !== body.extensionId);
    S.pairings.push({ extensionId: body.extensionId, tokenHash: sha(token), browser: body.browser, extensionVersion: body.extensionVersion, pairedAt: nowIso(), lastSeenAt: null });
    save();
    send(res, 200, { pairingToken: token, appVersion: VERSION, protocolVersion: EXTENSION_PROTOCOL_VERSION });
    return;
  }
  if (m === 'GET' && path === '/api/v1/extension/pairings') {
    gate(req, 'launch');
    send(res, 200, S.pairings.map(pairingInfo));
    return;
  }
  const del = path.match(/^\/api\/v1\/extension\/pairings\/([a-p]{32})$/);
  if (m === 'DELETE' && del) {
    gate(req, 'launch');
    const before = S.pairings.length;
    S.pairings = S.pairings.filter((p) => p.extensionId !== del[1]);
    save();
    if (S.pairings.length === before) throw new ApiErr('not_found', 'No such paired browser.');
    send(res, 200, { ok: true });
    return;
  }
  if (m === 'DELETE' && path === '/api/v1/extension/pairing') {
    const who = gate(req, 'pairing');
    if (who.kind === 'pairing') S.pairings = S.pairings.filter((p) => p !== who.pairing);
    save();
    send(res, 200, { ok: true });
    return;
  }
  if (m === 'GET' && path === '/api/v1/extension/status') {
    gate(req, 'pairing');
    save();
    const missing = missingFields();
    send(res, 200, { paired: true, appVersion: VERSION, protocolVersion: EXTENSION_PROTOCOL_VERSION, profileComplete: missing.length === 0, missingProfileFields: missing });
    return;
  }
  if (m === 'POST' && path === '/api/v1/extension/page') {
    gate(req, 'pairing');
    const body = await json<{ pageUrl: string }>(req, PageInfoRequestSchema);
    const job = jobForUrl(body.pageUrl);
    const t = job ? S.tracker.find((x) => x.jobId === job.id) : S.tracker.find((x) => pageKey(x.pageUrl) === pageKey(body.pageUrl));
    const suggested = resumeFor(job, null);
    const info: PageInfo = {
      jobId: job?.id ?? null, title: job?.title ?? null, company: job?.company ?? null,
      applied: t ? { at: t.appliedAt, resumeId: t.resumeId } : null,
      resumes: S.resumes.map((r) => ({ id: r.id, name: r.name, fileName: r.fileName, tailoredForThisJob: !!job && r.jobId === job.id, isDefault: r.isDefault })),
      suggestedResumeId: suggested?.id ?? null,
    };
    send(res, 200, info);
    return;
  }
  if (m === 'POST' && path === '/api/v1/extension/fill') {
    gate(req, 'pairing');
    const body = await json<FillRequest>(req, FillRequestSchema);
    const job = jobForUrl(body.pageUrl);
    const r = resumeFor(job, body.resumeId);
    const offer = draftOffer();
    const out = await answerFill(body, {
      profile: S.profile, jobId: job?.id ?? null, draftOffer: offer,
      resume: r ? { id: r.id, fileName: r.fileName, mimeType: r.mimeType, base64: r.base64 } : null,
      draft: offer && offer.maxPriceMicrosPerDraft === 0 ? async (fs) => makeDrafts(fs, job) : undefined,
    });
    save();
    send(res, 200, out);
    return;
  }
  if (m === 'POST' && path === '/api/v1/extension/drafts') {
    gate(req, 'pairing');
    const body = await json<{ requestId: string; pageUrl: string; jobId: string | null; fields: FormField[]; maxCostMicros: number }>(req, DraftRequestSchema);
    const offer = draftOffer();
    if (!offer) throw new ApiErr('bad_request', 'No draft provider is set up in the app.');
    const fields = openQuestions(body.fields);
    const skipped = body.fields.filter((f) => !fields.includes(f)).map((f) => ({ fieldId: f.fieldId, message: 'This is not an open question, so jobleft does not draft it.' }));
    const cost = offer.maxPriceMicrosPerDraft * fields.length;
    if (cost > body.maxCostMicros) throw new ApiErr('bad_request', 'The drafts would cost more than you agreed to. Nothing was spent.');
    if (S.drafts.kind === 'publik_sim' && cost > S.drafts.balanceMicros) {
      throw new ApiErr('insufficient_balance', 'Your publik balance (simulated) is too low for these drafts. Nothing was spent.');
    }
    const job = jobForUrl(body.pageUrl);
    const drafts = makeDrafts(fields, job);
    // A failed draft costs nothing: charge only for drafts that were made.
    const spent = offer.maxPriceMicrosPerDraft * drafts.length;
    if (S.drafts.kind === 'publik_sim') S.drafts.balanceMicros -= spent;
    save();
    const outBody: DraftResponse = {
      drafts, costMicros: spent, balanceMicros: S.drafts.kind === 'publik_sim' ? S.drafts.balanceMicros : null,
      skipped: [...skipped, ...fields.filter((f) => !drafts.some((d) => d.fieldId === f.fieldId)).map((f) => ({ fieldId: f.fieldId, message: 'Your profile has too few facts for a true draft.' }))],
    };
    send(res, 200, outBody);
    return;
  }
  if (m === 'POST' && path === '/api/v1/extension/review') {
    gate(req, 'pairing');
    const body = await json<{ pageUrl: string; jobId: string | null; submittedByUser: boolean; resumeId?: string | null }>(req, ReviewResultSchema);
    let job = (body.jobId ? S.jobs.find((j) => j.id === body.jobId) : null) ?? jobForUrl(body.pageUrl);
    let t = job ? S.tracker.find((x) => x.jobId === job?.id) : undefined;
    if (!body.submittedByUser) { send(res, 200, { trackerEntry: t ? trackerEntry(t, job) : null }); return; }
    if (!job) {
      // A page the app did not know: record it as an external job, keyed by its address.
      job = { id: `ext-${sha(pageKey(body.pageUrl) ?? body.pageUrl).slice(0, 16)}`, title: null, company: null, url: body.pageUrl, external: true };
      if (!S.jobs.some((j) => j.id === job?.id)) S.jobs.push(job);
      t = S.tracker.find((x) => x.jobId === job?.id);
    }
    const at = nowIso();
    if (!t) {
      t = { jobId: job.id, pageUrl: body.pageUrl, appliedAt: at, resumeId: body.resumeId ?? null, createdAt: at, updatedAt: at };
      S.tracker.push(t);
    } else {
      t.updatedAt = at;
      if (body.resumeId) t.resumeId = body.resumeId;
    }
    save();
    send(res, 200, { trackerEntry: trackerEntry(t, job) });
    return;
  }

  // ---- the stand-in's own page (launch token)
  if (path.startsWith('/api/v1/standin/')) {
    gate(req, 'launch');
    const sub = path.slice('/api/v1/standin/'.length);
    if (m === 'GET' && sub === 'state') {
      send(res, 200, {
        profile: S.profile, jobs: S.jobs, tracker: S.tracker, pairings: S.pairings.map(pairingInfo), drafts: S.drafts,
        resumes: S.resumes.map(({ base64: _b, ...r }) => ({ ...r, bytes: Buffer.from(_b, 'base64').length })), home,
      });
      return;
    }
    if (m === 'PUT' && sub === 'profile') {
      const p = await json<ProfileInput>(req, ProfileInputSchema);
      S.profile = { ...S.profile, ...p, version: `v${Date.now()}`, updatedAt: nowIso() };
      save();
      send(res, 200, S.profile);
      return;
    }
    if (m === 'POST' && sub === 'jobs') {
      const b = await json<{ title: string; company: string; url: string }>(req);
      if (!/^https?:\/\//.test(String(b.url))) throw new ApiErr('bad_request', 'The job link must start with http:// or https://.');
      const k = pageKey(b.url);
      if (S.jobs.some((j) => pageKey(j.url) === k)) throw new ApiErr('conflict', 'A job with this link is already in the list.');
      const job: StoredJob = { id: `job-${randomBytes(4).toString('hex')}`, title: String(b.title || '') || null, company: String(b.company || '') || null, url: b.url, external: false };
      S.jobs.push(job);
      save();
      send(res, 200, job);
      return;
    }
    const jd = sub.match(/^jobs\/([\w-]+)$/);
    if (m === 'DELETE' && jd) {
      S.jobs = S.jobs.filter((j) => j.id !== jd[1]);
      save();
      send(res, 200, { ok: true });
      return;
    }
    if (m === 'POST' && sub === 'resumes') {
      const type = String(req.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
      if (!['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(type)) throw new ApiErr('unsupported_media_type', 'Upload a PDF or a Word (.docx) file.');
      const bytes = await readBody(req, RAW_BODY_LIMIT);
      const fileName = decodeURIComponent(String(req.headers['x-jobleft-filename'] ?? 'resume.pdf')).replace(/[\\/]/g, '_').slice(0, 120);
      const r: StoredResume = { id: `res-${randomBytes(4).toString('hex')}`, name: fileName.replace(/\.[a-z]+$/i, ''), fileName, mimeType: type, isDefault: !S.resumes.some((x) => x.isDefault), jobId: null, updatedAt: nowIso(), base64: bytes.toString('base64') };
      S.resumes.push(r);
      save();
      send(res, 200, { id: r.id });
      return;
    }
    const rp = sub.match(/^resumes\/([\w-]+)$/);
    if (rp && m === 'PATCH') {
      const b = await json<{ isDefault?: boolean; jobId?: string | null; name?: string }>(req);
      const r = S.resumes.find((x) => x.id === rp[1]);
      if (!r) throw new ApiErr('not_found', 'No such resume.');
      if (b.isDefault) for (const x of S.resumes) x.isDefault = x === r;
      if (b.jobId !== undefined) r.jobId = b.jobId && S.jobs.some((j) => j.id === b.jobId) ? b.jobId : null;
      if (typeof b.name === 'string' && b.name.trim()) r.name = b.name.trim().slice(0, 200);
      r.updatedAt = nowIso();
      save();
      send(res, 200, { ok: true });
      return;
    }
    if (rp && m === 'DELETE') {
      S.resumes = S.resumes.filter((x) => x.id !== rp[1]);
      save();
      send(res, 200, { ok: true });
      return;
    }
    if (m === 'PUT' && sub === 'draft-provider') {
      const b = await json<{ kind: DraftProvider['kind']; priceMicros?: number; balanceMicros?: number }>(req);
      if (!['local', 'publik_sim', 'none'].includes(b.kind)) throw new ApiErr('bad_request', 'Unknown provider.');
      S.drafts = { kind: b.kind, priceMicros: Math.max(0, Math.round(b.priceMicros ?? S.drafts.priceMicros)), balanceMicros: Math.max(0, Math.round(b.balanceMicros ?? S.drafts.balanceMicros)) };
      save();
      send(res, 200, S.drafts);
      return;
    }
    if (m === 'DELETE' && sub === 'tracker') { S.tracker = []; save(); send(res, 200, { ok: true }); return; }
    if (m === 'GET' && sub === 'log') {
      const lines = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').slice(-200) : [];
      send(res, 200, { lines });
      return;
    }
    if (m === 'POST' && sub === 'quit') {
      send(res, 200, { ok: true });
      setTimeout(() => shutdown(), 100);
      return;
    }
  }
  throw new ApiErr('not_found', 'No such route.');
}

// ------------------------------------------------------------------ server

const server = createServer((req, res) => {
  route(req, res).then(() => log(req, res.statusCode), (e: unknown) => {
    const err = e instanceof ApiErr ? e : new ApiErr('internal', 'The stand-in app hit a bug.');
    if (!(e instanceof ApiErr)) console.error(e);
    send(res, STATUS[err.code], { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    log(req, STATUS[err.code], err.code);
  });
});

function shutdown(): void {
  try { rmSync(join(home, 'run', 'server.json'), { force: true }); } catch { /* ignore */ }
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function listen(): Promise<number> {
  const ports = fixedPort ? [fixedPort] : Array.from({ length: PORT_SPAN }, (_, i) => DEFAULT_PORT + i);
  for (const p of ports) {
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(p, '127.0.0.1', () => resolve(true));
    });
    if (ok) return p;
  }
  throw new Error(`no free port in ${ports[0]}..${ports[ports.length - 1]}`);
}

port = await listen();
mkdirSync(join(home, 'run'), { recursive: true, mode: 0o700 });
writeFileSync(join(home, 'run', 'server.json'), JSON.stringify({ pid: process.pid, port, version: VERSION, startedAt: nowIso() }), { mode: 0o600 });
console.log(`jobleft stand-in app ${VERSION} (for extension tests; not the real app)`);
console.log(`data folder: ${home}`);
console.log(`open this page (it holds the launch token in the # part): http://127.0.0.1:${port}/#token=${launchToken}`);
