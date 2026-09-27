// First run: what you look for (job function, job type, work model, level, place), your resume, your basics, and
// where AI answers come from. Each step is saved to the profile when you press Next; until then the local service
// keeps what you chose or typed (a draft, saved as you go), and the step you are on, so a quit or a reload never loses
// either. You can skip at any step: what you chose is kept, and the setup does not open by itself again.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Checkbox, Input, InputNumber, Progress, Select, Space, Steps, Tag } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import type { OnboardingState, Profile, ProfileInput } from '@jobleft/contracts';
import { call, type UiError } from '../app/api.ts';
import { invalidate, setCached } from '../app/data.ts';
import { ui } from '../app/layers.ts';
import { navigate } from '../app/router.ts';
import { getFeed, setFeed, useCrawl, useOnboarding, useProfile } from '../app/session.ts';
import { Art, LogoMark, Wordmark } from '../components/Art.tsx';
import { InlineError, Loading } from '../components/States.tsx';
import { COMMON_COUNTRY_OPTIONS, COUNTRY_OPTIONS, JOB_FUNCTION_SUGGESTIONS, LEVEL_OPTIONS, MODEL_OPTIONS, TYPE_OPTIONS, filterFromProfile, toggle } from '../lib/filters.ts';
import { countrySort } from '../lib/countries.ts';
import { plural, yearMonthText } from '../lib/format.ts';
import { PlacePicker } from './jobs/Filters.tsx';
import { YesNo } from './Profile.tsx';
import { importChanges } from '../lib/importMerge.ts';
import { cleanForSave, problemsIn, serverProblems, type FieldProblem } from '../lib/profileErrors.ts';
import { LAST_STEP, MAX_FUNCTION_LENGTH, addJobFunction, bodyToSave, closedState, keptState, replaceUpload, resumeSetup, toInput, type PendingImport } from '../lib/onboarding.ts';

/** jobleft 0.1.2 and earlier kept "skipped" only in this browser; read once to carry it over, never written again. */
const SKIP_KEY = 'jobleft.onboarding.skipped';
export function onboardingSkipped(): boolean {
  try { return localStorage.getItem(SKIP_KEY) === '1'; } catch { return false; }
}
function forgetLegacySkip(): void {
  try { localStorage.removeItem(SKIP_KEY); } catch { /* per-viewer convenience only */ }
}

/** A box with its name above it, so a filled box still says what it holds (JL-onboarding-8). */
function Labeled({ label, children, problem }: { label: string; children: ReactNode; problem?: string | null }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 220px', minWidth: 0 }}>
      <span style={{ fontWeight: 600, fontSize: 13 }}>{label}</span>
      {children}
      {problem && <span role="alert" style={{ color: 'var(--jl-error)', fontSize: 13 }}>{problem}</span>}
    </label>
  );
}

/** The boxes of the About-you step, checked before Next (JL-onboarding-5). */
const ABOUT_PATHS = ['firstName', 'lastName', 'email', 'phone', 'city', 'region'].map((k) => `/personal/${k}`);

const STEPS = ['Looking for', 'Job type', 'Where', 'Resume', 'About you', 'AI'];

