import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, row } from './helpers.ts';

const DAY = 86_400_000;

test('dead boards stop wasting requests; one failure never kills a board; a board that answers again comes back', async () => {
  const boards: Record<string, { name: string; jobs: number; script?: string[] }> = {};
  for (let i = 0; i < 15; i++) boards[`greenhouse:ok${i}`] = { name: `Ok ${i}`, jobs: 2 };
  for (let i = 0; i < 3; i++) boards[`greenhouse:dead${i}`] = { name: `Dead ${i}`, jobs: 2, script: ['404'] };
  boards['greenhouse:blip404'] = { name: 'Blip', jobs: 2, script: ['404', 'ok'] };
  boards['greenhouse:bliptimeout'] = { name: 'Slow once', jobs: 2, script: ['timeout', 'ok'] };
  const directory = Object.keys(boards).map((k) => row('greenhouse', k.split(':')[1]!, boards[k]!.name));
  const r = await rig({ boards }, { directory, timeoutMs: 400 });
  try {
    for (let cycle = 0; cycle < 10; cycle++) {
      await r.scheduler.runOnce();
      r.clock.now += 60_000; // one minute between refreshes
    }
    for (let i = 0; i < 3; i++) {
      assert.equal(r.mock.listRequests(`greenhouse:dead${i}`).length, 2, `dead${i} is asked in the first 2 refreshes only`);
      const e = r.service.get(`greenhouse:dead${i}`)!;
      assert.equal(e.state, 'unreachable');
      assert.ok(e.nextCheckAt && Date.parse(e.nextCheckAt) > r.clock.now, 'it states its next check date');
      assert.ok(e.lastCheckAt);
    }
    for (const id of ['greenhouse:blip404', 'greenhouse:bliptimeout', 'greenhouse:ok0']) assert.equal(r.service.get(id)!.state, 'live', id);
    assert.equal(r.mock.listRequests('greenhouse:ok3').length, 10, 'a live board gets one list request per refresh');
    // The dead board answers again; after its next check date it is live again with no action from the person.
    r.mock.setBoard('greenhouse:dead0', { name: 'Dead 0', jobs: 5 });
    await r.scheduler.runOnce();
    assert.equal(r.service.get('greenhouse:dead0')!.state, 'unreachable', 'not asked before its date');
    r.clock.now += 2 * DAY;
    await r.scheduler.runOnce();
    const back = r.service.get('greenhouse:dead0')!;
    assert.equal(back.state, 'live');
    assert.equal(back.openJobs, 5);
    assert.equal(r.store.count("ats = 'greenhouse' AND board = 'dead0' AND closed_at IS NULL"), 5, 'its jobs appear');
  } finally { await r.close(); }
});

test('a failing board never closes its jobs, and shows a warning', async () => {
  // A 500 is retried once by the polite client, so it takes two steps.
  const r = await rig({ boards: { 'greenhouse:acme': { name: 'Acme', jobs: 20, script: ['ok', '500', '500', '404', 'empty', 'broken', 'ok'] } } },
    { directory: [row('greenhouse', 'acme', 'Acme')] });
  try {
    await r.scheduler.runOnce();
    assert.equal(r.store.count("board = 'acme' AND closed_at IS NULL"), 20);
    for (const step of ['500', '404', 'empty', 'broken']) {
      r.clock.now += 3 * DAY; // past any back-off, and past the 48 h close grace
      await r.scheduler.runOnce();
      assert.equal(r.store.count("board = 'acme' AND closed_at IS NULL"), 20, `after ${step} all 20 jobs are open`);
      const e = r.service.get('greenhouse:acme')!;
      assert.notEqual(e.state, 'live', `after ${step} the board shows a warning`);
      assert.ok(e.lastError, `after ${step} the board says why`);
    }
  } finally { await r.close(); }
});

test('a board in the directory and in the person list is fetched once; hidden and disabled boards get no request', async () => {
  const r = await rig({ boards: { 'greenhouse:acme': { name: 'Acme', jobs: 3 }, 'greenhouse:hid': { name: 'Hid', jobs: 1 }, 'greenhouse:off': { name: 'Off', jobs: 1 } } },
    { directory: [row('greenhouse', 'acme', 'Acme'), row('greenhouse', 'hid', 'Hid'), row('greenhouse', 'off', 'Off')] });
  try {
    await r.service.resolve('https://boards.greenhouse.io/acme');
    r.service.add({ ats: 'greenhouse', board: 'acme' });
    r.service.update('greenhouse:acme', { followed: true });
    r.service.update('greenhouse:hid', { hidden: true });
    r.service.update('greenhouse:off', { disabled: true });
    const before = r.mock.listRequests('greenhouse:acme').length;
    await r.scheduler.runOnce();
    assert.equal(r.mock.listRequests('greenhouse:acme').length - before, 1);
    assert.equal(r.mock.listRequests('greenhouse:hid').length, 0);
    assert.equal(r.mock.listRequests('greenhouse:off').length, 0);
    assert.equal(r.store.count("board = 'acme'"), 3, 'each job once');
    assert.equal(r.service.list({}).total, 3, 'one board, not two');
  } finally { await r.close(); }
});

test('before any check every board says not checked yet, with no count', async () => {
  const r = await rig({}, { directory: [row('ashby', 'a', 'A'), row('lever', 'b', 'B')] });
  try {
    for (const e of r.service.list({}).items) {
      assert.equal(e.state, 'not_checked');
      assert.equal(e.openJobs, null);
      assert.equal(e.lastCheckAt, null);
    }
  } finally { await r.close(); }
});

