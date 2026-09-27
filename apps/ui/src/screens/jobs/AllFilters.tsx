// The All filters drawer: every filter of JobFilter in four groups. It edits either the current feed filter or a
// saved filter (with its name, sort and alert). Closing with unsaved changes asks first.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Checkbox, Drawer, Input, Radio, Select, Slider, Space, Switch, Tag } from 'antd';
import { Tooltip } from '../../components/Tip.tsx';
import { RightOutlined, DeleteOutlined, QuestionCircleOutlined } from '@ant-design/icons';
import type { JobFilter, JobSort, SavedFilter } from '@jobleft/contracts';
import {
  JOB_FUNCTION_SUGGESTIONS, LEVEL_OPTIONS, MODEL_OPTIONS, POSTED_OPTIONS, SORT_OPTIONS, TYPE_OPTIONS, COUNTRY_OPTIONS,
  PAY_FILTER_NOTE, cleanFilter, sameFilter, summaryChips, toggle,
} from '../../lib/filters.ts';
import { PlacePicker, SKILL_SUGGESTIONS, UnknownBox } from './Filters.tsx';
import { call } from '../../app/api.ts';
import { confirmDiscard, ui } from '../../app/layers.ts';

type Group = 'basics' | 'pay' | 'interests' | 'companies';
const GROUPS: Array<{ id: Group; t: string; s: string }> = [
  { id: 'basics', t: 'Basics', s: 'Job function, type, work model, place, level, years, date' },
  { id: 'pay', t: 'Pay and visa', s: 'Minimum yearly pay, H-1B, limits' },
  { id: 'interests', t: 'Interests', s: 'Skill, role type' },
  { id: 'companies', t: 'Companies', s: 'Include, exclude' },
];

function Box({ title, children, clear, help }: { title: string; children: ReactNode; clear?: () => void; help?: string }) {
  return (
    <section className="jl-af-group" aria-label={title}>
      <h3>
        <span>{title}{help && <Tooltip title={help}><QuestionCircleOutlined style={{ marginLeft: 6, color: 'var(--jl-text3)' }} aria-label={`About ${title}`} tabIndex={0} /></Tooltip>}</span>
        {clear && <Button type="link" size="small" onClick={clear}>Clear</Button>}
      </h3>
      {children}
    </section>
  );
}

function Tiles<T extends string>({ options, value, onChange, label }: { options: Array<{ value: T; label: string }>; value: T[] | undefined; onChange: (v: T[]) => void; label: string }) {
  return (
    <div className="jl-choice-grid" role="group" aria-label={label}>
      {options.map((o) => {
        const on = (value ?? []).includes(o.value);
        return (
          <label key={o.value} className={`jl-choice${on ? ' on' : ''}`}>
            <Checkbox checked={on} onChange={() => onChange(toggle(value, o.value))} /> {o.label}
          </label>
        );
      })}
    </div>
  );
}

/** Company search: the names come from stored jobs, so the key always belongs to a real company in the list. */
function CompanyPicker({ value, onChange, label }: { value: string[]; onChange: (v: string[]) => void; label: string }) {
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState<Array<{ value: string; label: string }>>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setOpts([]); return; }
    let alive = true;
    const h = setTimeout(async () => {
      try {
        const r = await call('searchJobs', { body: { sort: 'recommended', q: t, limit: 100, filter: {} } });
        if (!alive) return;
        const seen = new Map<string, string>();
        for (const it of r.items) if (it.job.company.toLowerCase().includes(t.toLowerCase())) seen.set(it.job.companyKey, it.job.company);
        setOpts([...seen].map(([k, n]) => ({ value: k, label: n })));
        setNames((old) => ({ ...old, ...Object.fromEntries(seen) }));
      } catch { if (alive) setOpts([]); }
    }, 250);
    return () => { alive = false; clearTimeout(h); };
  }, [q]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="jl-row jl-wrap">
        {value.map((k) => <Tag key={k} closable onClose={() => onChange(value.filter((x) => x !== k))} closeIcon={<span aria-label={`Remove ${names[k] ?? k}`}>×</span>}>{names[k] ?? k}</Tag>)}
        {!value.length && <span className="jl-muted">None</span>}
      </div>
      <Select showSearch value={null} placeholder="Search a company in your jobs" filterOption={false} onSearch={setQ} options={opts} aria-label={label}
        notFoundContent={q.length > 1 ? 'No company with that name in your jobs' : 'Type a company name'}
        onChange={(v) => { if (v && !value.includes(v)) onChange([...value, v]); setQ(''); }} />
    </div>
  );
}

