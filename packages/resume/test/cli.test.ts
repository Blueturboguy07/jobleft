import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FIX, tempDir } from './helpers.ts';

const MAIN = join(FIX, '..', '..', 'src', 'cli', 'main.ts');

function cli(home: string, ...args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [MAIN, ...args], { env: { ...process.env, JOBLEFT_HOME: home }, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

test('the CLI walk-through: import, correct, restart, tailor, accept, export; files stay in the data folder', () => {
  const t = tempDir('jl-resume-cli');
  const home = join(t.dir, 'home');
  try {
    const imp = cli(home, 'import', join(FIX, 'jordan-one-column.pdf'), '--adopt');
    assert.equal(imp.code, 0, imp.err);
    assert.match(imp.out, /Jobs: 2 {3}Bullets: 7 {3}Skills: 12 {3}Degrees: 1/);
    const again = cli(home, 'import', join(FIX, 'jordan-word.docx'), '--adopt');
    assert.equal(again.code, 2);
    assert.match(again.out, /NOT replaced/);
    assert.equal(cli(home, 'profile', 'set', 'work.1.startDate', '2021-02').code, 0);
    assert.equal(cli(home, 'profile', 'set', 'skills.5.name', 'Postgres').code, 0);
    // A new process reads the saved corrections.
    const show = cli(home, 'profile', 'show');
    assert.match(show.out, /Feb 2021 – May 2023/);
    assert.match(show.out, /Postgres \[5\]/);
    const bad = cli(home, 'profile', 'set', 'work.1.startDate', 'last spring');
    assert.equal(bad.code, 3);
    assert.match(bad.err, /does not match its contract/);
    assert.equal(cli(home, 'job', 'add', '--file', join(FIX, 'jobs', 'j-fit.txt'), '--title', 'Backend Engineer', '--company', 'Globex Sample Co').code, 0);
    const jobId = cli(home, 'job', 'list').out.split(/\s+/)[0]!;
    const resumeId = /\* (res_\S+)/.exec(cli(home, 'resume', 'list').out)![1]!;
    const tailor = cli(home, 'tailor', resumeId, jobId);
    assert.equal(tailor.code, 0, tailor.err);
    const pid = /Tailoring draft (tp_\S+)/.exec(tailor.out)![1]!;
    assert.equal(cli(home, 'accept', pid, '--none').code, 2);
    assert.doesNotMatch(cli(home, 'resume', 'list').out, /└/);
    const t2 = /Tailoring draft (tp_\S+)/.exec(cli(home, 'tailor', resumeId, jobId).out)![1]!;
    assert.equal(cli(home, 'accept', t2, '--all').code, 0);
    const vid = /└ (res_\S+)/.exec(cli(home, 'resume', 'list').out)![1]!;
    const pdf = join(t.dir, 'v.pdf');
    assert.equal(cli(home, 'export', vid, '--format', 'pdf', '--out', pdf).code, 0);
    assert.ok(readFileSync(pdf).subarray(0, 5).toString() === '%PDF-');
    let text = '';
    try { text = execFileSync('pdftotext', [pdf, '-'], { encoding: 'utf8' }); } catch { /* poppler not installed: skip the text check */ }
    if (text) { assert.match(text, /Feb 2021/); assert.match(text, /Postgres/); }
    // Nothing outside the data folder but the file we asked for; no logs, no temp copies.
    const files = readdirSync(join(home, 'files', 'resumes')).sort();
    assert.ok(files.includes('profile.json') && files.includes('jobs.json'));
    assert.ok(!existsSync(join(home, 'logs')) && !existsSync(join(home, 'tmp')));
    // A closed pipe ends quietly.
    const piped = spawnSync('sh', ['-c', `"${process.execPath}" "${MAIN}" profile show | head -1`], { env: { ...process.env, JOBLEFT_HOME: home }, encoding: 'utf8' });
    assert.doesNotMatch(piped.stderr, /EPIPE|at /);
  } finally { t.done(); }
});
