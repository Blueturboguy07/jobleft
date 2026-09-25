// Interview practice made for one job: practice questions from the posting (labelled as practice, never "asked
// at" the employer), feedback on your answers (no invented achievements; placeholders are marked), and your own
// question bank with answers and debriefs, kept on this Mac.

import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Empty, Input, Popconfirm, Select, Space, Tabs, Tag } from 'antd';
import { DeleteOutlined, SaveOutlined } from '@ant-design/icons';
import type { PracticeItem, PracticeSession, TrackerList } from '@jobleft/contracts';
import { call, type UiError } from '../app/api.ts';
import { invalidate, useApi } from '../app/data.ts';
import { ui, useDirty } from '../app/layers.ts';
import { navigate, queryParam } from '../app/router.ts';
import { useAiSettings } from '../app/session.ts';
import { AiNote, afterAiStep, ensureAiConsent } from '../components/AiNote.tsx';
import { EmptyState, InlineError } from '../components/States.tsx';
import { dateText } from '../lib/format.ts';

function useCandidateJobs() {
  const applied = useApi<TrackerList>('tracker:list:applied:', () => call('listTracker', { query: { view: 'applied' } }));
  const liked = useApi<TrackerList>('tracker:list:liked:', () => call('listTracker', { query: { view: 'liked' } }));
  return useMemo(() => {
    const seen = new Map<string, { id: string; label: string }>();
    for (const it of [...(applied.data?.items ?? []), ...(liked.data?.items ?? [])]) seen.set(it.job.id, { id: it.job.id, label: `${it.job.title} at ${it.job.company}` });
    return [...seen.values()];
  }, [applied.data, liked.data]);
}

