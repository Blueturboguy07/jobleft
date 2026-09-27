import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeUndo } from '../src/content/undoplan.ts';

type W = { el: string; prev: string; after: string; scan: number };

test('undo after "Fill again" goes back to the values before jobleft\'s first fill (JL-extension-7)', () => {
  const fill1: W[] = [{ el: 'first', prev: '', after: 'Jordan', scan: 1 }, { el: 'email', prev: '', after: 'j@x', scan: 1 }, { el: 'resume', prev: 'no file', after: 'cv.pdf', scan: 1 }];
  // "Fill again": jobleft re-writes its own values (their "before" is jobleft's value); the resume was kept, not written.
  const fill2: W[] = [{ el: 'first', prev: 'Jordan', after: 'Jordan', scan: 2 }, { el: 'email', prev: 'j@x', after: 'j@x', scan: 2 }];
  const plan = mergeUndo([fill1, fill2], (w) => w.el);
  assert.deepEqual(plan.map((w) => [w.el, w.prev, w.after, w.scan]), [
    ['first', '', 'Jordan', 2],
    ['email', '', 'j@x', 2],
    ['resume', 'no file', 'cv.pdf', 1],
  ]);
});

test('one fill: the plan is that fill; a draft inserted later is part of it', () => {
  const fill1: W[] = [{ el: 'a', prev: '', after: 'x', scan: 1 }, { el: 'why', prev: '', after: 'draft text', scan: 1 }];
  assert.deepEqual(mergeUndo([fill1], (w) => w.el), fill1);
  assert.deepEqual(mergeUndo([], (w: W) => w.el), []);
});
