// Probe network/csv-fixtures (network outcomes O1 and O4). Offline; made-up data only.
//   node evals/network/csv-fixtures/run.ts
// Imports each labelled file into a fresh in-memory database and checks: people imported, the exact skipped lines,
// "not a connections file", fields kept exactly as written, garbled flags, blank emails, and "You know N people at
// <Company>" for job company names (null = the card shows nothing). Prints one JSON summary line last.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCsvBytes, NetworkService, resolveCompanyKey } from '../../../packages/network/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const labels = JSON.parse(readFileSync(join(here, 'data', 'labels.json'), 'utf8')) as { files: Record<string, Record<string, unknown>> };
const keyFn = resolveCompanyKey();
const results: Array<{ file: string; check: string; ok: boolean; got?: unknown; want?: unknown }> = [];
const check = (file: string, name: string, got: unknown, want: unknown) => results.push({ file, check: name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

for (const [file, want] of Object.entries(labels.files)) {
  const bytes = new Uint8Array(readFileSync(join(here, 'data', file)));
  const service = new NetworkService({ db: new DatabaseSync(':memory:'), companyKey: keyFn.fn, now: () => Date.parse('2026-09-25T12:00:00Z') });
  const s = service.import(decodeCsvBytes(bytes).text);
  if (want.notAConnectionsFile) {
    check(file, 'not a connections file', s.notAConnectionsFile, true);
    check(file, 'nothing imported', service.total(), 0);
    continue;
  }
  check(file, 'people imported', s.inFile, want.people);
  check(file, 'people in the list', service.list().length, want.people);
  check(file, 'skipped lines', s.skipped.map((k) => k.line), want.skippedLines);
  check(file, 'every skip has a reason', s.skipped.every((k) => k.reason.length > 10), true);
  for (const [company, n] of Object.entries((want.counts ?? {}) as Record<string, number | null>)) {
    let key = '';
    try { key = keyFn.fn(company); } catch { key = ''; }
    check(file, `count at "${company}"`, service.countFor(key), n);
    check(file, `list behind "${company}" equals the count`, service.list({ companyKey: key }).length, n ?? 0);
  }
  if (want.blankCompanyPeople !== undefined) check(file, 'unknown-company group', service.companies().find((g) => g.kind === 'unknown')?.count ?? 0, want.blankCompanyPeople);
  for (const e of (want.exact ?? []) as Array<Record<string, string>>) {
    const who = service.list().find((c) => (e.lastName ? c.lastName === e.lastName : c.firstName === e.firstName));
    check(file, `exact ${e.field} of ${e.lastName ?? e.firstName}`, who ? (who as unknown as Record<string, unknown>)[e.field!] : null, e.value);
  }
  for (const f of (want.garbledFirstNames ?? []) as string[]) check(file, `garbled flag on ${f}`, service.list().find((c) => c.firstName === f)?.maybeGarbled, true);
  for (const f of (want.notGarbledFirstNames ?? []) as string[]) check(file, `no garbled flag on ${f}`, service.list().find((c) => c.firstName === f)?.maybeGarbled, false);
  for (const l of (want.blankEmailLastNames ?? []) as string[]) check(file, `blank email stays blank for ${l}`, service.list().find((c) => c.lastName === l)?.email, null);
}

const passed = results.filter((r) => r.ok).length;
mkdirSync(join(here, 'out'), { recursive: true });
writeFileSync(join(here, 'out', 'results.json'), JSON.stringify({ companyKey: keyFn.source, results }, null, 2));
for (const r of results.filter((x) => !x.ok)) console.log(`FAIL ${r.file}: ${r.check}: got ${JSON.stringify(r.got)}, want ${JSON.stringify(r.want)}`);
console.log(JSON.stringify({ probe: 'network/csv-fixtures', n: results.length, score: Math.round((passed / results.length) * 1000) / 1000, pass: passed === results.length, bar: 'every labelled count, skip line and kept field matches (1.0)' }));
process.exitCode = passed === results.length ? 0 : 1;
