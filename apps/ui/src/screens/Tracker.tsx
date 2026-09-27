// The application tracker: every job you liked, applied to, or wrote a note or reminder on, by stage. Move a job with
// its status menu (keyboard) or by dragging its card. Counts come from the same answer as the rows. Closed postings
// keep their stage and notes. A job that holds notes or reminders never leaves the board (JL-tracker-6).

import { useState } from 'react';
import { Button, Checkbox, Segmented, Select, Table } from 'antd';
import { Tooltip } from '../components/Tip.tsx';
import { TRACKER_STATUSES, TRACKER_STATUS_LABELS, type TrackerEntry, type TrackerList, type TrackerStatus } from '@jobleft/contracts';
import { call, type UiError } from '../app/api.ts';
import { ui } from '../app/layers.ts';
import { navigate } from '../app/router.ts';
import { afterTrackerChange } from '../app/session.ts';
import { EmptyState, ErrorState, Loading } from '../components/States.tsx';
import { dateText, dateTimeText, plural } from '../lib/format.ts';
import { patchFresh, reminderKeep } from '../lib/trackerEdit.ts';
import { nextReminder, openReminders } from '../lib/trackerView.ts';
import { useTrackerView } from './jobs/TrackerTabs.tsx';

type Item = TrackerList['items'][number];
type Col = TrackerStatus | 'saved';

const COLS: Array<{ id: Col; label: string }> = [
  { id: 'saved', label: 'Not applied yet' },
  ...TRACKER_STATUSES.map((s) => ({ id: s as Col, label: TRACKER_STATUS_LABELS[s] })),
];

async function move(it: Item, to: Col): Promise<void> {
  try {
    await call('updateTracker', { params: { jobId: it.job.id }, body: { status: to === 'saved' ? null : to } });
    afterTrackerChange();
    ui.message?.success(to === 'saved' ? 'Moved to Not applied yet. Its notes and reminders stay.' : `Moved to ${TRACKER_STATUS_LABELS[to]}.`);
  } catch (e) { ui.message?.error((e as UiError).message); }
}

function ReminderText({ e }: { e: TrackerEntry }) {
  const x = nextReminder(e, Date.now());
  if (!x) return null;
  return <>{dateTimeText(x.r.at)}{x.overdue && <span className="jl-chip warn" style={{ marginLeft: 4 }}>Overdue</span>}</>;
}

function StatusSelect({ it }: { it: Item }) {
  return (
    <Select size="small" value={(it.entry.status ?? 'saved') as Col} style={{ width: '100%' }} aria-label={`Stage of ${it.job.title}`}
      options={COLS.map((c) => ({ value: c.id, label: c.id === 'saved' ? 'Not applied' : c.label }))} onChange={(v) => { void move(it, v); }} />
  );
}

function Mini({ it }: { it: Item }) {
  const r = nextReminder(it.entry, Date.now());
  const e = it.entry;
  return (
    <div className="jl-mini" draggable onDragStart={(e) => { e.dataTransfer.setData('text/jobleft-job', it.job.id); e.dataTransfer.effectAllowed = 'move'; }}>
      <a className="t" href={`#/jobs/${encodeURIComponent(it.job.id)}`} style={{ color: '#000' }}>{it.job.title}</a>
      <span className="jl-small">{it.job.company}</span>
      {it.job.status === 'closed' && <span className="jl-chip closed" style={{ alignSelf: 'flex-start' }}>Posting closed</span>}
      {e.appliedAt && e.status !== null && <span className="jl-small jl-muted">Applied {dateText(e.appliedAt)}</span>}
      {e.status === null && !e.liked && <span className="jl-small jl-muted">Not liked. Kept here for your notes and reminders.</span>}
      {r && <span className="jl-small">Reminder: <ReminderText e={e} /></span>}
      {it.entry.notes.length > 0 && <span className="jl-small jl-muted">{plural(it.entry.notes.length, 'note')}</span>}
      <StatusSelect it={it} />
    </div>
  );
}

