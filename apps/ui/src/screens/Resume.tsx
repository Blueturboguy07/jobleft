// The resume workspace: base resumes and tailored versions, with their readability grade. Add a resume by upload
// (PDF or Word, up to 10 MB) or from the profile. An upload shows what it could and could not read, and proposes
// profile facts that the person confirms; nothing changes in the profile without that click.

import { useRef, useState } from 'react';
import { Alert, Button, Dropdown, Input, Modal, Space, Table, Tag } from 'antd';
import { Tooltip } from '../components/Tip.tsx';
import { DeleteOutlined, EllipsisOutlined, FormOutlined, PlusOutlined, StarFilled, ToolOutlined, UploadOutlined, UserOutlined } from '@ant-design/icons';
import type { CoverLetter, ImportReport, ProfileInput, Resume } from '@jobleft/contracts';
import { call, download, type UiError } from '../app/api.ts';
import { invalidate, useApi } from '../app/data.ts';
import { ui } from '../app/layers.ts';
import { navigate } from '../app/router.ts';
import { useProfile } from '../app/session.ts';
import { Art } from '../components/Art.tsx';
import { EmptyState, ErrorState, InlineError, Loading } from '../components/States.tsx';
import { ago, dateText, plural } from '../lib/format.ts';
import { importChanges, mergeImported } from '../lib/importMerge.ts';
import { toInput } from './Profile.tsx';
import { QuestionsModal, TailorForJobModal } from './resume/Extras.tsx';

export const useResumeList = () => useApi<Resume[]>('resumes', () => call('listResumes'));
const useLetterList = () => useApi<CoverLetter[]>('letters', () => call('listCoverLetters', { query: {} }));

const MAX = 10 * 1024 * 1024;
const TYPES: Record<string, string> = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

function ReportView({ r }: { r: ImportReport }) {
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <span>Read {plural(r.counts.jobs, 'job')}, {plural(r.counts.bullets, 'bullet')}, {plural(r.counts.skills, 'skill')} and {plural(r.counts.education, 'school')}.</span>
      {r.unreadSections.length > 0 && <Alert type="info" showIcon message={`Kept aside, not mapped: ${r.unreadSections.join(', ')}`} description="These sections are not lost. Add them by hand in the editor if you want them." />}
      {r.warnings.map((w) => <Alert key={w} type="warning" showIcon message={w} />)}
    </Space>
  );
}

/**
 * `stay`: opened from the Profile to fill it; "Update my profile" then keeps the person on the Profile, which shows the
 * new facts (JL-onboarding-26).
 */
