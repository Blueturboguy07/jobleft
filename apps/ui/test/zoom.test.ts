import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearestStep, stepZoom, zoomKey, zoomText } from '../src/lib/zoom.ts';

test('interface size: steps up and down stop at the ends', () => {
  assert.equal(stepZoom(1, 1), 1.1);
  assert.equal(stepZoom(1.1, 1), 1.25);
  assert.equal(stepZoom(1.5, 1), 1.5);
  assert.equal(stepZoom(1, -1), 0.9);
  assert.equal(stepZoom(0.8, -1), 0.8);
});

test('interface size: a size between steps or out of range lands on the nearest step', () => {
  assert.equal(nearestStep(1.2), 1.25);
  assert.equal(nearestStep(3), 1.5);
  assert.equal(nearestStep(0.1), 0.8);
  assert.equal(nearestStep(Number.NaN), 1);
  assert.equal(stepZoom(1.04, 1), 1.1);
  assert.equal(zoomText(1.25), '125%');
});

test('interface size keys: Ctrl on Linux and Windows, Cmd on a Mac', () => {
  const k = (key: string, mod: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }>) => ({ key, ctrlKey: false, metaKey: false, altKey: false, ...mod });
  assert.equal(zoomKey(k('=', { ctrlKey: true }), false), 1);
  assert.equal(zoomKey(k('+', { ctrlKey: true }), false), 1);
  assert.equal(zoomKey(k('-', { ctrlKey: true }), false), -1);
  assert.equal(zoomKey(k('0', { ctrlKey: true }), false), 0);
  assert.equal(zoomKey(k('=', {}), false), null);
  assert.equal(zoomKey(k('a', { ctrlKey: true }), false), null);
  assert.equal(zoomKey(k('-', { ctrlKey: true, altKey: true }), false), null);
  assert.equal(zoomKey(k('=', { metaKey: true }), true), 1);
  assert.equal(zoomKey(k('=', { ctrlKey: true }), true), null);
});
