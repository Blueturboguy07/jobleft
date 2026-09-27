import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCdx, slugsFromCdx } from '../src/commoncrawl.ts';
import { BusyPacer, createBoardHttp, DIRECTORY_FORMAT } from '../src/index.ts';
import { refreshDirectory } from '../src/refresh.ts';
import { startMockHosts } from '../scripts/mock-hosts.ts';
import { tmpdir } from 'node:os';
// Scratch folders: /private/tmp on macOS (short paths, no symlink games), the system temp folder elsewhere (Windows).
const TMP = process.platform === 'darwin' ? '/private/tmp' : tmpdir();

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'scripts', 'cc-discover.ts');

test('CDX answers: board tokens only, 200 answers only, cut-off lines skipped', () => {
  const lines = parseCdx(readFileSync(join(HERE, 'fixtures/cc/CC-MAIN-2026-39/job-boards.greenhouse.io/page-0.ndjson'), 'utf8'));
  assert.equal(lines.length, 7);
  const slugs = slugsFromCdx(lines, 'commoncrawl-test').map((s) => `${s.ats}:${s.slug}`);
  assert.deepEqual(slugs.sort(), ['greenhouse:acme-robotics', 'greenhouse:betacorp', 'greenhouse:gammaworks']);
});

test('replay of recorded-format answers works offline', () => {
  const dir = mkdtempSync(join(TMP, 'jl-cc-'));
  try {
    const out = join(dir, 'd.json');
    execFileSync(process.execPath, [SCRIPT, '--crawl', 'CC-MAIN-2026-39', '--host', 'job-boards.greenhouse.io', '--host', 'jobs.ashbyhq.com',
      '--pages', '0-1', '--replay', join(HERE, 'fixtures/cc'), '--out', out], { stdio: 'pipe' });
    const d = JSON.parse(readFileSync(out, 'utf8')) as { slugs: Array<{ ats: string; slug: string }>; requests: number };
    assert.equal(d.requests, 0);
    assert.equal(d.slugs.length, 6);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the live mode obeys the index robots.txt and asks nothing else', async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? '');
    if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('User-agent: *\nDisallow: /\nAllow: /$\n'); return; }
    res.writeHead(200); res.end('{"pages": 1}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    const port = (server.address() as AddressInfo).port;
    // An async child: the mock server in this process must keep answering while the script runs.
    const r = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const c = spawn(process.execPath, [SCRIPT, '--crawl', 'CC-MAIN-2026-39', '--host', 'job-boards.greenhouse.io'], {
        env: { ...process.env, JOBLEFT_HOST_MAP: JSON.stringify({ 'index.commoncrawl.org': `http://127.0.0.1:${port}` }) },
      });
      let stderr = '';
      c.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      c.on('close', (status) => resolve({ status, stderr }));
    });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /robots\.txt does not allow/);
    assert.deepEqual(seen, ['/robots.txt']);
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});

test('discovered tokens join the directory only when live and named by the board itself', async () => {
  const mock = await startMockHosts({ boards: { 'greenhouse:acme-robotics': { name: 'Acme Robotics' }, 'greenhouse:noname': { name: '' }, 'greenhouse:existing': { name: 'Existing' } } });
  try {
    const http = createBoardHttp({ pacer: new BusyPacer(0), hostMap: mock.hostMap });
    const input = {
      format: DIRECTORY_FORMAT, version: 't', generatedAt: '', notice: 'n', counts: {},
      sources: [{ id: 'jobsync', name: 'j', url: 'https://github.com/Gsync/jobsync', licence: 'MIT', licenceUrl: null, rows: 1 }],
      rows: [{ ats: 'greenhouse' as const, slug: 'existing', name: 'Existing', region: null, source: 'jobsync', lastVerified: null, status: 'unverified' as const }],
    };
    const res = await refreshDirectory({
      input, pruned: null, http, select: { kind: 'none' }, maxChecks: 10, recheckAfterHours: 24, now: Date.now(),
      discovered: ['acme-robotics', 'noname', 'nosuch', 'existing'].map((slug) => ({ ats: 'greenhouse' as const, slug, region: null, source: 'commoncrawl-CC-MAIN-2026-39' })),
      discoveredSources: [{ id: 'commoncrawl-CC-MAIN-2026-39', name: 'cc', url: 'https://index.commoncrawl.org/', licence: 'CC ToU', licenceUrl: null, rows: 0 }],
    });
    assert.deepEqual(res.file.rows.map((r) => `${r.slug}=${r.name}`).sort(), ['acme-robotics=Acme Robotics', 'existing=Existing']);
    assert.equal(res.summary.added, 1);
    assert.equal(res.summary.discoveredSkippedNoName, 1);
    assert.equal(res.file.sources.find((s) => s.id === 'commoncrawl-CC-MAIN-2026-39')?.rows, 1);
  } finally { await mock.close(); }
});
