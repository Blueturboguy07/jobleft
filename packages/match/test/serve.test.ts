// The local preview: 127.0.0.1 only, Host and Origin checks, a token in a header, JSON only, the documented endpoint,
// and skill claims that change the profile file (with undo). No request leaves the machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { MatchResultSchema, validate } from '@jobleft/contracts';
import { startPreview } from '../src/serve.ts';
import { PERSONA, SWE } from './helpers.ts';

function call(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

test('preview: security checks, the endpoint, and skill claims with undo', async () => {
  const dir = mkdtempSync('/private/tmp/jobleft-match-test-');
  const lines: string[] = [];
  try {
    mkdirSync(join(dir, 'jobs'));
    const profilePath = join(dir, 'profile.json');
    writeFileSync(profilePath, JSON.stringify({ personal: PERSONA, ...SWE, skills: ['TypeScript', 'MARKER-SKILL-XYZ'] }));
    writeFileSync(join(dir, 'jobs', 'a.txt'), 'Title: Data Engineer\nCompany: Contoso\nLocation: Austin, TX\n\nRequirements\n- SQL\n- Python\n- TypeScript');
    writeFileSync(join(dir, 'jobs', 'b.txt'), 'Title: Analytics Engineer\nCompany: Contoso\nLocation: Austin, TX\n\nRequirements\n- SQL\n- dbt');
    const srv = await startPreview({ profilePath, jobPaths: [join(dir, 'jobs')], port: 0, now: Date.parse('2026-09-25T00:00:00Z'), log: (l) => lines.push(l) });
    const host = `127.0.0.1:${srv.port}`;
    const auth = { host, 'x-jobleft-token': srv.token };
    try {
      assert.equal((await call(srv.port, '/api/v1/match/file%3Aa.txt', { headers: { host } })).status, 401);
      assert.equal((await call(srv.port, `/api/v1/match/file%3Aa.txt?token=${srv.token}`, { headers: { host } })).status, 401);
      assert.equal((await call(srv.port, '/api/v1/match/file%3Aa.txt', { headers: { ...auth, host: 'evil.example.com' } })).status, 403);
      assert.equal((await call(srv.port, '/api/v1/match/file%3Aa.txt', { headers: { ...auth, origin: 'https://evil.example.com' } })).status, 403);
      assert.equal((await call(srv.port, '/api/v1/match/file%3Aa.txt', { headers: { ...auth, origin: 'null' } })).status, 403);
      const r = await call(srv.port, '/api/v1/match/file%3Aa.txt', { headers: auth });
      assert.equal(r.status, 200);
      const m = JSON.parse(r.body);
      assert.ok(validate(MatchResultSchema, m).ok);
      assert.ok(m.skills.missing.includes('SQL'));
      assert.equal((await call(srv.port, '/preview/api/skills', { method: 'POST', headers: { ...auth, 'content-type': 'text/plain' }, body: '{"skill":"SQL","have":true}' })).status, 415);
      const claim = await call(srv.port, '/preview/api/skills', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ skill: 'SQL', have: true }) });
      assert.equal(claim.status, 200);
      assert.match(JSON.parse(claim.body).notice, /changes your profile/);
      for (const id of ['file%3Aa.txt', 'file%3Ab.txt']) {
        const after = JSON.parse((await call(srv.port, `/api/v1/match/${id}`, { headers: auth })).body);
        assert.ok(after.skills.matched.includes('SQL'), id);
      }
      assert.ok(JSON.parse(readFileSync(profilePath, 'utf8')).skills.some((s: { name: string }) => s.name === 'SQL'));
      assert.equal((await call(srv.port, '/preview/api/skills/undo', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' })).status, 200);
      const undone = JSON.parse((await call(srv.port, '/api/v1/match/file%3Aa.txt', { headers: auth })).body);
      assert.deepEqual(undone, m);
      const feed = JSON.parse((await call(srv.port, '/preview/api/feed', { headers: auth })).body);
      assert.equal(feed.counts.strong + feed.counts.good + feed.counts.fair + feed.counts.incomplete, feed.counts.total);
      const page = await call(srv.port, '/', { headers: { host } });
      assert.equal(page.status, 200);
      assert.ok(!page.body.includes(srv.token));
    } finally {
      await srv.close();
    }
    // Logs hold method, path, status and time: never profile text or the token.
    assert.ok(lines.length > 5);
    for (const l of lines) { assert.ok(!l.includes('MARKER-SKILL-XYZ')); assert.ok(!l.includes(srv.token)); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
