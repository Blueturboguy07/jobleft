import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boardListedAnyPosting, boardQualifies, boardReadWhatItListed, boardReachedPostings, closeTooBroad, cooldownFor,
  emptyFeedShouldClose, emptyStats, shouldSweep, sweepableBoards,
} from '../src/lifecycle.ts';
import type { BoardStats } from '../src/types.ts';

const st = (o: Partial<BoardStats>): BoardStats => ({ ...emptyStats(), ...o });
const H = 3600 * 1000;

test('guard 1: a board with any failure never qualifies, even when it ingested postings before dying', () => {
  assert.equal(boardQualifies('acme', st({ ingested: 40, failed: 1 })), false);
  assert.equal(boardQualifies('acme', st({ ingested: 40 })), true);
});

test('guard 2: a board that returned nothing never qualifies (empty is indistinguishable from broken)', () => {
  assert.equal(boardQualifies('acme', st({})), false);
  assert.equal(boardReachedPostings(st({ skipped: 30 })), false, 'skipped alone must not prove a crawl');
  assert.equal(boardQualifies('acme', st({ skipped: 30 })), false);
});

test('guard 2b: a posting dropped as a duplicate URL still counts as reached (freehire ATSCovered)', () => {
  assert.equal(boardReachedPostings(st({ dupUrl: 3 })), true);
});

test('guard 3: more than 5% unreadable postings withholds the close; exactly 5% is allowed', () => {
  assert.equal(boardReadWhatItListed(st({ ingested: 95, unreadable: 5 })), true);
  assert.equal(boardReadWhatItListed(st({ ingested: 94, unreadable: 6 })), false);
  assert.equal(boardQualifies('acme', st({ ingested: 94, unreadable: 6 })), false);
});

test('guard 3b: on a small board one unreadable posting in fifteen already exceeds the threshold', () => {
  assert.equal(boardReadWhatItListed(st({ ingested: 14, unreadable: 1 })), false);
});

test('guard 4: an empty board name never qualifies (its close pattern would match the whole provider)', () => {
  assert.equal(boardQualifies('', st({ ingested: 10 })), false);
});

test('boardListedAnyPosting is the generous reading: a board whose every save failed still listed postings', () => {
  assert.equal(boardListedAnyPosting(st({ skipped: 12 })), true);
  assert.equal(boardListedAnyPosting(st({ unreadable: 3 })), true);
  assert.equal(boardListedAnyPosting(st({})), false);
});

test('shouldSweep: a provider that ingested nothing proves only that its crawl failed', () => {
  assert.equal(shouldSweep(0), false);
  assert.equal(shouldSweep(1), true);
});

test('sweepableBoards: a provider-wide outage (nothing ingested anywhere) sweeps nothing, even for a board that "qualifies" alone', () => {
  const dead = [
    { ats: 'lever', board: 'a', stats: st({}), fullBoardListing: true },
    { ats: 'lever', board: 'b', stats: st({ failed: 1 }), fullBoardListing: true },
  ];
  assert.equal(sweepableBoards(dead).length, 0);
});

test('sweepableBoards: only qualifying boards on a fullBoardListing source are swept; the failed neighbour is left alone', () => {
  const cands = [
    { ats: 'greenhouse', board: 'good', stats: st({ ingested: 20 }), fullBoardListing: true },
    { ats: 'greenhouse', board: 'failed', stats: st({ ingested: 5, failed: 1 }), fullBoardListing: true },
    { ats: 'greenhouse', board: 'empty', stats: st({}), fullBoardListing: true },
    { ats: 'greenhouse', board: 'paged', stats: st({ ingested: 9 }), fullBoardListing: false },
  ];
  assert.deepEqual(sweepableBoards(cands).map((c) => c.board), ['good']);
});

test('sweepableBoards: a board name under two regions is ambiguous and never qualifies', () => {
  const cands = [
    { ats: 'lever', board: 'twin', stats: st({ ingested: 9 }), fullBoardListing: true },
    { ats: 'lever', board: 'twin', stats: st({ ingested: 9 }), fullBoardListing: true },
    { ats: 'lever', board: 'solo', stats: st({ ingested: 9 }), fullBoardListing: true },
  ];
  assert.deepEqual(sweepableBoards(cands).map((c) => c.board), ['solo']);
});

test('cooldownFor: none below 3 failures, then 6h doubling, capped at 24h, never permanent', () => {
  assert.equal(cooldownFor(0), null);
  assert.equal(cooldownFor(2), null);
  assert.equal(cooldownFor(3), 6 * H);
  assert.equal(cooldownFor(4), 12 * H);
  assert.equal(cooldownFor(5), 24 * H);
  assert.equal(cooldownFor(6), 24 * H);
  assert.equal(cooldownFor(500), 24 * H);
});

test('emptyFeedShouldClose: needs the whole window AND three consecutive clean empty crawls', () => {
  const now = Date.parse('2026-09-24T12:00:00Z');
  assert.equal(emptyFeedShouldClose(null, now, 7 * 24 * H, 9), false, 'never yielded: nothing to close');
  assert.equal(emptyFeedShouldClose('2026-09-20T12:00:00Z', now, 7 * 24 * H, 9), false, 'window not over');
  assert.equal(emptyFeedShouldClose('2026-09-17T12:00:00Z', now, 7 * 24 * H, 2), false, 'one glitchy empty answer is not enough');
  assert.equal(emptyFeedShouldClose('2026-09-17T12:00:00Z', now, 7 * 24 * H, 3), true);
});

test('closeTooBroad (local guard): closing most of a big board at once is held; small boards are exempt', () => {
  assert.equal(closeTooBroad(100, 60), true);
  assert.equal(closeTooBroad(100, 50), false);
  assert.equal(closeTooBroad(6, 6), false, 'a 6-job board legitimately empties');
});
