// Foundation addition (not part of the 76 ported S1 tests): the loopback host map used to point a crawl
// at local mock servers. The never-crawl list is checked on the REAL host before any mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeniedHostError, HostMapError, HttpClient, Pacer, checkHostMap, hostMapFromEnv } from '../src/http.ts';

function recordingFetch(calls: string[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
    return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
  }) as typeof fetch;
}
const fastPacer = () => {
  const clock = { t: 0 };
  return new Pacer(1000, () => clock.t, async (ms) => { clock.t += ms; });
};

test('host map: a real ATS host is sent to the loopback mock origin, path and query kept', async () => {
  const calls: string[] = [];
  const c = new HttpClient({
    fetchImpl: recordingFetch(calls), pacer: fastPacer(),
    hostMap: { 'boards-api.greenhouse.io': 'http://127.0.0.1:4010' },
  });
  await c.getJson('https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true');
  assert.deepEqual(calls, ['http://127.0.0.1:4010/robots.txt', 'http://127.0.0.1:4010/v1/boards/acme/jobs?content=true']);
});

test('host map: a never-crawl host is refused before mapping, and cannot be a map key', async () => {
  const calls: string[] = [];
  const c = new HttpClient({ fetchImpl: recordingFetch(calls), pacer: fastPacer(), hostMap: {} });
  await assert.rejects(c.getJson('https://www.linkedin.com/jobs'), DeniedHostError);
  assert.equal(calls.length, 0);
  assert.throws(() => checkHostMap({ 'www.linkedin.com': 'http://127.0.0.1:4010' }), HostMapError);
});

test('host map: only loopback http(s) targets are accepted, from code or from JOBLEFT_HOST_MAP', () => {
  assert.throws(() => checkHostMap({ 'api.lever.co': 'https://example.com' }), HostMapError);
  assert.throws(() => checkHostMap({ 'api.lever.co': 'file:///etc/passwd' }), HostMapError);
  assert.deepEqual(checkHostMap({ 'API.Lever.co': 'http://localhost:4011/' }), { 'api.lever.co': 'http://localhost:4011' });
  assert.deepEqual(hostMapFromEnv({}), {});
  assert.deepEqual(hostMapFromEnv({ JOBLEFT_HOST_MAP: '{"api.ashbyhq.com":"http://127.0.0.1:4012"}' }), { 'api.ashbyhq.com': 'http://127.0.0.1:4012' });
  assert.throws(() => hostMapFromEnv({ JOBLEFT_HOST_MAP: 'not json' }), HostMapError);
});
