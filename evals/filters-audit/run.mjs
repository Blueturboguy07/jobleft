// Filter accuracy audit against a running jobleft (default: the app on this Mac, read-only). For every filter the UI
// offers, the API's answer is compared with a recomputation from each job's own facts, using the documented rule:
// a job whose fact is unknown FAILS a filter on that fact unless includeUnknown names it.
// Usage: node evals/filters-audit/run.mjs [home]   (home defaults to ~/Library/Application Support/jobleft)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
const HOME = process.argv[2] ?? join(os.homedir(), 'Library/Application Support/jobleft');
const run = JSON.parse(readFileSync(join(HOME, 'run/server.json'), 'utf8'));
const call = async (body) => { const r = await fetch(`http://127.0.0.1:${run.port}/api/v1/jobs/search`, { method: 'POST', headers: { 'x-jobleft-token': run.token, 'content-type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); return r.json(); };
const all = async (filter) => { const out = []; let cursor; let total = 0; for (let i = 0; i < 400; i++) { const r = await call({ sort: 'most_recent', filter, limit: 100, ...(cursor ? { cursor } : {}) }); total = r.total; out.push(...r.items); if (!r.nextCursor) break; cursor = r.nextCursor; } return { items: out, total }; };
const t0 = Date.now();
const base = await all({});
const jobs = base.items.map((it) => it.job);
const now = Date.now();
console.log(`${jobs.length} open jobs read (total ${base.total}) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
const WIN = { '24h': 864e5, '3d': 3 * 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5 };
const annual = (p) => { if (!p) return null; const v = p.max ?? p.min; if (v === null || v === undefined) return null; const f = { year: 1, month: 12, week: 52, day: 260, hour: 2080 }[p.period] ?? null; return f ? v * f : null; };
const cases = [];
for (const w of ['remote', 'hybrid', 'onsite']) cases.push({ name: `workModels=${w}`, filter: { workModels: [w] }, want: (j) => j.workModel === w });
for (const e of ['full_time', 'part_time', 'contract', 'internship']) cases.push({ name: `employmentTypes=${e}`, filter: { employmentTypes: [e] }, want: (j) => j.employmentType === e });
for (const l of ['intern_new_grad', 'entry', 'mid', 'senior', 'lead_staff', 'director_exec']) cases.push({ name: `levels=${l}`, filter: { levels: [l] }, want: (j) => (j.levels ?? []).includes(l) });
for (const p of ['24h', '3d', '7d', '30d']) cases.push({ name: `postedWithin=${p}`, filter: { postedWithin: p }, want: (j) => !!j.postedAt && now - Date.parse(j.postedAt) <= WIN[p] });
for (const m of [60000, 100000, 150000]) cases.push({ name: `minAnnualPayUsd=${m}`, filter: { minAnnualPayUsd: m }, want: (j) => { const a = annual(j.pay); return a !== null && j.pay.currency === 'USD' && a >= m; } });
cases.push({ name: 'countries=US', filter: { countries: ['US'] }, want: (j) => j.isUs === true });
cases.push({ name: 'maxYearsRequired=2', filter: { maxYearsRequired: 2 }, want: (j) => { const y = j.yearsRequired; const v = y ? (y.min ?? y.max) : null; return v !== null && v !== undefined && v <= 2; } });
cases.push({ name: 'workModels=remote + includeUnknown=workModel', filter: { workModels: ['remote'], includeUnknown: ['workModel'] }, want: (j) => j.workModel === 'remote' || j.workModel === null });
cases.push({ name: 'minAnnualPayUsd=100000 + includeUnknown=pay', filter: { minAnnualPayUsd: 100000, includeUnknown: ['pay'] }, want: (j) => { const a = annual(j.pay); return a === null || (j.pay.currency === 'USD' && a >= 100000); } });
cases.push({ name: 'remote + senior + 7d', filter: { workModels: ['remote'], levels: ['senior'], postedWithin: '7d' }, want: (j) => j.workModel === 'remote' && (j.levels ?? []).includes('senior') && !!j.postedAt && now - Date.parse(j.postedAt) <= WIN['7d'] });
const rows = [];
for (const c of cases) {
  const got = await all(c.filter);
  const gotIds = new Set(got.items.map((it) => it.job.id));
  const want = new Set(jobs.filter(c.want).map((j) => j.id));
  const missing = [...want].filter((id) => !gotIds.has(id));
  const extra = [...gotIds].filter((id) => !want.has(id));
  const ex = (ids) => ids.slice(0, 2).map((id) => { const j = jobs.find((x) => x.id === id) ?? got.items.find((it) => it.job.id === id)?.job; return j ? `${j.title.slice(0, 30)} [wm=${j.workModel} et=${j.employmentType} lv=${(j.levels ?? []).join('/')} yrs=${j.yearsRequired ? `${j.yearsRequired.min}-${j.yearsRequired.max}` : null} pay=${j.pay ? `${j.pay.min}-${j.pay.max} ${j.pay.currency}/${j.pay.period}` : null} posted=${j.postedAt?.slice(0, 10)} us=${j.isUs}]` : id; }).join(' | ');
  const ok = missing.length === 0 && extra.length === 0 && got.total === got.items.length;
  rows.push({ name: c.name, ok, api: got.total, listed: got.items.length, expected: want.size, missing: missing.length, extra: extra.length, exMissing: ex(missing), exExtra: ex(extra) });
  console.log(`${ok ? 'OK  ' : 'DIFF'} ${c.name}: api total ${got.total} (listed ${got.items.length}), expected ${want.size}, missing ${missing.length}, extra ${extra.length}${missing.length ? `\n      missing e.g. ${ex(missing)}` : ''}${extra.length ? `\n      extra e.g. ${ex(extra)}` : ''}`);
}
const facts = { workModel: jobs.filter((j) => j.workModel === null).length, employmentType: jobs.filter((j) => j.employmentType === null).length, levels: jobs.filter((j) => !(j.levels ?? []).length).length, postedAt: jobs.filter((j) => !j.postedAt).length, pay: jobs.filter((j) => !j.pay).length, years: jobs.filter((j) => j.yearsRequired === null || j.yearsRequired === undefined).length };
console.log(`unknown facts among ${jobs.length} jobs: ${Object.entries(facts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
const byCompany = {}; for (const j of jobs) byCompany[j.company] = (byCompany[j.company] ?? 0) + 1;
console.log(`companies: ${Object.keys(byCompany).length}; top: ${Object.entries(byCompany).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c, n]) => `${c} ${n}`).join(', ')}`);
