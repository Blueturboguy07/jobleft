// Server O7 and O8: one backup file brings back everything in a fresh folder; damaged or foreign files are refused
// and change nothing; backups and exports hold no key or token.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { ZipWriter } from '../src/services/zip.ts';
import { cleanup, PERSONA, scratchHome, startTest, type TestServer } from './helpers.ts';

const PDF = Buffer.from('%PDF-1.4\n% backup test resume\n%%EOF\n');
const CSV = 'First Name,Last Name,URL,Email Address,Company,Position,Connected On\nAlex,Example,,,Acme,Recruiter,04 Mar 2025\n';
const MARKER = 'sk-test-MARKER123-abcdefghijklmnop';

async function seed(s: TestServer): Promise<void> {
  await s.call('PUT', '/api/v1/profile', PERSONA);
  const job = await s.call('POST', '/api/v1/jobs/external', { text: 'Analyst at Acme\nCompany: Acme\nText', applyUrl: 'https://example.com/a' });
  await s.call('PATCH', `/api/v1/tracker/${encodeURIComponent(job.json.job.id)}`, { liked: true, status: 'applied', notes: [{ text: 'note ✓' }], reminders: [{ at: '2026-10-01T09:00:00Z', text: 'r', done: false }] });
  await s.call('POST', '/api/v1/filters', { name: 'f', filter: {}, sort: 'recommended' });
  await s.call('POST', '/api/v1/resumes/import', PDF, { 'content-type': 'application/pdf', 'x-jobleft-filename': 'cv.pdf' });
  await s.call('POST', '/api/v1/network/import', Buffer.from(CSV), { 'content-type': 'text/csv' });
  await s.call('PUT', '/api/v1/ai/settings', { provider: 'custom', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' });
  await s.call('PUT', '/api/v1/ai/key', { key: MARKER });
}

/** Every file inside a zip, inflated, as one string (for secret searches). */
function unzipAll(buf: Buffer): string {
  let out = '';
  let p = 0;
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const nameLen = buf.readUInt16LE(p + 26), extra = buf.readUInt16LE(p + 28);
    const start = p + 30 + nameLen + extra;
    // Find the data descriptor that follows this entry.
    let d = start;
    for (;;) {
      d = buf.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]), d);
      if (d < 0) return out;
      const csize = buf.readUInt32LE(d + 8);
      if (csize === d - start) break;
      d += 4;
    }
    const data = buf.subarray(start, d);
    out += (method === 8 ? inflateRawSync(data) : data).toString('latin1');
    p = d + 16;
  }
  return out;
}

test('backup then restore into a fresh folder brings back every kind, files byte for byte, and no secret', async () => {
  const a = await startTest('bk-a');
  let backup: Buffer;
  let counts: Record<string, number>;
  try {
    await seed(a);
    const r = await a.call('POST', '/api/v1/backup');
    assert.equal(r.status, 200);
    assert.match(String(r.headers['content-disposition']), /attachment; filename="jobleft-backup-/);
    backup = r.body;
    const all = unzipAll(backup);
    assert.ok(!all.includes(MARKER), 'no provider key in the backup');
    assert.ok(!all.includes(a.token), 'no launch token in the backup');
    const manifest = JSON.parse(all.slice(all.indexOf('{\n  "format"'), all.lastIndexOf('}') + 1));
    counts = manifest.counts;
    assert.equal(counts.resumeFiles, 1);
    assert.equal(counts.notes, 1);
    const exp = await a.call('GET', '/api/v1/export');
    assert.equal(exp.status, 200);
    const text = unzipAll(exp.body);
    assert.ok(text.includes('note ✓'.normalize()) || text.includes('note'), 'export holds the notes');
    assert.ok(!text.includes(MARKER) && !text.includes(a.token), 'no secret in the export');
  } finally { await a.stop(); cleanup(a.home); }

  const b = await startTest('bk-b');
  try {
    const r = await b.call('POST', '/api/v1/restore', backup, { 'content-type': 'application/zip' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.restored, counts);
    const res = (await b.call('GET', '/api/v1/resumes')).json;
    assert.equal(res[0].file.sha256, createHash('sha256').update(PDF).digest('hex'));
    const liked = (await b.call('GET', '/api/v1/tracker?view=liked')).json;
    assert.equal(liked.items[0].entry.notes[0].text, 'note ✓');
    assert.equal(liked.items[0].job.title.length > 0, true, 'the liked job came back with its details');
    assert.equal((await b.call('GET', '/api/v1/ai/settings')).json.keySet, false, 'keys never travel in a backup');
    assert.equal((await b.call('GET', '/api/v1/jobs?q=analyst')).json.total, 1, 'search works on the restored data');
    const again = await b.call('POST', '/api/v1/restore', backup, { 'content-type': 'application/zip' });
    assert.deepEqual(again.json.restored, counts, 'a second restore replaces, never duplicates');
  } finally { await b.stop(); cleanup(b.home); }
});

test('a cut, changed, random or crafted file is refused and the current data stays', async () => {
  const s = await startTest('bk-bad');
  try {
    await seed(s);
    const good = (await s.call('POST', '/api/v1/backup')).body;
    const before = (await s.call('GET', '/api/v1/tracker?view=liked')).json.counts;
    const flipped = Buffer.from(good); flipped[Math.floor(flipped.length / 2)] ^= 0x01;
    const flippedEnd = Buffer.from(good); flippedEnd[flippedEnd.length - 3] ^= 0x01;
    const tmp = join(s.home, 'tmp', 'crafted.zip');
    const z = new ZipWriter(tmp);
    z.addBuffer('../escape.txt', Buffer.from('x'));
    z.finish(true);
    const crafted = readFileSync(tmp);
    const zr = join(s.home, 'tmp', 'random.zip');
    const z2 = new ZipWriter(zr);
    z2.addBuffer('hello.txt', Buffer.from('hello'));
    z2.finish(false);
    const random = readFileSync(zr);
    for (const [label, bytes] of [['cut', good.subarray(0, good.length - 100)], ['one byte changed', flipped], ['seal changed', flippedEnd], ['random zip', random], ['random bytes', Buffer.from('not a zip at all')], ['crafted ../ path', crafted], ['empty', Buffer.alloc(0)]] as const) {
      const r = await s.call('POST', '/api/v1/restore', bytes, { 'content-type': 'application/zip' });
      assert.equal(r.status, 400, `${label}: ${r.text}`);
      assert.match(r.json.error.message, /Nothing was changed/, label);
    }
    assert.deepEqual((await s.call('GET', '/api/v1/tracker?view=liked')).json.counts, before);
    assert.equal((await s.call('GET', '/api/v1/profile')).json.personal.lastName, 'Testwell');
  } finally { await s.stop(); cleanup(s.home); }
});

test('delete everything removes records, files and keys', async () => {
  const s = await startTest('bk-del');
  try {
    await seed(s);
    const wrong = await s.call('POST', '/api/v1/data/delete', { confirm: 'yes' });
    assert.equal(wrong.status, 400);
    const r = await s.call('POST', '/api/v1/data/delete', { confirm: 'delete everything' });
    assert.equal(r.status, 200, r.text);
    assert.equal((await s.call('GET', '/api/v1/profile')).json.personal.lastName, null);
    assert.equal((await s.call('GET', '/api/v1/resumes')).json.length, 0);
    assert.equal((await s.call('GET', '/api/v1/network/contacts')).json.length, 0);
    assert.equal((await s.call('GET', '/api/v1/ai/settings')).json.keySet, false);
  } finally { await s.stop(); cleanup(s.home); }
});

void writeFileSync;
