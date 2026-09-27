import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SynthGenerator } from '../src/index.ts';
import { tmpdir } from 'node:os';
// Scratch folders: /private/tmp on macOS (short paths, no symlink games), the system temp folder elsewhere (Windows).
const TMP = process.platform === 'darwin' ? '/private/tmp' : tmpdir();

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const run = (home: string, ...args: string[]) => spawnSync(process.execPath, [CLI, ...args, '--json'], { env: { ...process.env, JOBLEFT_HOME: home, JOBLEFT_OFFLINE: '1' }, encoding: 'utf8' });

test('a force quit in the middle of an import loses nothing that was saved before, and the store opens cleanly', async () => {
  const home = mkdtempSync(join(TMP, 'jobleft-crash-test-'));
  try {
    const g = new SynthGenerator({ seed: 21 });
    const first = join(home, 'first.ndjson');
    const big = join(home, 'big.ndjson');
    writeFileSync(first, Array.from({ length: 300 }, (_, i) => JSON.stringify(g.job(i))).join('\n'));
    writeFileSync(big, Array.from({ length: 12_000 }, (_, i) => JSON.stringify(g.job(1000 + i))).join('\n'));
    assert.equal(run(home, 'import-jobs', first).status, 0);
    const liked = JSON.parse(run(home, 'search', '--sort', 'most_recent', '--limit', '3').stdout) as { items: Array<{ job: { id: string } }> };
    const likedId = liked.items[0]!.job.id;
    assert.equal(run(home, 'tracker', 'like', likedId).status, 0);
    assert.equal(run(home, 'tracker', 'note', likedId, 'first', 'note').status, 0);
    assert.equal(run(home, 'filters', 'save', 'Remote senior', '--filter', '{"workModels":["remote"],"levels":["senior"]}', '--sort', 'most_recent').status, 0);
    const page1 = run(home, 'search', '--q', 'engineer', '--limit', '10').stdout;
    // Start a big import and kill it hard part way.
    const child = spawn(process.execPath, [CLI, 'import-jobs', big], { env: { ...process.env, JOBLEFT_HOME: home, JOBLEFT_OFFLINE: '1' }, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 1500));
    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r));
    const db = new DatabaseSync(join(home, 'data', 'jobleft.db'));
    assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
    db.close();
    const stats = JSON.parse(run(home, 'stats').stdout) as { jobs: number };
    assert.ok(stats.jobs >= 300);
    const again = JSON.parse(run(home, 'get', likedId).stdout) as { tracker: { liked: boolean; notes: Array<{ text: string }> } };
    assert.equal(again.tracker.liked, true);
    assert.equal(again.tracker.notes[0]!.text, 'first note');
    assert.equal((JSON.parse(run(home, 'filters', 'list').stdout) as unknown[]).length, 1);
    // The interrupted import can simply run again; nothing doubles.
    assert.equal(run(home, 'import-jobs', big).status, 0);
    assert.equal((JSON.parse(run(home, 'stats').stdout) as { jobs: number }).jobs, 12_300);
    const s1 = JSON.parse(page1) as { items: Array<{ job: { id: string } }> };
    const s2 = JSON.parse(run(home, 'search', '--q', 'engineer', '--limit', '10').stdout) as { items: Array<{ job: { id: string } }>; total: number };
    assert.ok(s2.total >= s1.items.length);
    // Private files.
    if (process.platform !== 'win32') { // POSIX modes only; Windows has no group/other bits
      assert.equal(statSync(join(home, 'data')).mode & 0o077, 0);
      assert.equal(statSync(join(home, 'data', 'jobleft.db')).mode & 0o077, 0);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
