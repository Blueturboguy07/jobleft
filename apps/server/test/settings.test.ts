// Settings fixes from the black-box pass (jobleft-qa findings/settings.md, JL-settings-*): AI keys, the publik
// connection, backup and restore, delete-all, load shedding and job sources.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { greenhouseJob, startAi, startBoards, startPublik } from '../scripts/mocks.ts';
import { cleanup, PERSONA, scratchHome, startTest, type TestServer } from './helpers.ts';

async function waitCrawl(s: TestServer): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const st = (await s.call('GET', '/api/v1/crawl/status')).json;
    if (!st.running && st.lastRun) return st.lastRun;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('crawl did not finish');
}

/** A server with one loopback Greenhouse board ("mockco", three jobs) added and crawled. */
async function withCrawledBoard(tag: string, fn: (s: TestServer, boardsFile: string) => Promise<void>): Promise<void> {
  const dir = scratchHome(`${tag}-boards`);
  const file = join(dir, 'boards.json');
  writeFileSync(file, JSON.stringify({ greenhouse: { mockco: [
    greenhouseJob(1, { board: 'mockco', title: 'Data Analyst', location: 'Austin, TX' }),
    greenhouseJob(2, { board: 'mockco', title: 'Nurse', location: 'Denver, CO' }),
    greenhouseJob(3, { board: 'mockco', title: 'Chef', location: 'Denver, CO' }),
  ] } }));
  const boards = await startBoards({ file });
  const s = await startTest(tag, { env: { JOBLEFT_HOST_MAP: JSON.stringify({ 'boards-api.greenhouse.io': boards.origin }) } });
  try {
    assert.equal((await s.call('POST', '/api/v1/boards', { ats: 'greenhouse', board: 'mockco' })).status, 200);
    assert.equal((await s.call('POST', '/api/v1/crawl/run', {})).json.started, true);
    assert.equal((await waitCrawl(s)).inserted, 3);
    await fn(s, file);
  } finally { await s.stop(); await boards.close(); cleanup(s.home); cleanup(dir); }
}

test('JL-settings-6: a key typed for OpenAI while a custom address is saved is refused (409) and never sent there', async () => {
  const ai = await startAi();
  const s = await startTest('keybind');
  try {
    const set = await s.call('PUT', '/api/v1/ai/settings', { provider: 'custom', baseUrl: `${ai.origin}/v1`, model: 'mock-model' });
    assert.equal(set.status, 200, set.text);
    const k = await s.call('PUT', '/api/v1/ai/key', { key: 'sk-proj-QAOPENAI-9z8y7x6w5v4u3t2s', provider: 'own_key', vendor: 'openai' });
    assert.equal(k.status, 409, k.text);
    assert.equal(k.json.error.code, 'conflict');
    assert.ok(!k.text.includes('QAOPENAI'));
    const after = (await s.call('GET', '/api/v1/ai/settings')).json;
    assert.equal(after.provider, 'custom');
    assert.equal(after.keySet, false);
    await s.call('POST', '/api/v1/ai/check');
    assert.ok(ai.log.every((e) => !String(e.headers.authorization ?? '').includes('QAOPENAI')), 'the OpenAI key never reached the custom address');
    // The provider saved first, then its key: kept for OpenAI, never for the custom address.
    assert.equal((await s.call('PUT', '/api/v1/ai/settings', { provider: 'own_key', vendor: 'openai', model: 'gpt-x' })).status, 200);
    const ok = await s.call('PUT', '/api/v1/ai/key', { key: 'sk-proj-QAOPENAI-9z8y7x6w5v4u3t2s', provider: 'own_key', vendor: 'openai' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.keyHint, '3t2s');
    assert.equal((await s.call('PUT', '/api/v1/ai/settings', { provider: 'custom', baseUrl: `${ai.origin}/v1`, model: 'mock-model' })).json.settings.keySet, false);
  } finally { await s.stop(); await ai.close(); cleanup(s.home); }
});

test('JL-settings-9: Disconnect then Connect resumes the same publik install (same balance), not a new empty account', async () => {
  const pub = await startPublik({ balanceMicros: 240_000 });
  const s = await startTest('pubresume', { env: { JOBLEFT_PUBLIK_APP_TOKEN: 'stand-in-app-token', JOBLEFT_PUBLIK_BASE_URL: `${pub.origin}/api/v1` } });
  try {
    const mints = () => pub.log.filter((e) => e.path === '/api/v1/installs' && e.method === 'POST').map((e) => JSON.parse(e.body).install_id as string);
    assert.equal((await s.call('POST', '/api/v1/publik/connect', { disclosureAccepted: true, disclosureVersion: 1 })).json.state, 'connected');
    assert.equal((await s.call('POST', '/api/v1/publik/disconnect')).json.state, 'disconnected');
    assert.equal((await s.call('GET', '/api/v1/publik')).json.state, 'disconnected');
    const again = await s.call('POST', '/api/v1/publik/connect', { disclosureAccepted: true, disclosureVersion: 1 });
    assert.equal(again.json.state, 'connected');
    assert.equal(again.json.wallet.balanceMicros, 240_000);
    const ids = mints();
    assert.equal(ids.length, 2);
    assert.equal(ids[1], ids[0], 'the reconnect asks publik for the same install');
  } finally { await s.stop(); await pub.close(); cleanup(s.home); }
});

/** Every file inside a zip, inflated, as one string (for searches), as in backup.test.ts. */
function unzipAll(buf: Buffer): string {
  let out = '';
  let p = 0;
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
    let d = start;
    for (;;) {
      d = buf.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]), d);
      if (d < 0) return out;
      if (buf.readUInt32LE(d + 8) === d - start) break;
      d += 4;
    }
    const data = buf.subarray(start, d);
    out += (method === 8 ? inflateRawSync(data) : data).toString('latin1');
    p = d + 16;
  }
  return out;
}