function Highlight({ text, marks }: { text: string; marks: string[] }) {
  if (!marks.length) return <>{text}</>;
  const re = new RegExp(`(${marks.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
  return <>{text.split(re).map((p, i) => (marks.includes(p) ? <mark key={i} style={{ background: 'var(--jl-warn-tint)', color: 'var(--jl-warn)', fontWeight: 600 }}>{p}</mark> : <span key={i}>{p}</span>))}</>;
}

function Question({ s, q, jobId }: { s: PracticeSession; q: PracticeSession['questions'][number]; jobId: string }) {
  const ai = useAiSettings();
  const [answer, setAnswer] = useState('');
  const [fb, setFb] = useState<{ feedback: string; sampleAnswer: string | null; placeholders: string[] } | null>(null);
  const [busy, setBusy] = useState<'fb' | 'save' | null>(null);
  const [err, setErr] = useState<UiError | null>(null);
  const [saved, setSaved] = useState(false);
  useDirty(`practice:${q.id}`, !!answer.trim() && !saved, 'your practice answer');
  const feedback = async () => {
    if (!(await ensureAiConsent(ai.data, 'practice'))) return;
    setBusy('fb'); setErr(null);
    try { setFb(await call('practiceFeedback', { body: { sessionId: s.id, questionId: q.id, answer } })); afterAiStep(null); } catch (e) { setErr(e as UiError); } finally { setBusy(null); }
  };
  const save = async () => {
    setBusy('save'); setErr(null);
    try {
      await call('savePracticeItem', { body: { jobId, kind: 'question', question: q.text, ...(answer.trim() ? { answer } : {}), ...(fb ? { feedback: fb.feedback } : {}) } });
      invalidate('practice');
      setSaved(true);
      ui.message?.success('Saved to your question bank.');
    } catch (e) { setErr(e as UiError); } finally { setBusy(null); }
  };
  return (
    <section className="jl-card-box" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} aria-label={q.text}>
      <div className="jl-row jl-wrap"><Tag>Practice question</Tag>{q.target && <Tag color="green">{q.target}</Tag>}{q.gap && <Tag color="gold">Not in your profile yet: prepare this</Tag>}</div>
      <strong style={{ fontSize: 16 }}>{q.text}</strong>
      <Input.TextArea value={answer} onChange={(e) => { setAnswer(e.target.value); setSaved(false); }} autoSize={{ minRows: 3, maxRows: 12 }} placeholder="Write your answer the way you would say it" aria-label={`Your answer to: ${q.text}`} maxLength={20000} />
      <AiNote kind="practice" what="get feedback" />
      <Space wrap>
        <Button type="primary" shape="round" disabled={!answer.trim()} loading={busy === 'fb'} onClick={() => { void feedback(); }}>Get feedback</Button>
        <Button shape="round" icon={<SaveOutlined />} loading={busy === 'save'} disabled={saved} onClick={() => { void save(); }}>{saved ? 'Saved' : 'Save to my question bank'}</Button>
      </Space>
      <InlineError error={err} />
      {fb && (
        <div className="jl-factbox" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <strong>Feedback</strong>
          <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{fb.feedback}</p>
          {fb.sampleAnswer && (<>
            <strong>A shape for your answer</strong>
            <p style={{ margin: 0 }}><Highlight text={fb.sampleAnswer} marks={fb.placeholders} /></p>
            {fb.placeholders.length > 0 && <span className="jl-small jl-muted">Marked parts are placeholders. Fill them with your own true facts; jobleft does not invent achievements.</span>}
          </>)}
        </div>
      )}
    </section>
  );
}

function Bank({ jobs }: { jobs: Array<{ id: string; label: string }> }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const items = useApi<PracticeItem[]>(`practice:items:${jobId ?? 'all'}`, () => call('listPracticeItems', { query: jobId ? { jobId } : {} }));
  const [debrief, setDebrief] = useState('');
  const [debriefJob, setDebriefJob] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; answer: string; notes: string } | null>(null);
  useDirty('debrief', !!debrief.trim(), 'your debrief');
  const label = (id: string) => jobs.find((j) => j.id === id)?.label ?? 'A job';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section className="jl-card-box" style={{ display: 'flex', flexDirection: 'column', gap: 8 }} aria-labelledby="deb-h">
        <h2 id="deb-h" className="jl-section-title" style={{ fontSize: 17, margin: 0 }}>Add a debrief after an interview</h2>
        <p className="jl-muted" style={{ margin: 0 }}>Write down the questions you were asked and how it went, while you remember. Free, kept on this Mac.</p>
        <Select placeholder="Which job?" value={debriefJob ?? undefined} onChange={setDebriefJob} options={jobs.map((j) => ({ value: j.id, label: j.label }))} aria-label="Job for this debrief" />
        <Input.TextArea value={debrief} onChange={(e) => setDebrief(e.target.value)} autoSize={{ minRows: 3 }} placeholder="Questions you were asked, what went well, what to prepare next time" aria-label="Debrief notes" maxLength={20000} />
        <Button type="primary" shape="round" style={{ alignSelf: 'flex-start' }} disabled={!debrief.trim() || !debriefJob} onClick={async () => {
          try { await call('savePracticeItem', { body: { jobId: debriefJob!, kind: 'debrief', notes: debrief.trim() } }); setDebrief(''); invalidate('practice'); ui.message?.success('Debrief saved.'); } catch (e) { ui.message?.error((e as UiError).message); }
        }}>Save debrief</Button>
      </section>
      <div className="jl-row"><span className="jl-grow" style={{ fontWeight: 600 }}>Saved questions, answers and debriefs</span>
        <Select allowClear placeholder="Every job" value={jobId ?? undefined} onChange={(v) => setJobId(v ?? null)} style={{ width: 320 }} options={jobs.map((j) => ({ value: j.id, label: j.label }))} aria-label="Show items for one job" />
      </div>
      {items.error && <InlineError error={items.error} onRetry={() => { void items.reload(); }} />}
      {items.data && !items.data.length && <EmptyState art="chat" title="Your question bank is empty" text="Save a practice question or a debrief, and it is kept here with its job." />}
      {items.data?.map((it) => (
        <article key={it.id} className="jl-card-box" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="jl-row"><Tag>{it.kind === 'debrief' ? 'Debrief' : 'Practice question'}</Tag><a className="jl-grow" href={`#/jobs/${encodeURIComponent(it.jobId)}`}>{label(it.jobId)}</a><span className="jl-small jl-muted">{dateText(it.updatedAt)}</span>
            <Popconfirm title="Delete this item?" okText="Delete" okButtonProps={{ danger: true }} onConfirm={async () => { try { await call('deletePracticeItem', { params: { itemId: it.id } }); invalidate('practice'); } catch (e) { ui.message?.error((e as UiError).message); } }}>
              <Button size="small" type="text" icon={<DeleteOutlined />} aria-label="Delete this item" />
            </Popconfirm>
          </div>
          {it.question && <strong>{it.question}</strong>}
          {editing?.id === it.id ? (
            <Space direction="vertical" style={{ width: '100%' }}>
              {it.kind === 'question' && <Input.TextArea value={editing.answer} onChange={(e) => setEditing({ ...editing, answer: e.target.value })} autoSize={{ minRows: 2 }} aria-label="Your answer" />}
              <Input.TextArea value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} autoSize={{ minRows: 2 }} aria-label="Notes" placeholder="Notes" />
              <Space><Button size="small" type="primary" shape="round" onClick={async () => {
                try { await call('updatePracticeItem', { params: { itemId: it.id }, body: { answer: editing.answer || null, notes: editing.notes || null } }); setEditing(null); invalidate('practice'); ui.message?.success('Saved.'); } catch (e) { ui.message?.error((e as UiError).message); }
              }}>Save</Button><Button size="small" shape="round" onClick={() => setEditing(null)}>Cancel</Button></Space>
            </Space>
          ) : (
            <>
              {it.answer && <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{it.answer}</p>}
              {it.feedback && <p className="jl-small jl-muted" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>Feedback: {it.feedback}</p>}
              {it.notes && <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{it.notes}</p>}
              <Button size="small" type="link" style={{ padding: 0, alignSelf: 'flex-start' }} onClick={() => setEditing({ id: it.id, answer: it.answer ?? '', notes: it.notes ?? '' })}>Edit</Button>
            </>
          )}
        </article>
      ))}
    </div>
  );
}

