// The dashboard: your job search at a glance. Every number is read from your own data when the screen opens (no
// fixed numbers), and each one opens the screen that lists it.

import { Button, Progress } from 'antd';
import { TRACKER_STATUSES, TRACKER_STATUS_LABELS, type CrawlBoardReport, type Digest, type JobListItem, type CrawlRunSummary, type NetworkContact, type SavedFilter, type StorageInfo } from '@jobleft/contracts';
import { call } from '../app/api.ts';
import { useApi } from '../app/data.ts';
import { navigate } from '../app/router.ts';
import { useCrawl, useNotifications } from '../app/session.ts';
import { ErrorState, Loading } from '../components/States.tsx';
import { ago, dateText, dateTimeText, plural } from '../lib/format.ts';
import { applicationsPerWeek, openReminders } from '../lib/trackerView.ts';
import { useTrackerView } from './jobs/TrackerTabs.tsx';

/** One new job in the summary: title, company and place, with its match; a click opens it. */
function NewJob({ it }: { it: JobListItem }) {
  const place = it.job.places.map((p) => p.text).filter(Boolean).join('; ');
  return (
    <a href={`#/jobs/${encodeURIComponent(it.job.id)}`} className="jl-row" style={{ gap: 8, padding: '6px 0', color: 'inherit', textDecoration: 'none', borderTop: '1px solid var(--jl-line)' }}>
      <span className="jl-grow" style={{ minWidth: 0 }}>
        <strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.job.title}</strong>
        <span className="jl-small jl-muted">{it.job.company}{place ? ` · ${place}` : ''}</span>
      </span>
      {it.match && <span className="jl-chip" style={{ flex: '0 0 auto' }}>{it.match.percent}%</span>}
    </a>
  );
}

/** The daily summary (Settings > Notifications): the new jobs of the last 24 hours that fit, best first. */
function NewToday({ d }: { d: Digest }) {
  const n = d.boards.total + d.web.total;
  return (
    <section className="jl-card-box" aria-labelledby="new-h">
      <h2 id="new-h" className="jl-section-title" style={{ fontSize: 17 }}>New in the last 24 hours</h2>
      {!n && <p className="jl-muted">No new jobs that fit you since {dateTimeText(d.since)}.</p>}
      {d.boards.total > 0 && (
        <>
          <p style={{ margin: '4px 0' }}>{plural(d.boards.total, 'new job')} from your boards that {d.boards.total === 1 ? 'fits' : 'fit'} you{d.boards.top.length < d.boards.total ? ', the best first' : ''}:</p>
          {d.boards.top.map((it) => <NewJob key={it.job.id} it={it} />)}
          <Button type="link" style={{ padding: 0 }} onClick={() => navigate('jobs')}>Open Recommended</Button>
        </>
      )}
      {d.web.total > 0 && (
        <>
          <p style={{ margin: '8px 0 4px' }}>{plural(d.web.total, 'new job')} from web searches:</p>
          {d.web.top.map((it) => <NewJob key={it.job.id} it={it} />)}
          <Button type="link" style={{ padding: 0 }} onClick={() => navigate('jobs/web')}>Open Web jobs</Button>
        </>
      )}
    </section>
  );
}

function Kpi({ n, label, to }: { n: number | null | undefined; label: string; to: string }) {
  return (
    <button type="button" className="jl-kpi" onClick={() => navigate(to)} aria-label={`${label}: ${n ?? 'not known yet'}. Open.`}>
      <span className="n">{n === null || n === undefined ? '–' : n.toLocaleString('en-US')}</span>
      <span className="l">{label}</span>
    </button>
  );
}

