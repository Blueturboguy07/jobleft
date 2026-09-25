import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arr, int, obj, str } from '@jobleft/contracts';
import { AiError, extractJson, parseScoresHeader, readFieldLines, readStructured, stripThinking, ThinkStripper } from '../src/index.ts';
import { makeEngine, use, withModel } from './helpers.ts';

const Fit = obj({ score: int({ minimum: 0, maximum: 100 }), reasons: arr(str({ minLength: 1 }), { minItems: 1 }) });

test('JSON is read from fences, prose around it, and trailing commas', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! Here it is: {"a": [1, 2,], } Hope this helps.'), { a: [1, 2] });
  assert.deepEqual(extractJson('<think>{"no":1}</think>{"yes":2}'), { yes: 2 });
  assert.equal(extractJson('no json here'), undefined);
});

test('a bad answer is refused, never filled in', () => {
  const bad = (text: string, incomplete = false) => assert.throws(() => readStructured(text, Fit, { incomplete }), (e: AiError) => e.code === 'bad_answer');
  bad('');
  bad('The candidate looks strong.');
  bad('{"score": 140, "reasons": ["x"]}');
  bad('{"score": 80}');
  bad('{"score": 80, "reasons": ["a"]}', true);
  assert.throws(() => readStructured('{"score": 140, "reasons": ["x"]}', Fit, { incomplete: false }), /out of range/);
  assert.deepEqual(readStructured('{"score": 80, "reasons": ["SQL"]}', Fit, { incomplete: false }), { score: 80, reasons: ['SQL'] });
});

test('line fallback reads plain text from small models, and is still range-checked', () => {
  const fallback = (t: string) => {
    const s = parseScoresHeader(t);
    const reasons = t.split('\n').map((l) => /^- (.+)$/.exec(l)?.[1]).filter((x): x is string => !!x);
    return s?.fit !== undefined && reasons.length ? { score: s.fit, reasons } : null;
  };
  assert.deepEqual(readStructured('SCORES: fit=77%\n- knows SQL\n- no Tableau', Fit, { incomplete: false, lineFallback: fallback }), { score: 77, reasons: ['knows SQL', 'no Tableau'] });
  assert.throws(() => readStructured('SCORES: fit=140\n- x', Fit, { incomplete: false, lineFallback: fallback }), (e: AiError) => e.code === 'bad_answer');
  assert.deepEqual(parseScoresHeader('**Scores:** experience: 80, skills=70 / 100; industry = 55%'), { experience: 80, skills: 70, industry: 55 });
  assert.equal(parseScoresHeader('no scores here'), null);
  assert.deepEqual(readFieldLines('Score: 80\nReasons:\n- SQL\n- Excel\nUnknown: x', Fit), { score: 80, reasons: ['SQL', 'Excel'] });
});

test('thinking text never reaches the person', () => {
  const st = new ThinkStripper();
  const out = ['<thi', 'nk>plan the ', 'answer</th', 'ink>  Hello', ' world'].map((p) => st.push(p)).join('') + st.flush();
  assert.equal(out, 'Hello world');
  const plain = new ThinkStripper();
  assert.equal(['<b>bold</b>', ' text'].map((p) => plain.push(p)).join('') + plain.flush(), '<b>bold</b> text');
  assert.equal(stripThinking('reasoning here</think>The answer'), 'The answer');
});

test('structured answers through a provider: good, plain text, out of range, cut off, empty', async () => {
  const expect = { ok: true, text: 'bad_answer', badscore: 'bad_answer', cutoff: 'bad_answer', empty: 'bad_answer', think: true } as const;
  for (const [mode, want] of Object.entries(expect)) {
    await withModel({ mode: mode as never }, async (m) => {
      const { engine } = makeEngine();
      await use(engine, { provider: 'custom', baseUrl: m.url, model: 'standin-7b' });
      const run = engine.client().json({ schema: Fit, messages: [{ role: 'user', content: 'Rate Jordan Testwell for a data analyst job.' }] });
      if (want === true) {
        const v = await run;
        assert.equal(typeof v.score, 'number');
        assert.ok(v.score >= 0 && v.score <= 100);
      } else {
        await assert.rejects(run, (e: AiError) => e.code === want && /cannot use/.test(e.message));
      }
      const chat = m.log.entries.filter((e) => e.path.endsWith('/chat/completions')).at(-1);
      assert.ok(chat && JSON.parse(chat.body).response_format, 'asks the server for JSON');
    });
  }
});

test('structured answers from Ollama use the schema as format', async () => {
  await withModel({ models: ['plain:7b'] }, async (m) => {
    const { engine } = makeEngine();
    await use(engine, { provider: 'local', localKind: 'ollama', baseUrl: m.url, model: 'plain:7b' });
    const v = await engine.client().json({ schema: Fit, messages: [{ role: 'user', content: 'rate' }] });
    assert.ok(v.reasons.length >= 1);
    const body = JSON.parse(m.log.entries.filter((e) => e.path === '/api/chat').at(-1)!.body);
    assert.equal(body.format.type, 'object');
  });
});
