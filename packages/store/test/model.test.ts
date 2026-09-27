import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkModel, ensureModel, type ModelFile } from '../src/index.ts';
import { WordPieceTokenizer } from '../src/embed/tokenizer.ts';
import { tmpdir } from 'node:os';
// Scratch folders: /private/tmp on macOS (short paths, no symlink games), the system temp folder elsewhere (Windows).
const TMP = process.platform === 'darwin' ? '/private/tmp' : tmpdir();

function fakeFiles(): { files: ModelFile[]; bytes: Map<string, Buffer> } {
  const bytes = new Map<string, Buffer>();
  const a = Buffer.alloc(300_000, 7);
  for (let i = 0; i < a.length; i += 997) a[i] = i & 0xff;
  const b = Buffer.from('[PAD]\n[UNK]\n[CLS]\n[SEP]\nhello\n');
  bytes.set('onnx/model.onnx', a);
  bytes.set('vocab.txt', b);
  const files = [...bytes].map(([path, buf]) => ({ path, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') }));
  return { files, bytes };
}

test('model download: resumes after a cut, verifies every file, refuses a damaged one, and needs no network after', async () => {
  const { files, bytes } = fakeFiles();
  const log: Array<{ path: string; range: string | undefined; ua: string | undefined }> = [];
  let cutOnce = true;
  let damage = false;
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').slice(1));
    log.push({ path, range: req.headers.range, ua: req.headers['user-agent'] });
    let buf = bytes.get(path);
    if (!buf) { res.writeHead(404); res.end(); return; }
    if (damage) { buf = Buffer.from(buf); buf[10] = buf[10]! ^ 0xff; }
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    const start = m ? Number(m[1]) : 0;
    res.writeHead(m ? 206 : 200, { 'content-length': String(buf.length - start) });
    if (cutOnce && path === 'onnx/model.onnx') { cutOnce = false; res.flushHeaders(); res.write(buf.subarray(start, start + 100_000), () => setTimeout(() => res.destroy(), 100)); return; }
    res.end(buf.subarray(start));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const dir = mkdtempSync(join(TMP, 'jobleft-model-test-'));
  const source = { base: `http://127.0.0.1:${port}/`, files };
  try {
    await assert.rejects(ensureModel(dir, source));
    const partial = await checkModel(dir, files, true);
    assert.equal(partial.state, 'partial');
    await ensureModel(dir, source);
    const ok = await checkModel(dir, files, true);
    assert.equal(ok.state, 'ready');
    assert.ok(log.some((l) => l.path === 'onnx/model.onnx' && l.range === 'bytes=100000-'), 'the second try resumed with a Range request');
    assert.ok(log.every((l) => l.ua === 'jobleft/0.1.2 (+https://github.com/Blueturboguy07/jobleft; no personal data)'));
    // Ready: nothing is fetched again (offline works).
    const n = log.length;
    await ensureModel(dir, source, { offline: true });
    assert.equal(log.length, n);
    // A damaged file on disk is found and replaced; a damaged download is refused and deleted.
    const p = join(dir, 'onnx/model.onnx');
    const cur = readFileSync(p);
    cur[5] = cur[5]! ^ 0xff;
    writeFileSync(p, cur);
    assert.equal((await checkModel(dir, files, true)).state, 'damaged');
    damage = true;
    await assert.rejects(ensureModel(dir, source), /checksum/);
    assert.ok(!existsSync(p) && !existsSync(`${p}.part`));
    damage = false;
    await ensureModel(dir, source);
    assert.equal(statSync(p).mode & 0o077, 0, 'model files are private to the account');
    // Offline with no model: a plain error, no request.
    const dir2 = mkdtempSync(join(TMP, 'jobleft-model-test-'));
    const before = log.length;
    await assert.rejects(ensureModel(dir2, source, { offline: true }), /offline/);
    assert.equal(log.length, before);
    rmSync(dir2, { recursive: true, force: true });
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tokenizer: BERT uncased WordPiece rules on a small vocabulary', () => {
  const vocab = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'c', '+', '#', 'cafe', 'resume', 'un', '##aff', '##able', '.', 'net', '東', '京'].join('\n');
  const t = new WordPieceTokenizer(vocab);
  const id = (s: string) => vocab.split('\n').indexOf(s);
  assert.deepEqual(t.encode('C++'), [id('[CLS]'), id('c'), id('+'), id('+'), id('[SEP]')]);
  assert.deepEqual(t.encode('Café résumé'), [id('[CLS]'), id('cafe'), id('resume'), id('[SEP]')]);
  assert.deepEqual(t.encode('unaffable'), [id('[CLS]'), id('un'), id('##aff'), id('##able'), id('[SEP]')]);
  assert.deepEqual(t.encode('.NET'), [id('[CLS]'), id('.'), id('net'), id('[SEP]')]);
  assert.deepEqual(t.encode('東京'), [id('[CLS]'), id('東'), id('京'), id('[SEP]')]);
  assert.deepEqual(t.encode('zzz'), [id('[CLS]'), id('[UNK]'), id('[SEP]')]);
  assert.equal(t.encode('c '.repeat(1000), 16).length, 16);
});
