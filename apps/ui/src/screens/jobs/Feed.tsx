// The Recommended feed: filters, sort, words, saved filters, and the job list. The list keeps its own pages, so
// liking or hiding a job never reloads the list or moves the scroll position. Only the newest request may update
// the list, so fast typing never ends with the results of an older query.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Dropdown, Progress } from 'antd';
import { ArrowUpOutlined, ReloadOutlined, FolderOpenOutlined } from '@ant-design/icons';
import type { FitState, JobFilter, JobListItem, JobSort, SavedFilter } from '@jobleft/contracts';
import { call, type UiError } from '../../app/api.ts';
import { navigate } from '../../app/router.ts';
import { getFeed, profileIsSet, setFeed, useCrawl, useFeed, useProfile, useTrackerCounts } from '../../app/session.ts';
import { JobCard, type CardItem } from '../../components/JobCard.tsx';
import { EmptyState, ErrorState, InlineError, SkeletonCards } from '../../components/States.tsx';
import { VirtualList } from '../../components/VirtualList.tsx';
import { activeCount, filterFromProfile } from '../../lib/filters.ts';
import { plural } from '../../lib/format.ts';
import { AllFiltersDrawer } from './AllFilters.tsx';
import { useCardActions } from './cardActions.tsx';
import { FilterBar } from './Filters.tsx';
import { BoardsCard, Checklist, SavedFilters, SaveFilterModal, UserCard, useSavedFilters } from './Side.tsx';

export const ROW = 232;
export const GAP = 8;
const PAGE = 40;

export function toCard(i: JobListItem): CardItem {
  return { job: i.job, match: i.match, liked: i.liked, hidden: i.hidden, trackerStatus: i.trackerStatus, networkCount: i.networkCount, h1bTag: i.h1bTag };
}

interface Pages {
  items: CardItem[];
  total: number | null;
  next: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: UiError | null;
  moreError: UiError | null;
  fit: FitState | null;
}

export function useJobPages(filter: JobFilter, sort: JobSort, q: string) {
  const [st, setSt] = useState<Pages>({ items: [], total: null, next: null, loading: true, loadingMore: false, error: null, moreError: null, fit: null });
  const seq = useRef(0);
  const ref = useRef(st);
  ref.current = st;
  const reqKey = JSON.stringify([filter, sort, q.trim()]);
  const body = useCallback((cursor?: string) => ({ sort, q: q.trim() || undefined, filter, limit: PAGE, ...(cursor ? { cursor } : {}) }), [reqKey]);

  const load = useCallback(async (silent = false) => {
    const my = ++seq.current;
    if (!silent) setSt((s) => ({ ...s, loading: true, error: null }));
    try {
      const r = await call('searchJobs', { body: body() });
      if (my !== seq.current) return;
      setSt({ items: r.items.map(toCard), total: r.total, next: r.nextCursor, loading: false, loadingMore: false, error: null, moreError: null, fit: r.fit });
    } catch (e) {
      if (my !== seq.current) return;
      setSt((s) => ({ ...s, loading: false, error: e as UiError }));
    }
  }, [body]);

  useEffect(() => { void load(); }, [load]);

  const more = useCallback(async () => {
    const cur = ref.current;
    if (!cur.next || cur.loadingMore || cur.loading || cur.moreError) return;
    const my = seq.current;
    setSt((s) => ({ ...s, loadingMore: true }));
    try {
      const r = await call('searchJobs', { body: body(cur.next) });
      if (my !== seq.current) return;
      setSt((s) => {
        const have = new Set(s.items.map((x) => x.job.id));
        return { ...s, items: [...s.items, ...r.items.map(toCard).filter((x) => !have.has(x.job.id))], next: r.nextCursor, total: r.total, loadingMore: false };
      });
    } catch (e) {
      if (my !== seq.current) return;
      setSt((s) => ({ ...s, loadingMore: false, moreError: e as UiError }));
    }
  }, [body]);

  const ops = useMemo(() => ({
    update: (id: string, patch: Partial<CardItem>) => setSt((s) => ({ ...s, items: s.items.map((x) => (x.job.id === id ? { ...x, ...patch } : x)) })),
    remove: (id: string) => setSt((s) => ({ ...s, items: s.items.filter((x) => x.job.id !== id), total: s.total === null ? null : Math.max(0, s.total - 1) })),
    reinsert: () => { void load(true); },
  }), [load]);

  return { st, load, more, ops, retryMore: () => { setSt((s) => ({ ...s, moreError: null })); } };
}