export function Dashboard() {
  const storage = useApi<StorageInfo>('dashboard:storage', () => call('storage'));
  const recent = useApi<number>('dashboard:recent', async () => (await call('searchJobs', { body: { sort: 'most_recent', filter: { postedWithin: '7d' }, limit: 1 } })).total);
  // One tracker answer: counts, applications and every open reminder (liked jobs too, JL-tracker-1).
  const applied = useTrackerView('tracked');
  const contacts = useApi<NetworkContact[]>('network:contacts:', () => call('listContacts', { query: {} }));
  const filters = useApi<SavedFilter[]>('filters', () => call('listFilters'));
  const report = useApi<{ run: CrawlRunSummary | null; boards: CrawlBoardReport[] }>('dashboard:report', () => call('crawlReport'));
  const notes = useNotifications();
  const digest = useApi<Digest>('dashboard:digest', () => call('getDigest', { query: {} }));
  const { progress } = useCrawl();

  if (applied.error && !applied.data) return <div className="jl-page"><ErrorState error={applied.error} onRetry={() => { void applied.reload(); }} /></div>;
  if (!applied.data) return <div className="jl-page"><Loading label="Loading your dashboard" /></div>;

  const by = applied.data.counts.byStatus;
  const today = new Date().toISOString().slice(0, 10);
  const due = (contacts.data ?? []).filter((c) => c.followUpOn && c.followUpOn <= today).length;
  const maxBy = Math.max(1, ...TRACKER_STATUSES.map((s) => by[s]));

  // applications per week (last 8 weeks): every application counts, whatever stage it went to first
  const now = Date.now();
  const { weeks, counts: perWeek, earlier } = applicationsPerWeek(applied.data.items, now);
  const maxWeek = Math.max(1, ...perWeek);
  const allReminders = openReminders(applied.data.items, now);
  const reminders = allReminders.slice(0, 5);
  const failing = (report.data?.boards ?? []).filter((b) => b.status !== 'ok');

  return (
    <div className="jl-page">
      <div className="jl-page-inner" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="jl-kpis">
          <Kpi n={storage.data?.openJobs} label="Open jobs stored" to="jobs" />
          <Kpi n={recent.data} label="Posted in the last 7 days" to="jobs" />
          <Kpi n={applied.data.counts.liked} label="Liked" to="jobs/liked" />
          <Kpi n={applied.data.counts.applied} label="Applications" to="tracker" />
          <Kpi n={by.interviewing} label="Interviewing" to="tracker" />
          <Kpi n={by.offer_received} label="Offers" to="tracker" />
          <Kpi n={contacts.data?.length} label="Connections imported" to="network" />
          <Kpi n={contacts.data ? due : null} label="Follow-ups due" to="network/followups" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
          {digest.data && <NewToday d={digest.data} />}
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
                  <span className="jl-small jl-muted" style={{ whiteSpace: 'nowrap' }}>{new Date(weeks[i]!).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                </div>
              ))}
            </div>
            {earlier > 0 && <p className="jl-small jl-muted" style={{ marginTop: 8 }}>Plus {plural(earlier, 'application')} before {dateText(new Date(weeks[0]!).toISOString())}.</p>}
          </section>
          <section className="jl-card-box" aria-labelledby="rem2-h">
            <h2 id="rem2-h" className="jl-section-title" style={{ fontSize: 17 }}>Next reminders</h2>
            {!reminders.length && <p className="jl-muted">No open reminders.</p>}
            {reminders.map(({ r, it, overdue }) => <p key={r.id} style={{ margin: '4px 0' }}>{overdue && <span className="jl-chip warn" style={{ marginRight: 6 }}>Overdue</span>}<strong>{dateTimeText(r.at)}</strong>: {r.text} · <a href={`#/jobs/${encodeURIComponent(it.job.id)}`}>{it.job.company}</a></p>)}
            {allReminders.length > reminders.length && <Button type="link" style={{ padding: 0 }} onClick={() => navigate('tracker')}>{plural(allReminders.length - reminders.length, 'more open reminder')} in the Tracker</Button>}
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
            <Button type="link" style={{ padding: 0 }} onClick={() => navigate('notifications')}>Open alerts</Button>
          </section>
        </div>
      </div>
    </div>
  );
}