test('JL-settings-14/15: a backup carries no publik connection; a restore keeps this computer\'s publik account and saved keys', async () => {
  const pubA = await startPublik({ balanceMicros: 111_000 });
  const pubB = await startPublik({ balanceMicros: 222_000 });
  const a = await startTest('bk-pub-a', { env: { JOBLEFT_PUBLIK_APP_TOKEN: 'stand-in-app-token', JOBLEFT_PUBLIK_BASE_URL: `${pubA.origin}/api/v1` } });
  const b = await startTest('bk-pub-b', { env: { JOBLEFT_PUBLIK_APP_TOKEN: 'stand-in-app-token', JOBLEFT_PUBLIK_BASE_URL: `${pubB.origin}/api/v1` } });
  try {
    assert.equal((await a.call('POST', '/api/v1/publik/connect', { disclosureAccepted: true, disclosureVersion: 1 })).json.wallet.balanceMicros, 111_000);
    const installA = JSON.parse(pubA.log.find((e) => e.path === '/api/v1/installs')!.body).install_id as string;
    assert.equal((await a.call('PUT', '/api/v1/ai/settings', { provider: 'own_key', vendor: 'openai', model: 'gpt-x' })).status, 200);
    assert.equal((await a.call('PUT', '/api/v1/ai/key', { key: 'sk-proj-QAKEY-restore-Q7Z9', provider: 'own_key', vendor: 'openai' })).json.keyHint, 'Q7Z9');
    const backup = (await a.call('POST', '/api/v1/backup')).body;
    const all = unzipAll(backup);
    assert.ok(!all.includes(installA), 'no publik install id in the backup');
    assert.ok(!all.includes('claim/stand-in'), 'no publik claim link in the backup');
    assert.ok(!all.includes('ai.publik'), 'no publik connection record in the backup');

    // Same computer: everything back, the saved key still set (it never left this computer's secret store).
    assert.equal((await a.call('POST', '/api/v1/restore', backup, { 'content-type': 'application/zip' })).status, 200);
    const ai = (await a.call('GET', '/api/v1/ai/settings')).json;
    assert.equal(ai.provider, 'own_key');
    assert.equal(ai.keySet, true);
    assert.equal(ai.keyHint, 'Q7Z9');
    const pa = (await a.call('GET', '/api/v1/publik')).json;
    assert.equal(pa.state, 'connected');
    assert.equal(pa.wallet.balanceMicros, 111_000);

    // Another computer: its own publik account stays; the backup's account never shows there.
    assert.equal((await b.call('POST', '/api/v1/publik/connect', { disclosureAccepted: true, disclosureVersion: 1 })).json.wallet.balanceMicros, 222_000);
    assert.equal((await b.call('POST', '/api/v1/restore', backup, { 'content-type': 'application/zip' })).status, 200);
    const pb = (await b.call('GET', '/api/v1/publik')).json;
    assert.equal(pb.state, 'connected');
    assert.equal(pb.wallet.balanceMicros, 222_000, 'the balance card shows this computer\'s account, not the backup\'s');
    assert.equal((await b.call('GET', '/api/v1/ai/settings')).json.keySet, false, 'no key is set on a computer that never saved one');
    const before = pubA.log.length;
    assert.equal((await b.call('POST', '/api/v1/publik/refresh')).json.wallet.balanceMicros, 222_000);
    assert.equal(pubA.log.length, before, 'nothing went to the backup\'s publik account');
  } finally { await a.stop(); await b.stop(); await pubA.close(); await pubB.close(); cleanup(a.home); cleanup(b.home); }
});