export function Feed() {
  const feed = useFeed();
  const profile = useProfile();
  const counts = useTrackerCounts();
  const { progress } = useCrawl();
  const saved = useSavedFilters();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [drawer, setDrawer] = useState<{ open: boolean; saved: SavedFilter | null }>({ open: false, saved: null });
  const [savingNarrow, setSavingNarrow] = useState(false);
  const [newJobs, setNewJobs] = useState(false);
  const profileSet = profileIsSet(profile.data);

  // the first time a profile exists, start from its preferences
  useEffect(() => {
    if (feed.initialized || !profile.data) return;
    setFeed({ filter: profileIsSet(profile.data) ? filterFromProfile(profile.data) : {}, initialized: true });
  }, [profile.data, feed.initialized]);

  const { st, load, more, ops, retryMore } = useJobPages(feed.filter, feed.sort, feed.q);
  const actions = useCardActions(ops);

  // new jobs arriving during a refresh: update in place when at the top, otherwise offer a button
  const seen = progress?.jobsSeen ?? 0;
  const lastSeen = useRef(seen);
  useEffect(() => {
    if (seen === lastSeen.current) return;
    lastSeen.current = seen;
    const top = (scrollRef.current?.scrollTop ?? 0) < 200;
    if (top || (st.total ?? 0) < 5) void load(true); else setNewJobs(true);
  }, [seen]);
  useEffect(() => { if (progress && !progress.running) setNewJobs(false); }, [progress?.running]);

  const applySaved = (s: SavedFilter) => { setFeed({ filter: s.filter, sort: s.sort, savedId: s.id, initialized: true }); scrollRef.current?.scrollTo({ top: 0 }); };
  const onFilter = (f: JobFilter) => { setFeed({ filter: f, initialized: true }); scrollRef.current?.scrollTo({ top: 0 }); };
  const onSort = (s: JobSort) => { setFeed({ sort: s }); scrollRef.current?.scrollTo({ top: 0 }); };

  const firstRun = !!progress?.running && (progress.reason === 'first_run' || (progress.lastRun === null));
  const nActive = activeCount(feed.filter);
  const needsProfile = st.fit?.state === 'needs_profile';
  const savedApplied = saved.data?.find((x) => x.id === getFeed().savedId) ?? null;

  let body;
  if (st.error && !st.items.length) body = <ErrorState error={st.error} onRetry={() => { void load(); }} />;
  else if (st.loading && !st.items.length) body = <SkeletonCards n={4} />;
  else if (!st.items.length) {
    if (progress?.running) body = <EmptyState art="search" title="Your job boards are being read" text={`Jobs appear here as each board finishes: ${progress.boardsDone} of ${plural(progress.boardsTotal, 'board')} done so far.`} />;
    else if (feed.q.trim() || nActive) body = (
      <EmptyState art="search" title="No jobs match" text={<>Nothing matches {feed.q.trim() ? <>“{feed.q.trim()}” and </> : null}these filters. Many postings do not state pay, level or a posted date; each filter can include those jobs.</>}
        action={<div className="jl-row"><Button shape="round" type="primary" onClick={() => setFeed({ filter: {}, q: '' })}>Clear filters and words</Button><Button shape="round" onClick={() => setDrawer({ open: true, saved: null })}>Change filters</Button></div>} />
    );
    else body = <EmptyState art="search" title="No jobs yet" text="jobleft reads the public job boards you follow. Start a refresh, or add boards in Settings." action={<div className="jl-row"><Button shape="round" type="primary" icon={<ReloadOutlined />} onClick={() => { void call('crawlRun', { body: {} }).then(() => undefined, () => undefined); }}>Refresh now</Button><Button shape="round" onClick={() => navigate('settings/sources')}>Job sources</Button></div>} />;
  } else {
    body = (
      <>
        <VirtualList items={st.items} rowHeight={ROW} gap={GAP} keyOf={(x) => x.job.id} scrollRef={scrollRef} onNearEnd={more} label="Jobs"
          render={(it) => <JobCard item={it} profileSet={profileSet} actions={actions} now={Date.now()} />} />
        <div style={{ padding: '12px 0', textAlign: 'center' }} className="jl-muted">
          {st.moreError ? <InlineError error={st.moreError} onRetry={() => { retryMore(); void more(); }} />
            : st.loadingMore ? 'Loading more jobs…'
              : st.next ? <Button type="link" onClick={() => { void more(); }}>Load more</Button>
                : `That is all ${plural(st.total ?? st.items.length, 'job')}.`}
        </div>
      </>
    );
  }

  return (
    <div className="jl-2col">
      <div className="jl-list-pane">
        <div className="jl-list-scroll" ref={scrollRef} id="jl-feed-scroll">
          <FilterBar filter={feed.filter} sort={feed.sort} onFilter={onFilter} onSort={onSort} onAllFilters={() => setDrawer({ open: true, saved: null })}
            hiddenCount={counts.data?.hidden ?? 0} onHidden={() => navigate('jobs/hidden')} needsProfile={!profileSet}
            extra={
              <span className="jl-narrow-only">
                <Dropdown trigger={['click']} menu={{
                  items: [...(saved.data ?? []).map((s) => ({ key: s.id, label: s.name })), { type: 'divider' as const }, { key: '__save', label: 'Save the current filters' }],
                  onClick: ({ key }) => { if (key === '__save') setSavingNarrow(true); else { const s = saved.data?.find((x) => x.id === key); if (s) applySaved(s); } },
                }}>
                  <Button className="jl-filter-btn" icon={<FolderOpenOutlined />}>Saved filters</Button>
                </Dropdown>
              </span>
            } />
          <div className="jl-results-line">
            <span aria-live="polite" aria-atomic="true">
              {st.total !== null && <strong style={{ color: '#000' }}>{plural(st.total, 'job')}</strong>}
              {feed.q.trim() && <> for “{feed.q.trim()}”</>}
              {savedApplied && <> · filter “{savedApplied.name}”</>}
            </span>
            {st.loading && st.items.length > 0 && <span className="jl-muted">Updating…</span>}
            {feed.q.trim() && <Button size="small" type="link" onClick={() => setFeed({ q: '' })}>Clear words</Button>}
          </div>
          {needsProfile && <Alert type="info" showIcon style={{ marginBottom: 8 }} message="Top matched needs your profile, so this list uses the recommended order." action={<Button size="small" onClick={() => navigate('profile')}>Add profile</Button>} />}
          {progress?.running && (
            <div className="jl-progress" role="status" style={{ marginBottom: 8 }}>
              <span className="jl-grow">{firstRun ? 'Your first refresh is running. Jobs appear as each board finishes.' : 'Refreshing your job boards.'} {progress.boardsDone} of {plural(progress.boardsTotal, 'board')} done, {plural(progress.jobsSeen, 'job')} seen.</span>
              <Progress className="meter" percent={progress.boardsTotal ? Math.round((100 * progress.boardsDone) / progress.boardsTotal) : 0} size="small" strokeColor="#0A8F5C" aria-label="Refresh progress" />
            </div>
          )}
          {newJobs && (
            <div style={{ position: 'sticky', top: 120, zIndex: 6, display: 'flex', justifyContent: 'center', height: 0 }}>
              <Button type="primary" shape="round" icon={<ArrowUpOutlined />} style={{ marginTop: 4 }} onClick={() => { setNewJobs(false); scrollRef.current?.scrollTo({ top: 0 }); void load(true); }}>New jobs arrived. Show them</Button>
            </div>
          )}
          {st.error && st.items.length > 0 && <InlineError error={st.error} onRetry={() => { void load(); }} />}
          {body}
        </div>
      </div>
      <aside className="jl-rightcol collapsible" aria-label="Your filters and setup">
        <UserCard />
        <SavedFilters current={feed.filter} currentSort={feed.sort} savedId={feed.savedId} onApply={applySaved} onEdit={(s) => setDrawer({ open: true, saved: s })} />
        <BoardsCard />
        <Checklist />
      </aside>
      <AllFiltersDrawer open={drawer.open} saved={drawer.saved} filter={feed.filter} sort={feed.sort} onClose={() => setDrawer({ open: false, saved: null })}
        onApply={(f, s) => { setFeed({ filter: f, sort: s, savedId: drawer.saved ? drawer.saved.id : getFeed().savedId, initialized: true }); scrollRef.current?.scrollTo({ top: 0 }); }}
        onSaved={(s) => { void saved.reload(); if (!s && getFeed().savedId === drawer.saved?.id) setFeed({ savedId: null }); }} />
      <SaveFilterModal open={savingNarrow} onClose={() => setSavingNarrow(false)} filter={feed.filter} sort={feed.sort} onSaved={(s) => { void saved.reload(); applySaved(s); }} />
    </div>
  );
}
