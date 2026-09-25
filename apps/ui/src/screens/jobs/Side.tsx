// The feed's right column: who you are, saved filters, the job-board refresh, and a setup checklist.
// No plan, no upsell, nothing that opens by itself.

import { useState } from 'react';
import { Button, Form, Input, Modal, Progress, Switch } from 'antd';
import { Tooltip } from '../../components/Tip.tsx';
import { BellFilled, BellOutlined, CheckCircleFilled, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { JobFilter, JobSort, SavedFilter } from '@jobleft/contracts';
import { call } from '../../app/api.ts';
import { invalidate, useApi } from '../../app/data.ts';
import { ui } from '../../app/layers.ts';
import { navigate } from '../../app/router.ts';
import { displayName, profileIsSet, useAiSettings, useCrawl, useProfile } from '../../app/session.ts';
import { ago, plural } from '../../lib/format.ts';
import { cleanFilter, sameFilter, suggestName } from '../../lib/filters.ts';
import { ProviderChip } from '../../components/Shell.tsx';

export function UserCard() {
  const profile = useProfile();
  const name = displayName(profile.data);
  return (
    <div className="jl-row" style={{ gap: 10 }}>
      <div className="jl-avatar" aria-hidden="true">{name ? name[0]!.toUpperCase() : '?'}</div>
      <div className="jl-grow">
        <a href="#/profile" style={{ color: '#000', fontWeight: 600, textDecoration: 'none' }}>{name ?? 'Set up your profile'}</a>
        <div className="jl-small jl-muted">Everything stays on this Mac</div>
      </div>
      <ProviderChip compact />
    </div>
  );
}

export function useSavedFilters() {
  return useApi<SavedFilter[]>('filters', () => call('listFilters'));
}

export function SaveFilterModal({ open, onClose, filter, sort, onSaved }: { open: boolean; onClose: () => void; filter: JobFilter; sort: JobSort; onSaved: (s: SavedFilter) => void }) {
  const [name, setName] = useState('');
  const [alert, setAlert] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open={open} title="Save this filter" onCancel={onClose} destroyOnClose afterOpenChange={(o) => { if (o) { setName(suggestName(filter)); setErr(null); } }}
      okText="Save filter" okButtonProps={{ shape: 'round', loading: busy, disabled: !name.trim() }} cancelButtonProps={{ shape: 'round' }}
      onOk={async () => {
        setBusy(true); setErr(null);
        try {
          const s = await call('createFilter', { body: { name: name.trim(), filter: cleanFilter(filter), sort, alert } });
          invalidate('filters');
          ui.message?.success(`Saved "${s.name}".`);
          onSaved(s);
          onClose();
        } catch (e) { setErr((e as { message: string }).message); } finally { setBusy(false); }
      }}>
      <Form layout="vertical">
        <Form.Item label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus aria-label="Filter name" />
        </Form.Item>
        <Form.Item>
          <label className="jl-row"><Switch aria-label="Tell me when a refresh finds new jobs for this filter" checked={alert} onChange={setAlert} /> Tell me when a refresh finds new jobs for this filter</label>
        </Form.Item>
      </Form>
      {err && <div role="alert" style={{ color: 'var(--jl-error)' }}>{err}</div>}
    </Modal>
  );
}

export function SavedFilters({ current, currentSort, savedId, onApply, onEdit }: { current: JobFilter; currentSort: JobSort; savedId: string | null; onApply: (s: SavedFilter) => void; onEdit: (s: SavedFilter) => void }) {
  const list = useSavedFilters();
  const [saving, setSaving] = useState(false);
  const toggleAlert = async (s: SavedFilter) => {
    try {
      await call('updateFilter', { params: { filterId: s.id }, body: { name: s.name, filter: s.filter, sort: s.sort, alert: !s.alert.enabled } });
      invalidate('filters');
      ui.message?.success(s.alert.enabled ? `Alerts off for "${s.name}".` : `You will be told about new jobs for "${s.name}".`);
    } catch (e) { ui.message?.error((e as { message: string }).message); }
  };
  return (
    <section aria-labelledby="sf-title">
      <div className="jl-rc-title">
        <h2 id="sf-title" style={{ fontSize: 14, fontWeight: 700 }}>Your saved filters</h2>
        <Tooltip title="Save the current filters">
          <Button type="primary" shape="circle" size="small" icon={<PlusOutlined />} aria-label="Save the current filters" onClick={() => setSaving(true)} />
        </Tooltip>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
        {list.error && <span className="jl-small" role="alert">{list.error.message} <Button size="small" type="link" onClick={() => void list.reload()}>Try again</Button></span>}
        {list.data && !list.data.length && <span className="jl-small jl-muted">No saved filters yet. Set filters, then press + to keep them.</span>}
        {list.data?.map((s) => {
          const applied = savedId === s.id;
          const modified = applied && (!sameFilter(s.filter, current) || s.sort !== currentSort);
          return (
            <div className="jl-saved-row" key={s.id} style={{ borderLeftColor: applied ? '#047A52' : 'var(--jl-accent)' }}>
              <button type="button" className="name" onClick={() => onApply(s)} aria-current={applied} title={s.name}>
                {applied ? <strong>{s.name}</strong> : s.name}{modified && <span className="jl-muted"> (changed)</span>}
              </button>
              <Tooltip title={s.alert.enabled ? 'Alerts on' : 'Alerts off'}>
                <Button size="small" type="text" icon={s.alert.enabled ? <BellFilled /> : <BellOutlined />} aria-pressed={s.alert.enabled} aria-label={`Alerts for ${s.name}: ${s.alert.enabled ? 'on' : 'off'}`} onClick={() => { void toggleAlert(s); }} />
              </Tooltip>
              <Tooltip title="Edit">
                <Button size="small" type="text" icon={<EditOutlined />} aria-label={`Edit ${s.name}`} onClick={() => onEdit(s)} />
              </Tooltip>
            </div>
          );
        })}
      </div>
      <SaveFilterModal open={saving} onClose={() => setSaving(false)} filter={current} sort={currentSort} onSaved={(s) => onApply(s)} />
    </section>
  );
}