export interface AllFiltersProps {
  open: boolean;
  onClose: () => void;
  filter: JobFilter;
  sort: JobSort;
  /** When set, the drawer edits this saved filter (name, sort, alert). */
  saved: SavedFilter | null;
  onApply: (f: JobFilter, sort: JobSort) => void;
  onSaved: (s: SavedFilter | null) => void;
}

export function AllFiltersDrawer({ open, onClose, filter, sort, saved, onApply, onSaved }: AllFiltersProps) {
  const [draft, setDraft] = useState<JobFilter>(filter);
  const [dsort, setDsort] = useState<JobSort>(sort);
  const [name, setName] = useState('');
  const [alert, setAlert] = useState(false);
  const [group, setGroup] = useState<Group>('basics');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setDraft(saved ? saved.filter : filter);
    setDsort(saved ? saved.sort : sort);
    setName(saved?.name ?? '');
    setAlert(saved?.alert.enabled ?? false);
    setErr(null);
  }, [open, saved, filter, sort]);
  const base = saved ? saved.filter : filter;
  const changed = !sameFilter(draft, base) || dsort !== (saved ? saved.sort : sort) || (!!saved && (name.trim() !== saved.name || alert !== saved.alert.enabled));
  const chips = useMemo(() => summaryChips(draft), [draft]);
  const set = (patch: Partial<JobFilter>) => setDraft(cleanFilter({ ...draft, ...patch }));

  const tryClose = async () => {
    if (changed && !(await confirmDiscard(['the filters']))) return;
    onClose();
  };

  const submit = async () => {
    setErr(null);
    if (saved) {
      if (!name.trim()) { setErr('Give the saved filter a name.'); return; }
      setBusy(true);
      try {
        const s = await call('updateFilter', { params: { filterId: saved.id }, body: { name: name.trim(), filter: cleanFilter(draft), sort: dsort, alert } });
        onSaved(s);
        onApply(s.filter, s.sort);
        ui.message?.success(`Saved "${s.name}".`);
        onClose();
      } catch (e) { setErr((e as { message: string }).message); } finally { setBusy(false); }
      return;
    }
    onApply(cleanFilter(draft), dsort);
    onClose();
  };

  const remove = async () => {
    if (!saved) return;
    const ok = await ui.modal?.confirm({ title: `Delete "${saved.name}"?`, content: 'The saved filter and its alert are removed. Your jobs are not changed.', okText: 'Delete', okButtonProps: { danger: true, shape: 'round' }, cancelButtonProps: { shape: 'round' } });
    if (!ok) return;
    try {
      await call('deleteFilter', { params: { filterId: saved.id } });
      onSaved(null);
      ui.message?.success('Saved filter deleted.');
      onClose();
    } catch (e) { setErr((e as { message: string }).message); }
  };

  const pane: Record<Group, ReactNode> = {
    basics: (<>
      <Box title="Job function" clear={() => set({ jobFunctions: [] })}>
        <Select mode="tags" value={draft.jobFunctions ?? []} onChange={(v) => set({ jobFunctions: v })} options={JOB_FUNCTION_SUGGESTIONS.map((x) => ({ value: x, label: x }))} placeholder="Pick or type a job function" aria-label="Job functions" />
        <details><summary style={{ cursor: 'pointer', fontWeight: 600 }}>Leave out titles with these words</summary>
          <Select mode="tags" style={{ width: '100%', marginTop: 8 }} value={draft.excludedTitles ?? []} onChange={(v) => set({ excludedTitles: v })} placeholder="For example: sales, intern" aria-label="Excluded title words" open={false} suffixIcon={null} />
        </details>
      </Box>
      <Box title="Job type" clear={() => set({ employmentTypes: [] })}>
        <Tiles options={TYPE_OPTIONS} value={draft.employmentTypes} onChange={(v) => set({ employmentTypes: v })} label="Job type" />
        <UnknownBox f={draft} k="employmentType" onChange={setDraft} />
      </Box>
      <Box title="Work model" clear={() => set({ workModels: [] })}>
        <Tiles options={MODEL_OPTIONS} value={draft.workModels} onChange={(v) => set({ workModels: v })} label="Work model" />
        <UnknownBox f={draft} k="workModel" onChange={setDraft} />
        <UnknownBox f={draft} k="remoteRegion" onChange={setDraft} />
      </Box>
      <Box title="Location" clear={() => set({ countries: [], places: [] })}>
        <Select mode="multiple" value={draft.countries ?? []} onChange={(v) => set({ countries: v })} options={COUNTRY_OPTIONS.map((c) => ({ value: c.value, label: c.label }))} placeholder="Any country" aria-label="Countries" />
        <PlacePicker places={draft.places ?? []} onChange={(places) => set({ places })} />
        <UnknownBox f={draft} k="place" onChange={setDraft} />
        <p className="jl-note">Remote jobs open to people in the chosen country count as a match.</p>
      </Box>
      <Box title="Experience level" clear={() => set({ levels: [] })}>
        <Tiles options={LEVEL_OPTIONS} value={draft.levels} onChange={(v) => set({ levels: v })} label="Experience level" />
        <UnknownBox f={draft} k="level" onChange={setDraft} />
      </Box>
      <Box title="Required experience">
        <Space><Switch checked={draft.maxYearsRequired === undefined} onChange={(v) => set({ maxYearsRequired: v ? undefined : 3 })} aria-label="Any requirement" /><span>Any requirement</span></Space>
        {draft.maxYearsRequired !== undefined && (<>
          <span>At most <strong>{draft.maxYearsRequired}</strong> years</span>
          <Slider min={0} max={15} value={draft.maxYearsRequired} onChange={(v) => set({ maxYearsRequired: v })} aria-label="Most years required" />
        </>)}
        <UnknownBox f={draft} k="years" onChange={setDraft} />
      </Box>
      <Box title="Date posted" clear={() => set({ postedWithin: undefined })}>
        <Radio.Group value={draft.postedWithin ?? 'any'} onChange={(e) => set({ postedWithin: e.target.value === 'any' ? undefined : e.target.value })}>
          <Space direction="vertical"><Radio value="any">Any time</Radio>{POSTED_OPTIONS.map((o) => <Radio key={o.value} value={o.value}>{o.label}</Radio>)}</Space>
        </Radio.Group>
        <UnknownBox f={draft} k="postedAt" onChange={setDraft} />
      </Box>
    </>),
    pay: (<>
      <Box title="Minimum yearly pay">
        <Space><Switch checked={draft.minAnnualPayUsd === undefined} onChange={(v) => set({ minAnnualPayUsd: v ? undefined : 80000 })} aria-label="Any pay" /><span>Any pay</span></Space>
        {draft.minAnnualPayUsd !== undefined && (<>
          <span>At least <strong>${Math.round(draft.minAnnualPayUsd / 1000)}K</strong> a year</span>
          <Slider min={20000} max={300000} step={5000} value={draft.minAnnualPayUsd} onChange={(v) => set({ minAnnualPayUsd: v })} aria-label="Minimum yearly pay" tooltip={{ formatter: (v) => `$${Math.round((v ?? 0) / 1000)}K` }} />
        </>)}
        <UnknownBox f={draft} k="pay" onChange={setDraft} />
        <p className="jl-note">{PAY_FILTER_NOTE}</p>
      </Box>
      <Box title="Visa sponsorship" help="Past filings are public US Department of Labor data. They show a company has sponsored H-1B workers; they do not promise sponsorship for a role.">
        <label className={`jl-choice${draft.h1bSponsorship ? ' on' : ''}`}><Checkbox checked={!!draft.h1bSponsorship} onChange={(e) => set({ h1bSponsorship: e.target.checked })} /> H-1B sponsor likely</label>
        <p className="jl-note">Shows jobs whose posting says it offers visa sponsorship, and jobs at companies with many recent certified H-1B filings (sponsorship likely). A company missing from the data is never treated as a "no".</p>
      </Box>
      <Box title="Leave out jobs with limits">
        <label className={`jl-choice${draft.excludeClearanceRequired ? ' on' : ''}`}><Checkbox checked={!!draft.excludeClearanceRequired} onChange={(e) => set({ excludeClearanceRequired: e.target.checked })} /> Security clearance required</label>
        <label className={`jl-choice${draft.excludeUsCitizenOnly ? ' on' : ''}`}><Checkbox checked={!!draft.excludeUsCitizenOnly} onChange={(e) => set({ excludeUsCitizenOnly: e.target.checked })} /> US citizens only</label>
        <p className="jl-note">Only postings that state these limits are left out.</p>
      </Box>
    </>),
    interests: (<>
      <Box title="Skill" clear={() => set({ skills: [], excludedSkills: [] })}>
        <Select mode="tags" value={draft.skills ?? []} onChange={(v) => set({ skills: v })} options={SKILL_SUGGESTIONS.map((x) => ({ value: x, label: x }))} placeholder="Jobs that name any of these skills" aria-label="Skills" />
        <span className="jl-small jl-muted">Leave out jobs that name these skills</span>
        <Select mode="tags" value={draft.excludedSkills ?? []} onChange={(v) => set({ excludedSkills: v })} options={SKILL_SUGGESTIONS.map((x) => ({ value: x, label: x }))} placeholder="Add a skill to leave out" aria-label="Excluded skills" />
      </Box>
      <Box title="Role type" clear={() => set({ roleTypes: [] })}>
        <Tiles options={[{ value: 'ic', label: 'Individual contributor' }, { value: 'manager', label: 'Manager' }]} value={draft.roleTypes} onChange={(v) => set({ roleTypes: v })} label="Role type" />
        <p className="jl-note">Uses the level the posting states: managers, directors and executives are Manager; interns to principals are Individual contributor. Jobs with no stated level, and leads, are left out while this is on.</p>
      </Box>
      <p className="jl-note">Industry is not offered: jobleft has no industry facts for these companies yet, so the filter could only match nothing.</p>
    </>),
    companies: (<>
      <Box title="Only these companies" clear={() => set({ companies: [] })}>
        <CompanyPicker value={draft.companies ?? []} onChange={(v) => set({ companies: v })} label="Add a company to include" />
      </Box>
      <Box title="Leave out these companies" clear={() => set({ excludedCompanies: [] })}>
        <CompanyPicker value={draft.excludedCompanies ?? []} onChange={(v) => set({ excludedCompanies: v })} label="Add a company to leave out" />
      </Box>
      <p className="jl-note">Company stage and staffing agency are not offered: jobleft has no such facts for these companies yet, so those filters could only match nothing.</p>
    </>),
  };

  return (
    <Drawer open={open} onClose={() => { void tryClose(); }} width="min(880px, 94vw)" closable={false} maskClosable
      styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column', minHeight: 0 } }}
      title={
        <div className="jl-row" style={{ gap: 12 }}>
          <Button shape="circle" icon={<RightOutlined />} aria-label="Close filters" onClick={() => { void tryClose(); }} />
          {saved ? (
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} aria-label="Saved filter name" style={{ fontSize: 20, fontWeight: 700, maxWidth: 360 }} variant="filled" />
          ) : <span style={{ fontSize: 20, fontWeight: 700 }}>All filters</span>}
          <span style={{ marginLeft: 'auto' }} />
          {saved && <Button type="text" danger icon={<DeleteOutlined />} onClick={() => { void remove(); }}>Delete</Button>}
          <Button className="jl-accent-btn" shape="round" disabled={!changed || busy} loading={busy} onClick={() => { void submit(); }}>{saved ? 'Save changes' : 'Apply filters'}</Button>
        </div>
      }>
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--jl-line)', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {chips.length ? chips.map((c, i) => <span key={`${c}-${i}`} className="jl-tag grey">{c}</span>) : <span className="jl-muted">No filters: every stored job can show.</span>}
        {saved && (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 12, alignItems: 'center' }}>
            <Select size="small" value={dsort} onChange={setDsort} options={SORT_OPTIONS} aria-label="Sort for this saved filter" style={{ width: 140 }} />
            <Space size={6}><Switch size="small" checked={alert} onChange={setAlert} aria-label="Alert me about new jobs" /> <span className="jl-small">Alert me about new jobs</span></Space>
          </span>
        )}
      </div>
      {err && <div role="alert" style={{ padding: '8px 16px', background: 'var(--jl-error-tint)', color: '#6E1016' }}>{err}</div>}
      <div className="jl-af" style={{ flex: 1, minHeight: 0 }}>
        <nav className="jl-af-menu" aria-label="Filter groups">
          {GROUPS.map((g) => (
            <button key={g.id} type="button" aria-current={group === g.id} onClick={() => setGroup(g.id)}>
              <div className="t">{g.t}</div><div className="s">{g.s}</div>
            </button>
          ))}
          <div className="jl-note" style={{ marginTop: 12, background: 'var(--jl-accent-tint)', borderStyle: 'solid', borderColor: 'transparent' }}>
            <strong>Looking at a few companies?</strong> Use the Companies group to pick them.
          </div>
        </nav>
        <div className="jl-af-pane" aria-label={GROUPS.find((g) => g.id === group)!.t}>{pane[group]}</div>
      </div>
    </Drawer>
  );
}