function Choice({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" className={`jl-choice${on ? ' on' : ''}`} aria-pressed={on} onClick={onClick}>{children}</button>;
}

export function Onboarding() {
  const profile = useProfile();
  const setup = useOnboarding();
  const { progress } = useCrawl();
  const [step, setStep] = useState(0);
  const [d, setD] = useState<ProfileInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<UiError | null>(null);
  const [problems, setProblems] = useState<FieldProblem[]>([]);
  const [imported, setImported] = useState<PendingImport | null>(null);
  /** The choice that ends the setup, once one was made: every other way out waits (JL-onboarding-10). */
  const [leaving, setLeaving] = useState<string | null>(null);
  const leavingRef = useRef(false);
  const status = useRef<OnboardingState['status']>('new');
  const hadFacts = !!(profile.data && (profile.data.work.length || profile.data.skills.length || profile.data.education.length));
  const [custom, setCustom] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  const pending = useRef<OnboardingState | null>(null);
  const savedKey = useRef('');
  const chain = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Open where the person was: the saved step and what they had chosen or typed (JL-onboarding-2, -11).
  useEffect(() => {
    if (d || !profile.data || !setup.data) return;
    const r = resumeSetup(setup.data, profile.data);
    status.current = setup.data.status;
    savedKey.current = JSON.stringify(setup.data);
    setStep(r.step); setD(r.d); setImported(r.pending);
    forgetLegacySkip();
  }, [profile.data, setup.data]);

  // Keep the state on the local service as the person works: every change, 300 ms after the last one, one write at a
  // time and always the newest, and at once when the window is hidden or closed.
  const flush = (): Promise<void> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    chain.current = chain.current.then(async () => {
      const s = pending.current;
      pending.current = null;
      if (!s) return;
      const key = JSON.stringify(s);
      if (key === savedKey.current) return;
      try {
        const r = await call('putOnboarding', { body: s });
        savedKey.current = key;
        setCached('onboarding', () => r);
      } catch { if (!pending.current) pending.current = s; /* the next change or leave tries again */ }
    });
    return chain.current;
  };
  const keep = (s: OnboardingState, now = false): Promise<void> => {
    pending.current = s;
    status.current = s.status;
    if (now) return flush();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, 300);
    return Promise.resolve();
  };
  useEffect(() => {
    if (!d || !profile.data || leavingRef.current) return;
    void keep(keptState(status.current, step, d, imported, profile.data));
  }, [d, step, imported]);
  useEffect(() => {
    const now = () => { void flush(); };
    const hidden = () => { if (document.visibilityState === 'hidden') void flush(); };
    window.addEventListener('pagehide', now);
    document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('pagehide', now); document.removeEventListener('visibilitychange', hidden); void flush(); };
  }, []);

  const loadError = profile.error ?? setup.error;
  if (loadError && !(profile.data && setup.data)) return <main className="jl-onboard"><InlineError error={loadError} onRetry={() => { void profile.reload(); void setup.reload(); }} /></main>;
  if (!d || !profile.data) return <main className="jl-onboard"><Loading label="Getting ready" /></main>;
  const pr = d.preferences;
  const setPr = (patch: Partial<ProfileInput['preferences']>) => setD({ ...d, preferences: { ...pr, ...patch } });
  const p = d.personal;
  const setP = (patch: Partial<ProfileInput['personal']>) => {
    setD({ ...d, personal: { ...p, ...patch } });
    if (problems.length) setProblems(problems.filter((x) => !Object.keys(patch).some((k) => x.path === `/personal/${k}`)));
  };
  const problem = (k: string) => problems.find((x) => x.path === `/personal/${k}`)?.message ?? null;

  const persist = async (next: ProfileInput): Promise<Profile | null> => {
    setBusy(true); setErr(null);
    try {
      const saved = await call('putProfile', { body: next });
      setCached('profile', () => saved);
      invalidate('jobs:', 'job:', 'match:');
      setProblems([]);
      return saved;
    } catch (e) { setErr(e as UiError); setProblems(serverProblems((e as UiError).details)); return null; } finally { setBusy(false); }
  };
  const goTo = (n: number) => { if (!leavingRef.current) setStep(Math.min(Math.max(0, n), LAST_STEP)); };
  const next = async () => {
    if (step === 1 || step === 4) {
      const found = step === 1 ? problemsIn(d, ['preferences']) : problemsIn(d, ['personal'], ABOUT_PATHS);
      setProblems(found);
      if (found.length) return;
    }
    const saved = await persist(bodyToSave(cleanForSave(d), imported));
    if (!saved) return;
    const n = Math.min(step + 1, LAST_STEP);
    setD(toInput(saved));
    if (imported) setImported(null);
    setStep(n);
    await keep(keptState(status.current, n, toInput(saved), null, saved), true);
  };
  /** Ends the setup: saves what is on screen, marks the setup finished or skipped, sets the starting filters, then goes on. */
  const leave = async (goto: string, how: 'done' | 'skipped') => {
    if (leavingRef.current) return;
    leavingRef.current = true; setLeaving(goto);
    const saved = await persist(bodyToSave(cleanForSave(d), imported));
    if (!saved) { leavingRef.current = false; setLeaving(null); return; }
    await keep(closedState(status.current, how), true);
    if (how === 'done' || !getFeed().initialized) setFeed({ filter: filterFromProfile(saved), initialized: true, savedId: null });
    navigate(goto, { replace: true, force: true });
  };
  const finish = (goto: string) => leave(goto, 'done');
  const skip = () => leave('jobs', 'skipped');
  const upload = async (f: File) => {
    const ext = f.name.split('.').pop()?.toLowerCase();
    const type = ext === 'pdf' ? 'application/pdf' : ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : null;
    setErr(null);
    if (!type) { setErr({ code: 'bad_request', status: null, message: 'Use a PDF or a Word (.docx) file.', link: null }); return; }
    if (f.size > 10 * 1024 * 1024) { setErr({ code: 'payload_too_large', status: null, message: 'The file is larger than 10 MB.', link: null }); return; }
    setBusy(true);
    try {
      const r = await call('importResume', { body: new Uint8Array(await f.arrayBuffer()), contentType: type, fileName: f.name });
      const before = imported?.resumeId ?? null;
      setImported({ resumeId: r.resume.id, report: r.resume.importReport!, proposed: r.proposedProfile, useFacts: !hadFacts });
      // "Use another file" replaces the file the person did not keep; the kept file takes its place as the primary
      // resume (JL-onboarding-4).
      await replaceUpload({
        isPrimary: async (id) => (await call('getResume', { params: { resumeId: id } })).isPrimary,
        remove: async (id) => { await call('deleteResume', { params: { resumeId: id }, query: {} }); },
        makePrimary: async (id) => { await call('updateResume', { params: { resumeId: id }, body: { isPrimary: true } }); },
      }, before, r.resume.id);
      invalidate('resumes');
    } catch (e) { setErr(e as UiError); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const addCustom = () => { setPr({ jobFunctions: addJobFunction(pr.jobFunctions, custom, JOB_FUNCTION_SUGGESTIONS) }); setCustom(''); };

  const body = [
    (
      <Space direction="vertical" size={14} style={{ width: '100%' }} key="0">
        <h2 className="jl-display" style={{ fontSize: 28 }}>What kind of work are you looking for?</h2>
        <p className="jl-muted">Pick one or more. This sets the starting filters of your job list; you can change them any time.</p>
        <div className="jl-choice-grid">
          {JOB_FUNCTION_SUGGESTIONS.map((f) => <Choice key={f} on={pr.jobFunctions.includes(f)} onClick={() => setPr({ jobFunctions: toggle(pr.jobFunctions, f) })}>{f}</Choice>)}
        </div>
        <div className="jl-row">
          <Input value={custom} maxLength={MAX_FUNCTION_LENGTH} onChange={(e) => setCustom(e.target.value)} placeholder="Something else? Type it" aria-label="Other job function" onPressEnter={addCustom} />
          <Button onClick={addCustom}>Add</Button>
        </div>
        {pr.jobFunctions.filter((f) => !JOB_FUNCTION_SUGGESTIONS.includes(f)).map((f) => <Choice key={f} on onClick={() => setPr({ jobFunctions: pr.jobFunctions.filter((x) => x !== f) })}><span style={{ overflowWrap: 'anywhere' }}>{f} ×</span></Choice>)}
        <Select mode="tags" style={{ width: '100%' }} value={pr.targetTitles} onChange={(v) => setPr({ targetTitles: v })} placeholder="Target job titles (optional), for example Backend engineer" aria-label="Target job titles" open={false} suffixIcon={null} />
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
        <InputNumber min={0} step={5000} precision={0} style={{ width: 220 }} status={problems.some((x) => x.path === '/preferences/minAnnualPayUsd') ? 'error' : undefined} value={pr.minAnnualPayUsd ?? undefined} onChange={(v) => { setPr({ minAnnualPayUsd: v ?? null }); setProblems([]); }} placeholder="Not set" aria-label="Minimum yearly pay in US dollars" />
        {problems.filter((x) => x.path === '/preferences/minAnnualPayUsd').map((x) => <span key={x.path} role="alert" style={{ color: 'var(--jl-error)', fontSize: 13 }}>{x.message}</span>)}
        <p className="jl-note">A job that does not state its pay is never hidden by this. It is marked "pay not stated".</p>
      </Space>
    ),
    (
      <Space direction="vertical" size={14} style={{ width: '100%' }} key="2">
        <h2 className="jl-display" style={{ fontSize: 28 }}>Where do you want to work?</h2>
        <strong>Countries</strong>
        <div className="jl-choice-grid">{COUNTRY_OPTIONS.filter((o) => COMMON_COUNTRY_OPTIONS.includes(o) || pr.countries.includes(o.value)).map((o) => <Choice key={o.value} on={pr.countries.includes(o.value)} onClick={() => setPr({ countries: toggle(pr.countries, o.value) })}>{o.label}</Choice>)}</div>
        <Select showSearch optionFilterProp="label" filterSort={countrySort} value={null} placeholder="Another country? Type its name" aria-label="Another country" style={{ maxWidth: 360 }}
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
            <Checkbox checked={imported.useFacts} onChange={(e) => setImported({ ...imported, useFacts: e.target.checked })}>Use the facts from this file in my profile</Checkbox>
            <Button onClick={() => fileRef.current?.click()} icon={<UploadOutlined />} loading={busy}>Use another file</Button>
            <p className="jl-small jl-muted" style={{ margin: 0 }}>Another file replaces this one.</p>
          </>
        )}
        <p className="jl-small jl-muted">No resume at hand? Press Next; you can add one later.</p>
      </Space>
    ),
    (
      <Space direction="vertical" size={12} style={{ width: '100%' }} key="4">
        <h2 className="jl-display" style={{ fontSize: 28 }}>About you</h2>
        <p className="jl-muted">Stays on this Mac. Used on your resumes and application forms.</p>
        <div className="jl-row jl-wrap" style={{ alignItems: 'flex-start' }}><Labeled label="First name" problem={problem('firstName')}><Input status={problem('firstName') ? 'error' : undefined} value={p.firstName ?? ''} onChange={(e) => setP({ firstName: e.target.value || null })} aria-label="First name" /></Labeled><Labeled label="Last name" problem={problem('lastName')}><Input status={problem('lastName') ? 'error' : undefined} value={p.lastName ?? ''} onChange={(e) => setP({ lastName: e.target.value || null })} aria-label="Last name" /></Labeled></div>
        <div className="jl-row jl-wrap" style={{ alignItems: 'flex-start' }}><Labeled label="Email" problem={problem('email')}><Input status={problem('email') ? 'error' : undefined} type="email" value={p.email ?? ''} onChange={(e) => setP({ email: e.target.value || null })} placeholder="name@example.com" aria-label="Email" /></Labeled><Labeled label="Phone" problem={problem('phone')}><Input status={problem('phone') ? 'error' : undefined} value={p.phone ?? ''} onChange={(e) => setP({ phone: e.target.value || null })} placeholder="+1 555 010 0100" aria-label="Phone" /></Labeled></div>
        <div className="jl-row jl-wrap" style={{ alignItems: 'flex-start' }}><Labeled label="City" problem={problem('city')}><Input status={problem('city') ? 'error' : undefined} value={p.city ?? ''} onChange={(e) => setP({ city: e.target.value || null })} aria-label="City" /></Labeled><Labeled label="State or region" problem={problem('region')}><Input status={problem('region') ? 'error' : undefined} value={p.region ?? ''} onChange={(e) => setP({ region: e.target.value || null })} aria-label="State or region" /></Labeled></div>
      </Space>
    ),
    (
      <Space direction="vertical" size={14} style={{ width: '100%' }} key="5">
        <h2 className="jl-display" style={{ fontSize: 28 }}>Where should AI answers come from?</h2>
        <p className="jl-muted">AI is the one part of jobleft that costs money: tailoring a resume or a letter runs a model, and the model's provider charges for each run. Through publik you pay only for those runs, from a dollar balance, which comes to about 2% of what the subscription job-search apps charge each month.</p>
        <p className="jl-muted">AI is optional. Search, filters, match scores and the tracker work without it.</p>
        <div className="jl-choice-grid">
          <button type="button" className="jl-choice" disabled={!!leaving} aria-busy={leaving === 'settings/balance'} onClick={() => { void finish('settings/balance'); }} style={{ flexDirection: 'column', alignItems: 'flex-start' }}><span className="jl-row" style={{ gap: 8 }}><strong>publik API</strong><Tag color="green" style={{ margin: 0 }}>Cheapest</Tag></span><span className="jl-small">Pay per use from a dollar balance; publik may add a small free starting amount. You read the terms and connect on the next screen.</span></button>
          <button type="button" className="jl-choice" disabled={!!leaving} aria-busy={leaving === 'settings/ai?pick=local'} onClick={() => { void finish('settings/ai?pick=local'); }} style={{ flexDirection: 'column', alignItems: 'flex-start' }}><strong>A model on this computer</strong><span className="jl-small">Ollama, LM Studio and similar. Nothing leaves this Mac. Be warned: the small models that fit on a laptop tailor resumes and answer questions noticeably worse than the hosted ones. You pick the server and test it on the next screen.</span></button>
          <button type="button" className="jl-choice" disabled={!!leaving} aria-busy={leaving === 'settings/ai?pick=own_key'} onClick={() => { void finish('settings/ai?pick=own_key'); }} style={{ flexDirection: 'column', alignItems: 'flex-start' }}><strong>Your own key</strong><span className="jl-small">Your account with OpenAI, Anthropic, OpenRouter or Google. The vendor bills you. You paste the key on the next screen; it stays in the macOS Keychain.</span></button>
        </div>
        <p className="jl-small">Want more than a free starting amount? <a href="https://publikhq.com/pricing" target="_blank" rel="noopener noreferrer">See the plans and prices on publikhq.com</a>. A plan adds a weekly budget to your balance; you still pay only for what you use.</p>
        {leaving && <p className="jl-small jl-muted" role="status">Saving your answers…</p>}
      </Space>
    ),
  ];

  return (
    <main className="jl-onboard">
      <div className="jl-row" style={{ width: '100%', maxWidth: 760 }}>
        <LogoMark size={36} /><Wordmark size={24} />
        <span className="jl-grow" />
        <Button type="text" disabled={!!leaving} loading={leaving === 'jobs' && step < LAST_STEP} onClick={() => { void skip(); }}>Skip setup</Button>
      </div>
      <div className="jl-onboard-card">
        {/* Earlier steps can be opened from their names; later ones need Next, which saves (JL-onboarding-7). */}
        <Steps size="small" current={step} onChange={(n) => { if (n < step) goTo(n); }} items={STEPS.map((t, i) => ({ title: t, disabled: i > step || !!leaving }))} responsive={false} style={{ marginBottom: 24 }} />
        {body[step]}
        <InlineError error={err} />
        <div className="jl-row" style={{ marginTop: 24 }}>
          {step > 0 && <Button shape="round" disabled={!!leaving} onClick={() => goTo(step - 1)}>Back</Button>}
          <span className="jl-grow" />
          {step < LAST_STEP
            ? <Button type="primary" shape="round" size="large" loading={busy} onClick={() => { void next(); }}>Next</Button>
            : <Button type="link" style={{ padding: 0 }} disabled={!!leaving} loading={leaving === 'jobs'} onClick={() => { void finish('jobs'); }}>Decide later and see my jobs</Button>}
        </div>
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
