// Two doors on the Resume screen (2026-09-27): "Tailor for a job" (pick any stored job, then the same TailorDrawer the
// job page uses) and "Answer a few questions" (fill concrete gaps in the profile, one field at a time, saved through
// the profile route; no model, no interview).
import { useEffect, useState } from 'react';
import { Button, Input, Modal, Select, Space } from 'antd';
import type { Job, Profile, ProfileInput } from '@jobleft/contracts';
import { call, type UiError } from '../../app/api.ts';
import { invalidate, setCached } from '../../app/data.ts';
import { ui } from '../../app/layers.ts';
import { useProfile } from '../../app/session.ts';
import { InlineError } from '../../components/States.tsx';
import { ANSWER_MAX, answerProblem, applyAnswer, profileQuestions, type Question } from '../../lib/profileQuestions.ts';
import { TailorDrawer } from '../detail/Tools.tsx';
import { toInput } from '../Profile.tsx';

/** Search the stored jobs (same debounce as the filters' company picker), resolve the pick to a full Job, then tailor. */
export function TailorForJobModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState<Array<{ value: string; label: string }>>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<UiError | null>(null);
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setOpts([]); return; }
    let alive = true;
    const h = setTimeout(async () => {
      try {
        const r = await call('searchJobs', { body: { sort: 'recommended', q: t, limit: 30, filter: {} } });
        if (alive) setOpts(r.items.map((it) => ({ value: it.job.id, label: `${it.job.title} · ${it.job.company}` })));
      } catch { if (alive) setOpts([]); }
    }, 250);
    return () => { alive = false; clearTimeout(h); };
  }, [q]);
  const pick = async (id: string) => {
    setBusy(true); setErr(null);
    try { const d = await call('getJob', { params: { jobId: id } }); setJob(d.job); } catch (e) { setErr(e as UiError); } finally { setBusy(false); }
  };
  return (
    <>
      <Modal open={open && !job} title="Tailor a resume for a job" onCancel={onClose} footer={null}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <span className="jl-muted">Pick a job from your feed. The draft keeps only facts that are in your profile.</span>
          <Select showSearch value={null} placeholder="Search a job title or company" filterOption={false} onSearch={setQ} options={opts} aria-label="Job to tailor for" loading={busy} style={{ width: '100%' }}
            notFoundContent={q.trim().length > 1 ? 'No job with those words in your jobs' : 'Type a job title or a company'} onChange={(v) => { if (v) void pick(v); }} />
          {err && <InlineError error={err} />}
        </Space>
      </Modal>
      {job && <TailorDrawer job={job} open onClose={() => { setJob(null); onClose(); }} />}
    </>
  );
}

/** One question at a time; every saved answer goes straight into the profile field the question names. */
export function QuestionsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const prof = useProfile();
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<UiError | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [done, setDone] = useState(0);
  useEffect(() => { if (open) { setSkipped([]); setDone(0); setAnswer(''); setErr(null); } }, [open]);
  const input: ProfileInput | null = prof.data ? toInput(prof.data as Profile) : null;
  const key = (qq: Question) => `${qq.kind}:${'workId' in qq ? qq.workId : 'educationId' in qq ? qq.educationId : ''}`;
  const pending = input ? profileQuestions(input).filter((qq) => !skipped.includes(key(qq))) : [];
  const q = pending[0] ?? null;
  const save = async () => {
    if (!input || !q) return;
    const problem = answerProblem(q, answer);
    if (problem) { setErr({ code: 'bad_request', status: null, message: problem, link: null }); return; }
    const next = applyAnswer(input, q, answer);
    if (next === input) { setSkipped((s) => [...s, key(q)]); setAnswer(''); return; }
    setBusy(true); setErr(null);
    try {
      const p = await call('putProfile', { body: next });
      setCached('profile', () => p);
      invalidate('jobs:', 'job:', 'match:', 'dashboard');
      setDone((n) => n + 1); setAnswer('');
    } catch (e) { setErr(e as UiError); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} title="Answer a few questions" onCancel={onClose} footer={null} destroyOnHidden>
      {!input ? <span className="jl-muted">Loading your profile…</span> : !q ? (
        <Space direction="vertical" style={{ width: '100%' }}>
          <span>{done > 0 ? `Saved ${done} answer${done === 1 ? '' : 's'} to your profile.` : 'Your profile has no gaps these questions cover.'}</span>
          <span className="jl-muted">Match scores and new tailored resumes use the profile as it is now.</span>
          <Button type="primary" shape="round" onClick={onClose}>Done</Button>
        </Space>
      ) : (
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <span className="jl-muted">{pending.length} left{done > 0 ? ` · ${done} saved` : ''}. Each answer goes into one field of your profile; nothing is rewritten.</span>
          <strong>{q.text}</strong>
          <span className="jl-small">{q.hint}</span>
          <Input.TextArea value={answer} onChange={(e) => { setAnswer(e.target.value); setErr(null); }} autoSize={{ minRows: 2, maxRows: 6 }} maxLength={ANSWER_MAX[q.kind]} showCount aria-label="Your answer" autoFocus
            onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); void save(); } }} />
          {err && <InlineError error={err} />}
          <Space>
            <Button type="primary" shape="round" loading={busy} disabled={!answer.trim()} onClick={() => { void save(); }}>Save and next</Button>
            <Button shape="round" onClick={() => { setSkipped((s) => [...s, key(q)]); setAnswer(''); setErr(null); }}>Skip</Button>
            <Button type="link" onClick={onClose}>Stop here</Button>
          </Space>
        </Space>
      )}
    </Modal>
  );
}
