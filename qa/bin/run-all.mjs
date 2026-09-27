// Runs every replay scenario in order against one running app and prints a summary; exit 1 when any scenario failed.
// Usage: node qa/bin/run-all.mjs [names...]   (env: JOBLEFT_QA_URL, JOBLEFT_QA_API, JOBLEFT_QA_TOKEN, optional
// JOBLEFT_QA_FIXTURES, JOBLEFT_QA_SHOTS, JOBLEFT_QA_EXTENSION, JOBLEFT_QA_STATE, JOBLEFT_CHROME)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const QA = fileURLToPath(new URL('../', import.meta.url));
const ORDER = ['onboarding', 'feed', 'tracker', 'resume', 'network', 'settings', 'extension'];
const names = process.argv.slice(2).length ? process.argv.slice(2) : ORDER;
const env = { ...process.env, JOBLEFT_QA_FIXTURES: process.env.JOBLEFT_QA_FIXTURES ?? join(QA, 'fixtures'), JOBLEFT_QA_SHOTS: process.env.JOBLEFT_QA_SHOTS ?? join(QA, 'shots'), JOBLEFT_QA_STATE: process.env.JOBLEFT_QA_STATE ?? 'golden' };
mkdirSync(env.JOBLEFT_QA_SHOTS, { recursive: true });
const results = [];
for (const name of names) {
  const file = join(QA, 'scenarios', `${name}.mjs`);
  if (!existsSync(file)) { results.push([name, 'missing']); console.log(`== ${name}: no scenario file`); continue; }
  console.log(`\n== ${name}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [file], { env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 12 * 60_000 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  process.stdout.write(out);
  const checks = out.split('\n').filter((l) => l.startsWith('CHECK '));
  const fails = checks.filter((l) => l.startsWith('CHECK FAIL')).length;
  const skips = checks.filter((l) => l.startsWith('CHECK skip')).length;
  const status = r.status === 0 ? 'ok' : r.signal ? `killed (${r.signal})` : `exit ${r.status}`;
  results.push([name, `${status}; ${checks.length - fails - skips} ok, ${fails} failed, ${skips} skipped, ${((Date.now() - t0) / 1000).toFixed(0)} s`]);
}
console.log('\n== summary');
for (const [n, s] of results) console.log(`${n.padEnd(12)} ${s}`);
process.exit(results.some(([, s]) => !s.startsWith('ok') && s !== 'missing') ? 1 : 0);