test('JL-settings-22: "Delete my data" deletes the personal records and keeps the crawled jobs and boards', async () => {
  await withCrawledBoard('delkeep', async (s) => {
    const NOTE = 'private-note-QX7-zebra';
    await s.call('PUT', '/api/v1/profile', PERSONA);
    await s.call('PATCH', `/api/v1/tracker/${encodeURIComponent('greenhouse:mockco:1')}`, { liked: true, status: 'applied', notes: [{ text: NOTE }] });
    const ext = await s.call('POST', '/api/v1/jobs/external', { text: 'Secret Role at Hidden Co\nCompany: Hidden Co\nText', applyUrl: 'https://example.com/hidden' });
    assert.equal(ext.status, 200, ext.text);
    await s.call('POST', '/api/v1/filters', { name: 'my filter', filter: {}, sort: 'recommended' });
    await s.call('PUT', '/api/v1/ai/settings', { provider: 'custom', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' });
    assert.equal((await s.call('POST', '/api/v1/data/delete', { confirm: 'delete everything' })).status, 200);

    // Kept: the crawled jobs and the boards they come from.
    assert.equal((await s.call('POST', '/api/v1/jobs/search', { sort: 'most_recent' })).json.total, 3);
    assert.equal((await s.call('GET', '/api/v1/storage')).json.jobs, 3);
    const boards = (await s.call('GET', '/api/v1/boards?view=all')).json;
    assert.deepEqual(boards.items.map((b: any) => b.id), ['greenhouse:mockco']);
    assert.equal((await s.call('GET', `/api/v1/jobs/${encodeURIComponent('greenhouse:mockco:1')}`)).json.tracker, null, 'the job stays; its tracking is gone');

    // Gone: every personal record, the job the person added, their settings.
    assert.equal((await s.call('GET', '/api/v1/profile')).json.personal.lastName, null);
    assert.equal((await s.call('GET', `/api/v1/jobs/${encodeURIComponent(ext.json.job.id)}`)).status, 404);
    assert.equal((await s.call('GET', '/api/v1/tracker?view=liked')).json.items.length, 0);
    assert.equal((await s.call('GET', '/api/v1/filters')).json.length, 0);
    assert.equal((await s.call('GET', '/api/v1/ai/settings')).json.provider, null);
    // Nothing of the deleted text is left in the database file (freed pages are wiped).
    const data = join(s.home, 'data');
    for (const f of readdirSync(data)) {
      const bytes = readFileSync(join(data, f)).toString('latin1');
      for (const secret of [NOTE, 'Testwell', 'Hidden Co', 'my filter']) assert.ok(!bytes.includes(secret), `${f} holds "${secret}"`);
    }
  });
});
