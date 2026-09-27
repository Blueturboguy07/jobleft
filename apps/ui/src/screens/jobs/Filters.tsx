// The filter bar of the feed: one popover per filter, the sort control, and the entry to All filters.
// Every filter that reads a fact some jobs do not state says how it treats those jobs, and offers to include them.
// Active filters have a green fill; inactive ones are white.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Checkbox, Input, Popover, Radio, Select, Slider, Switch, Space } from 'antd';
import { Tooltip } from '../../components/Tip.tsx';
import { DownOutlined, QuestionCircleOutlined, CloseOutlined, FilterOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import type { JobFilter, JobSort, PlaceQuery } from '@jobleft/contracts';
import {
  COUNTRY_OPTIONS, JOB_FUNCTION_SUGGESTIONS, LEVEL_OPTIONS, MODEL_OPTIONS, POSTED_OPTIONS, SORT_OPTIONS, TYPE_OPTIONS, activeCount, applySection, cleanFilter,
  countryLabel, functionLabel, industryLabel, levelLabel, modelLabel, payLabel, postedLabel, resetSection, sameFilter, toggle, typeLabel, withUnknown, yearsLabel,
  type FilterSection,
} from '../../lib/filters.ts';
import { call } from '../../app/api.ts';

export const INDUSTRY_SUGGESTIONS = [
  'Software', 'Information Technology', 'Artificial Intelligence (AI)', 'Health Care', 'Hospitals', 'Financial Services', 'Banking', 'Insurance',
  'FinTech', 'Retail', 'E-Commerce', 'Logistics', 'Transportation', 'Energy', 'Renewable Energy', 'Education', 'EdTech', 'Media and Entertainment',
  'Advertising', 'Robotics', 'Manufacturing', 'Hardware', 'Staffing and Recruiting', 'SaaS', 'Cloud Computing', 'Developer Tools',
];
export const SKILL_SUGGESTIONS = [
  'TypeScript', 'JavaScript', 'Python', 'Go', 'Java', 'SQL', 'PostgreSQL', 'React', 'Node.js', 'AWS', 'Docker', 'Kubernetes', 'GraphQL', 'Terraform',
  'C++', 'C#', '.NET', 'Rust', 'Swift', 'Kotlin', 'Spark', 'Airflow', 'dbt', 'Tableau', 'Excel', 'Figma', 'Salesforce', 'HubSpot', 'Epic', 'BLS',
  'ACLS', 'GAAP', 'NetSuite', 'QuickBooks', 'SAP', 'SEO', 'Google Analytics', 'Machine Learning', 'PyTorch', 'Statistics', 'A/B Testing',
];

export const UNKNOWN_TEXT = {
  place: 'Include jobs that do not state a place',
  workModel: 'Include jobs that do not say onsite, hybrid or remote',
  employmentType: 'Include jobs that do not state a job type',
  level: 'Include jobs that do not state a level',
  years: 'Include jobs that do not state years of experience',
  postedAt: 'Include jobs with no posted date',
  pay: 'Include jobs with no pay listed',
  remoteRegion: 'Include remote jobs that do not say where you may work from',
} as const;

export function UnknownBox({ f, k, onChange }: { f: JobFilter; k: keyof typeof UNKNOWN_TEXT; onChange: (f: JobFilter) => void }) {
  const on = (f.includeUnknown ?? []).includes(k);
  return <Checkbox checked={on} onChange={(e) => onChange(withUnknown(f, k, e.target.checked))}>{UNKNOWN_TEXT[k]}</Checkbox>;
}

/** Place search with the local place lookup; the radius applies to the chosen city. */
export function PlacePicker({ places, onChange }: { places: PlaceQuery[]; onChange: (p: PlaceQuery[]) => void }) {
  const [text, setText] = useState('');
  const [opts, setOpts] = useState<Array<{ value: string; label: string; placeId: string }>>([]);
  useEffect(() => {
    const t = text.trim();
    if (t.length < 2) { setOpts([]); return; }
    let alive = true;
    const h = setTimeout(async () => {
      try {
        const r = await call('placeLookup', { query: { text: t } });
        if (!alive) return;
        const all = [...r.places, ...r.ambiguous].filter((p) => p.placeId);
        setOpts(all.map((p) => ({ value: p.placeId!, label: p.text, placeId: p.placeId! })));
      } catch { if (alive) setOpts([]); }
    }, 200);
    return () => { alive = false; clearTimeout(h); };
  }, [text]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {places.map((p, i) => (
        <div className="jl-row" key={`${p.placeId ?? p.text}-${i}`}>
          <span className="jl-grow">{p.text}</span>
          <Select size="small" style={{ width: 110 }} aria-label={`Distance from ${p.text}`} value={p.radiusMiles ?? 0}
            options={[{ value: 0, label: 'This city' }, { value: 10, label: '10 miles' }, { value: 25, label: '25 miles' }, { value: 50, label: '50 miles' }, { value: 100, label: '100 miles' }]}
            onChange={(v) => onChange(places.map((x, j) => (j === i ? { ...x, radiusMiles: v || null } : x)))} />
          <Button size="small" type="text" icon={<CloseOutlined />} aria-label={`Remove ${p.text}`} onClick={() => onChange(places.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Select showSearch value={null} placeholder="Add a city" filterOption={false} onSearch={setText} notFoundContent={text.length > 1 ? 'No city found' : 'Type a city name'}
        options={opts} aria-label="Add a city"
        onChange={(v) => { const o = opts.find((x) => x.value === v); if (o) onChange([...places, { text: o.label, placeId: o.placeId, radiusMiles: 25 }]); setText(''); }} />
    </div>
  );
}

function Pop({ title, children, onApply, onReset, dirty }: { title: string; children: ReactNode; onApply: () => void; onReset: () => void; dirty: boolean }) {
  return (
    <div className="jl-pop" role="dialog" aria-label={title}>
      <h3>{title}</h3>
      {children}
      <div className="jl-pop-foot">
        <Button type="text" onClick={onReset}>Reset</Button>
        <Button type="primary" shape="round" onClick={onApply} disabled={!dirty}>Apply</Button>
      </div>
    </div>
  );
}

type Section = FilterSection;

function sectionActive(f: JobFilter, s: Section): boolean {
  switch (s) {
    case 'location': return !!(f.countries?.length || f.places?.length);
    case 'function': return !!f.jobFunctions?.length;
    case 'level': return !!f.levels?.length;
    case 'type': return !!f.employmentTypes?.length;
    case 'model': return !!f.workModels?.length;
    case 'posted': return !!f.postedWithin;
    case 'industry': return !!f.industries?.length;
    case 'years': return f.maxYearsRequired !== undefined;
    case 'pay': return f.minAnnualPayUsd !== undefined;
  }
}

function FilterButton({ section, label, filter, onApply }: { section: Section; label: string; filter: JobFilter; onApply: (f: JobFilter) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraftState] = useState<JobFilter>(filter);
  // The latest filter and draft, read at the moment of Apply (a popup can still hold the handlers of an older render).
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const draftRef = useRef(draft);
  const setDraft = (next: JobFilter | ((d: JobFilter) => JobFilter)) => {
    const v = typeof next === 'function' ? next(draftRef.current) : next;
    draftRef.current = v;
    setDraftState(v);
  };
  // The draft starts from the filter in use each time the popover opens (in the same event, so the first click inside
  // it already edits the current filter).
  const onOpenChange = (o: boolean) => { if (o) setDraft(filter); setOpen(o); };
  const active = sectionActive(filter, section);
  const dirty = !sameFilter(applySection(filter, draft, section), filter);
  // Apply changes only this popover's fields; every other filter stays as it is now (JL-feed-1).
  const apply = () => { onApply(applySection(filterRef.current, draftRef.current, section)); setOpen(false); };
  const reset = () => setDraft((d) => resetSection(d, section));
  const set = (patch: Partial<JobFilter>) => setDraft((d) => cleanFilter({ ...d, ...patch }));

  let body: ReactNode = null;
  let title = '';
  switch (section) {
    case 'location':
      title = 'Location';
      body = (<>
        <Radio.Group value={draft.countries?.[0] ?? 'any'} onChange={(e) => set({ countries: e.target.value === 'any' ? [] : [e.target.value] })} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Radio value="any">Any country</Radio>
          {COUNTRY_OPTIONS.map((c) => <Radio key={c.value} value={c.value}>{c.label}</Radio>)}
        </Radio.Group>
        <strong style={{ fontSize: 13 }}>Near a city</strong>
        <PlacePicker places={draft.places ?? []} onChange={(places) => set({ places })} />
        <UnknownBox f={draft} k="place" onChange={setDraft} />
        <p className="jl-note">Remote jobs open to people in the chosen country count as a match.</p>
      </>);
      break;
    case 'function':
      title = 'Job function';
      body = (<>
        <Select mode="tags" value={draft.jobFunctions ?? []} onChange={(v) => set({ jobFunctions: v })} options={JOB_FUNCTION_SUGGESTIONS.map((x) => ({ value: x, label: x }))}
          placeholder="Pick or type a job function" aria-label="Job functions" style={{ width: '100%' }} />
        <p className="jl-note">A job matches when its field is one of these, or its title contains the words you type.</p>
      </>);
      break;
    case 'level':
      title = 'Experience level';
      body = (<>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {LEVEL_OPTIONS.map((o) => <Checkbox key={o.value} checked={(draft.levels ?? []).includes(o.value)} onChange={() => set({ levels: toggle(draft.levels, o.value) })}>{o.label}</Checkbox>)}
        </div>
        <UnknownBox f={draft} k="level" onChange={setDraft} />
      </>);
      break;
    case 'type':
      title = 'Job type';
      body = (<>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {TYPE_OPTIONS.map((o) => <Checkbox key={o.value} checked={(draft.employmentTypes ?? []).includes(o.value)} onChange={() => set({ employmentTypes: toggle(draft.employmentTypes, o.value) })}>{o.label}</Checkbox>)}
        </div>
        <UnknownBox f={draft} k="employmentType" onChange={setDraft} />
      </>);
      break;
    case 'model':
      title = 'Work model';
      body = (<>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {MODEL_OPTIONS.map((o) => <Checkbox key={o.value} checked={(draft.workModels ?? []).includes(o.value)} onChange={() => set({ workModels: toggle(draft.workModels, o.value) })}>{o.label}</Checkbox>)}
        </div>
        <UnknownBox f={draft} k="workModel" onChange={setDraft} />
      </>);
      break;
    case 'posted':
      title = 'Date posted';
      body = (<>
        <Radio.Group value={draft.postedWithin ?? 'any'} onChange={(e) => set({ postedWithin: e.target.value === 'any' ? undefined : e.target.value })} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Radio value="any">Any time</Radio>
          {POSTED_OPTIONS.map((o) => <Radio key={o.value} value={o.value}>{o.label}</Radio>)}
        </Radio.Group>
        <UnknownBox f={draft} k="postedAt" onChange={setDraft} />
        <p className="jl-note">Uses the date the employer posted the job, not the date jobleft found it.</p>
      </>);
      break;
    case 'industry':
      title = 'Industry';
      body = (<>
        <Select mode="tags" value={draft.industries ?? []} onChange={(v) => set({ industries: v })} options={INDUSTRY_SUGGESTIONS.map((x) => ({ value: x, label: x }))}
          placeholder="Add an industry" aria-label="Industries" style={{ width: '100%' }} />
        <p className="jl-note">Uses the company facts jobleft has. Jobs at companies whose industry is unknown are left out while this filter is on.</p>
      </>);
      break;
    case 'years': {
      title = 'Required experience';
      const any = draft.maxYearsRequired === undefined;
      body = (<>
        <Space><Switch checked={any} onChange={(v) => set({ maxYearsRequired: v ? undefined : 3 })} aria-label="Any requirement" /> <span>Any requirement</span></Space>
        {!any && (<>
          <span>Jobs that ask for at most <strong>{draft.maxYearsRequired}</strong> {draft.maxYearsRequired === 1 ? 'year' : 'years'}</span>
          <Slider min={0} max={15} value={draft.maxYearsRequired} onChange={(v) => set({ maxYearsRequired: v })} aria-label="Most years required" />
        </>)}
        <UnknownBox f={draft} k="years" onChange={setDraft} />
      </>);
      break;
    }
    case 'pay': {
      title = 'Minimum yearly pay';
      const any = draft.minAnnualPayUsd === undefined;
      body = (<>
        <Space><Switch checked={any} onChange={(v) => set({ minAnnualPayUsd: v ? undefined : 80000 })} aria-label="Any pay" /> <span>Any pay</span></Space>
        {!any && (<>
          <span>At least <strong>${Math.round(draft.minAnnualPayUsd! / 1000)}K</strong> a year</span>
          <Slider min={20000} max={300000} step={5000} value={draft.minAnnualPayUsd} onChange={(v) => set({ minAnnualPayUsd: v })} aria-label="Minimum yearly pay in dollars" tooltip={{ formatter: (v) => `$${Math.round((v ?? 0) / 1000)}K` }} />
        </>)}
        <UnknownBox f={draft} k="pay" onChange={setDraft} />
        <p className="jl-note">Jobs with no stated pay are left out unless you tick the box above. Hourly pay counts as its yearly amount (2,080 hours). Pay in other currencies is not compared.</p>
      </>);
      break;
    }
  }
  return (
    <Popover open={open} onOpenChange={onOpenChange} trigger="click" placement="bottomLeft" arrow={false} destroyTooltipOnHide
      content={<Pop title={title} onApply={apply} onReset={reset} dirty={dirty}>{body}</Pop>}>
      <Button className={`jl-filter-btn${active ? ' active' : ''}`} aria-expanded={open} aria-haspopup="dialog" aria-label={`${title} filter: ${active ? label : 'off'}`}>
        {label} <DownOutlined style={{ fontSize: 10 }} />
      </Button>
    </Popover>
  );
}

export function SortControl({ sort, onChange, needsProfile }: { sort: JobSort; onChange: (s: JobSort) => void; needsProfile: boolean }) {
  return (
    <Space size={4}>
      <Tooltip title={<div><b>Recommended</b>: a mix of your match, how complete the posting is, and how new it is. The order stays the same when you reload.<br /><b>Top matched</b>: highest match score first{needsProfile ? ' (needs your profile)' : ''}.<br /><b>Most recent</b>: newest posted date first; jobs with no posted date come last.</div>}>
        <Button type="text" shape="circle" icon={<QuestionCircleOutlined />} aria-label="How sorting works" />
      </Tooltip>
      <Select value={sort} onChange={onChange} options={SORT_OPTIONS} style={{ width: 150 }} aria-label="Sort jobs" popupMatchSelectWidth={false} />
    </Space>
  );
}

export interface FilterBarProps {
  filter: JobFilter;
  sort: JobSort;
  onFilter: (f: JobFilter) => void;
  onSort: (s: JobSort) => void;
  onAllFilters: () => void;
  hiddenCount: number;
  onHidden: () => void;
  needsProfile: boolean;
  extra?: ReactNode;
}

export function FilterBar({ filter, sort, onFilter, onSort, onAllFilters, hiddenCount, onHidden, needsProfile, extra }: FilterBarProps) {
  const n = useMemo(() => activeCount(filter), [filter]);
  return (
    <div className="jl-filterbar" role="search" aria-label="Job filters">
      <div className="jl-filter-row">
        <FilterButton section="location" label={countryLabel(filter)} filter={filter} onApply={onFilter} />
        <FilterButton section="function" label={functionLabel(filter)} filter={filter} onApply={onFilter} />
        <FilterButton section="level" label={levelLabel(filter)} filter={filter} onApply={onFilter} />
        <FilterButton section="type" label={typeLabel(filter)} filter={filter} onApply={onFilter} />
        <FilterButton section="model" label={modelLabel(filter)} filter={filter} onApply={onFilter} />
        <FilterButton section="posted" label={postedLabel(filter)} filter={filter} onApply={onFilter} />
        <FilterButton section="industry" label={industryLabel(filter)} filter={filter} onApply={onFilter} />
        <span style={{ marginLeft: 'auto' }} />
        <SortControl sort={sort} onChange={onSort} needsProfile={needsProfile} />
      </div>
      <div className="jl-filter-row">
        <FilterButton section="years" label={yearsLabel(filter)} filter={filter} onApply={onFilter} />
        <FilterButton section="pay" label={payLabel(filter)} filter={filter} onApply={onFilter} />
        <Tooltip title="Shows jobs whose posting offers visa sponsorship, or whose company filed many H-1B petitions in recent US Department of Labor data (sponsorship likely, not promised).">
          <Button className={`jl-filter-btn${filter.h1bSponsorship ? ' active' : ''}`} icon={<SafetyCertificateOutlined />} aria-pressed={!!filter.h1bSponsorship}
            onClick={() => onFilter(cleanFilter({ ...filter, h1bSponsorship: !filter.h1bSponsorship }))}>H-1B sponsor likely</Button>
        </Tooltip>
        <Button className="jl-filter-btn" onClick={onHidden} aria-label={`Hidden jobs: ${hiddenCount}`}>Hidden jobs <span className="jl-pill light" style={{ marginLeft: 4 }}>{hiddenCount}</span></Button>
        <Button className="jl-filter-btn" style={{ background: 'var(--jl-accent)', boxShadow: 'none', fontWeight: 600 }} icon={<FilterOutlined />} onClick={onAllFilters}>
          All filters{n > 0 && <span className="jl-pill" style={{ marginLeft: 4 }}>{n}</span>}
        </Button>
        {n > 0 && <Button type="link" onClick={() => onFilter({})}>Clear all</Button>}
        {extra}
      </div>
    </div>
  );
}

export { Input };