export function TrackerScreen() {
  // One answer for the whole board: every job the person liked, applied to, or wrote a note or reminder on.
  const tracked = useTrackerView('tracked');
  const closed = useTrackerView('closed');
  const [view, setView] = useState<'board' | 'table'>('board');
  const [over, setOver] = useState<Col | null>(null);
  if (tracked.error && !tracked.data) return <div className="jl-page"><ErrorState error={tracked.error} onRetry={() => { void tracked.reload(); }} /></div>;
  if (!tracked.data) return <div className="jl-page"><Loading label="Loading your tracker" /></div>;
  const all = tracked.data.items;
  const saved = all.filter((x) => x.entry.status === null);
  const byCol: Record<Col, Item[]> = { saved, applied: [], interviewing: [], offer_received: [], rejected: [], archived: [] };
  for (const it of all) if (it.entry.status !== null) byCol[it.entry.status].push(it);
  const reminders = openReminders(all, Date.now());
  const counts = tracked.data.counts;

  const drop = (col: Col, e: React.DragEvent) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData('text/jobleft-job');
    const it = all.find((x) => x.job.id === id);
    if (it && (it.entry.status ?? 'saved') !== col) void move(it, col);
  };

  return (
    <div className="jl-page">
      <div className="jl-page-inner" style={{ maxWidth: 1400 }}>
        <div className="jl-row jl-wrap" style={{ marginBottom: 12 }}>
          <p className="jl-grow" style={{ fontSize: 15, fontWeight: 500 }}>{plural(counts.applied, 'application')} and {plural(saved.length, 'job')} not applied yet.</p>
          <Segmented value={view} onChange={(v) => setView(v as 'board' | 'table')} options={[{ value: 'board', label: 'Board' }, { value: 'table', label: 'Table' }]} aria-label="Tracker view" />
        </div>
        {!all.length ? (
          <EmptyState art="board" title="Nothing to track yet" text="Like a job, or mark one as applied, and it shows here by stage." action={<Button type="primary" shape="round" onClick={() => navigate('jobs')}>Browse jobs</Button>} />
        ) : view === 'board' ? (
          <div style={{ paddingBottom: 8 }}>
            <div className="jl-board">
              {COLS.map((c) => (
                <section key={c.id} className="jl-col" aria-label={`${c.label}: ${byCol[c.id].length}`}
                  style={over === c.id ? { outline: '2px dashed #047A52' } : undefined}
                  onDragOver={(e) => { e.preventDefault(); setOver(c.id); }} onDragLeave={() => setOver(null)} onDrop={(e) => drop(c.id, e)}>
                  <h3>{c.label}<span className="jl-pill light">{byCol[c.id].length}</span></h3>
                  {byCol[c.id].map((it) => <Mini key={it.job.id} it={it} />)}
                  {!byCol[c.id].length && <span className="jl-small jl-muted">None</span>}
                </section>
              ))}
            </div>
          </div>
        ) : (
          <Table size="middle" rowKey={(r) => r.job.id} dataSource={all} pagination={{ pageSize: 25, hideOnSinglePage: true }}
            columns={[
              { title: 'Job', key: 'job', render: (_, r) => <a href={`#/jobs/${encodeURIComponent(r.job.id)}`}>{r.job.title}</a>, sorter: (a, b) => a.job.title.localeCompare(b.job.title) },
              { title: 'Company', key: 'co', render: (_, r) => r.job.company, sorter: (a, b) => a.job.company.localeCompare(b.job.company) },
              { title: 'Stage', key: 'st', width: 190, render: (_, r) => <StatusSelect it={r} /> },
              { title: 'Applied', key: 'ap', render: (_, r) => dateText(r.entry.appliedAt) ?? '', sorter: (a, b) => (a.entry.appliedAt ?? '').localeCompare(b.entry.appliedAt ?? '') },
              { title: 'Posting', key: 'po', render: (_, r) => (r.job.status === 'closed' ? 'Closed' : 'Open') },
              { title: 'Next reminder', key: 'rm', render: (_, r) => <ReminderText e={r.entry} /> },
              { title: 'Notes', key: 'no', render: (_, r) => r.entry.notes.length || '' },
            ]} />
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginTop: 16 }}>
          <section className="jl-card-box" aria-labelledby="rem-h">
            <h2 id="rem-h" className="jl-section-title" style={{ fontSize: 17 }}>Open reminders</h2>
            {!reminders.length && <p className="jl-muted">No open reminders. Add one from a job's notes.</p>}
            {reminders.slice(0, 12).map(({ r, it, overdue }) => (
              <div key={r.id} className="jl-row" style={{ padding: '4px 0' }}>
                <Checkbox aria-label={`Done: ${r.text}`} onChange={async (e) => {
                  const done = e.target.checked;
                  try {
                    await patchFresh(it.job.id, (f) => (f?.reminders.some((x) => x.id === r.id) ? { reminders: reminderKeep(f).map((x) => (x.id === r.id ? { ...x, done } : x)) } : null));
                    afterTrackerChange();
                  } catch (err) { ui.message?.error((err as UiError).message); }
                }} />
                <span className="jl-grow">{overdue && <span className="jl-chip warn" style={{ marginRight: 6 }}>Overdue</span>}<strong>{dateTimeText(r.at)}</strong>: {r.text} · <a href={`#/jobs/${encodeURIComponent(it.job.id)}`}>{it.job.company}</a></span>
              </div>
            ))}
            {reminders.length > 12 && <p className="jl-small jl-muted">{plural(reminders.length - 12, 'more open reminder')}. Open a job to see all of its reminders.</p>}
          </section>
          <section className="jl-card-box" aria-labelledby="cl-h">
            <h2 id="cl-h" className="jl-section-title" style={{ fontSize: 17 }}>Closed postings ({closed.data?.counts.closed ?? 0})</h2>
            {closed.data && !closed.data.items.length && <p className="jl-muted">None. When a posting you track closes, it is listed here with its stage and notes.</p>}
            {closed.data?.items.slice(0, 12).map((it) => (
              <div key={it.job.id} className="jl-row" style={{ padding: '4px 0' }}>
                <a className="jl-grow" href={`#/jobs/${encodeURIComponent(it.job.id)}`}>{it.job.title}</a>
                <span className="jl-muted jl-small">{it.job.company}</span>
                <Tooltip title={`Closed ${dateText(it.job.closedAt) ?? ''}`}><span className="jl-chip">{it.entry.status ? TRACKER_STATUS_LABELS[it.entry.status] : 'Liked'}</span></Tooltip>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}
