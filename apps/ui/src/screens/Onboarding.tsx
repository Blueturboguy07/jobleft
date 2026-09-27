// First run: what you look for (job function, job type, work model, level, place), your resume, your basics, and
// where AI answers come from. Each step is saved when you press Next, so a quit never loses what you typed. You can
// skip at any step; nothing opens by itself afterwards.

import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Input, InputNumber, Progress, Select, Space, Steps, Tag } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import type { ImportReport, Profile, ProfileInput } from '@jobleft/contracts';
import { call, type UiError } from '../app/api.ts';
import { invalidate, setCached } from '../app/data.ts';
import { ui } from '../app/layers.ts';
import { navigate } from '../app/router.ts';
import { setFeed, useCrawl, useProfile } from '../app/session.ts';
import { Art, LogoMark, Wordmark } from '../components/Art.tsx';
import { InlineError, Loading } from '../components/States.tsx';
import { COMMON_COUNTRY_OPTIONS, COUNTRY_OPTIONS, JOB_FUNCTION_SUGGESTIONS, LEVEL_OPTIONS, MODEL_OPTIONS, TYPE_OPTIONS, filterFromProfile, toggle } from '../lib/filters.ts';
import { plural, yearMonthText } from '../lib/format.ts';
import { PlacePicker } from './jobs/Filters.tsx';
import { YesNo, toInput } from './Profile.tsx';
import { importChanges, mergeImported } from '../lib/importMerge.ts';

const SKIP_KEY = 'jobleft.onboarding.skipped';
export function onboardingSkipped(): boolean {
  try { return localStorage.getItem(SKIP_KEY) === '1'; } catch { return false; }
}

const STEPS = ['Looking for', 'Job type', 'Where', 'Resume', 'About you', 'AI'];

