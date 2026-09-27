// Shows how the database pacer books slots and when its waiters wake (run on a Windows runner to see why two
// pacers on one database fired 3 ms apart there). Usage: node qa/bin/pacer-diag.mjs  (from the repository root)
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { DbPacer, MIN_GAP_MS } = await import('../../packages/sources-other/src/http.ts');
const { migrateSourcesOther } = await import('../../packages/sources-other/src/index.ts');
const dir = mkdtempSync(join(tmpdir(), 'jl-pacer-diag-'));
const path = join(dir, 'pace.db');
const a = new DatabaseSync(path); migrateSourcesOther(a);
const b = new DatabaseSync(path); b.exec('PRAGMA busy_timeout = 5000');
console.log('journal a:', a.prepare('PRAGMA journal_mode').get(), 'b:', b.prepare('PRAGMA journal_mode').get(), 'MIN_GAP_MS', MIN_GAP_MS, 'node', process.version, process.platform);
const pa = new DbPacer(a), pb = new DbPacer(b);
const t0 = Date.now();
const rows = () => JSON.stringify(a.prepare('SELECT host, next_at_ms FROM source_host_slots').all().map((r) => ({ ...r, next_at_ms: Number(r.next_at_ms) - t0 })));
const times = await Promise.all([0, 1, 2].map(async (i) => {
  const p = i % 2 ? pb : pa;
  const before = Date.now() - t0;
  await p.wait('feed.example', 0);
  const woke = Date.now() - t0;
  console.log(`waiter ${i} (${i % 2 ? 'b' : 'a'}): started at +${before} ms, woke at +${woke} ms; slots now ${rows()}`);
  return woke;
}));
times.sort((x, y) => x - y);
console.log('gaps:', times.slice(1).map((t, i) => t - times[i]).join(', '), 'ms');
a.close(); b.close();
