import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BoardEntrySchema, BoardResolveResponseSchema, CrawlBoardReportSchema, CrawlProgressSchema, LOCAL_API, validate,
} from '@jobleft/contracts';
import { rig, row } from './helpers.ts';

test('every answer matches its contract (BoardEntry, BoardResolveResponse, CrawlProgress, CrawlBoardReport, list)', async () => {
  const r = await rig({
    boards: { 'greenhouse:acme': { name: 'Acme', jobs: 2 }, 'greenhouse:gone': { name: 'Gone', jobs: 1, script: ['404'] } },
    pages: { '/p.html': '<a href="https://boards.greenhouse.io/acme">Jobs</a>' },
  }, { directory: [row('greenhouse', 'gone', 'Gone'), row('lever', 'nocheck', 'No Check')] });
  try {
    const ok = (schema: Parameters<typeof validate>[0], v: unknown, what: string) => {
      const res = validate(schema, v);
      assert.ok(res.ok, `${what}: ${JSON.stringify(res.ok ? [] : res.issues)}`);
    };
    for (const link of ['https://boards.greenhouse.io/acme', 'https://careers.mock.example/p.html', 'nope', 'https://www.indeed.com/x', 'https://boards.greenhouse.io/zzz']) {
      ok(BoardResolveResponseSchema, await r.service.resolve(link), `resolve ${link}`);
    }
    ok(BoardEntrySchema, r.service.add({ ats: 'greenhouse', board: 'acme' }), 'add');
    ok(BoardEntrySchema, r.service.update('lever:nocheck', { hidden: true }), 'update');
    ok(CrawlProgressSchema, r.scheduler.progress(), 'progress before');
    await r.scheduler.runOnce();
    await r.scheduler.runOnce();
    ok(CrawlProgressSchema, r.scheduler.progress(), 'progress after');
    const rep = r.scheduler.lastReport();
    for (const b of rep.boards) ok(CrawlBoardReportSchema, b, `report ${b.boardId}`);
    ok(LOCAL_API.crawlReport.response, rep, 'crawlReport');
    const list = r.service.list({ limit: 2 });
    ok(LOCAL_API.listBoards.response, list, 'list');
    for (const e of r.service.entries()) ok(BoardEntrySchema, e, `entry ${e.id}`);
    const page2 = r.service.list({ limit: 2, cursor: list.nextCursor! });
    assert.equal(new Set([...list.items, ...page2.items].map((e) => e.id)).size, 3, 'pages never repeat or skip');
  } finally { await r.close(); }
});