function Choice({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" className={`jl-choice${on ? ' on' : ''}`} aria-pressed={on} onClick={onClick}>{children}</button>;
}

export function Onboarding() {
  const profile = useProfile();
  const { progress } = useCrawl();
  const [step, setStep] = useState(0);
  const [d, setD] = useState<ProfileInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<UiError | null>(null);
  const [imported, setImported] = useState<{ report: ImportReport; proposed: ProfileInput } | null>(null);
  const [useFacts, setUseFacts] = useState(true);
  const hadFacts = !!(profile.data && (profile.data.work.length || profile.data.skills.length || profile.data.education.length));
  const [custom, setCustom] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (profile.data && !d) setD(toInput(profile.data)); }, [profile.data]);
  if (profile.error && !profile.data) return <main className="jl-onboard"><InlineError error={profile.error} onRetry={() => { void profile.reload(); }} /></main>;
  if (!d) return <main className="jl-onboard"><Loading label="Getting ready" /></main>;
  const pr = d.preferences;
  const setPr = (patch: Partial<ProfileInput['preferences']>) => setD({ ...d, preferences: { ...pr, ...patch } });
  const p = d.personal;
  const setP = (patch: Partial<ProfileInput['personal']>) => setD({ ...d, personal: { ...p, ...patch } });

  const persist = async (next: ProfileInput): Promise<Profile | null> => {
    setBusy(true); setErr(null);
    try {
      const saved = await call('putProfile', { body: next });
      setCached('profile', () => saved);
      invalidate('jobs:', 'job:', 'match:');
      return saved;
    } catch (e) { setErr(e as UiError); return null; } finally { setBusy(false); }
  };
  const next = async () => {
    let body = d;
    if (step === 3 && imported && useFacts) {
      body = mergeImported(d, imported.proposed);
      setD(body);
    }
    const saved = await persist(body);
    if (!saved) return;
    if (step < STEPS.length - 1) setStep(step + 1);
  };
  const finish = async (goto: string) => {
    const saved = await persist(d);
    if (!saved) return;
    setFeed({ filter: filterFromProfile(saved), initialized: true, savedId: null });
    try { localStorage.setItem(SKIP_KEY, '1'); } catch { /* ignore */ }
    navigate(goto, { replace: true });
  };
  const skip = () => {
    try { localStorage.setItem(SKIP_KEY, '1'); } catch { /* ignore */ }
    navigate('jobs', { replace: true });
  };
  const upload = async (f: File) => {
    const ext = f.name.split('.').pop()?.toLowerCase();
    const type = ext === 'pdf' ? 'application/pdf' : ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : null;
    setErr(null);
    if (!type) { setErr({ code: 'bad_request', status: null, message: 'Use a PDF or a Word (.docx) file.', link: null }); return; }
    if (f.size > 10 * 1024 * 1024) { setErr({ code: 'payload_too_large', status: null, message: 'The file is larger than 10 MB.', link: null }); return; }
    setBusy(true);
    try {
      const r = await call('importResume', { body: new Uint8Array(await f.arrayBuffer()), contentType: type, fileName: f.name });
      setImported({ report: r.resume.importReport!, proposed: r.proposedProfile });
      setUseFacts(!hadFacts);
      invalidate('resumes');
    } catch (e) { setErr(e as UiError); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const body = [
    (
      <Space direction="vertical" size={14} style={{ width: '100%' }} key="0">
        <h2 className="jl-display" style={{ fontSize: 28 }}>What kind of work are you looking for?</h2>
        <p className="jl-muted">Pick one or more. This sets the starting filters of your job list; you can change them any time.</p>
        <div className="jl-choice-grid">
          {JOB_FUNCTION_SUGGESTIONS.map((f) => <Choice key={f} on={pr.jobFunctions.includes(f)} onClick={() => setPr({ jobFunctions: toggle(pr.jobFunctions, f) })}>{f}</Choice>)}
        </div>
        <div className="jl-row">
          <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Something else? Type it" aria-label="Other job function" onPressEnter={() => { if (custom.trim()) { setPr({ jobFunctions: [...pr.jobFunctions, custom.trim()] }); setCustom(''); } }} />
          <Button onClick={() => { if (custom.trim()) { setPr({ jobFunctions: [...pr.jobFunctions, custom.trim()] }); setCustom(''); } }}>Add</Button>
        </div>
        {pr.jobFunctions.filter((f) => !JOB_FUNCTION_SUGGESTIONS.includes(f)).map((f) => <Choice key={f} on onClick={() => setPr({ jobFunctions: pr.jobFunctions.filter((x) => x !== f) })}>{f} ×</Choice>)}
        <Select mode="tags" value={pr.targetTitles} onChange={(v) => setPr({ targetTitles: v })} placeholder="Target job titles (optional), for example Backend engineer" aria-label="Target job titles" open={false} suffixIcon={null} />
      </Space>
    ),
    (
      <Space direction="vertical" size={14} style={{ width: '100%' }} key="1">
        <h2 className="jl-display" style={{ fontSize: 28 }}>Which jobs fit you?</h2>
        <strong>Job type</strong>
        <div className="jl-choice-grid">{TYPE_OPTIONS.map((o) => <Choice key={o.value} on={pr.employmentTypes.includes(o.value)} onClick={() => setPr({ employmentTypes: toggle(pr.employmentTypes, o.value) })}>{o.label}</Choice>)}</div>
        <strong>Work model</strong>
        <div className="jl-choice-grid">{MODEL_OPTIONS.map((o) => <Choice key={o.value} on={pr.workModels.includes(o.value)} onClick={() => setPr({ workModels: toggle(pr.workModels, o.value) })}>{o.label}</Choice>)}</div>
        <strong>Experience level</strong>
        <div className="jl-choice-grid">{LEVEL_OPTIONS.map((o) => <Choice key={o.value} on={pr.levels.includes(o.value)} onClick={() => setPr({ levels: toggle(pr.levels, o.value) })}>{o.label}</Choice>)}</div>
        <strong>Minimum yearly pay (US dollars, optional)</strong>
        <InputNumber min={0} step={5000} style={{ width: 220 }} value={pr.minAnnualPayUsd ?? undefined} onChange={(v) => setPr({ minAnnualPayUsd: v ?? null })} placeholder="Not set" aria-label="Minimum yearly pay in US dollars" />
        <p className="jl-note">A job that does not state its pay is never hidden by this. It is marked "pay not stated".</p>
      </Space>
    ),
    (
      <Space direction="vertical" size={14} style={{ width: '100%' }} key="2">
        <h2 className="jl-display" style={{ fontSize: 28 }}>Where do you want to work?</h2>
        <strong>Countries</strong>
        <div className="jl-choice-grid">{COUNTRY_OPTIONS.filter((o) => COMMON_COUNTRY_OPTIONS.includes(o) || pr.countries.includes(o.value)).map((o) => <Choice key={o.value} on={pr.countries.includes(o.value)} onClick={() => setPr({ countries: toggle(pr.countries, o.value) })}>{o.label}</Choice>)}</div>
        <Select showSearch optionFilterProp="label" value={null} placeholder="Another country? Type its name" aria-label="Another country" style={{ maxWidth: 360 }}
          options={COUNTRY_OPTIONS.filter((o) => !COMMON_COUNTRY_OPTIONS.includes(o) && !pr.countries.includes(o.value))} onChange={(v: string) => setPr({ countries: [...pr.countries, v] })} />
        <strong>Cities (optional)</strong>
        <PlacePicker places={pr.places} onChange={(places) => setPr({ places })} />
        <p className="jl-note">Remote jobs open to people in your countries are always included.</p>
        <strong>Work authorization</strong>
        <YesNo label="Are you legally allowed to work in the US?" value={d.workAuthorization.usAuthorized} onChange={(v) => setD({ ...d, workAuthorization: { ...d.workAuthorization, usAuthorized: v } })} />
        <YesNo label="Will you need visa sponsorship now or later?" value={d.workAuthorization.needsSponsorship} onChange={(v) => setD({ ...d, workAuthorization: { ...d.workAuthorization, needsSponsorship: v } })} />
        <p className="jl-note">These answers stay on this Mac. They are never sent to an AI provider. A job that says it does not sponsor is flagged. A job that says nothing is never called "no sponsorship".</p>
      </Space>
    ),
    (
      <Space direction="vertical" size={14} style={{ width: '100%' }} key="3">
        <h2 className="jl-display" style={{ fontSize: 28 }}>Add your resume</h2>
        <p className="jl-muted">jobleft reads it on this Mac to fill your profile. You can check every fact. PDF or Word, up to 10 MB.</p>
        <input ref={fileRef} type="file" accept=".pdf,.docx" style={{ display: 'none' }} aria-label="Resume file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
        {!imported && <div style={{ textAlign: 'center' }}><Art kind="doc" /><div><Button type="primary" shape="round" size="large" icon={<UploadOutlined />} loading={busy} onClick={() => fileRef.current?.click()}>Upload a resume</Button></div></div>}
        {imported && (
          <>
            <Alert type={imported.report.outcome === 'ok' ? 'success' : 'info'} showIcon message={`Read ${plural(imported.report.counts.jobs, 'job')}, ${plural(imported.report.counts.skills, 'skill')} and ${plural(imported.report.counts.education, 'school')}.`}
              description={[...imported.report.warnings].join(' ') || undefined} />
            {(imported.report.unreadSections.length > 0) && <Alert type="info" showIcon message={`Kept aside, not mapped: ${imported.report.unreadSections.join(', ')}`} />}
            <div className="jl-factbox" role="group" aria-label="What jobleft read">
              <strong>{[imported.proposed.personal.firstName, imported.proposed.personal.lastName].filter(Boolean).join(' ') || 'No name found'}</strong>
              <div className="jl-small jl-muted">{[imported.proposed.personal.email, imported.proposed.personal.phone, [imported.proposed.personal.city, imported.proposed.personal.region].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || 'No contact details found'}</div>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {imported.proposed.work.map((w) => <li key={w.id}>{w.title || 'No title'} at {w.company || 'no employer found'}, {yearMonthText(w.startDate) ?? 'no start date'} to {w.current ? 'now' : (yearMonthText(w.endDate) ?? 'no end date')}</li>)}
                {imported.proposed.education.map((e) => <li key={e.id}>{[e.degree, e.major].filter(Boolean).join(' in ') || 'Degree not found'}, {e.school || 'school not found'}</li>)}
                {imported.proposed.skills.length > 0 && <li>Skills: {imported.proposed.skills.map((s) => s.name).join(', ')}</li>}
              </ul>
              <p className="jl-small jl-muted" style={{ marginTop: 6 }}>Check every line. You can correct anything on the Profile screen after setup.</p>
            </div>
            {importChanges(d, imported.proposed).replaces.length > 0 && <Alert type="warning" showIcon message="This would replace changes you already made" description={<ul style={{ margin: 0, paddingLeft: 18 }}>{importChanges(d, imported.proposed).replaces.map((x) => <li key={x}>{x}</li>)}</ul>} />}
            <Checkbox checked={useFacts} onChange={(e) => setUseFacts(e.target.checked)}>Use the facts from this file in my profile</Checkbox>
            <Button onClick={() => fileRef.current?.click()} icon={<UploadOutlined />}>Use another file</Button>
          </>
        )}
        <p className="jl-small jl-muted">No resume at hand? Press Next; you can add one later.</p>
      </Space>
    ),
    (
      <Space direction="vertical" size={12} style={{ width: '100%' }} key="4">
        <h2 className="jl-display" style={{ fontSize: 28 }}>About you</h2>
        <p className="jl-muted">Stays on this Mac. Used on your resumes and application forms.</p>
        <div className="jl-row jl-wrap"><Input style={{ flex: 1 }} value={p.firstName ?? ''} onChange={(e) => setP({ firstName: e.target.value || null })} placeholder="First name" aria-label="First name" /><Input style={{ flex: 1 }} value={p.lastName ?? ''} onChange={(e) => setP({ lastName: e.target.value || null })} placeholder="Last name" aria-label="Last name" /></div>
        <div className="jl-row jl-wrap"><Input style={{ flex: 1 }} type="email" value={p.email ?? ''} onChange={(e) => setP({ email: e.target.value || null })} placeholder="Email" aria-label="Email" /><Input style={{ flex: 1 }} value={p.phone ?? ''} onChange={(e) => setP({ phone: e.target.value || null })} placeholder="Phone" aria-label="Phone" /></div>
        <div className="jl-row jl-wrap"><Input style={{ flex: 1 }} value={p.city ?? ''} onChange={(e) => setP({ city: e.target.value || null })} placeholder="City" aria-label="City" /><Input style={{ flex: 1 }} value={p.region ?? ''} onChange={(e) => setP({ region: e.target.value || null })} placeholder="State or region" aria-label="State or region" /></div>
      </Space>
    ),
    (
      <Space direction="vertical" size={14} style={{ width: '100%' }} key="5">
        <h2 className="jl-display" style={{ fontSize: 28 }}>Where should AI answers come from?</h2>
        <p className="jl-muted">AI is the one part of jobleft that costs money: tailoring a resume or a letter runs a model, and the model's provider charges for each run. Through publik you pay only for those runs, from a dollar balance, which comes to about 2% of what the subscription job-search apps charge each month.</p>
        <p className="jl-muted">AI is optional. Search, filters, match scores and the tracker work without it.</p>
        <div className="jl-choice-grid">
          <button type="button" className="jl-choice" onClick={() => { void finish('settings/balance'); }} style={{ flexDirection: 'column', alignItems: 'flex-start' }}><span className="jl-row" style={{ gap: 8 }}><strong>publik API</strong><Tag color="green" style={{ margin: 0 }}>Cheapest</Tag></span><span className="jl-small">Pay per use from a dollar balance; a free starter amount is included. You read the terms and connect on the next screen.</span></button>
          <button type="button" className="jl-choice" onClick={() => { void finish('settings/ai'); }} style={{ flexDirection: 'column', alignItems: 'flex-start' }}><strong>A model on this computer</strong><span className="jl-small">Ollama, LM Studio and similar. Nothing leaves this Mac. Be warned: the small models that fit on a laptop tailor resumes and answer questions noticeably worse than the hosted ones.</span></button>
        </div>
        <p className="jl-small">Want more than the starter amount? <a href="https://publikhq.com/pricing" target="_blank" rel="noopener noreferrer">See the plans and prices on publikhq.com</a>. A plan adds a weekly budget to your balance; you still pay only for what you use.</p>
        <Button type="link" style={{ alignSelf: 'flex-start', padding: 0 }} onClick={() => { void finish('jobs'); }}>Decide later and see my jobs</Button>
      </Space>
    ),
  ];

  return (
    <main className="jl-onboard">
      <div className="jl-row" style={{ width: '100%', maxWidth: 760 }}>
        <LogoMark size={36} /><Wordmark size={24} />
        <span className="jl-grow" />
        <Button type="text" onClick={skip}>Skip setup</Button>
      </div>
      <div className="jl-onboard-card">
        <Steps size="small" current={step} items={STEPS.map((t) => ({ title: t }))} responsive={false} style={{ marginBottom: 24 }} />
        {body[step]}
        <InlineError error={err} />
        {step < STEPS.length - 1 && (
          <div className="jl-row" style={{ marginTop: 24 }}>
            {step > 0 && <Button shape="round" onClick={() => setStep(step - 1)}>Back</Button>}
            <span className="jl-grow" />
            <Button type="primary" shape="round" size="large" loading={busy} onClick={() => { void next(); }}>Next</Button>
          </div>
        )}
      </div>
      {progress?.running && (
        <div className="jl-progress" style={{ marginTop: 16, width: '100%', maxWidth: 760 }} role="status">
          <span className="jl-grow">While you set up, jobleft is reading job boards: {progress.boardsDone} of {plural(progress.boardsTotal, 'board')} done, {plural(progress.jobsSeen, 'job')} so far.</span>
          <Progress className="meter" percent={progress.boardsTotal ? Math.round((100 * progress.boardsDone) / progress.boardsTotal) : 0} size="small" strokeColor="#0A8F5C" aria-label="Refresh progress" />
        </div>
      )}
    </main>
  );
}

export { ui };
