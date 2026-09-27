// The profile: your own facts (the only source for match scores, resumes and autofill), your job preferences,
// work authorization and equal-employment answers. Each block is edited in a drawer; closing it with unsaved
// changes asks first, and a failed save keeps what you typed and says so.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Checkbox, Drawer, Input, InputNumber, Segmented, Select, Space, Tag } from 'antd';
import { EditOutlined, PlusOutlined, DeleteOutlined, ArrowUpOutlined, LockOutlined } from '@ant-design/icons';
import type { EducationEntry, Profile, ProfileInput, WorkEntry } from '@jobleft/contracts';
import { EXPERIENCE_LEVEL_LABELS } from '@jobleft/contracts';
import { call, type UiError } from '../app/api.ts';
import { invalidate, setCached } from '../app/data.ts';
import { confirmDiscard, ui, useDirty } from '../app/layers.ts';
import { navigate } from '../app/router.ts';
import { displayName, useProfile } from '../app/session.ts';
import { ConflictNotice, ErrorState, InlineError, Loading } from '../components/States.tsx';
import { COUNTRY_OPTIONS, JOB_FUNCTION_SUGGESTIONS, LEVEL_OPTIONS, MODEL_OPTIONS, STAGE_OPTIONS, TYPE_OPTIONS } from '../lib/filters.ts';
import { countrySort } from '../lib/countries.ts';
import { typeText, yearMonthText } from '../lib/format.ts';
import { INDUSTRY_SUGGESTIONS, PlacePicker, SKILL_SUGGESTIONS } from './jobs/Filters.tsx';
import { AddResumeModal } from './Resume.tsx';
import { toInput } from '../lib/onboarding.ts';

type Block = 'personal' | 'prefs' | 'education' | 'work' | 'skills' | 'auth' | 'eeo';
const BLOCKS: Array<{ id: Block; label: string }> = [
  { id: 'personal', label: 'Personal' }, { id: 'prefs', label: 'Job preferences' }, { id: 'education', label: 'Education' }, { id: 'work', label: 'Work experience' },
  { id: 'skills', label: 'Skills' }, { id: 'auth', label: 'Work authorization' }, { id: 'eeo', label: 'Equal employment' },
];

export { toInput };

let seq = 0;
const nid = (p: string) => `${p}${Date.now().toString(36)}${++seq}`;

export function YesNo({ value, onChange, decline = false, label }: { value: string | null; onChange: (v: never) => void; decline?: boolean; label: string }) {
  const opts = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }, ...(decline ? [{ value: 'decline', label: 'Decline to state' }] : []), { value: 'unset', label: 'Not answered' }];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontWeight: 600 }}>{label}</span>
      <Segmented value={value ?? 'unset'} options={opts} onChange={(v) => onChange((v === 'unset' ? null : v) as never)} aria-label={label} />
    </div>
  );
}

function Field({ label, children, required }: { label: string; children: ReactNode; required?: boolean }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 220px' }}>
      <span style={{ fontWeight: 600, fontSize: 13 }}>{label}{required && <span style={{ color: 'var(--jl-error)' }}> *</span>}</span>
      {children}
    </label>
  );
}

const Row = ({ children }: { children: ReactNode }) => <div className="jl-row jl-wrap" style={{ gap: 12, alignItems: 'flex-start' }}>{children}</div>;

