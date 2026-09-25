// The stand-in job feed: one page of jobs with "You know N people at <Company>" (network O4, O14). The counts come
// from one cached map in NetworkService (countsFor), so a page costs no query per card.

import type { NetworkService } from '../service.ts';
import type { StandIn } from './standin.ts';

export interface FeedItem {
  id: string;
  title: string;
  company: string;
  companyKey: string;
  department: string | null;
  liked: boolean;
  /** null = no connections there (the card shows nothing). */
  networkCount: number | null;
}

export function feedPage(standin: StandIn, service: NetworkService, q: { q?: string; liked?: boolean; limit?: number; offset?: number } = {}): { items: FeedItem[]; total: number; ms: number } {
  const t0 = performance.now();
  let jobs = standin.jobs();
  if (q.liked) jobs = jobs.filter((j) => j.liked);
  if (q.q) {
    const needle = q.q.toLowerCase();
    jobs = jobs.filter((j) => `${j.title} ${j.company}`.toLowerCase().includes(needle));
  }
  const offset = q.offset ?? 0;
  const page = jobs.slice(offset, offset + (q.limit ?? 200));
  const keys = page.map((j) => standin.companyKeyOf(j));
  const counts = service.countsFor(keys);
  const items = page.map((j, i) => ({
    id: j.id, title: j.title, company: j.company, companyKey: keys[i]!, department: j.department, liked: j.liked,
    networkCount: counts.get(keys[i]!) ?? null,
  }));
  return { items, total: jobs.length, ms: Math.round((performance.now() - t0) * 100) / 100 };
}
