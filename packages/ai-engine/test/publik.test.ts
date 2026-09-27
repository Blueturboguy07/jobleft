import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECRET_NAMES, formatDollars } from '@jobleft/contracts';
import { AiError, PUBLIK_DISCLOSURE_VERSION, toApiError } from '../src/index.ts';
import { collect, makeEngine, use, withPublik } from './helpers.ts';

test('connect needs no typed key; one connection keeps one key', async () => {
  await withPublik({ balanceUsd: 5 }, async (p) => {
    const { engine, secrets } = makeEngine({ publikBaseUrl: p.baseUrl });
    assert.equal((await engine.publik.status()).state, 'disconnected');
    await assert.rejects(engine.publik.connect(PUBLIK_DISCLOSURE_VERSION + 1), /disclosure/);
    const c = await engine.publik.connect(PUBLIK_DISCLOSURE_VERSION);
    assert.equal(c.state, 'connected');
    assert.equal(c.wallet?.balanceMicros, 5_000_000);
    assert.match(c.wallet!.topUpUrl, /^https:\/\/publikhq\.com\/claim\//);
    assert.ok(!JSON.stringify(c).includes('pk_test_'), 'the key is never in what the app shows');
    const key = await secrets.get(SECRET_NAMES.publikKey);
    assert.match(key!, /^pk_test_/);
    await engine.publik.connect(PUBLIK_DISCLOSURE_VERSION);
    assert.equal(p.state().keys, 1, 'a second connect does not mint a second key');
  });
});

test('three paid chats: the balance follows publik, in dollars, with no restart', async () => {
  await withPublik({ balanceUsd: 5, priceUsd: 0.01 }, async (p) => {
    const { engine } = makeEngine({ publikBaseUrl: p.baseUrl });
    await engine.publik.connect(PUBLIK_DISCLOSURE_VERSION);
    const { check } = await use(engine, { provider: 'publik' });
    assert.equal(check.ok, true, check.message);
    assert.equal(p.state().charges, 0, 'the setup check spends nothing');
    for (let i = 0; i < 3; i++) {
      const { text } = await collect(engine.client().chat({ messages: [{ role: 'user', content: 'Reply with the word ready' }] }));
      assert.equal(text, 'ready');
    }
    await engine.idle();
    const w = (await engine.publik.status()).wallet!;
    assert.equal(w.balanceMicros, 4_970_000);
    assert.equal(formatDollars(w.balanceMicros), '$4.97');
    assert.equal(p.state().charges, 3);
    const done = await engine.client().complete({ messages: [{ role: 'user', content: 'x' }] });
    assert.equal(done.costMicros, null, 'a stream has no charge header: unknown, never an estimate');
  });
});

test('balance too low: one plain message, exactly one link, no retry, works again after money is added', async () => {
  await withPublik({ balanceUsd: 0 }, async (p) => {
    const { engine } = makeEngine({ publikBaseUrl: p.baseUrl });
    await engine.publik.connect(PUBLIK_DISCLOSURE_VERSION);
    const { check } = await use(engine, { provider: 'publik' });
    assert.equal(check.problem, 'balance_too_low');
    assert.equal(check.link?.url.startsWith('https://publikhq.com/'), true);
    const before = p.log.entries.filter((e) => e.path === '/api/v1/chat/completions').length;
    let err: AiError | null = null;
    try { await collect(engine.client().chat({ messages: [{ role: 'user', content: 'my typed message' }] })); } catch (e) { err = e as AiError; }
    assert.equal(err?.code, 'insufficient_balance');
    assert.match(err!.message, /balance ran out \(\$0\.00 left\)/);
    assert.doesNotMatch(err!.message, /credit|402|quota/i);
    const api = toApiError(err);
    assert.equal(api.status, 402);
    assert.equal(api.body.error.code, 'insufficient_balance');
    assert.match(api.body.error.link!.url, /^https:\/\/publikhq\.com\//);
    assert.equal(JSON.stringify(api.body).match(/https?:\/\//g)!.length, 1, 'exactly one link');
    const after = p.log.entries.filter((e) => e.path === '/api/v1/chat/completions').length;
    assert.equal(after - before, 1, 'one request, no retry, no other provider');
    p.setBalanceMicros(5_000_000);
    const { text } = await collect(engine.client().chat({ messages: [{ role: 'user', content: 'Reply with the word ready' }] }));
    assert.equal(text, 'ready');
  });
});

test('disconnect revokes and deletes the key; nothing spends the balance afterwards', async () => {
  await withPublik({ balanceUsd: 5 }, async (p) => {
    const { engine, secrets } = makeEngine({ publikBaseUrl: p.baseUrl });
    await engine.publik.connect(PUBLIK_DISCLOSURE_VERSION);
    await use(engine, { provider: 'publik' });
    const charges = p.state().charges;
    const d = await engine.publik.disconnect();
    assert.equal(d.state, 'disconnected');
    assert.equal(await secrets.get(SECRET_NAMES.publikKey), null);
    assert.equal(p.state().liveKeys, 0, 'revoked at publik');
    const n = p.log.entries.length;
    await assert.rejects(collect(engine.client().chat({ messages: [{ role: 'user', content: 'hi' }] })), (e: AiError) => e.code === 'no_provider');
    await assert.rejects(engine.client().json({ schema: { type: 'object' }, messages: [{ role: 'user', content: 'hi' }] }), (e: AiError) => e.code === 'no_provider');
    assert.equal(p.log.entries.length, n, 'no request after disconnect');
    assert.equal(p.state().charges, charges);
  });
});

test('disconnect during a stream stops it at once', async () => {
  await withPublik({ balanceUsd: 5 }, async (p) => {
    const { engine } = makeEngine({ publikBaseUrl: p.baseUrl });
    await engine.publik.connect(PUBLIK_DISCLOSURE_VERSION);
    await use(engine, { provider: 'publik' });
    await fetch(`http://127.0.0.1:${p.port}/__admin/mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"mode":"stall"}' });
    const running = collect(engine.client().chat({ messages: [{ role: 'user', content: 'hi' }] })).then(() => null, (e: AiError) => e);
    await new Promise((r) => setTimeout(r, 150));
    const t0 = Date.now();
    await engine.publik.disconnect();
    // JL-settings-10: the stop names its real reason (it said "You stopped the answer." in the Assistant).
    const stopped = await running;
    assert.equal(stopped?.code, 'no_provider');
    assert.match(stopped!.message, /publik was disconnected, so the answer stopped/);
    assert.ok(Date.now() - t0 < 2000);
    // A stop the person asks for is still a plain cancel.
    await engine.publik.connect(PUBLIK_DISCLOSURE_VERSION);
    const ctl = new AbortController();
    const mine = collect(engine.client().chat({ messages: [{ role: 'user', content: 'hi' }], signal: ctl.signal })).then(() => null, (e: AiError) => e);
    await new Promise((r) => setTimeout(r, 150));
    ctl.abort();
    assert.equal((await mine)?.code, 'cancelled');
  });
});

test('a failed connect leaves nothing half connected', async () => {
  await withPublik({}, async (p) => {
    const { engine, secrets } = makeEngine({ publikBaseUrl: p.baseUrl, appToken: 'pat_jobleft_wrongwrongwrongwrongwrongwrong00' });
    await assert.rejects(engine.publik.connect(PUBLIK_DISCLOSURE_VERSION), (e: AiError) => /nothing was connected/.test(e.message));
    assert.equal((await engine.publik.status()).state, 'disconnected');
    assert.equal(await secrets.get(SECRET_NAMES.publikKey), null);
  });
  const { engine } = makeEngine({ appToken: null });
  await assert.rejects(engine.publik.connect(PUBLIK_DISCLOSURE_VERSION), (e: AiError) => e.code === 'not_ready' && /no publik app token/.test(e.message));
  const off = makeEngine({ publikBaseUrl: 'http://127.0.0.1:9/api/v1' });
  await assert.rejects(off.engine.publik.connect(PUBLIK_DISCLOSURE_VERSION), (e: AiError) => e.code === 'unreachable');
  assert.equal((await off.engine.publik.status()).state, 'disconnected');
});

test('publik-smart needs a linked account; a revoked key disconnects with a plain message', async () => {
  await withPublik({ balanceUsd: 5 }, async (p) => {
    const { engine, secrets } = makeEngine({ publikBaseUrl: p.baseUrl });
    await engine.publik.connect(PUBLIK_DISCLOSURE_VERSION);
    const { check } = await use(engine, { provider: 'publik', model: 'publik-smart' });
    assert.equal(check.ok, false);
    assert.match(check.message, /linked/);
    await assert.rejects(collect(engine.client().chat({ messages: [{ role: 'user', content: 'hi' }] })), (e: AiError) => e.code === 'needs_claim' && !!e.topUpUrl);
    await use(engine, { provider: 'publik', model: 'publik-balanced' });
    await fetch(`http://127.0.0.1:${p.port}/__admin/revoke-all`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await assert.rejects(collect(engine.client().chat({ messages: [{ role: 'user', content: 'hi' }] })), (e: AiError) => e.code === 'key_refused' && /removed/.test(e.message));
    assert.equal(await secrets.get(SECRET_NAMES.publikKey), null);
    assert.equal((await engine.publik.status()).state, 'disconnected');
  });
});

test('the publik key never goes to another provider', async () => {
  await withPublik({ balanceUsd: 5 }, async (p) => {
    const { engine, secrets } = makeEngine({ publikBaseUrl: p.baseUrl });
    await engine.publik.connect(PUBLIK_DISCLOSURE_VERSION);
    const key = (await secrets.get(SECRET_NAMES.publikKey))!;
    const { startMockModelServer } = await import('../src/mock/model-server.ts');
    const m = await startMockModelServer({});
    try {
      await use(engine, { provider: 'custom', baseUrl: m.url, model: 'standin-7b' });
      await collect(engine.client().chat({ messages: [{ role: 'user', content: 'hi' }] }));
      await assert.rejects(engine.setKey('   '), /empty/);
      await assert.rejects(use(engine, { provider: 'publik', model: 'gpt-4o' }), /publik tier/);
      for (const e of m.log.entries) assert.ok(!JSON.stringify(e).includes(key));
    } finally { await m.close(); }
  });
});

// JL-settings-9: Disconnect then Connect made a new, empty publik account; the balance stayed on the old one.
test('disconnect then connect resumes the same install and balance; delete-all forgets it', async () => {
  await withPublik({ balanceUsd: 0.24 }, async (p) => {
    const { engine, secrets } = makeEngine({ publikBaseUrl: p.baseUrl });
    const installIds = () => p.log.entries.filter((e) => e.path === '/api/v1/installs' && e.method === 'POST').map((e) => JSON.parse(e.body).install_id as string);
    await engine.publik.connect(PUBLIK_DISCLOSURE_VERSION);
    const firstKey = await secrets.get(SECRET_NAMES.publikKey);
    await engine.publik.disconnect();
    assert.equal(await secrets.get(SECRET_NAMES.publikKey), null, 'the key is deleted on disconnect');
    assert.equal(p.state().liveKeys, 0, 'and revoked at publik');
    const again = await engine.publik.connect(PUBLIK_DISCLOSURE_VERSION);
    assert.equal(again.state, 'connected');
    assert.equal(again.wallet?.balanceMicros, 240_000, 'the same balance');
    const ids = installIds();
    assert.equal(ids.length, 2);
    assert.equal(ids[1], ids[0], 'the reconnect resumes the same install');
    const secondKey = await secrets.get(SECRET_NAMES.publikKey);
    assert.ok(secondKey && secondKey !== firstKey, 'publik gave the install a new key');
    // An install removed on the publik dashboard cannot be resumed: a new install is made, in the same connect.
    await engine.publik.disconnect();
    await fetch(`${p.baseUrl.replace(/\/api\/v1$/, '')}/__admin/remove-installs`, { method: 'POST', body: '{}' });
    assert.equal((await engine.publik.connect(PUBLIK_DISCLOSURE_VERSION)).state, 'connected');
    const after = installIds();
    assert.equal(after.length, 4);
    assert.equal(after[2], ids[0]);
    assert.notEqual(after[3], ids[0]);
    // Delete all data forgets the install: the next connect is a new install.
    await engine.forgetAllKeys();
    await engine.publik.connect(PUBLIK_DISCLOSURE_VERSION);
    const last = installIds();
    assert.equal(last.length, 5);
    assert.notEqual(last[4], after[3]);
  });
});

test('a streamed answer never shows its temporary hold as the balance; the re-read after it does (JL-tracker-14)', async () => {
  await withPublik({ balanceUsd: 5, priceUsd: 0.01 }, async (p) => {
    const { engine } = makeEngine({ publikBaseUrl: p.baseUrl });
    await engine.publik.connect(PUBLIK_DISCLOSURE_VERSION);
    // The headers written before a streamed answer: the balance there is minus a hold.
    engine.publik.observeHeaders({ 'x-publik-balance': '3900000', 'x-publik-week-used': '10000' }, { balance: false });
    let w = (await engine.publik.status()).wallet!;
    assert.equal(w.balanceMicros, 5_000_000, 'the hold is not shown as spent');
    assert.equal(w.week.usedMicros, 10_000, 'the other facts are still read');
    // A whole (not streamed) answer's headers come after the charge: they are the balance.
    engine.publik.observeHeaders({ 'x-publik-balance': '4990000' });
    assert.equal((await engine.publik.status()).wallet!.balanceMicros, 4_990_000);
    // A real streamed chat: the balance shown afterwards is what publik reports after the charge.
    await use(engine, { provider: 'publik' });
    await collect(engine.client().chat({ messages: [{ role: 'user', content: 'Reply with the word ready' }] }));
    await engine.idle();
    w = (await engine.publik.status()).wallet!;
    assert.equal(w.balanceMicros, p.state().balanceMicros);
  });
});

test('JL-network-19: a daily-limit refusal says what happened (this step, not the balance), with the amounts and a local reset time', async () => {
  await withPublik({ balanceUsd: 5 }, async (p) => {
    const { engine } = makeEngine({ publikBaseUrl: p.baseUrl });
    await engine.publik.connect(PUBLIK_DISCLOSURE_VERSION);
    const e = await engine.publik.failure(429, { 'retry-after': '3600' }, JSON.stringify({ error: { type: 'daily_cap_reached', daily_cap_micros: 250_000, spent_today_micros: 145_795 } }));
    assert.equal(e.code, 'provider_error');
    assert.match(e.message, /^This AI step would go over today's publik spending limit for this computer \(\$0\.25 a day, \$0\.14 used so far\), so publik did not run it and nothing was charged\./);
    assert.match(e.message, /smaller AI steps may still run\. The limit starts again (today|tomorrow) at \d{1,2}:\d{2} [AP]M/);
    assert.doesNotMatch(e.message, /midnight UTC/, 'a reset one hour away is not called midnight');
    const w = (await engine.publik.status()).wallet!;
    assert.equal(w.daily?.capMicros, 250_000);
    assert.ok(w.daily?.reachedAt);
    assert.equal(w.balanceMicros, 5_000_000);
    // Without amounts from publik, no amount is guessed.
    const bare = await engine.publik.failure(429, {}, JSON.stringify({ error: { type: 'daily_cap_reached' } }));
    assert.doesNotMatch(bare.message.replace(/\$0\.25 a day, \$0\.14 used so far/, ''), /\$/);
  });
});
