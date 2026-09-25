// App-wide reads shared by many screens (profile, AI provider, publik balance, tracker counts, crawl progress,
// notifications) and the feed state (filter, sort, words) that survives screen switches and relaunches.

import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { AiSettings, CrawlProgress, DatasetInfo, JobFilter, JobSort, Notification, Profile, PublikConnection, TrackerList } from '@jobleft/contracts';
import { call } from './api.ts';
import { invalidate, load, useApi } from './data.ts';
import { cleanFilter } from '../lib/filters.ts';

export const useProfile = () => useApi<Profile>('profile', () => call('getProfile'));
export const useAiSettings = () => useApi<AiSettings>('ai:settings', () => call('getAiSettings'));
export const usePublik = (enabled: boolean) => useApi<PublikConnection>(enabled ? 'ai:publik' : null, () => call('getPublik'));
export const useTrackerCounts = () => useApi<TrackerList['counts']>('tracker:counts', async () => (await call('listTracker', { query: { view: 'hidden' } })).counts, { staleMs: 3000 });
/** Where the H-1B filing history comes from and how recent it is (for the sponsorship tooltips). */
export function useH1bSource(): { name: string; through: string | null } | null {
  const d = useApi<DatasetInfo[]>('datasets', () => call('listDatasets'));
  const h = d.data?.find((x) => x.id === 'h1b');
  if (!h) return null;
  return { name: h.attribution ?? h.name, through: h.dataThrough };
}
export const useNotifications = () => useApi<Notification[]>('notifications', () => call('listNotifications'), { staleMs: 3000 });

/** true when the profile has anything that the match score can use. */
export function profileIsSet(p: Profile | undefined): boolean {
  return !!p && !!(p.personal.firstName || p.work.length || p.skills.length || p.preferences.jobFunctions.length || p.preferences.targetTitles.length);
}

export function displayName(p: Profile | undefined): string | null {
  if (!p) return null;
  const n = [p.personal.firstName, p.personal.lastName].filter(Boolean).join(' ').trim();
  return n || null;
}

/** The refresh progress (read by the feed, the dashboard and settings). Polling is done once, by useCrawlWatcher. */
export function useCrawl(): { progress: CrawlProgress | undefined; error: boolean } {
  const s = useApi<CrawlProgress>('crawl', () => call('crawlStatus'));
  return { progress: s.data, error: !!s.error };
}

/**
 * Called once by the app root, on every screen: polls the refresh progress (every 2 s while a refresh runs, every 5 s
 * otherwise) and, when a refresh ends, reloads everything that lists jobs, so badges and lists never keep old numbers.
 */
export function useCrawlWatcher(): void {
  const s = useApi<CrawlProgress>('crawl', () => call('crawlStatus'));
  const running = s.data?.running ?? false;
  useEffect(() => {
    const t = setInterval(() => { void load('crawl'); }, running ? 2000 : 5000);
    return () => clearInterval(t);
  }, [running]);
  // coming back to this window (from another app or after sleep): everything on screen is read again
  useEffect(() => {
    const again = () => { if (document.visibilityState === 'visible') invalidate(''); };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => { window.removeEventListener('focus', again); document.removeEventListener('visibilitychange', again); };
  }, []);
  // reminders and new-job alerts come from the local service on their own schedule: the badge follows within seconds
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') invalidate('notifications'); }, 12000);
    return () => clearInterval(t);
  }, []);
  const prevRunning = useRef(running);
  useEffect(() => {
    if (prevRunning.current && !running) invalidate('jobs:', 'job:', 'match:', 'tracker', 'dashboard', 'notifications', 'boards', 'sources');
    prevRunning.current = running;
  }, [running]);
  useEffect(() => {
    // a refresh that finished while this window was closed or asleep
    if (!running && s.data?.lastRun) invalidate('tracker', 'dashboard', 'notifications');
  }, [s.data?.lastRun?.finishedAt]);
}

// ---------------------------------------------------------------- feed state

export interface FeedState {
  filter: JobFilter;
  sort: JobSort;
  q: string;
  /** The saved filter now applied, if any (edits make it "modified"). */
  savedId: string | null;
  /** true once the filter was set from the profile or by the person (so a fresh profile fills it once). */
  initialized: boolean;
}

const FEED_KEY = 'jobleft.feed.v1';
let feed: FeedState = (() => {
  try {
    const raw = window.localStorage.getItem(FEED_KEY);
    if (raw) {
      const v = JSON.parse(raw) as FeedState;
      if (v && typeof v === 'object' && v.sort) return { ...v, filter: cleanFilter(v.filter ?? {}), q: v.q ?? '' };
    }
  } catch { /* per-viewer convenience only */ }
  return { filter: {}, sort: 'recommended', q: '', savedId: null, initialized: false };
})();
const feedSubs = new Set<() => void>();

export function getFeed(): FeedState {
  return feed;
}

export function setFeed(patch: Partial<FeedState>): void {
  feed = { ...feed, ...patch, filter: patch.filter ? cleanFilter(patch.filter) : feed.filter };
  try { window.localStorage.setItem(FEED_KEY, JSON.stringify(feed)); } catch { /* ignore */ }
  for (const s of [...feedSubs]) s();
}

export function useFeed(): FeedState {
  return useSyncExternalStore((cb) => { feedSubs.add(cb); return () => feedSubs.delete(cb); }, () => feed);
}

/** Reloads the reads a tracker change affects. */
export function afterTrackerChange(): void {
  invalidate('tracker', 'jobs:', 'job:', 'dashboard');
}
