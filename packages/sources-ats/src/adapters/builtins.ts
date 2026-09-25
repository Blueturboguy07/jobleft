// The crawler's Greenhouse, Lever and Ashby adapters, run through this lane with the facts they drop put back.
// The adapters themselves belong to @jobleft/crawler and stay unchanged: each wrapper below runs the crawler's
// adapter, keeps the raw answer it read (nothing is fetched twice), and repairs the jobs from that answer.
//   Greenhouse: a board with region "eu" is read from boards-api.eu.greenhouse.io; a job with no `first_published`
//               has no posted date (`updated_at` is the last edit, not the posting).
//   Lever:      every place in `categories.allLocations` is kept, joined with "; " (the crawler kept the first).
//   Ashby:      the pay is the board's overall range (`summaryComponents`), not the first tier of several.

import { arr, isoDate, num, obj, SOURCES, str } from '@jobleft/crawler';
import type { BoardRef, HttpGetter, PayPeriod, RawJob, Source } from '@jobleft/crawler';
import { atsHost } from '../hosts.ts';
import { joinDistinct, statedPay, textField } from '../util.ts';
import { polishSource } from '../polish.ts';

interface Capture { http: HttpGetter; bodies: unknown[] }

/** An HttpGetter that hands every answer to the wrapped adapter and keeps a copy (and may change the URL first). */
function capture(http: HttpGetter, rewrite?: (url: string) => string): Capture {
  const bodies: unknown[] = [];
  return {
    bodies,
    http: {
      async getJson(url: string): Promise<unknown> {
        const r = await http.getJson(rewrite ? rewrite(url) : url);
        bodies.push(r);
        return r;
      },
    },
  };
}

function need(ats: 'greenhouse' | 'lever' | 'ashby'): Source {
  const s = SOURCES[ats];
  if (!s) throw new Error(`@jobleft/crawler has no ${ats} adapter`);
  return s;
}

function byId(list: unknown[], key = 'id'): Map<string, Record<string, unknown>> {
  const m = new Map<string, Record<string, unknown>>();
  for (const x of list) {
    const o = obj(x);
    const id = o[key];
    if (typeof id === 'string' || typeof id === 'number') m.set(String(id), o);
  }
  return m;
}

// ---------------------------------------------------------------- Greenhouse

export const GREENHOUSE_EU_HOST = 'boards-api.eu.greenhouse.io';

export function greenhouseUrlFor(board: Pick<BoardRef, 'region'>, url: string): string {
  return (board.region ?? '').toLowerCase() === 'eu' ? url.replace('://boards-api.greenhouse.io/', `://${GREENHOUSE_EU_HOST}/`) : url;
}

const greenhouseBase = need('greenhouse');
export const greenhouse: Source = polishSource({
  ...greenhouseBase,
  host: (b: BoardRef) => atsHost('greenhouse', b.region ?? null),
  async fetchBoard(board: BoardRef, http: HttpGetter): Promise<RawJob[]> {
    const cap = capture(http, (u) => greenhouseUrlFor(board, u));
    const jobs = await greenhouseBase.fetchBoard(board, cap.http);
    const raw = byId(arr(obj(cap.bodies[0]).jobs));
    return jobs.map((j) => {
      const src = raw.get(j.externalId);
      // No usable first_published: the crawler fell back to updated_at. An update date is not a posting date.
      if (src && isoDate(src.first_published) === null && j.postedAt !== null) return { ...j, postedAt: null };
      return j;
    });
  },
});

// ---------------------------------------------------------------- Lever

const leverBase = need('lever');
export const lever: Source = polishSource({
  ...leverBase,
  async fetchBoard(board: BoardRef, http: HttpGetter): Promise<RawJob[]> {
    const cap = capture(http);
    const jobs = await leverBase.fetchBoard(board, cap.http);
    const raw = byId(arr(cap.bodies[0]));
    return jobs.map((j) => {
      const cats = obj(raw.get(j.externalId)?.categories);
      const places = arr(cats.allLocations).map((l) => textField(l)).filter(Boolean);
      if (places.length === 0) return j;
      const location = joinDistinct(places, '; ');
      return { ...j, location, remote: j.remote || /remote/i.test(location) };
    });
  },
});

// ---------------------------------------------------------------- Ashby

function ashbyPeriod(interval: string): PayPeriod | null {
  switch (interval) {
    case '1 YEAR': return 'year';
    case '1 MONTH': return 'month';
    case '1 DAY': return 'day';
    case '1 HOUR': return 'hour';
    default: return null; // "NONE" is not a recurring wage
  }
}

/** The board's overall salary range: `summaryComponents` when present, else the widest range over all tiers. */
export function ashbyOverallPay(compensation: unknown) {
  const comp = obj(compensation);
  const salary = (list: unknown[]): Array<Record<string, unknown>> => list.map(obj)
    .filter((c) => str(c.compensationType) === 'Salary' && (num(c.minValue) !== null || num(c.maxValue) !== null) && ashbyPeriod(str(c.interval)) !== null);
  let comps = salary(arr(comp.summaryComponents));
  if (comps.length === 0) comps = salary(arr(comp.compensationTiers).flatMap((t) => arr(obj(t).components)));
  if (comps.length === 0) return null;
  const first = comps[0];
  const currency = str(first.currencyCode) || 'USD';
  const same = comps.filter((c) => str(c.interval) === str(first.interval) && (str(c.currencyCode) || 'USD') === currency);
  const mins = same.map((c) => num(c.minValue)).filter((v): v is number => v !== null && v > 0);
  const maxs = same.map((c) => num(c.maxValue)).filter((v): v is number => v !== null && v > 0);
  return statedPay(mins.length ? Math.min(...mins) : null, maxs.length ? Math.max(...maxs) : null, currency, ashbyPeriod(str(first.interval)));
}

const ashbyBase = need('ashby');
export const ashby: Source = polishSource({
  ...ashbyBase,
  async fetchBoard(board: BoardRef, http: HttpGetter): Promise<RawJob[]> {
    const cap = capture(http);
    const jobs = await ashbyBase.fetchBoard(board, cap.http);
    const raw = byId(arr(obj(cap.bodies[0]).jobs));
    return jobs.map((j) => {
      const pay = ashbyOverallPay(raw.get(j.externalId)?.compensation);
      return pay ? { ...j, pay } : j;
    });
  },
});