export function AddResumeModal({ open, onClose, stay = false }: { open: boolean; onClose: () => void; stay?: boolean }) {
  const profile = useProfile();
  const resumes = useResumeList();
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<UiError | null>(null);
  const [result, setResult] = useState<{ resume: Resume; proposed: ProfileInput } | null>(null);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'choose' | 'profile'>('choose');
  const reset = () => { setErr(null); setResult(null); setMode('choose'); setName(''); };
  const upload = async (f: File) => {
    setErr(null);
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (!TYPES[ext]) { setErr({ code: 'bad_request', status: null, message: 'Use a PDF or a Word (.docx) file.', link: null }); return; }
    if (f.size > MAX) { setErr({ code: 'payload_too_large', status: null, message: 'The file is larger than 10 MB. Nothing was stored.', link: null }); return; }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const r = await call('importResume', { body: bytes, contentType: TYPES[ext], fileName: f.name });
      setResult({ resume: r.resume, proposed: r.proposedProfile });
      invalidate('resumes');
    } catch (e) { setErr(e as UiError); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  const applyProfile = async () => {
    if (!result) return;
    setBusy(true);
    try {
      // Only the facts the file states change; preferences, work authorization and answers stay as they are.
      await call('putProfile', { body: profile.data ? mergeImported(toInput(profile.data), result.proposed) : result.proposed });
      invalidate('profile', 'jobs:', 'job:', 'match:');
      ui.message?.success('Profile updated from your resume.');
      onClose(); reset();
      if (!stay) navigate(`resume/${encodeURIComponent(result.resume.id)}`);
    } catch (e) { setErr(e as UiError); } finally { setBusy(false); }
  };
  // a resume "from my profile" needs facts in it (the same rule as the resume engine)
  const p0 = profile.data;
  const canStartFromProfile = !!p0 && !!([p0.personal.firstName, p0.personal.lastName].some((x) => x?.trim()) || p0.work.length || p0.education.length || p0.skills.length);
  const fromProfile = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await call('createResume', { body: { name: name.trim() || 'My resume' } });
      invalidate('resumes');
      onClose(); reset();
      navigate(`resume/${encodeURIComponent(r.id)}`);
    } catch (e) { setErr(e as UiError); } finally { setBusy(false); }
  };
  const changes = result ? importChanges(profile.data ? toInput(profile.data) : undefined, result.proposed) : { lines: [], replaces: [] };
  const diff = changes.lines;
  // The same file added before (same content): say so, and offer to remove the new copy (JL-resume-3).
  const same = result?.resume.file ? (resumes.data ?? []).find((x) => x.id !== result.resume.id && x.file?.sha256 === result.resume.file!.sha256) : undefined;
  const dropCopy = async () => {
    if (!result) return;
    setBusy(true);
    try { await call('deleteResume', { params: { resumeId: result.resume.id }, query: {} }); invalidate('resumes'); ui.message?.success('The copy was removed.'); onClose(); reset(); } catch (e) { setErr(e as UiError); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onCancel={() => { onClose(); reset(); }} footer={null} width={640} title={result ? 'Resume added' : 'Add a resume'} destroyOnClose>
      {!result && mode === 'choose' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center', padding: '8px 0' }}>
          <Art kind="doc" />
          <p className="jl-muted">PDF or Word (.docx), up to 10 MB. The file stays on this Mac.</p>
          <input ref={input} type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} aria-label="Resume file" />
          <Space wrap>
            <Button type="primary" shape="round" size="large" icon={<UploadOutlined />} loading={busy} onClick={() => input.current?.click()}>Upload a file</Button>
            {canStartFromProfile && <Button shape="round" size="large" icon={<UserOutlined />} onClick={() => setMode('profile')}>Start from my profile</Button>}
          </Space>
          <InlineError error={err} />
        </div>
      )}
      {!result && mode === 'profile' && (
        <Space direction="vertical" style={{ width: '100%' }}>
          <p>jobleft builds a resume from the facts in your profile. You can edit it after.</p>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Resume name, for example Data analyst resume" aria-label="Resume name" maxLength={200} />
          <Space><Button type="primary" shape="round" loading={busy} onClick={() => { void fromProfile(); }}>Create resume</Button><Button shape="round" onClick={() => setMode('choose')}>Back</Button></Space>
          <InlineError error={err} />
        </Space>
      )}
      {result && (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          {same && <Alert type="info" showIcon message={`You already added this file on ${dateText(same.createdAt) ?? 'an earlier day'} as "${same.name}". This copy is named "${result.resume.name}".`}
            action={<Button size="small" shape="round" loading={busy} onClick={() => { void dropCopy(); }}>Remove this copy</Button>} />}
          {result.resume.importReport && <ReportView r={result.resume.importReport} />}
          {diff.length ? (
            <div className="jl-factbox">
              <strong>Use these facts from the file in your profile?</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, overflowWrap: 'anywhere' }}>{diff.map((d, i) => <li key={i}>{d}</li>)}</ul>
              {changes.replaces.length > 0 && (
                <Alert style={{ marginTop: 8 }} type="warning" showIcon message="This replaces or removes these parts of your profile"
                  description={<ul style={{ margin: 0, paddingLeft: 18, overflowWrap: 'anywhere' }}>{changes.replaces.map((d, i) => <li key={i}>{d}</li>)}</ul>} />
              )}
              <p className="jl-small jl-muted" style={{ marginTop: 6 }}>Your profile drives your match scores. Nothing changes unless you press the button, and the button changes only what is listed. Your links, your skills and any job or school the file does not mention stay. Your job preferences and answers are never changed by a file.</p>
            </div>
          ) : <p className="jl-muted">Your profile already has these facts.</p>}
          <Space wrap>
            {diff.length > 0 && <Button type="primary" shape="round" loading={busy} onClick={() => { void applyProfile(); }}>Update my profile</Button>}
            <Button shape="round" onClick={() => { const id = result.resume.id; onClose(); reset(); navigate(`resume/${encodeURIComponent(id)}`); }}>{diff.length ? 'Keep my profile as it is' : 'Open the resume'}</Button>
          </Space>
          <InlineError error={err} />
        </Space>
      )}
    </Modal>
  );
}