export function BoardsCard() {
  const { progress, error } = useCrawl();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await call('crawlRun', { body: {} });
      if (r.started) ui.message?.success(r.message); else ui.message?.info(r.message);
      invalidate('crawl');
    } catch (e) { ui.message?.error((e as { message: string }).message); } finally { setBusy(false); }
  };
  const last = progress?.lastRun;
  return (
    <section className="jl-factbox" aria-labelledby="bc-title" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h2 id="bc-title" style={{ fontSize: 14, fontWeight: 700 }}>Job boards</h2>
      {error && <span className="jl-small">jobleft cannot read the refresh status right now.</span>}
      {progress?.running ? (
        <>
          <span className="jl-small">Refreshing: {progress.boardsDone} of {plural(progress.boardsTotal, 'board')} done, {plural(progress.jobsSeen, 'job')} seen.</span>
          <Progress percent={progress.boardsTotal ? Math.round((100 * progress.boardsDone) / progress.boardsTotal) : 0} size="small" showInfo={false} strokeColor="#0A8F5C" aria-label="Refresh progress" />
        </>
      ) : last ? (
        <span className="jl-small">Last refresh {ago(last.finishedAt)}: {plural(last.ok, 'board')} read{last.failed ? `, ${last.failed} could not be read` : ''}. {plural(last.inserted, 'new job')}.</span>
      ) : <span className="jl-small">No refresh has run yet.</span>}
      <div className="jl-row jl-wrap">
        <Button size="small" shape="round" icon={<ReloadOutlined />} onClick={() => { void run(); }} loading={busy} disabled={progress?.running}>Refresh now</Button>
        <Button size="small" type="link" style={{ padding: 0 }} onClick={() => navigate('settings/sources')}>Sources and report</Button>
      </div>
    </section>
  );
}

const CHECK_KEY = 'jobleft.checklist.hidden';

export function Checklist() {
  const profile = useProfile();
  const ai = useAiSettings();
  const resumes = useApi('resumes', () => call('listResumes'));
  const contacts = useApi('network:contacts:any', () => call('listContacts', { query: { limit: '1' } }));
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(CHECK_KEY) === '1'; } catch { return false; } });
  if (hidden) return null;
  const steps = [
    { done: profileIsSet(profile.data), text: 'Add your profile', to: 'profile' },
    { done: (resumes.data?.length ?? 0) > 0, text: 'Add a resume', to: 'resume' },
    { done: !!ai.data?.provider, text: 'Choose where AI answers come from', to: 'settings/ai' },
    { done: (contacts.data?.length ?? 0) > 0, text: 'Import your connections (optional)', to: 'network' },
  ];
  const done = steps.filter((s) => s.done).length;
  return (
    <section className="jl-factbox" aria-labelledby="cl-title" style={{ background: 'linear-gradient(160deg, rgba(0,240,160,0.14), #fff 70%)', border: '1px solid rgba(0,240,160,0.35)' }}>
      <div className="jl-rc-title"><h2 id="cl-title" style={{ fontSize: 14, fontWeight: 700 }}>Get set up</h2><span className="jl-small">{done} of {steps.length}</span></div>
      <Progress percent={Math.round((100 * done) / steps.length)} size="small" showInfo={false} strokeColor="#0A8F5C" aria-label="Setup progress" />
      <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {steps.map((s) => (
          <li key={s.text} className="jl-row">
            {s.done ? <CheckCircleFilled style={{ color: '#0A8F5C' }} aria-label="Done" /> : <span aria-label="Not done" style={{ width: 14, height: 14, borderRadius: 7, border: '1.5px solid #9AA0A6', display: 'inline-block' }} />}
            <a href={`#/${s.to}`} style={{ color: '#000' }}>{s.text}</a>
          </li>
        ))}
      </ul>
      <Button size="small" type="link" style={{ padding: 0, marginTop: 6 }} onClick={() => { setHidden(true); try { localStorage.setItem(CHECK_KEY, '1'); } catch { /* ignore */ } }}>Hide this list</Button>
    </section>
  );
}
