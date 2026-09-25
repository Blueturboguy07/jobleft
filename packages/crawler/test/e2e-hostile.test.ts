// Outcome O9: a hung, slow, huge, broken, looping or junk-flooded board neither stops nor slows the healthy ones,
// memory stays bounded, and the report names every bad board with its reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allJobs, cfg, crawlOnce, jobsOf, serveBoards, tempStore } from './helpers.ts';

test('O9: six hostile boards and four healthy ones: the healthy jobs are all stored at once, each bad board is named', async () => {
  const m = await serveBoards({
    hang: { ats: 'greenhouse', mode: 'timeout', jobs: [] },
    slow: { ats: 'greenhouse', mode: 'slow', jobs: jobsOf(5, 's') },
    huge: { ats: 'greenhouse', mode: 'huge', hugeMB: 100, jobs: [] },
    broken: { ats: 'lever', mode: 'broken', jobs: [] },
    loop: { ats: 'ashby', mode: 'redirectLoop', jobs: [] },
    junk: { ats: 'greenhouse', mode: 'junk', junkCount: 50_000, jobs: [] },
    good1: { ats: 'greenhouse', jobs: jobsOf(25, 'a') },
    good2: { ats: 'lever', jobs: jobsOf(25, 'b') },
    good3: { ats: 'ashby', jobs: jobsOf(25, 'c') },
    good4: { ats: 'greenhouse', jobs: jobsOf(25, 'd') },
  });
  const { store, cleanup } = tempStore();
  const finishedAt = new Map<string, number>();
  const t0 = Date.now();
  let peak = 0;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
  try {
    const out = await crawlOnce(store, m.boards, { config: cfg({ requestTimeoutSeconds: 4, maxBodyMB: 16 }) });
    for (const b of out.report.boards) finishedAt.set(b.board, b.elapsedMs);
    const by = new Map(out.report.boards.map((b) => [b.board, b]));
    for (const g of ['good1', 'good2', 'good3', 'good4']) {
      assert.equal(by.get(g)!.status, 'ok');
      assert.ok(by.get(g)!.elapsedMs < 2000, `${g} was not held up by the bad boards (${by.get(g)!.elapsedMs} ms)`);
    }
    assert.equal(allJobs(store).total, 100, 'every healthy job is stored and nothing from the bad boards');
    const want: Record<string, string> = { hang: 'timeout', slow: 'timeout', huge: 'too_large', broken: 'broken_reply', loop: 'redirect', junk: 'too_many_jobs' };
    for (const [board, code] of Object.entries(want)) {
      assert.equal(by.get(board)!.status, 'failed', board);
      assert.equal(by.get(board)!.reasonCode, code, board);
      assert.ok((by.get(board)!.reason ?? '').length > 10, `${board}: ${by.get(board)!.reason}`);
    }
    assert.match(by.get('loop')!.reason ?? '', /redirect loop/);
    assert.equal(out.run.boards_done, 10, 'the run ends');
    assert.equal(out.run.failed, 6);
    assert.ok(Date.now() - t0 < 30_000);
    assert.ok(peak < 1024 * 1024 * 1024, `memory stayed under 1 GB (peak ${Math.round(peak / 1048576)} MB)`);
  } finally {
    clearInterval(sampler);
    cleanup();
    await m.close();
  }
});