export function ResumeScreen() {
  const list = useResumeList();
  const letters = useLetterList();
  const [adding, setAdding] = useState(false);
  const [tailoring, setTailoring] = useState(false);
  const [asking, setAsking] = useState(false);
  const [renaming, setRenaming] = useState<Resume | null>(null);
  const [rn, setRn] = useState({ name: '', target: '' });
  const act = async (r: Resume, key: string) => {
    try {
      if (key === 'open') navigate(`resume/${encodeURIComponent(r.id)}`);
      if (key === 'primary') { await call('updateResume', { params: { resumeId: r.id }, body: { isPrimary: true } }); invalidate('resumes'); ui.message?.success(`"${r.name}" is now your primary resume.`); }
      if (key === 'rename') { setRenaming(r); setRn({ name: r.name, target: r.targetTitle ?? '' }); }
      if (key === 'pdf' || key === 'docx' || key === 'original') { const f = await download('exportResume', { params: { resumeId: r.id }, query: { format: key } }); ui.message?.success(`Saved ${f} to your Downloads.`); }
      if (key === 'delete') {
        const versions = (list.data ?? []).filter((x) => x.baseResumeId === r.id);
        const ids = new Set([r.id, ...versions.map((v) => v.id)]);
        // The confirm names everything that goes (JL-resume-24): versions and cover letters made with this resume.
        const own = (letters.data ?? []).filter((l) => ids.has(l.resumeId)).length;
        const also = [versions.length ? plural(versions.length, 'tailored version') : '', own ? plural(own, 'cover letter') : ''].filter(Boolean).join(' and ');
        const ok = await ui.modal?.confirm({
          title: `Delete "${r.name}"?`, content: also ? `Its ${also} will be deleted too. This cannot be undone.` : 'This cannot be undone.',
          okText: 'Delete', okButtonProps: { danger: true, shape: 'round' }, cancelButtonProps: { shape: 'round' },
        });
        if (!ok) return;
        await call('deleteResume', { params: { resumeId: r.id }, query: also ? { withVersions: 'true' } : {} });
        invalidate('resumes', 'letters');
        ui.message?.success('Deleted.');
      }
    } catch (e) { ui.message?.error((e as UiError).message); }
  };
  if (list.error && !list.data) return <div className="jl-page"><ErrorState error={list.error} onRetry={() => { void list.reload(); }} /></div>;
  if (!list.data) return <div className="jl-page"><Loading label="Loading your resumes" /></div>;
  const rows = [...list.data].sort((a, b) => (a.kind === b.kind ? (a.updatedAt < b.updatedAt ? 1 : -1) : a.kind === 'base' ? -1 : 1));
  return (
    <div className="jl-page">
      <div className="jl-page-inner">
        <div className="jl-row" style={{ marginBottom: 12 }}>
          <p className="jl-grow jl-info-line" style={{ margin: 0 }}>You have {plural(list.data.filter((r) => r.kind === 'base').length, 'resume')} and {plural(list.data.filter((r) => r.kind === 'tailored').length, 'tailored version')}. Match scores use your profile, not a resume.</p>
          <Button shape="round" size="large" icon={<FormOutlined />} onClick={() => setAsking(true)}>Answer a few questions</Button>
          <Button shape="round" size="large" icon={<ToolOutlined />} onClick={() => setTailoring(true)} disabled={!list.data.some((r) => r.kind === 'base')}>Tailor for a job</Button>
          <Button shape="round" size="large" icon={<PlusOutlined />} onClick={() => setAdding(true)}>Add resume</Button>
        </div>
        {!rows.length ? (
          <EmptyState art="doc" title="No resumes yet" text="Upload a PDF or Word file, or build one from your profile." action={<Button type="primary" shape="round" icon={<UploadOutlined />} onClick={() => setAdding(true)}>Add a resume</Button>} />
        ) : (
          <div className="jl-card-box" style={{ padding: 8 }}>
            <Table rowKey="id" dataSource={rows} pagination={false}
              columns={[
                {
                  title: 'Resume', key: 'name', render: (_, r) => (
                    <div className="jl-row" style={{ gap: 10 }}>
                      {r.atsReport ? <Tooltip title={`Readability grade ${r.atsReport.grade} (${r.atsReport.score} of 100)`}><span className={`jl-grade ${r.atsReport.grade}`} aria-label={`Grade ${r.atsReport.grade}`}>{r.atsReport.grade}</span></Tooltip> : <span className="jl-grade" style={{ background: 'var(--jl-chip)' }} aria-label="Not graded yet">–</span>}
                      <a href={`#/resume/${encodeURIComponent(r.id)}`} style={{ fontWeight: 600, color: '#000', overflowWrap: 'anywhere' }}>{r.name}</a>
                      {r.isPrimary && <Tag color="green" icon={<StarFilled />}>PRIMARY</Tag>}
                      {r.kind === 'tailored' && <Tag>Tailored</Tag>}
                    </div>
                  ),
                },
                { title: 'Target job title', key: 't', render: (_, r) => r.targetTitle ?? <span className="jl-muted">Not set</span> },
                {
                  title: 'For job', key: 'j', render: (_, r) => r.kind === 'tailored' && r.jobId
                    ? <a href={`#/jobs/${encodeURIComponent(r.jobId)}`}>{r.name.includes(' for ') ? r.name.slice(r.name.indexOf(' for ') + 5) : 'Open the job'}</a>
                    : <span className="jl-muted">Base resume</span>,
                },
                {
                  title: 'Made from', key: 'b', render: (_, r) => {
                    const base = r.baseResumeId ? list.data?.find((x) => x.id === r.baseResumeId) : null;
                    return r.kind === 'tailored' ? (base ? <a href={`#/resume/${encodeURIComponent(base.id)}`}>{base.name}</a> : <span className="jl-muted">Its base was deleted</span>) : <span className="jl-muted">{r.file ? r.file.fileName : 'Your profile'}</span>;
                  },
                },
                { title: 'Last changed', key: 'u', render: (_, r) => <span title={dateText(r.updatedAt) ?? ''}>{ago(r.updatedAt)}</span> },
                { title: 'Created', key: 'c', render: (_, r) => <span title={dateText(r.createdAt) ?? ''}>{ago(r.createdAt)}</span> },
                {
                  title: <span className="jl-sr">Actions</span>, key: 'a', width: 56, render: (_, r) => (
                    <Dropdown trigger={['click']} menu={{
                      items: [
                        { key: 'open', label: 'Open and edit' },
                        { key: 'primary', label: 'Make primary', disabled: r.isPrimary || r.kind !== 'base' },
                        { key: 'rename', label: 'Rename and target title' },
                        { key: 'pdf', label: 'Export as PDF' },
                        { key: 'docx', label: 'Export as Word' },
                        ...(r.file ? [{ key: 'original', label: 'Download the original file (as uploaded)' }] : []),
                        { type: 'divider' },
                        { key: 'delete', label: 'Delete', danger: true },
                      ],
                      onClick: ({ key }) => { void act(r, key); },
                    }}>
                      <Button shape="circle" icon={<EllipsisOutlined />} aria-label={`Actions for ${r.name}`} />
                    </Dropdown>
                  ),
                },
              ]} />
          </div>
        )}
      </div>
      <LetterList letters={letters} resumes={list.data} />
      <AddResumeModal open={adding} onClose={() => setAdding(false)} />
      <TailorForJobModal open={tailoring} onClose={() => setTailoring(false)} />
      <QuestionsModal open={asking} onClose={() => setAsking(false)} />
      <Modal open={!!renaming} title="Rename and target title" onCancel={() => setRenaming(null)} okText="Save" okButtonProps={{ shape: 'round', disabled: !rn.name.trim() }} cancelButtonProps={{ shape: 'round' }}
        onOk={async () => {
          if (!renaming) return;
          try {
            await call('updateResume', { params: { resumeId: renaming.id }, body: { name: rn.name.trim(), targetTitle: rn.target.trim() || null } });
            invalidate('resumes'); setRenaming(null); ui.message?.success('Saved.');
          } catch (e) { ui.message?.error((e as UiError).message); }
        }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <label>Name<Input value={rn.name} onChange={(e) => setRn({ ...rn, name: e.target.value })} maxLength={200} /></label>
          <label>Target job title<Input value={rn.target} onChange={(e) => setRn({ ...rn, target: e.target.value })} placeholder="For example: Data analyst" /></label>
        </Space>
      </Modal>
    </div>
  );
}

/** Every cover letter in one place, with the job it is for and a delete (JL-resume-18). */
function LetterList({ letters, resumes }: { letters: ReturnType<typeof useLetterList>; resumes: Resume[] | undefined }) {
  const del = async (l: CoverLetter) => {
    const what = l.jobLabel ? `${l.jobLabel.title} · ${l.jobLabel.company}` : 'this job';
    const ok = await ui.modal?.confirm({ title: `Delete the cover letter for ${what}?`, content: 'This cannot be undone.', okText: 'Delete', okButtonProps: { danger: true, shape: 'round' }, cancelButtonProps: { shape: 'round' } });
    if (!ok) return;
    try { await call('deleteCoverLetter', { params: { letterId: l.id } }); invalidate('letters'); ui.message?.success('Cover letter deleted.'); } catch (e) { ui.message?.error((e as UiError).message); }
  };
  return (
    <div className="jl-page-inner" style={{ marginTop: 20 }}>
      <h2 className="jl-subhead">Cover letters</h2>
      {letters.error && !letters.data ? <InlineError error={letters.error} onRetry={() => { void letters.reload(); }} />
        : !letters.data ? <Loading label="Loading your cover letters" inline />
          : !letters.data.length ? <p className="jl-muted">No cover letters yet. Open a job and choose "Write a cover letter".</p> : (
            <div className="jl-card-box" style={{ padding: 8 }}>
              <Table rowKey="id" dataSource={[...letters.data].reverse()} pagination={false}
                columns={[
                  { title: 'For job', key: 'j', render: (_, l) => <a href={`#/jobs/${encodeURIComponent(l.jobId)}`} style={{ overflowWrap: 'anywhere' }}>{l.jobLabel ? `${l.jobLabel.title} · ${l.jobLabel.company}` : 'Open the job'}</a> },
                  { title: 'Resume used', key: 'r', render: (_, l) => <span className="jl-muted">{resumes?.find((x) => x.id === l.resumeId)?.name ?? 'Deleted'}</span> },
                  { title: 'State', key: 's', render: (_, l) => (l.ready ? <Tag color="green">Ready</Tag> : <Tag color="gold">Not ready</Tag>) },
                  { title: 'Last changed', key: 'u', render: (_, l) => <span title={dateText(l.updatedAt) ?? ''}>{ago(l.updatedAt)}</span> },
                  {
                    title: <span className="jl-sr">Actions</span>, key: 'a', width: 56, render: (_, l) => (
                      <Tooltip title="Delete this cover letter"><Button shape="circle" icon={<DeleteOutlined />} aria-label={`Delete the cover letter for ${l.jobLabel ? `${l.jobLabel.title} at ${l.jobLabel.company}` : 'this job'}, written ${ago(l.createdAt) ?? ''}`} onClick={() => { void del(l); }} /></Tooltip>
                    ),
                  },
                ]} />
            </div>
          )}
    </div>
  );
}
