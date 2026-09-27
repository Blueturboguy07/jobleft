// The detail's AI and resume tools. Nothing is saved until the person accepts it; an AI step starts only on a click
// that names it, after the note says where the text goes and what it costs.

import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Drawer, Empty, Input, Select, Space, Table, Tag } from 'antd';
import { CopyOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import type { CoverLetter, Job, KeywordGapReport, Resume, TailorProposal } from '@jobleft/contracts';
import { call, type UiError } from '../../app/api.ts';
import { invalidate, useApi } from '../../app/data.ts';
import { confirmDiscard, ui, useDirty } from '../../app/layers.ts';
import { navigate } from '../../app/router.ts';
import { useAiSettings } from '../../app/session.ts';
import { AiNote, afterAiStep, ensureAiConsent } from '../../components/AiNote.tsx';
import { InlineError, Loading } from '../../components/States.tsx';
import { ago, changeName } from '../../lib/format.ts';

function changeLabel(field: string): string {
  if (field === 'skills.order') return 'Change to the order of your skills (no skill is added)';
  if (field === 'bullets.order') return 'Change to the order of the bullets under one job (no bullet is changed)';
  if (field === 'summary') return 'Change to your summary';
  if (field.startsWith('bullets[')) return 'Change to one bullet';
  if (field === 'item') return 'Your profile has other facts for this entry (a corrected date, title or name)';
  if (field === 'skills.rename') return 'Your profile spells this skill another way';
  return 'Change to your resume';
}

function useResumes() {
  return useApi<Resume[]>('resumes', () => call('listResumes'));
}

function ResumePick({ value, onChange }: { value: string | null; onChange: (id: string) => void }) {
  const r = useResumes();
  const bases = (r.data ?? []).filter((x) => x.kind === 'base');
  useEffect(() => {
    if (!value && bases.length) onChange((bases.find((x) => x.isPrimary) ?? bases[0]!).id);
  }, [bases.length]);
  if (r.error) return <InlineError error={r.error} onRetry={() => { void r.reload(); }} />;
  if (r.data && !bases.length) return <Alert type="info" showIcon message="You have no resume yet." action={<Button size="small" onClick={() => navigate('resume')}>Add a resume</Button>} />;
  return (
    <label className="jl-row">Resume
      <Select style={{ minWidth: 280 }} value={value ?? undefined} onChange={onChange} aria-label="Resume to use" loading={!r.data}
        options={bases.map((b) => ({ value: b.id, label: `${b.name}${b.isPrimary ? ' (primary)' : ''}` }))} />
    </label>
  );
}

export function TailorDrawer({ job, open, onClose }: { job: Job; open: boolean; onClose: () => void }) {
  const ai = useAiSettings();
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [prop, setProp] = useState<TailorProposal | null>(null);
  const [accept, setAccept] = useState<string[]>([]);
  const [busy, setBusy] = useState<'draft' | 'save' | null>(null);
  const [err, setErr] = useState<UiError | null>(null);
  useDirty('tailor', !!prop, 'the tailoring draft');
  useEffect(() => { if (!open) { setProp(null); setErr(null); } }, [open]);
  const draft = async () => {
    if (!resumeId || !(await ensureAiConsent(ai.data, 'tailor'))) return;
    setBusy('draft'); setErr(null);
    try {
      const p = await call('tailorResume', { params: { resumeId }, body: { jobId: job.id } });
      setProp(p);
      setAccept(p.changes.map((c) => c.id));
      invalidate('ai:publik');
      afterAiStep((p as TailorProposal & { costMicros?: number | null }).costMicros);
    } catch (e) { setErr(e as UiError); invalidate('ai:publik'); } finally { setBusy(null); }
  };
  const save = async () => {
    if (!prop || !resumeId) return;
    setBusy('save'); setErr(null);
    try {
      const r = await call('acceptTailoring', { params: { resumeId }, body: { proposalId: prop.id, acceptChangeIds: accept } });
      invalidate('resumes');
      setProp(null);
      ui.message?.success(`Saved "${r.name}" as a tailored version.`);
      onClose();
      navigate(`resume/${encodeURIComponent(r.id)}`, { force: true });
    } catch (e) { setErr(e as UiError); } finally { setBusy(null); }
  };
  return (
    <Drawer open={open} width="min(760px, 94vw)" title={`Tailor a resume for ${job.title}`} onClose={async () => { if (await confirmDiscard(prop ? ['the tailoring draft'] : [])) { setProp(null); onClose(); } }}
      footer={prop && (
        <div className="jl-row">
          <span className="jl-grow jl-muted">{accept.length} of {prop.changes.length} changes chosen. {accept.length ? 'Your base resume stays as it is.' : 'With none chosen, nothing is saved and your base resume is what you download.'}</span>
          <Button shape="round" onClick={() => setProp(null)}>{accept.length ? 'Discard draft' : 'Keep my base resume as it is'}</Button>
          <Button type="primary" shape="round" loading={busy === 'save'} disabled={!accept.length} onClick={() => { void save(); }}>Save tailored version</Button>
        </div>
      )}>
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <p>jobleft drafts changes that only use facts from your profile. You choose which changes to keep. Nothing is saved until you do.</p>
        <ResumePick value={resumeId} onChange={setResumeId} />
        {!prop && <>
          <AiNote kind="tailor" what="draft a tailored version" />
          <Button type="primary" shape="round" disabled={!resumeId} loading={busy === 'draft'} onClick={() => { void draft(); }}>Draft tailored changes</Button>
        </>}
        {busy === 'draft' && <Loading label="Drafting changes" inline />}
        <InlineError error={err} />
        {prop && (
          <>
            {!prop.changes.length && <Alert type="info" showIcon message="No change was needed: your resume already fits this job as well as your profile allows." />}
            {prop.changes.map((c) => (
              <div key={c.id} className="jl-factbox" style={{ display: 'flex', gap: 12 }}>
                <Checkbox checked={accept.includes(c.id)} onChange={(e) => setAccept(e.target.checked ? [...accept, c.id] : accept.filter((x) => x !== c.id))} aria-label={changeName(c)} />
                <div className="jl-grow" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span className="jl-small jl-muted">{changeLabel(c.field)}</span>
                  <span className="jl-small jl-muted">Before</span>
                  <del style={{ color: 'var(--jl-text3)', whiteSpace: 'pre-wrap' }}>{c.before}</del>
                  <span className="jl-small jl-muted">After</span>
                  <span style={{ whiteSpace: 'pre-wrap' }}><strong>{c.after}</strong></span>
                  {c.warning && <span className="jl-chip warn" style={{ alignSelf: 'flex-start' }}>{c.warning}</span>}
                </div>
              </div>
            ))}
            {prop.notice && <Alert type="info" showIcon message={prop.notice} />}
            {prop.gaps.length > 0 && (
              <Alert type="warning" showIcon message="Not in your profile"
                description={<>
                  <div className="jl-row jl-wrap" style={{ margin: '4px 0' }}>{prop.gaps.map((g) => <Tag key={g}>{g}</Tag>)}</div>
                  The job asks for these and your profile does not show them, so jobleft does not add them. If one is true, add it to your profile yourself; nothing goes on a resume until you do.
                </>} />
            )}
            {prop.violations.length > 0 && <Alert type="info" showIcon message="Removed from the draft" description={<ul style={{ margin: 0, paddingLeft: 18 }}>{prop.violations.map((v, i) => <li key={i}>{v.reason}</li>)}</ul>} />}
          </>
        )}
      </Space>
    </Drawer>
  );
}

export function CoverLetterDrawer({ job, open, onClose }: { job: Job; open: boolean; onClose: () => void }) {
  const ai = useAiSettings();
  const letters = useApi<CoverLetter[]>(open ? `letters:${job.id}` : null, () => call('listCoverLetters', { query: { jobId: job.id } }));
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [current, setCurrent] = useState<CoverLetter | null>(null);
  const [text, setText] = useState('');
  const [instr, setInstr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<UiError | null>(null);
  useEffect(() => { if (letters.data && !current && letters.data.length) { const l = letters.data.at(-1)!; setCurrent(l); setText(l.text); } }, [letters.data]);
  const dirty = !!current && text !== current.text;
  useDirty('letter', dirty, 'the cover letter');
  const all = letters.data ?? [];
  // Every letter for this job stays reachable (a new letter never hides the older ones) and each can be deleted
  // (JL-resume-18).
  const show = async (id: string) => {
    if (dirty && !(await confirmDiscard(['the cover letter']))) return;
    const l = all.find((x) => x.id === id);
    if (l) { setCurrent(l); setText(l.text); }
  };
  const remove = async () => {
    if (!current) return;
    const ok = await ui.modal?.confirm({ title: 'Delete this cover letter?', content: 'This cannot be undone.', okText: 'Delete', okButtonProps: { danger: true, shape: 'round' }, cancelButtonProps: { shape: 'round' } });
    if (!ok) return;
    setBusy('delete'); setErr(null);
    try {
      await call('deleteCoverLetter', { params: { letterId: current.id } });
      const next = all.filter((l) => l.id !== current.id).at(-1) ?? null;
      setCurrent(next); setText(next?.text ?? '');
      invalidate('letters');
      ui.message?.success('Cover letter deleted.');
    } catch (e) { setErr(e as UiError); } finally { setBusy(null); }
  };
  const create = async () => {
    if (!resumeId || !(await ensureAiConsent(ai.data, 'coverLetter'))) return;
    setBusy('create'); setErr(null);
    try {
      const l = await call('createCoverLetter', { body: { jobId: job.id, resumeId } });
      setCurrent(l); setText(l.text);
      invalidate('letters');
      afterAiStep((l as CoverLetter & { costMicros?: number | null }).costMicros);
    } catch (e) { setErr(e as UiError); invalidate('ai:publik'); } finally { setBusy(null); }
  };
  const saveText = async () => {
    if (!current) return;
    setBusy('save'); setErr(null);
    try {
      const l = await call('updateCoverLetter', { params: { letterId: current.id }, body: { text } });
      setCurrent(l); setText(l.text);
      ui.message?.success('Cover letter saved.');
    } catch (e) { setErr(e as UiError); } finally { setBusy(null); }
  };
  const byRequest = async () => {
    if (!current || !instr.trim() || !(await ensureAiConsent(ai.data, 'coverLetter'))) return;
    setBusy('instr'); setErr(null);
    try {
      const l = await call('updateCoverLetter', { params: { letterId: current.id }, body: { instruction: instr.trim() } });
      setCurrent(l); setText(l.text); setInstr('');
      afterAiStep((l as CoverLetter & { costMicros?: number | null }).costMicros);
    } catch (e) { setErr(e as UiError); } finally { setBusy(null); }
  };
  const gaps = (current as (CoverLetter & { gaps?: string[] }) | null)?.gaps ?? [];
  return (
    <Drawer open={open} width="min(720px, 94vw)" title={`Cover letter for ${job.title}`} onClose={async () => { if (await confirmDiscard(dirty ? ['the cover letter'] : [])) { setCurrent(null); onClose(); } }}>
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <ResumePick value={resumeId} onChange={setResumeId} />
        <AiNote kind="coverLetter" what="write a cover letter" />
        <Button type="primary" shape="round" loading={busy === 'create'} disabled={!resumeId} onClick={() => { void create(); }}>{current ? 'Write a new letter' : 'Write a cover letter'}</Button>
        <InlineError error={err} />
        {all.length > 1 && current && (
          <label className="jl-row">Letter
            <Select style={{ minWidth: 280 }} value={current.id} onChange={(id) => { void show(id); }} aria-label="Cover letter to show"
              options={all.map((l, i) => ({ value: l.id, label: `Letter ${i + 1}, written ${ago(l.createdAt) ?? ''}${l.ready ? '' : ' (not ready)'}` }))} />
          </label>
        )}
        {current && (
          <>
            {current.notice && <Alert type="info" showIcon message={current.notice} />}
            {!current.ready && <Alert type="warning" showIcon message="This letter is not ready: these words do not trace to your profile. Remove them, or add them to your profile first if they are true."
              description={<ul style={{ margin: 0, paddingLeft: 18, overflowWrap: 'anywhere' }}>{current.violations.map((v, i) => <li key={i}><strong>{v.fact}</strong> ({v.where}): {v.reason}</li>)}</ul>} />}
            {gaps.length > 0 && <Alert type="info" showIcon message={`Not in your profile: ${gaps.join(', ')}. The letter does not claim ${gaps.length === 1 ? 'it' : 'them'}.`} />}
            <Input.TextArea value={text} onChange={(e) => setText(e.target.value)} autoSize={{ minRows: 10, maxRows: 24 }} aria-label="Cover letter text" />
            <div className="jl-row">
              <Button shape="round" icon={<CopyOutlined />} onClick={() => { void navigator.clipboard?.writeText(text).then(() => ui.message?.success('Copied.')); }}>Copy</Button>
              <Button type="primary" shape="round" icon={<EditOutlined />} disabled={!dirty} loading={busy === 'save'} onClick={() => { void saveText(); }}>Save edits</Button>
              {dirty && <span className="jl-small" style={{ color: 'var(--jl-warn)' }}>Unsaved edits</span>}
              <span className="jl-grow" />
              <Button shape="round" danger icon={<DeleteOutlined />} loading={busy === 'delete'} onClick={() => { void remove(); }}>Delete this letter</Button>
            </div>
            <div className="jl-row">
              <Input value={instr} onChange={(e) => setInstr(e.target.value)} placeholder="Ask for a change, for example: make it shorter" aria-label="Change the letter by request" maxLength={2000} onPressEnter={() => { void byRequest(); }} />
              <Button shape="round" loading={busy === 'instr'} disabled={!instr.trim()} onClick={() => { void byRequest(); }}>Change it</Button>
            </div>
            <AiNote kind="coverLetter" what="change the letter by request" />
          </>
        )}
      </Space>
    </Drawer>
  );
}

export function GapsDrawer({ job, open, onClose }: { job: Job; open: boolean; onClose: () => void }) {
  const [resumeId, setResumeId] = useState<string | null>(null);
  const rep = useApi<KeywordGapReport>(open && resumeId ? `gaps:${job.id}:${resumeId}` : null, () => call('keywordGaps', { params: { jobId: job.id }, query: { resumeId: resumeId! } }));
  const label = { covered: 'In your resume', in_profile_not_resume: 'In your profile, not in this resume', not_in_profile: 'Not in your profile' } as const;
  const color = { covered: 'green', in_profile_not_resume: 'gold', not_in_profile: 'default' } as const;
  return (
    <Drawer open={open} width="min(640px, 94vw)" title={`Keyword check for ${job.title}`} onClose={onClose}>
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <p>Runs on this Mac, free. It compares the skills the posting names with your resume and your profile.</p>
        <ResumePick value={resumeId} onChange={setResumeId} />
        {rep.error && <InlineError error={rep.error} onRetry={() => { void rep.reload(); }} />}
        {rep.loading && !rep.data && <Loading label="Checking" inline />}
        {rep.data && !rep.data.requirementsFound && <Alert type="info" showIcon message="jobleft could not read the requirements of this posting, so it cannot say what is missing." />}
        {rep.data && rep.data.requirementsFound && (
          rep.data.terms.length ? (
            <Table size="small" pagination={false} rowKey="term" dataSource={rep.data.terms}
              columns={[
                { title: 'Skill the posting names', dataIndex: 'term' },
                { title: 'Where it is', dataIndex: 'status', render: (s: keyof typeof label) => <Tag color={color[s]}>{label[s]}</Tag> },
              ]} />
          ) : <Empty description="The posting names no skills jobleft can recognise." />
        )}
      </Space>
    </Drawer>
  );
}
