// The dashboard: your job search at a glance. Every number is read from your own data when the screen opens (no
// fixed numbers), and each one opens the screen that lists it.

import { Button, Progress } from 'antd';
import { TRACKER_STATUSES, TRACKER_STATUS_LABELS, type CrawlBoardReport, type CrawlRunSummary, type NetworkContact, type SavedFilter, type StorageInfo } from '@jobleft/contracts';
import { call } from '../app/api.ts';
import { useApi } from '../app/data.ts';
import { navigate } from '../app/router.ts';
import { useCrawl, useNotifications } from '../app/session.ts';
import { ErrorState, Loading } from '../components/States.tsx';
import { ago, dateTimeText, plural } from '../lib/format.ts';
import { useTrackerView } from './jobs/TrackerTabs.tsx';

function Kpi({ n, label, to }: { n: number | null | undefined; label: string; to: string }) {
  return (
    <button type="button" className="jl-kpi" onClick={() => navigate(to)} aria-label={`${label}: ${n ?? 'not known yet'}. Open.`}>
      <span className="n">{n === null || n === undefined ? '–' : n.toLocaleString('en-US')}</span>
      <span className="l">{label}</span>
    </button>
  );
}

function weekStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

export function Dashboard() {
  const storage = useApi<StorageInfo>('dashboard:storage', () => call('storage'));
  const recent = useApi<number>('dashboard:recent', async () => (await call('searchJobs', { body: { sort: 'most_recent', filter: { postedWithin: '7d' }, limit: 1 } })).total);
  const applied = useTrackerView('applied');
  const liked = useTrackerView('liked');
  const contacts = useApi<NetworkContact[]>('network:contacts:', () => call('listContacts', { query: {} }));
  const filters = useApi<SavedFilter[]>('filters', () => call('listFilters'));
  const report = useApi<{ run: CrawlRunSummary | null; boards: CrawlBoardReport[] }>('dashboard:report', () => call('crawlReport'));
  const notes = useNotifications();
  const { progress } = useCrawl();

  if (applied.error && !applied.data) return <div className="jl-page"><ErrorState error={applied.error} onRetry={() => { void applied.reload(); }} /></div>;
  if (!applied.data) return <div className="jl-page"><Loading label="Loading your dashboard" /></div>;

  const by = applied.data.counts.byStatus;
  const today = new Date().toISOString().slice(0, 10);
  const due = (contacts.data ?? []).filter((c) => c.followUpOn && c.followUpOn <= today).length;
  const maxBy = Math.max(1, ...TRACKER_STATUSES.map((s) => by[s]));

  // applications per week (last 8 weeks), from each job's status history
  const now = Date.now();
  const weeks = Array.from({ length: 8 }, (_, i) => weekStart(now) - (7 - i) * 7 * 86_400_000);
  const perWeek = weeks.map(() => 0);
  for (const it of applied.data.items) {
    const at = it.entry.appliedAt ? Date.parse(it.entry.appliedAt) : null;
    if (at === null) continue;
    const w = weekStart(at);
    const idx = weeks.indexOf(w);
    if (idx >= 0) perWeek[idx]!++;
  }
  const maxWeek = Math.max(1, ...perWeek);
  const reminders = applied.data.items.flatMap((it) => it.entry.reminders.filter((r) => !r.done).map((r) => ({ r, it }))).sort((a, b) => (a.r.at < b.r.at ? -1 : 1)).slice(0, 5);
  const failing = (report.data?.boards ?? []).filter((b) => b.status !== 'ok');

  return (
    <div className="jl-page">
      <div className="jl-page-inner" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="jl-kpis">
          <Kpi n={storage.data?.openJobs} label="Open jobs stored" to="jobs" />
          <Kpi n={recent.data} label="Posted in the last 7 days" to="jobs" />
          <Kpi n={liked.data?.counts.liked} label="Liked" to="jobs/liked" />
          <Kpi n={applied.data.counts.applied} label="Applications" to="tracker" />
          <Kpi n={by.interviewing} label="Interviewing" to="tracker" />
          <Kpi n={by.offer_received} label="Offers" to="tracker" />
          <Kpi n={contacts.data?.length} label="Connections imported" to="network" />
          <Kpi n={contacts.data ? due : null} label="Follow-ups due" to="network/followups" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
          <section className="jl-card-box" aria-labelledby="pipe-h">
            <h2 id="pipe-h" className="jl-section-title" style={{ fontSize: 17 }}>Your applications by stage</h2>
            <div className="jl-bars">
              {TRACKER_STATUSES.map((s) => (
                <div className="jl-bar-row" key={s}>
                  <span>{TRACKER_STATUS_LABELS[s]}</span>
                  <span className="jl-bar" aria-hidden="true"><span style={{ width: `${(100 * by[s]) / maxBy}%` }} /></span>
                  <span>{by[s]}</span>
                </div>
              ))}
            </div>
          </section>
          <section className="jl-card-box" aria-labelledby="week-h">
            <h2 id="week-h" className="jl-section-title" style={{ fontSize: 17 }}>Applications per week</h2>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 120 }} role="img" aria-label={`Applications in the last 8 weeks: ${perWeek.join(', ')}`}>
              {perWeek.map((n, i) => (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <span className="jl-small">{n}</span>
                  <div style={{ width: '100%', height: `${(90 * n) / maxWeek}px`, minHeight: 2, background: n ? '#0A8F5C' : 'var(--jl-chip)', borderRadius: 4 }} />
                  <span className="jl-small jl-muted">{new Date(weeks[i]!).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                </div>
              ))}
            </div>
          </section>
          <section className="jl-card-box" aria-labelledby="rem2-h">
            <h2 id="rem2-h" className="jl-section-title" style={{ fontSize: 17 }}>Next reminders</h2>
            {!reminders.length && <p className="jl-muted">No open reminders.</p>}
            {reminders.map(({ r, it }) => <p key={r.id} style={{ margin: '4px 0' }}><strong>{dateTimeText(r.at)}</strong>: {r.text} · <a href={`#/jobs/${encodeURIComponent(it.job.id)}`}>{it.job.company}</a></p>)}
          </section>
          <section className="jl-card-box" aria-labelledby="ref-h">
            <h2 id="ref-h" className="jl-section-title" style={{ fontSize: 17 }}>Job boards</h2>
            {progress?.running ? (
              <>
                <p>Refreshing now: {progress.boardsDone} of {plural(progress.boardsTotal, 'board')}.</p>
                <Progress percent={progress.boardsTotal ? Math.round((100 * progress.boardsDone) / progress.boardsTotal) : 0} size="small" strokeColor="#0A8F5C" />
              </>
            ) : report.data?.run ? (
              <p>Last refresh {ago(report.data.run.finishedAt)}: {plural(report.data.run.ok, 'board')} read, {plural(report.data.run.inserted, 'new job')}, {plural(report.data.run.closed, 'posting')} closed.</p>
            ) : <p className="jl-muted">No refresh has run yet.</p>}
            {failing.length > 0 && <p style={{ color: 'var(--jl-warn)' }}>{plural(failing.length, 'board')} could not be read. Their jobs stay open until a refresh reads them.</p>}
            <Button type="link" style={{ padding: 0 }} onClick={() => navigate('settings/sources')}>See the refresh report</Button>
          </section>
          <section className="jl-card-box" aria-labelledby="al-h">
            <h2 id="al-h" className="jl-section-title" style={{ fontSize: 17 }}>Alerts</h2>
            <p>{plural(notes.data?.length ?? 0, 'new notification')}. {plural((filters.data ?? []).filter((f) => f.alert.enabled).length, 'saved filter')} with alerts on.</p>
            <Button type="link" style={{ padding: 0 }} onClick={() => navigate('notifications')}>Open notifications</Button>
          </section>
        </div>
      </div>
    </div>
  );
}
