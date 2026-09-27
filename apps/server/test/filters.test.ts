// A saved filter keeps its search words, and its alert watches only jobs that match them (JL-tracker-15).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { greenhouseJob, startBoards } from '../scripts/mocks.ts';
import { cleanup, scratchHome, startTest } from './helpers.ts';

test('saved filter: the words are saved, kept on a change, cleared on purpose, and the alert counts only matching jobs', async () => {
  const dir = scratchHome('fltboards');
  const file = join(dir, 'boards.json');
  writeFileSync(file, JSON.stringify({ greenhouse: { mockco: [
    greenhouseJob(1, { board: 'mockco', title: 'Data Analyst', location: 'Austin, TX' }),
    greenhouseJob(2, { board: 'mockco', title: 'Registered Nurse', location: 'Austin, TX' }),
    greenhouseJob(3, { board: 'mockco', title: 'Line Cook', location: 'Austin, TX' }),
  ] } }));
  const boards = await startBoards({ file });
  const s = await startTest('flt', { env: { JOBLEFT_HOST_MAP: JSON.stringify({ 'boards-api.greenhouse.io': boards.origin }) } });
  try {
    const words = await s.call('POST', '/api/v1/filters', { name: 'Data analyst words', filter: {}, sort: 'recommended', alert: true, q: 'data analyst' });
    assert.equal(words.status, 200, words.text);
    assert.equal(words.json.q, 'data analyst');
    const all = await s.call('POST', '/api/v1/filters', { name: 'Everything', filter: {}, sort: 'recommended', alert: true });
    assert.equal(all.json.q, undefined, 'no words: none saved');
    // A change that does not send words keeps them (older screens); blank words clear them.
    const kept = await s.call('PUT', `/api/v1/filters/${words.json.id}`, { name: 'Data analyst words', filter: {}, sort: 'most_recent' });
    assert.equal(kept.json.q, 'data analyst');
    const listed = (await s.call('GET', '/api/v1/filters')).json;
    assert.equal(listed.find((f: any) => f.id === words.json.id).q, 'data analyst');

    await s.call('POST', '/api/v1/boards', { ats: 'greenhouse', board: 'mockco' });
    await s.call('POST', '/api/v1/crawl/run', {});
    for (let i = 0; i < 200; i++) { const st = (await s.call('GET', '/api/v1/crawl/status')).json; if (!st.running && st.lastRun) break; await new Promise((r) => setTimeout(r, 50)); }
    const notes = (await s.call('GET', '/api/v1/notifications')).json.filter((n: any) => n.kind === 'saved_filter_alert');
    const titles = notes.map((n: any) => n.title).sort();
    assert.deepEqual(titles, ['1 new job for "Data analyst words"', '3 new jobs for "Everything"']);

    const cleared = await s.call('PUT', `/api/v1/filters/${words.json.id}`, { name: 'Data analyst words', filter: {}, sort: 'most_recent', q: '' });
    assert.equal(cleared.json.q, undefined);
  } finally { await s.stop(); await boards.close(); cleanup(s.home); cleanup(dir); }
});
