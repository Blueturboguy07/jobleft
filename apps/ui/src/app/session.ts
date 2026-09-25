// App-wide reads shared by many screens (profile, AI provider, publik balance, tracker counts, crawl progress,
// notifications) and the feed state (filter, sort, words) that survives screen switches and relaunches.

import { useEffect, useSyncExternalStore } from 'react';
import type { AiSettings, CrawlProgress, JobFilter, JobSort, Notification, Profile, PublikConnection, TrackerList } from '@jobleft/contracts';
import { call } from './api.ts';
import { invalidate, load, useApi } from './data.ts';
import { cleanFilter } from '../lib/filters.ts';

export const useProfile = () => useApi<Profile>('profile', () => call('getProfile'));
export const useAiSettings = () => useApi<AiSettings>('ai:settings', () => call('getAiSettings'));
export const usePublik = (enabled: boolean) => useApi<PublikConnection>(enabled ? 'ai:publik' : null, () => call('getPublik'));
export const useTrackerCounts = () => useApi<TrackerList['counts']>('tracker:counts', async () => (await call('listTracker', { query: { view: 'hidden' } })).counts);
export const useNotifications = () => useApi<Notification[]>('notifications', () => call('listNotifications'));

/** true when the profile has anything that the match score can use. */
export function profileIsSet(p: Profile | undefined): boolean {
  return !!p && !!(p.personal.firstName || p.work.length || p.skills.length || p.preferences.jobFunctions.length || p.preferences.targetTitles.length);
}

export function displayName(p: Profile | undefined): string | null {
  if (!p) return null;
  const n = [p.personal.firstName, p.personal.lastName].filter(Boolean).join(' ').trim();
  return n || null;
}

/** Polls the crawl progress: every 2 s while a refresh runs, every 30 s otherwise. */
export function useCrawl(): { progress: CrawlProgress | undefined; error: boolean } {
  const s = useApi<CrawlProgress>('crawl', () => call('crawlStatus'));
  const running = s.data?.running ?? false;
  useEffect(() => {
    const t = setInterval(() => { void load('crawl'); }, running ? 2000 : 30000);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => {
    // when a refresh ends, everything that lists jobs is reloaded
    if (!running && s.data?.lastRun) invalidate('jobs:', 'job:', 'match:', 'tracker', 'dashboard', 'notifications');
  }, [running, s.data?.lastRun?.finishedAt]);
  return { progress: s.data, error: !!s.error };
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