export function InterviewScreen() {
  const ai = useAiSettings();
  const jobs = useCandidateJobs();
  const [jobId, setJobId] = useState<string | null>(() => queryParam('job'));
  const [session, setSession] = useState<PracticeSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<UiError | null>(null);
  const [tab, setTab] = useState('practice');
  const direct = useApi(jobId && !jobs.some((j) => j.id === jobId) ? `job:${jobId}` : null, () => call('getJob', { params: { jobId: jobId! } }));
  const options = [...jobs, ...(direct.data ? [{ id: direct.data.job.id, label: `${direct.data.job.title} at ${direct.data.job.company}` }] : [])];
  useEffect(() => { setSession(null); setErr(null); }, [jobId]);
  const start = async () => {
    if (!jobId || !(await ensureAiConsent(ai.data, 'practice'))) return;
    setBusy(true); setErr(null);
    try { setSession(await call('startPractice', { body: { jobId } })); afterAiStep(null); } catch (e) { setErr(e as UiError); } finally { setBusy(false); }
  };
  return (
    <div className="jl-page">
      <div className="jl-page-inner" style={{ maxWidth: 920 }}>
        <Tabs activeKey={tab} onChange={setTab} items={[
          {
            key: 'practice', label: 'Practice for a job',
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <p className="jl-muted">Practice questions are made from a job's posting and your profile. They are practice, not questions this employer is known to ask.</p>
                {!options.length ? (
                  <EmptyState art="chat" title="Pick a job to practice for" text="Like or apply to a job first, or open a job and choose Practice interview questions." action={<Button type="primary" shape="round" onClick={() => navigate('jobs')}>Browse jobs</Button>} />
                ) : (
                  <>
                    <Select value={jobId ?? undefined} onChange={setJobId} placeholder="Choose a job" options={options.map((j) => ({ value: j.id, label: j.label }))} aria-label="Job to practice for" showSearch optionFilterProp="label" />
                    <AiNote kind="practice" what="make practice questions" />
                    <Button type="primary" shape="round" style={{ alignSelf: 'flex-start' }} disabled={!jobId} loading={busy} onClick={() => { void start(); }}>{session ? 'Make new questions' : 'Start practice'}</Button>
                  </>
                )}
                <InlineError error={err} />
                {session && (
                  <>
                    <Alert type="info" showIcon message={`${session.questions.length} practice questions for ${session.title} at ${session.company}.`} />
                    {session.questions.map((q) => <Question key={q.id} s={session} q={q} jobId={session.jobId} />)}
                  </>
                )}
                {!session && !busy && options.length > 0 && !jobId && <Empty description="Choose a job to begin." />}
              </div>
            ),
          },
          { key: 'bank', label: 'My question bank', children: <Bank jobs={options} /> },
        ]} />
      </div>
    </div>
  );
}
