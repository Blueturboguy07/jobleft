import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ContractError, anyValue, arr, bool, enm, int, isValid, lit, nullable, num, obj, parse, rec, str, union, validate,
} from '../src/index.ts';

test('validate: types, required keys and unknown keys (unknown keys are allowed: contracts are additive)', () => {
  const S = obj({ a: str(), b: int() }, { c: bool() });
  assert.equal(validate(S, { a: 'x', b: 1 }).ok, true);
  assert.equal(validate(S, { a: 'x', b: 1, extra: true }).ok, true);
  const r = validate(S, { a: 1, c: 'no' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    const paths = r.issues.map((i) => i.path).sort();
    assert.deepEqual(paths, ['/a', '/b', '/c']);
  }
  assert.equal(validate(int(), 1.5).ok, false);
  assert.equal(validate(num(), Number.NaN).ok, false);
  assert.equal(validate(arr(str()), 'x').ok, false);
});

test('validate: null means unknown only where the schema says nullable', () => {
  assert.equal(isValid(nullable(num()), null), true);
  assert.equal(isValid(num(), null), false);
  assert.equal(isValid(obj({ a: nullable(str()) }), {}), false, 'a nullable field is still required');
});

test('validate: enum, const and anyOf unions', () => {
  assert.equal(isValid(enm(['open', 'closed']), 'open'), true);
  assert.equal(isValid(enm(['open', 'closed']), 'Open'), false);
  assert.equal(isValid(lit(true), true), true);
  assert.equal(isValid(lit(true), false), false);
  const U = union([obj({ type: lit('a'), n: int() }), obj({ type: lit('b'), s: str() })]);
  assert.equal(isValid(U, { type: 'b', s: 'x' }), true);
  assert.equal(isValid(U, { type: 'b', n: 1 }), false);
});

test('validate: formats, patterns and limits', () => {
  assert.equal(isValid(str({ format: 'date-time' }), '2026-09-25T05:00:00.000Z'), true);
  assert.equal(isValid(str({ format: 'date-time' }), '2026-09-25 05:00'), false);
  assert.equal(isValid(str({ format: 'date' }), '2026-02-29'), false, 'not a real date');
  assert.equal(isValid(str({ format: 'date' }), '2028-02-29'), true);
  assert.equal(isValid(str({ format: 'uri', pattern: '^https?://' }), 'javascript:alert(1)'), false);
  assert.equal(isValid(str({ format: 'uri', pattern: '^https?://' }), 'https://example.com/x'), true);
  assert.equal(isValid(str({ maxLength: 3 }), 'héé'), true, 'length counts characters, not bytes');
  assert.equal(isValid(int({ minimum: 0, maximum: 100 }), 101), false);
  assert.equal(isValid(arr(int(), { uniqueItems: true }), [1, 1]), false);
  assert.equal(isValid(rec(int()), { a: 1, b: 'x' }), false);
  assert.equal(isValid(anyValue(), { anything: [1, null] }), true);
});

test('parse: returns the value, or throws a ContractError naming the path', () => {
  const S = obj({ a: int() }, {}, { title: 'Thing' });
  assert.deepEqual(parse(S, { a: 2 }), { a: 2 });
  assert.throws(() => parse(S, { a: 'x' }), (e: unknown) => e instanceof ContractError && /Thing/.test(e.message) && e.issues[0]?.path === '/a');
});

test('refusals name the allowed values and the date form in plain words (JL-tracker-20)', async () => {
  const { TrackerPatchSchema, validate } = await import('../src/index.ts');
  const bad = validate(TrackerPatchSchema, { status: 'bogus' });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.issues[0]!.message, 'must be one of "applied", "interviewing", "offer_received", "rejected", "archived", null');
  const when = validate(TrackerPatchSchema, { reminders: [{ at: 'tomorrow', text: 'a', done: false }] });
  if (!when.ok) assert.match(when.issues[0]!.message, /date and time with a time zone, like 2026-10-01T10:00:00Z/);
  else assert.fail('a reminder at "tomorrow" is refused');
});
