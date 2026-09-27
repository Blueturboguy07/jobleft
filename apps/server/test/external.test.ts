// A job added from pasted text: the text's own apply link is used; with none, the job has no apply link (the UI then
// shows "No apply link" instead of opening the reserved no-link address) (JL-tracker-12).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, startTest } from './helpers.ts';

test('pasted text: the apply link the text states is the apply link; no link stays no link', async () => {
  const s = await startTest('ext');
  try {
    const a = await s.call('POST', '/api/v1/jobs/external', { text: 'Data Analyst\nQA Test Corp\nAustin, TX (Hybrid)\nFull-time. $80,000 - $95,000 per year.\nSee our site https://example.com/about for more.\nApply at https://example.com/careers/data-analyst.' });
    assert.equal(a.status, 200, a.text);
    assert.equal(a.json.job.applyUrl, 'https://example.com/careers/data-analyst');
    assert.equal(new URL(a.json.job.url).hostname, 'jobleft.invalid', 'the text is not a page: its own address stays the no-link one');
    const b = await s.call('POST', '/api/v1/jobs/external', { text: 'Senior Data Analyst at Northwind Traders\nLocation: Remote (US)\nTo apply email jobs@northwind.example' });
    assert.equal(b.status, 200, b.text);
    assert.equal(b.json.job.applyUrl, null);
    assert.equal(new URL(b.json.job.url).hostname, 'jobleft.invalid');
    // Two postings that name one careers page stay two jobs.
    const c = await s.call('POST', '/api/v1/jobs/external', { text: 'Data Engineer\nApply at https://example.com/careers/data-analyst' });
    assert.notEqual(c.json.job.id, a.json.job.id);
    // A link the person types wins over the text.
    const d = await s.call('POST', '/api/v1/jobs/external', { text: 'ML Engineer\nApply at https://example.com/careers/ml', applyUrl: 'https://jobs.example.org/ml-1' });
    assert.equal(d.json.job.url, 'https://jobs.example.org/ml-1');
  } finally { await s.stop(); cleanup(s.home); }
});