function EditDrawer({ block, profile, onClose }: { block: Block | null; profile: Profile; onClose: () => void }) {
  const [d, setD] = useState<ProfileInput>(() => toInput(profile));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<UiError | null>(null);
  const [newer, setNewer] = useState<Profile | null>(null);
  const openedVersion = useRef(profile.version);
  useEffect(() => { if (block) { setD(toInput(profile)); setErr(null); setNewer(null); openedVersion.current = profile.version; } }, [block]);
  const base = useMemo(() => JSON.stringify(toInput(profile)), [profile]);
  const dirty = !!block && JSON.stringify(d) !== base;
  useDirty('profile-drawer', dirty, 'your profile');
  const close = async () => { if (await confirmDiscard(dirty ? ['your profile'] : [])) onClose(); };
  const save = async (overwrite = false) => {
    setBusy(true); setErr(null);
    try {
      // another window may have saved the profile since this drawer opened: ask before overwriting it
      if (!overwrite) {
        const latest = await call('getProfile');
        if (latest.version !== openedVersion.current) { setNewer(latest); return; }
      }
      const p = await call('putProfile', { body: d });
      setCached('profile', () => p);
      invalidate('jobs:', 'job:', 'match:', 'dashboard');
      ui.message?.success('Profile saved.');
      onClose();
    } catch (e) { setErr(e as UiError); } finally { setBusy(false); }
  };
  const p = d.personal;
  const setP = (patch: Partial<ProfileInput['personal']>) => setD({ ...d, personal: { ...p, ...patch } });
  const pr = d.preferences;
  const setPr = (patch: Partial<ProfileInput['preferences']>) => setD({ ...d, preferences: { ...pr, ...patch } });
  const wa = d.workAuthorization;
  const setWa = (patch: Partial<ProfileInput['workAuthorization']>) => setD({ ...d, workAuthorization: { ...wa, ...patch } });
  const eeo = d.eeo;
  const setEeo = (patch: Partial<ProfileInput['eeo']>) => setD({ ...d, eeo: { ...eeo, ...patch } });
  const setWork = (i: number, w: WorkEntry) => setD({ ...d, work: d.work.map((x, j) => (j === i ? w : x)) });
  const setEdu = (i: number, e: EducationEntry) => setD({ ...d, education: d.education.map((x, j) => (j === i ? e : x)) });

  let body: ReactNode = null;
  switch (block) {
    case 'personal':
      body = (<Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Row><Field label="First name"><Input value={p.firstName ?? ''} onChange={(e) => setP({ firstName: e.target.value || null })} /></Field><Field label="Middle name"><Input value={p.middleName ?? ''} onChange={(e) => setP({ middleName: e.target.value || null })} /></Field><Field label="Last name"><Input value={p.lastName ?? ''} onChange={(e) => setP({ lastName: e.target.value || null })} /></Field></Row>
        <Row><Field label="Email"><Input type="email" value={p.email ?? ''} onChange={(e) => setP({ email: e.target.value || null })} /></Field><Field label="Phone"><Input value={p.phone ?? ''} onChange={(e) => setP({ phone: e.target.value || null })} /></Field></Row>
        <Row><Field label="Street address"><Input value={p.addressLine ?? ''} onChange={(e) => setP({ addressLine: e.target.value || null })} /></Field></Row>
        <Row><Field label="City"><Input value={p.city ?? ''} onChange={(e) => setP({ city: e.target.value || null })} /></Field><Field label="State or region"><Input value={p.region ?? ''} onChange={(e) => setP({ region: e.target.value || null })} /></Field><Field label="Postal code"><Input value={p.postalCode ?? ''} onChange={(e) => setP({ postalCode: e.target.value || null })} /></Field></Row>
        <Field label="Country"><Select allowClear showSearch optionFilterProp="label" filterSort={countrySort} value={p.country ?? undefined} onChange={(v) => setP({ country: (v ?? null) as never })} options={COUNTRY_OPTIONS.map((c) => ({ value: c.value, label: c.label }))} placeholder="Choose a country" /></Field>
        <span style={{ fontWeight: 600 }}>Links</span>
        {p.links.map((l, i) => (
          <Row key={i}>
            <Input style={{ width: 160 }} value={l.label} onChange={(e) => setP({ links: p.links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} placeholder="Label" aria-label="Link label" />
            <Input style={{ flex: 1 }} value={l.url} onChange={(e) => setP({ links: p.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} placeholder="https://" aria-label="Link address" status={l.url && !/^https?:\/\//.test(l.url) ? 'error' : undefined} />
            <Button type="text" icon={<DeleteOutlined />} aria-label="Remove link" onClick={() => setP({ links: p.links.filter((_, j) => j !== i) })} />
          </Row>
        ))}
        <Button type="dashed" icon={<PlusOutlined />} onClick={() => setP({ links: [...p.links, { label: 'Portfolio', url: 'https://' }] })}>Add a link</Button>
        <Field label="Summary"><Input.TextArea value={d.summary ?? ''} autoSize={{ minRows: 2 }} onChange={(e) => setD({ ...d, summary: e.target.value || null })} /></Field>
      </Space>);
      break;
    case 'prefs':
      body = (<Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Field label="Job functions"><Select mode="tags" value={pr.jobFunctions} onChange={(v) => setPr({ jobFunctions: v })} options={JOB_FUNCTION_SUGGESTIONS.map((x) => ({ value: x, label: x }))} /></Field>
        <Field label="Target job titles"><Select mode="tags" value={pr.targetTitles} onChange={(v) => setPr({ targetTitles: v })} open={false} suffixIcon={null} placeholder="Type a title and press Enter" /></Field>
        <Field label="Job types"><Checkbox.Group value={pr.employmentTypes} onChange={(v) => setPr({ employmentTypes: v as never })} options={TYPE_OPTIONS} /></Field>
        <Field label="Work models"><Checkbox.Group value={pr.workModels} onChange={(v) => setPr({ workModels: v as never })} options={MODEL_OPTIONS} /></Field>
        <Field label="Experience levels"><Checkbox.Group value={pr.levels} onChange={(v) => setPr({ levels: v as never })} options={LEVEL_OPTIONS} /></Field>
        <Field label="Countries"><Select mode="multiple" optionFilterProp="label" filterSort={countrySort} value={pr.countries} onChange={(v) => setPr({ countries: v })} options={COUNTRY_OPTIONS.map((c) => ({ value: c.value, label: c.label }))} /></Field>
        <Field label="Cities"><PlacePicker places={pr.places} onChange={(places) => setPr({ places })} /></Field>
        <Field label="Minimum yearly pay (US dollars)"><InputNumber min={0} step={5000} style={{ width: 200 }} value={pr.minAnnualPayUsd ?? undefined} onChange={(v) => setPr({ minAnnualPayUsd: v ?? null })} placeholder="Not set" /></Field>
        <Field label="Industries"><Select mode="tags" value={pr.industries} onChange={(v) => setPr({ industries: v })} options={INDUSTRY_SUGGESTIONS.map((x) => ({ value: x, label: x }))} /></Field>
        <Field label="Company stages"><Checkbox.Group value={pr.companyStages} onChange={(v) => setPr({ companyStages: v as never })} options={STAGE_OPTIONS} /></Field>
        <Field label="Role types"><Checkbox.Group value={pr.roleTypes} onChange={(v) => setPr({ roleTypes: v as never })} options={[{ value: 'ic', label: 'Individual contributor' }, { value: 'manager', label: 'Manager' }]} /></Field>
        <p className="jl-note">Your preferences set the starting filters of your feed and feed the match score.</p>
      </Space>);
      break;
    case 'education':
      body = (<Space direction="vertical" size={12} style={{ width: '100%' }}>
        {d.education.map((e, i) => (
          <div key={e.id} className="jl-factbox" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="jl-row"><strong className="jl-grow">School {i + 1}</strong><Button type="text" icon={<DeleteOutlined />} aria-label={`Remove school ${i + 1}`} onClick={() => setD({ ...d, education: d.education.filter((_, j) => j !== i) })} /></div>
            <Row><Field label="School"><Input value={e.school} onChange={(x) => setEdu(i, { ...e, school: x.target.value })} /></Field><Field label="Degree"><Input value={e.degree ?? ''} onChange={(x) => setEdu(i, { ...e, degree: x.target.value || null })} /></Field></Row>
            <Row><Field label="Major"><Input value={e.major ?? ''} onChange={(x) => setEdu(i, { ...e, major: x.target.value || null })} /></Field><Field label="GPA"><Input value={e.gpa ?? ''} onChange={(x) => setEdu(i, { ...e, gpa: x.target.value || null })} /></Field></Row>
            <Row><Field label="Start"><Input type="month" value={e.startDate?.length === 7 ? e.startDate : ''} onChange={(x) => setEdu(i, { ...e, startDate: x.target.value || null })} /></Field><Field label="End"><Input type="month" disabled={e.current} value={e.endDate?.length === 7 ? e.endDate : ''} onChange={(x) => setEdu(i, { ...e, endDate: x.target.value || null })} /></Field></Row>
            <Checkbox checked={e.current} onChange={(x) => setEdu(i, { ...e, current: x.target.checked, endDate: x.target.checked ? null : e.endDate })}>I study here now</Checkbox>
          </div>
        ))}
        <Button type="dashed" icon={<PlusOutlined />} onClick={() => setD({ ...d, education: [...d.education, { id: nid('e'), school: '', degree: null, major: null, gpa: null, startDate: null, endDate: null, current: false, achievements: [], coursework: [] }] })}>Add a school</Button>
      </Space>);
      break;
    case 'work':
      body = (<Space direction="vertical" size={12} style={{ width: '100%' }}>
        {d.work.map((w, i) => (
          <div key={w.id} className="jl-factbox" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="jl-row"><strong className="jl-grow">Job {i + 1}</strong>
              <Button type="text" icon={<ArrowUpOutlined />} disabled={i === 0} aria-label={`Move job ${i + 1} up`} onClick={() => { const a = [...d.work]; [a[i - 1], a[i]] = [a[i]!, a[i - 1]!]; setD({ ...d, work: a }); }} />
              <Button type="text" icon={<DeleteOutlined />} aria-label={`Remove job ${i + 1}`} onClick={() => setD({ ...d, work: d.work.filter((_, j) => j !== i) })} />
            </div>
            <Row><Field label="Job title"><Input value={w.title} onChange={(x) => setWork(i, { ...w, title: x.target.value })} /></Field><Field label="Company"><Input value={w.company} onChange={(x) => setWork(i, { ...w, company: x.target.value })} /></Field></Row>
            <Row><Field label="Job type"><Select allowClear value={w.employmentType ?? undefined} onChange={(v) => setWork(i, { ...w, employmentType: v ?? null })} options={TYPE_OPTIONS} /></Field><Field label="Location"><Input value={w.location ?? ''} onChange={(x) => setWork(i, { ...w, location: x.target.value || null })} /></Field></Row>
            <Row><Field label="Start"><Input type="month" value={w.startDate?.length === 7 ? w.startDate : ''} onChange={(x) => setWork(i, { ...w, startDate: x.target.value || null })} /></Field><Field label="End"><Input type="month" disabled={w.current} value={w.endDate?.length === 7 ? w.endDate : ''} onChange={(x) => setWork(i, { ...w, endDate: x.target.value || null })} /></Field></Row>
            <Checkbox checked={w.current} onChange={(x) => setWork(i, { ...w, current: x.target.checked, endDate: x.target.checked ? null : w.endDate })}>I work here now</Checkbox>
            <span style={{ fontWeight: 600, fontSize: 13 }}>What you did</span>
            {w.bullets.map((b, k) => (
              <div className="jl-row" key={k}>
                <Input.TextArea value={b} autoSize={{ minRows: 1, maxRows: 4 }} onChange={(x) => setWork(i, { ...w, bullets: w.bullets.map((y, m) => (m === k ? x.target.value : y)) })} aria-label={`Bullet ${k + 1}`} />
                <Button type="text" icon={<DeleteOutlined />} aria-label="Remove bullet" onClick={() => setWork(i, { ...w, bullets: w.bullets.filter((_, m) => m !== k) })} />
              </div>
            ))}
            <Button type="dashed" size="small" icon={<PlusOutlined />} style={{ alignSelf: 'flex-start' }} onClick={() => setWork(i, { ...w, bullets: [...w.bullets, ''] })}>Add a bullet</Button>
          </div>
        ))}
        <Button type="dashed" icon={<PlusOutlined />} onClick={() => setD({ ...d, work: [{ id: nid('w'), company: '', title: '', employmentType: null, location: null, startDate: null, endDate: null, current: false, summary: null, bullets: [] }, ...d.work] })}>Add a job</Button>
      </Space>);
      break;
    case 'skills':
      body = (<Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Field label="Skills"><Select mode="tags" value={d.skills.map((s) => s.name)} options={SKILL_SUGGESTIONS.map((x) => ({ value: x, label: x }))}
          onChange={(names: string[]) => setD({ ...d, skills: names.map((n) => d.skills.find((s) => s.name === n) ?? { name: n, years: null, source: 'user' as const }) })} /></Field>
        {d.skills.map((s, i) => (
          <div key={s.name} className="jl-row"><span className="jl-grow">{s.name}</span>
            <InputNumber min={0} max={60} step={0.5} value={s.years ?? undefined} placeholder="Years" aria-label={`Years of ${s.name}`} onChange={(v) => setD({ ...d, skills: d.skills.map((x, j) => (j === i ? { ...x, years: v ?? null, source: 'user' } : x)) })} />
          </div>
        ))}
      </Space>);
      break;
    case 'auth':
      body = (<Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Alert type="info" showIcon icon={<LockOutlined />} message="These answers stay on this Mac. They are never sent to an AI provider. jobleft uses them to warn you when a posting has a limit you do not meet." />
        <YesNo label="Are you legally allowed to work in the US?" value={wa.usAuthorized} onChange={(v) => setWa({ usAuthorized: v })} />
        <YesNo label="Will you need visa sponsorship now or later?" value={wa.needsSponsorship} onChange={(v) => setWa({ needsSponsorship: v })} />
        <YesNo label="Are you a US citizen?" value={wa.usCitizen} onChange={(v) => setWa({ usCitizen: v })} />
        <YesNo label="Do you hold a security clearance?" value={wa.hasSecurityClearance} onChange={(v) => setWa({ hasSecurityClearance: v })} />
        <Field label="Other countries where you may work"><Select mode="multiple" optionFilterProp="label" filterSort={countrySort} value={wa.authorizedCountries} onChange={(v) => setWa({ authorizedCountries: v })} options={COUNTRY_OPTIONS.map((c) => ({ value: c.value, label: c.label }))} /></Field>
      </Space>);
      break;
    case 'eeo':
      body = (<Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Alert type="info" showIcon icon={<LockOutlined />} message="Optional. Used only to fill the equal-employment questions of an application form, when you review it yourself. Never sent to an AI provider and never used in match scores." />
        <YesNo decline label="Do you have a disability?" value={eeo.disability} onChange={(v) => setEeo({ disability: v })} />
        <YesNo decline label="Are you a veteran?" value={eeo.veteran} onChange={(v) => setEeo({ veteran: v })} />
        <Field label="Gender"><Select allowClear value={eeo.gender ?? undefined} onChange={(v) => setEeo({ gender: v ?? null })} options={['Woman', 'Man', 'Non-binary', 'Decline to state'].map((x) => ({ value: x, label: x }))} placeholder="Not answered" /></Field>
        <YesNo decline label="Do you identify as LGBTQ+?" value={eeo.lgbtq} onChange={(v) => setEeo({ lgbtq: v })} />
        <Field label="Race"><Select allowClear value={eeo.race ?? undefined} onChange={(v) => setEeo({ race: v ?? null })} placeholder="Not answered"
          options={['American Indian or Alaska Native', 'Asian', 'Black or African American', 'Native Hawaiian or Other Pacific Islander', 'White', 'Two or more races', 'Decline to state'].map((x) => ({ value: x, label: x }))} /></Field>
        <YesNo decline label="Are you Hispanic or Latino?" value={eeo.hispanicOrLatino} onChange={(v) => setEeo({ hispanicOrLatino: v })} />
        <Field label="Sexual orientation (choose any)"><Select mode="multiple" value={eeo.sexualOrientation} onChange={(v) => setEeo({ sexualOrientation: v })} options={['Heterosexual', 'Gay', 'Lesbian', 'Bisexual', 'Queer', 'Asexual', 'Decline to state'].map((x) => ({ value: x, label: x }))} placeholder="Not answered" /></Field>
        <Field label="Pronouns"><Select allowClear value={eeo.pronouns ?? undefined} onChange={(v) => setEeo({ pronouns: v ?? null })} options={['she/her', 'he/him', 'they/them', 'Decline to state'].map((x) => ({ value: x, label: x }))} placeholder="Not answered" /></Field>
      </Space>);
      break;
  }
  return (
    <Drawer open={!!block} width="min(760px, 94vw)" title={`Edit: ${BLOCKS.find((b) => b.id === block)?.label ?? ''}`} onClose={() => { void close(); }}
      footer={<div className="jl-row"><span className="jl-grow">{err ? '' : dirty ? <span style={{ color: 'var(--jl-warn)' }}>Unsaved changes</span> : <span className="jl-muted">No changes</span>}</span><Button shape="round" onClick={() => { void close(); }}>Cancel</Button><Button type="primary" shape="round" loading={busy} disabled={!dirty} onClick={() => { void save(); }}>Save</Button></div>}>
      {newer && <div style={{ marginBottom: 12 }}><ConflictNotice what="profile" busy={busy} onKeepMine={() => { setNewer(null); void save(true); }} onLoadNewer={() => { setCached('profile', () => newer); setD(toInput(newer)); openedVersion.current = newer.version; setNewer(null); }} /></div>}
      {err && <div style={{ marginBottom: 12 }}><InlineError error={err} onRetry={() => { void save(); }} /><p className="jl-small" style={{ marginTop: 6 }}>Your changes are still here. Nothing was saved.</p></div>}
      {body}
    </Drawer>
  );
}

function Block({ id, title, onEdit, children }: { id: Block; title: string; onEdit: () => void; children: ReactNode }) {
  return (
    <section className="jl-detail-sec" id={`pf-${id}`} aria-labelledby={`pf-${id}-h`}>
      <div className="jl-row" style={{ marginBottom: 12 }}>
        <h2 id={`pf-${id}-h`} className="jl-grow" style={{ fontSize: 24, fontWeight: 700 }}>{title}</h2>
        <Button shape="circle" icon={<EditOutlined />} aria-label={`Edit ${title}`} onClick={onEdit} />
      </div>
      {children}
    </section>
  );
}

const None = ({ what, onAdd }: { what: string; onAdd: () => void }) => <p className="jl-muted">No {what} yet. <Button type="link" style={{ padding: 0 }} onClick={onAdd}>Add</Button></p>;
const ANS: Record<string, string> = { yes: 'Yes', no: 'No', decline: 'Decline to state' };

export function ProfileScreen() {
  const prof = useProfile();
  const [edit, setEdit] = useState<Block | null>(null);
  const [importing, setImporting] = useState(false);
  if (prof.error && !prof.data) return <div className="jl-page"><ErrorState error={prof.error} onRetry={() => { void prof.reload(); }} /></div>;
  if (!prof.data) return <div className="jl-page"><Loading label="Loading your profile" /></div>;
  const p = prof.data;
  const name = displayName(p);
  const missing = [
    !name && 'your name', !p.personal.email && 'an email', !p.work.length && 'work experience', !p.skills.length && 'skills',
    !p.preferences.jobFunctions.length && 'job functions', p.workAuthorization.usAuthorized === null && 'work authorization',
  ].filter(Boolean) as string[];
  const wa = p.workAuthorization;
  const eeoAnswered = Object.values(p.eeo).filter((v) => (Array.isArray(v) ? v.length : v !== null)).length;
  return (
    <div className="jl-2col">
      <div className="jl-colmain">
        <p className="jl-info-line"><LockOutlined /> Your profile stays on this Mac. It drives your match scores, resumes and application answers.</p>
        <div className="jl-detail-card">
          <nav className="jl-detail-tabs" aria-label="Profile sections" style={{ top: -16, height: 'auto', flexWrap: 'wrap', gap: '0 20px', padding: '0 24px' }}>
            {BLOCKS.map((b) => <button key={b.id} type="button" className="jl-detail-tab" style={{ fontSize: 14, whiteSpace: 'nowrap', height: 48 }} onClick={() => document.getElementById(`pf-${b.id}`)?.scrollIntoView({ behavior: 'smooth' })}>{b.label}</button>)}
          </nav>
          <Block id="personal" title={name ?? 'Your name'} onEdit={() => setEdit('personal')}>
            <div className="jl-row jl-wrap">
              {[p.personal.city && [p.personal.city, p.personal.region].filter(Boolean).join(', '), p.personal.email, p.personal.phone].filter(Boolean).map((x) => <span key={x as string} className="jl-tag grey" style={{ borderRadius: 16 }}>{x}</span>)}
              {p.personal.links.map((l) => <a key={l.url} className="jl-tag grey" style={{ borderRadius: 16 }} href={l.url} target="_blank" rel="noopener noreferrer">{l.label || l.url}</a>)}
              {!name && !p.personal.email && <None what="personal details" onAdd={() => setEdit('personal')} />}
            </div>
            {p.summary && <p style={{ marginTop: 10 }}>{p.summary}</p>}
          </Block>
          <Block id="prefs" title="Job preferences" onEdit={() => setEdit('prefs')}>
            {p.preferences.jobFunctions.length || p.preferences.levels.length ? (
              <div className="jl-row jl-wrap">
                {[...p.preferences.jobFunctions, ...p.preferences.targetTitles, ...p.preferences.employmentTypes.map((t) => typeText(t)!), ...p.preferences.workModels.map((m) => MODEL_OPTIONS.find((o) => o.value === m)?.label ?? m), ...p.preferences.levels.map((l) => EXPERIENCE_LEVEL_LABELS[l]), ...p.preferences.places.map((x) => x.text), ...p.preferences.countries.map((c) => COUNTRY_OPTIONS.find((o) => o.value === c)?.label ?? c)]
                  .map((x, i) => <Tag key={`${x}-${i}`}>{x}</Tag>)}
                {p.preferences.minAnnualPayUsd !== null && <Tag>At least ${Math.round(p.preferences.minAnnualPayUsd / 1000)}K a year</Tag>}
              </div>
            ) : <None what="preferences" onAdd={() => setEdit('prefs')} />}
          </Block>
          <Block id="education" title="Education" onEdit={() => setEdit('education')}>
            {p.education.length ? (
              <div className="jl-timeline">
                {p.education.map((e) => (
                  <div key={e.id} className="jl-tl-item">
                    <span className="jl-muted jl-small">{[yearMonthText(e.startDate), e.current ? 'Now' : yearMonthText(e.endDate)].filter(Boolean).join(' – ')}</span>
                    <div style={{ fontSize: 18, fontWeight: 700 }}>{e.school}</div>
                    <div>{[e.degree, e.major].filter(Boolean).join(' in ')}</div>
                  </div>
                ))}
              </div>
            ) : <None what="education" onAdd={() => setEdit('education')} />}
          </Block>
          <Block id="work" title="Work experience" onEdit={() => setEdit('work')}>
            {p.work.length ? (
              <div className="jl-timeline">
                {p.work.map((w) => (
                  <div key={w.id} className="jl-tl-item">
                    <span className="jl-muted jl-small">{[yearMonthText(w.startDate), w.current ? 'Now' : yearMonthText(w.endDate)].filter(Boolean).join(' – ')}</span>
                    <div style={{ fontSize: 18, fontWeight: 700 }}>{w.company}</div>
                    <div>{w.title}</div>
                    {w.bullets.length > 0 && <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{w.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>}
                  </div>
                ))}
              </div>
            ) : <None what="work experience" onAdd={() => setEdit('work')} />}
          </Block>
          <Block id="skills" title="Skills" onEdit={() => setEdit('skills')}>
            {p.skills.length ? <div className="jl-row jl-wrap">{p.skills.map((s) => <span key={s.name} className="jl-tag grey">{s.name}{s.years !== null ? ` · ${s.years} yr` : ''}</span>)}</div> : <None what="skills" onAdd={() => setEdit('skills')} />}
          </Block>
          <Block id="auth" title="Work authorization" onEdit={() => setEdit('auth')}>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>Legally allowed to work in the US: {wa.usAuthorized ? ANS[wa.usAuthorized] : 'not answered'}</li>
              <li>Needs visa sponsorship: {wa.needsSponsorship ? ANS[wa.needsSponsorship] : 'not answered'}</li>
              <li>US citizen: {wa.usCitizen ? ANS[wa.usCitizen] : 'not answered'}</li>
              <li>Security clearance: {wa.hasSecurityClearance ? ANS[wa.hasSecurityClearance] : 'not answered'}</li>
            </ul>
          </Block>
          <Block id="eeo" title="Equal employment" onEdit={() => setEdit('eeo')}>
            <p>{eeoAnswered ? `${eeoAnswered} of 8 questions answered.` : 'Not answered.'} <span className="jl-muted">These answers are used only on application forms you review yourself.</span></p>
          </Block>
        </div>
      </div>
      <aside className="jl-rightcol collapsible" aria-label="Profile help">
        {missing.length ? (
          <section className="jl-factbox" style={{ background: 'var(--jl-warn-tint)' }}>
            <strong>Add {missing.slice(0, 3).join(', ')}{missing.length > 3 ? ' and more' : ''}</strong>
            <p className="jl-small" style={{ marginTop: 4 }}>A fuller profile gives truer match scores and better answers.</p>
            <Button type="primary" shape="round" block style={{ marginTop: 10 }} onClick={() => setImporting(true)}>Fill it from a resume</Button>
          </section>
        ) : <section className="jl-factbox"><strong>Your profile has the main facts.</strong></section>}
        <section className="jl-factbox" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Button type="link" style={{ padding: 0, textAlign: 'left' }} onClick={() => navigate('resume')}>Manage my resumes</Button>
          <Button type="link" style={{ padding: 0, textAlign: 'left' }} onClick={() => navigate('settings/data')}>Export or back up my data</Button>
        </section>
      </aside>
      <EditDrawer block={edit} profile={p} onClose={() => setEdit(null)} />
      <AddResumeModal open={importing} onClose={() => setImporting(false)} />
    </div>
  );
}
