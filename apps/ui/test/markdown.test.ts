// JL-network-20: assistant answers show bold text and lists, not raw asterisks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineSpans, parseMarkdown } from '../src/lib/markdown.ts';

test('JL-network-20: bold, lists and paragraphs', () => {
  assert.deepEqual(inlineSpans('You liked **24 jobs**. None applied.'), [{ text: 'You liked ' }, { text: '24 jobs', bold: true }, { text: '. None applied.' }]);
  const b = parseMarkdown('I proposed this change:\n- Move **Staff Data Analyst at Stripe** to **Applied**\n\nNothing has changed yet.');
  assert.equal(b.length, 3);
  assert.equal(b[0]!.kind, 'p');
  assert.equal(b[1]!.kind, 'ul');
  assert.deepEqual((b[1] as { items: unknown[][] }).items[0], [{ text: 'Move ' }, { text: 'Staff Data Analyst at Stripe', bold: true }, { text: ' to ' }, { text: 'Applied', bold: true }]);
  assert.equal(b[2]!.kind, 'p');
  assert.equal(parseMarkdown('1. one\n2. two')[0]!.kind, 'ol');
  assert.equal(parseMarkdown('### Plan')[0]!.kind, 'h');
});

test('JL-network-20: a marker without its pair stays as written, and a product like 5*3 is not italic', () => {
  assert.deepEqual(inlineSpans('**24 jobs'), [{ text: '**24 jobs' }]);
  assert.deepEqual(inlineSpans('2*3*4 is 24'), [{ text: '2*3*4 is 24' }]);
  assert.deepEqual(inlineSpans('use `SELECT 1` here'), [{ text: 'use ' }, { text: 'SELECT 1', code: true }, { text: ' here' }]);
  assert.deepEqual(inlineSpans('an *important* word'), [{ text: 'an ' }, { text: 'important', italic: true }, { text: ' word' }]);
});
