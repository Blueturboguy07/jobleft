// Notifications: new jobs from refreshes, saved-filter alerts, reminders and follow-ups. The desktop app also shows
// them as macOS notifications; dismissing one here marks it shown.

import { Button } from 'antd';
import { BellOutlined, CalendarOutlined, SearchOutlined, TeamOutlined } from '@ant-design/icons';
import type { NetworkContact, Notification } from '@jobleft/contracts';
import { call, type UiError } from '../app/api.ts';
import { invalidate, useApi } from '../app/data.ts';
import { ui } from '../app/layers.ts';
import { navigate } from '../app/router.ts';
import { useNotifications } from '../app/session.ts';
import { EmptyState, ErrorState, Loading } from '../components/States.tsx';
import { ago, calendarDate, dateTimeText } from '../lib/format.ts';
import { useTrackerView } from './jobs/TrackerTabs.tsx';

const ICON: Record<Notification['kind'], React.ReactNode> = { new_matches: <SearchOutlined />, saved_filter_alert: <BellOutlined />, reminder: <CalendarOutlined />, follow_up: <TeamOutlined /> };

function targetRoute(t: string | null): string | null {
  if (!t) return null;
  const clean = t.replace(/^\/+/, '').split('?')[0]!;
  return clean || null;
}

export function Notifications() {
  const notes = useNotifications();
  const applied = useTrackerView('applied');
  const contacts = useApi<NetworkContact[]>('network:contacts:soon', () => call('listContacts', { query: { withFollowUp: 'true', due: 'false' } }));
  const dismiss = async (n: Notification) => {
    try { await call('ackNotification', { params: { notificationId: n.id } }); invalidate('notifications'); } catch (e) { ui.message?.error((e as UiError).message); }
  };
  if (notes.error && !notes.data) return <div className="jl-page"><ErrorState error={notes.error} onRetry={() => { void notes.reload(); }} /></div>;
  if (!notes.data) return <div className="jl-page"><Loading label="Loading notifications" /></div>;
  const now = Date.now();
  const upcoming = (applied.data?.items ?? []).flatMap((it) => it.entry.reminders.filter((r) => !r.done && Date.parse(r.at) > now).map((r) => ({ r, it }))).sort((a, b) => (a.r.at < b.r.at ? -1 : 1)).slice(0, 8);
  const today = new Date().toISOString().slice(0, 10);
  const followUps = (contacts.data ?? []).filter((c) => c.followUpOn && c.followUpOn > today).sort((a, b) => (a.followUpOn! < b.followUpOn! ? -1 : 1)).slice(0, 8);
  return (
    <div className="jl-page">
      <div className="jl-page-inner" style={{ maxWidth: 860, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <section className="jl-card-box" aria-labelledby="new-h">
          <div className="jl-row" style={{ marginBottom: 8 }}>
            <h2 id="new-h" className="jl-section-title jl-grow" style={{ margin: 0 }}>New</h2>
            {notes.data.length > 1 && <Button size="small" shape="round" onClick={async () => { for (const n of notes.data!) await call('ackNotification', { params: { notificationId: n.id } }).catch(() => undefined); invalidate('notifications'); }}>Dismiss all</Button>}
          </div>
          {!notes.data.length ? <EmptyState art="bell" title="No new notifications" text="New jobs from a refresh, saved-filter alerts and reminders show here. Choose which ones you want." action={<Button shape="round" type="primary" onClick={() => navigate('settings/alerts')}>Choose alerts</Button>} /> : notes.data.map((n) => {
            const to = targetRoute(n.target);
            return (
              <article key={n.id} className="jl-row" style={{ padding: '10px 0', borderTop: '1px solid var(--jl-line)', alignItems: 'flex-start' }} aria-label={n.title}>
                <span className="jl-sec-icon" aria-hidden="true">{ICON[n.kind] ?? <BellOutlined />}</span>
                <div className="jl-grow">
                  <strong>{n.title}</strong>
                  <p style={{ margin: '2px 0' }}>{n.body}</p>
                  <span className="jl-small jl-muted">{ago(n.createdAt)}</span>
                </div>
                {to && <Button size="small" shape="round" onClick={() => { void dismiss(n); navigate(to); }}>Open</Button>}
                <Button size="small" type="text" onClick={() => { void dismiss(n); }}>Dismiss</Button>
              </article>
            );
          })}
        </section>
        <section className="jl-card-box" aria-labelledby="up-h">
          <h2 id="up-h" className="jl-section-title">Coming up</h2>
          {!upcoming.length && !followUps.length && <p className="jl-muted">No upcoming reminders or follow-ups.</p>}
          {upcoming.map(({ r, it }) => <p key={r.id} style={{ margin: '4px 0' }}><CalendarOutlined /> {dateTimeText(r.at)}: {r.text} · <a href={`#/jobs/${encodeURIComponent(it.job.id)}`}>{it.job.company}</a></p>)}
          {followUps.map((c) => <p key={c.id} style={{ margin: '4px 0' }}><TeamOutlined /> {calendarDate(c.followUpOn)}: follow up with {c.firstName} {c.lastName}{c.company ? ` (${c.company})` : ''}</p>)}
        </section>
      </div>
    </div>
  );
}
