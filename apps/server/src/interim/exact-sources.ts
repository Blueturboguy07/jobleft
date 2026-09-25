// Server O13: facts exactly as the board states them. Two interim corrections to the foundation's built-in board
// adapters (@jobleft/crawler SOURCES), applied around them, until the crawler lane's versions land:
//   1. Greenhouse: the posted date is `first_published` only. `updated_at` is the last edit, never a posted date, so
//      it is hidden from the adapter and a missing `first_published` stays null.
//   2. Pay keeps the board's exact amounts: an hourly $18.50 stays 18.5 (the adapters round to whole units, which
//      turns it into $19). Only the rounding is undone: the amount replaces the adapter's only when it rounds to the
//      adapter's value, so the choice of range, currency and period stays the adapter's.

import { arr, num, obj, type BoardRef, type HttpGetter, type RawJob, type Source, type SourceRegistry } from '@jobleft/crawler';

type Amounts = { min: number | null; max: number | null };
const positive = (v: number | null): number | null => (v !== null && v > 0 ? v : null);

/** The unrounded amounts the adapter read, per ATS. */
const EXACT: Record<string, { id: (raw: Record<string, unknown>) => string; list: (resp: unknown) => unknown[]; pay: (raw: Record<string, unknown>) => Amounts | null }> = {
  greenhouse: {
    id: (j) => String(j.id ?? ''),
    list: (resp) => arr(obj(resp).jobs),
    pay: (j) => {
      const r = obj(arr(j.pay_input_ranges)[0]);
      const min = num(r.min_cents), max = num(r.max_cents);
      return { min: positive(min === null ? null : min / 100), max: positive(max === null ? null : max / 100) };
    },
  },
  lever: {
    id: (p) => String(p.id ?? ''),
    list: (resp) => arr(resp),
    pay: (p) => { const sr = obj(p.salaryRange); return { min: positive(num(sr.min)), max: positive(num(sr.max)) }; },
  },
  ashby: {
    id: (j) => String(j.id ?? ''),
    list: (resp) => arr(obj(resp).jobs),
    pay: (j) => {
      for (const t of arr(obj(j.compensation).compensationTiers)) {
        for (const c of arr(obj(t).components)) {
          const co = obj(c);
          if (co.compensationType !== 'Salary' || !['1 YEAR', '1 MONTH', '1 DAY', '1 HOUR'].includes(String(co.interval))) continue;
          const a = { min: positive(num(co.minValue)), max: positive(num(co.maxValue)) };
          if (a.min !== null || a.max !== null) return a;
        }
      }
      return null;
    },
  },
};

/** Greenhouse's list answer without `updated_at` on each job. */
function withoutUpdatedAt(resp: unknown): unknown {
  const o = obj(resp);
  if (!Array.isArray(o.jobs)) return resp;
  return { ...o, jobs: o.jobs.map((j) => {
    if (!j || typeof j !== 'object' || Array.isArray(j)) return j;
    const { updated_at: _lastEdit, ...rest } = j as Record<string, unknown>;
    return rest;
  }) };
}

const sameRounded = (exact: number | null, rounded: number | null): boolean =>
  exact === null ? rounded === null : rounded !== null && Math.round(exact) === rounded;

function exactSource(ats: string, src: Source): Source {
  const ex = EXACT[ats];
  if (!ex) return src;
  return {
    ...src,
    async fetchBoard(board: BoardRef, http: HttpGetter): Promise<RawJob[]> {
      let answer: unknown = null;
      const jobs = await src.fetchBoard(board, {
        getJson: async (url: string) => {
          const r = await http.getJson(url);
          answer = ats === 'greenhouse' ? withoutUpdatedAt(r) : r;
          return answer;
        },
      });
      const byId = new Map<string, Record<string, unknown>>();
      for (const raw of ex.list(answer)) { const o = obj(raw); byId.set(ex.id(o), o); }
      for (const j of jobs) {
        if (!j.pay) continue;
        const raw = byId.get(j.externalId);
        const exact = raw ? ex.pay(raw) : null;
        if (!exact || !sameRounded(exact.min, j.pay.min) || !sameRounded(exact.max, j.pay.max)) continue;
        j.pay = { ...j.pay, min: exact.min, max: exact.max };
      }
      return jobs;
    },
  };
}

/** The built-in adapters with the two corrections above; other adapters pass through unchanged. */
export function exactSources(sources: SourceRegistry): SourceRegistry {
  const out: SourceRegistry = { ...sources };
  for (const [ats, src] of Object.entries(sources) as [keyof SourceRegistry, Source | undefined][]) {
    if (src) out[ats] = exactSource(ats, src);
  }
  return out;
}
