// The Liked, Applied, External and Hidden tabs. Each list and its count come from the same tracker answer, so a
// badge always equals the rows its view lists. A job whose posting closed moves to Liked > Closed and keeps its
// status, notes and reminders.

import { useMemo, useRef, useState } from 'react';
import { Alert, Button, Input, Segmented, Select, Space, Tabs } from 'antd';
import { LinkOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { TRACKER_STATUSES, TRACKER_STATUS_LABELS, summarizeMatch, type MatchResult, type TrackerList, type TrackerStatus, type TrackerView } from '@jobleft/contracts';
import { call, type UiError } from '../../app/api.ts';
import { invalidate, useApi } from '../../app/data.ts';
import { ui } from '../../app/layers.ts';
import { navigate } from '../../app/router.ts';
import { afterTrackerChange, profileIsSet, useProfile } from '../../app/session.ts';
import { JobCard, type CardItem } from '../../components/JobCard.tsx';
import { EmptyState, ErrorState, SkeletonCards } from '../../components/States.tsx';
import { VirtualList } from '../../components/VirtualList.tsx';
import { dateText, dateTimeText, plural } from '../../lib/format.ts';
import { useCardActions } from './cardActions.tsx';
import { GAP, ROW } from './Feed.tsx';

type Item = TrackerList['items'][number];

export function useTrackerView(view: TrackerView, status?: TrackerStatus) {
  return useApi<TrackerList>(`tracker:list:${view}:${status ?? ''}`, () => call('listTracker', { query: { view, ...(status ? { status } : {}) } }));
}

/** A tracked job card: the match comes from the same route as the detail view, so the numbers agree. */
function TrackedCard({ it, actions, profileSet, strip }: { it: Item; actions: ReturnType<typeof useCardActions>; profileSet: boolean; strip?: boolean }) {
  const m = useApi<MatchResult | null>(profileSet ? `match:${it.job.id}` : null, async () => {
    try { return await call('getMatch', { params: { jobId: it.job.id } }); } catch (e) { if ((e as UiError).status === 404 || (e as UiError).status === 409) return null; throw e; }
  });
  const item: CardItem = {
    job: it.job, match: m.data ? summarizeMatch(m.data) : null, liked: it.entry.liked, hidden: it.entry.hidden, trackerStatus: it.entry.status,
    networkCount: null, h1bTag: null, external: it.entry.external,
  };
  return (
    <div>
      <JobCard item={item} profileSet={profileSet} actions={actions} now={Date.now()} />
      {strip && <StatusStrip it={it} />}
    </div>
  );
}

function StatusStrip({ it }: { it: Item }) {
  const [busy, setBusy] = useState(false);
  const e = it.entry;
  const next = e.reminders.filter((r) => !r.done).sort((a, b) => (a.at < b.at ? -1 : 1))[0];
  const change = async (s: TrackerStatus) => {
    setBusy(true);
    try {
      await call('updateTracker', { params: { jobId: it.job.id }, body: { status: s } });
      afterTrackerChange();
      ui.message?.success(`Moved to ${TRACKER_STATUS_LABELS[s]}.`);
    } catch (err) { ui.message?.error((err as UiError).message); } finally { setBusy(false); }
  };
  return (
    <div className="jl-row jl-wrap" style={{ background: '#fff', borderRadius: '0 0 16px 16px', boxShadow: 'inset 0 0 0 1px var(--jl-line)', padding: '8px 16px', marginTop: -12, paddingTop: 18, fontSize: 13 }}>
      <label className="jl-row">Status
        <Select size="small" value={e.status ?? undefined} onChange={change} disabled={busy} style={{ width: 160 }} aria-label={`Status of ${it.job.title}`}
          options={TRACKER_STATUSES.map((s) => ({ value: s, label: TRACKER_STATUS_LABELS[s] }))} />
      </label>
      {e.appliedAt && <span className="jl-muted">Applied {dateText(e.appliedAt)}</span>}
      <span className="jl-muted">{plural(e.notes.length, 'note')}</span>
      {next && <span>Next reminder: {dateTimeText(next.at)}</span>}
      <Button size="small" type="link" onClick={() => navigate(`jobs/${encodeURIComponent(it.job.id)}`)}>Notes and reminders</Button>
    </div>
  );
}

function ListBody({ list, view, emptyArt, emptyTitle, emptyText, strip, filterText }: { list: ReturnType<typeof useTrackerView>; view: TrackerView; emptyArt: 'heart' | 'send' | 'link' | 'hidden' | 'box'; emptyTitle: string; emptyText: string; strip?: boolean; filterText?: string }) {
  const profile = useProfile();
  const profileSet = profileIsSet(profile.data);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const ops = useMemo(() => ({ update: () => { void list.reload(); }, remove: () => { void list.reload(); }, reinsert: () => { void list.reload(); } }), [list.reload]);
  const actions = useCardActions(ops);
  const items = (list.data?.items ?? []).filter((it) => !filterText || `${it.job.title} ${it.job.company}`.toLowerCase().includes(filterText.toLowerCase()));
  if (list.error && !list.data) return <ErrorState error={list.error} onRetry={() => { void list.reload(); }} />;
  if (!list.data) return <SkeletonCards n={2} />;
  if (!items.length) {
    return <EmptyState art={emptyArt} title={filterText ? 'No job matches that search' : emptyTitle} text={filterText ? 'Try other words.' : emptyText}
      action={view !== 'external' && !filterText ? <Button type="primary" shape="round" onClick={() => navigate('jobs')}>Browse recommended jobs</Button> : undefined} />;
  }
  const rowH = strip ? ROW + 44 : ROW;
  return (
    <div ref={scrollRef} className="jl-list-scroll" style={{ paddingTop: 8 }}>
      <VirtualList items={items} rowHeight={rowH} gap={GAP} keyOf={(x) => x.job.id} scrollRef={scrollRef} label={`${view} jobs`}
        render={(it) => <TrackedCard it={it} actions={actions} profileSet={profileSet} strip={strip} />} />
    </div>
  );
}

export function LikedTab() {
  const [sub, setSub] = useState<'active' | 'closed'>('active');
  const active = useTrackerView('liked');
  const closed = useTrackerView('closed');
  const counts = active.data?.counts ?? closed.data?.counts;
  return (
    <div className="jl-list-pane">
      <div style={{ padding: '12px 16px 0' }}>
        <Segmented value={sub} onChange={(v) => setSub(v as 'active' | 'closed')} aria-label="Liked jobs"
          options={[{ value: 'active', label: `Active (${counts?.liked ?? 0})` }, { value: 'closed', label: `Closed (${counts?.closed ?? 0})` }]} />
        {sub === 'closed' && <p className="jl-small jl-muted" style={{ marginTop: 8 }}>Jobs you liked, applied to or added whose posting has closed. Their status, notes and reminders stay.</p>}
      </div>
      {sub === 'active'
        ? <ListBody list={active} view="liked" emptyArt="heart" emptyTitle="No liked jobs yet" emptyText="Select the heart on a job to keep it here." />
        : <ListBody list={closed} view="closed" emptyArt="box" emptyTitle="No closed postings" emptyText="When a posting you liked or applied to closes, it moves here with its notes." />}
    </div>
  );
}

export function AppliedTab() {
  // "All" lists every job the Applied badge counts; the other tabs narrow it to one stage
  const [status, setStatus] = useState<TrackerStatus | 'all'>('all');
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const list = useTrackerView('applied', status === 'all' ? undefined : status);
  const counts = list.data?.counts.byStatus;
  const total = list.data?.counts.applied;
  return (
    <div className="jl-list-pane">
      <div className="jl-row" style={{ padding: '4px 16px 0' }}>
        <Tabs activeKey={status} onChange={(k) => setStatus(k as TrackerStatus | 'all')} className="jl-grow"
          items={[{ key: 'all', label: `All (${total ?? 0})` }, ...TRACKER_STATUSES.map((s) => ({ key: s, label: `${TRACKER_STATUS_LABELS[s]} (${counts?.[s] ?? 0})` }))]} />
        {searching
          ? <Input autoFocus allowClear size="small" style={{ width: 220 }} placeholder="Search your applications" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search your applications" onBlur={() => { if (!q) setSearching(false); }} />
          : <Button shape="circle" icon={<SearchOutlined />} aria-label="Search your applications" onClick={() => setSearching(true)} />}
      </div>
      <ListBody list={list} view="applied" emptyArt="send" emptyTitle={status === 'all' ? 'No applications yet' : `No jobs in ${TRACKER_STATUS_LABELS[status]}`} emptyText="Mark a job as applied from its card or detail, then move it through the stages here or in the tracker." strip filterText={q} />
    </div>
  );
}

export function HiddenTab() {
  const list = useTrackerView('hidden');
  return (
    <div className="jl-list-pane">
      <div style={{ padding: '12px 16px 0' }} className="jl-row">
        <p className="jl-muted">Jobs you marked "Not interested". They never show in your results. Select the crossed-circle button on a card to show it again.</p>
      </div>
      <ListBody list={list} view="hidden" emptyArt="hidden" emptyTitle="No hidden jobs" emptyText="Jobs you mark as not interested are listed here, so you can bring them back." />
    </div>
  );
}

export function ExternalTab() {
  const list = useTrackerView('external');
  const [mode, setMode] = useState<'url' | 'text'>('url');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [applyUrl, setApplyUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ type: 'success' | 'error' | 'info'; msg: string } | null>(null);
  const add = async () => {
    setBusy(true);
    setResult(null);
    try {
      const body = mode === 'url' ? { url: url.trim() } : { text, ...(applyUrl.trim() ? { applyUrl: applyUrl.trim() } : {}) };
      if (mode === 'url' && !/^https?:\/\//i.test(url.trim())) throw { code: 'bad_request', status: 400, message: 'Paste the full link, starting with https:// or http://.', link: null } satisfies UiError;
      const r = await call('addExternalJob', { body });
      // the same job twice is one row: say so (a server may also say it with alreadyAdded)
      const already = (r as unknown as { alreadyAdded?: boolean }).alreadyAdded ?? !!list.data?.items.some((x) => x.job.id === r.job.id);
      setResult({ type: already ? 'info' : 'success', msg: already ? `Already in your list: ${r.job.title} at ${r.job.company}. Nothing was added twice.` : `Added: ${r.job.title} at ${r.job.company}.` });
      setUrl(''); setText(''); setApplyUrl('');
      afterTrackerChange();
      invalidate('tracker');
    } catch (e) {
      setResult({ type: 'error', msg: (e as UiError).message });
    } finally { setBusy(false); }
  };
  return (
    <div className="jl-list-pane">
      <div style={{ padding: '12px 16px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Space>
          <Segmented value={mode} onChange={(v) => { setMode(v as 'url' | 'text'); setResult(null); }} options={[{ value: 'url', label: 'Paste a link' }, { value: 'text', label: 'Paste the text' }]} aria-label="How to add a job" />
        </Space>
        {mode === 'url' ? (
          <div className="jl-row">
            <Input size="large" prefix={<LinkOutlined />} value={url} onChange={(e) => setUrl(e.target.value)} onPressEnter={() => { if (url.trim()) void add(); }} placeholder="Paste a job link to add it to your list" aria-label="Job link" />
            <Button size="large" className="jl-accent-btn" shape="round" icon={<PlusOutlined />} loading={busy} disabled={!url.trim()} onClick={() => { void add(); }}>Add job</Button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Input.TextArea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the whole posting: title on the first line, then the description" aria-label="Posting text" maxLength={200000} />
            <div className="jl-row">
              <Input value={applyUrl} onChange={(e) => setApplyUrl(e.target.value)} placeholder="Apply link (optional)" aria-label="Apply link (optional)" />
              <Button className="jl-accent-btn" shape="round" icon={<PlusOutlined />} loading={busy} disabled={text.trim().length < 1} onClick={() => { void add(); }}>Add job</Button>
            </div>
          </div>
        )}
        <p className="jl-small jl-muted">jobleft reads the page once to get the job's facts. It never reads LinkedIn, Indeed or Glassdoor; paste the posting text for those.</p>
        {result && <Alert type={result.type} showIcon message={result.msg} closable onClose={() => setResult(null)} />}
      </div>
      <ListBody list={list} view="external" emptyArt="link" emptyTitle="No added jobs yet" emptyText="Add jobs from other sites to track them, check your match and tailor a resume." />
    </div>
  );
}