test('a newer directory never removes, renames or re-enables the person boards and choices', async () => {
  const { BoardDirectory, BoardService } = await import('../src/index.ts');
  const r = await rig({ boards: { 'greenhouse:mine': { name: 'Mine Inc', jobs: 1 } } },
    { directory: [row('greenhouse', 'mine', 'Mine Inc'), row('lever', 'off1', 'Off One'), row('lever', 'fol1', 'Fol One')] });
  try {
    await r.service.resolve('https://boards.greenhouse.io/mine');
    r.service.add({ ats: 'greenhouse', board: 'mine' });
    r.service.update('lever:off1', { disabled: true });
    r.service.update('lever:fol1', { followed: true });
    // A newer directory: drops "mine" and "off1", renames "fol1".
    const next = new BoardService({ db: r.store.db, directory: new BoardDirectory([row('lever', 'fol1', 'Renamed')]), http: {} as never, sources: {} });
    assert.equal(next.get('greenhouse:mine')?.company, 'Mine Inc');
    assert.equal(next.get('greenhouse:mine')?.origin, 'user');
    assert.equal(next.get('lever:off1')?.disabled, true);
    assert.equal(next.get('lever:fol1')?.followed, true);
    assert.equal(next.get('lever:fol1')?.company, 'Fol One');
  } finally { await r.close(); }
});

test('a job removed from a working board closes after two refreshes a day apart; the others stay open', async () => {
  const ids = Array.from({ length: 20 }, (_, i) => String(2000 + i));
  const r = await rig({ boards: { 'greenhouse:acme': { name: 'Acme', jobs: ids } } }, { directory: [row('greenhouse', 'acme', 'Acme')] });
  try {
    await r.scheduler.runOnce();
    r.mock.setBoard('greenhouse:acme', { name: 'Acme', jobs: ids.slice(1) });
    r.clock.now += 60 * 60_000;
    await r.scheduler.runOnce();
    assert.equal(r.store.count("board = 'acme' AND closed_at IS NOT NULL"), 0, 'not closed after one refresh');
    r.clock.now += DAY;
    await r.scheduler.runOnce();
    assert.equal(r.store.count("board = 'acme' AND closed_at IS NOT NULL"), 1);
    assert.equal(r.store.count("board = 'acme' AND closed_at IS NOT NULL AND job_id = '2000'"), 1);
    assert.equal(r.store.count("board = 'acme' AND closed_at IS NULL"), 19);
  } finally { await r.close(); }
});

test('a board that answers 429 waits at least its Retry-After, and the host gets no request before that', async () => {
  const r = await rig({ boards: { 'greenhouse:busy': { name: 'Busy', jobs: 2, script: ['429:3', 'ok'] }, 'greenhouse:calm': { name: 'Calm', jobs: 1 } } },
    { directory: [row('greenhouse', 'busy', 'Busy'), row('greenhouse', 'calm', 'Calm')] });
  try {
    await r.scheduler.runOnce();
    const e = r.service.get('greenhouse:busy')!;
    assert.equal(e.state, 'blocked');
    assert.ok(Date.parse(e.nextCheckAt!) - r.clock.now >= 15 * 60_000, 'at least 15 minutes, and at least the Retry-After');
    const t = r.mock.log.filter((x) => x.host === 'boards-api.greenhouse.io' && x.path.startsWith('/v1/')).map((x) => x.at);
    const i429 = r.mock.log.findIndex((x) => x.path.startsWith('/v1/boards/busy'));
    const after = r.mock.log.slice(i429 + 1).filter((x) => x.host === 'boards-api.greenhouse.io');
    for (const x of after) assert.ok(x.at - r.mock.log[i429]!.at >= 2900, `next request to the host after ${x.at - r.mock.log[i429]!.at} ms`);
    assert.ok(t.length >= 1);
  } finally { await r.close(); }
});

test('network trouble: an unreachable host leaves boards "not checked yet"; a host outage never makes boards unreachable', async () => {
  const r = await rig({ boards: { 'lever:down1': { jobs: 1, script: ['500'] }, 'lever:down2': { jobs: 1, script: ['500'] } } },
    { directory: [row('lever', 'down1', 'Down 1'), row('lever', 'down2', 'Down 2'), row('ashby', 'nohost', 'No Host')] });
  try {
    await r.mock.close(); // every mock host stops answering (connection refused)
    await r.scheduler.runOnce();
    for (const e of r.service.list({}).items) assert.equal(e.state, 'not_checked', `${e.id} after the host could not be reached`);
  } finally { await r.close().catch(() => {}); }
  const r2 = await rig({ boards: { 'lever:down1': { jobs: 1, script: ['500'] }, 'lever:down2': { jobs: 1, script: ['500'] } } },
    { directory: [row('lever', 'down1', 'Down 1'), row('lever', 'down2', 'Down 2')] });
  try {
    for (let i = 0; i < 3; i++) { await r2.scheduler.runOnce(); r2.clock.now += 60_000; }
    for (const e of r2.service.list({}).items) {
      assert.equal(e.state, 'failing', `${e.id} shows a warning`);
      assert.ok(e.lastError);
    }
  } finally { await r2.close(); }
});
