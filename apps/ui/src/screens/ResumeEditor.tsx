// The resume editor. The header is copied from the profile (edit it there). Sections, entries and bullets are
// edited here and saved with Save; leaving with unsaved changes asks first, and a failed save keeps the text.
// The readability check grades the exact exported PDF, on this computer, for free.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Drawer, Dropdown, Input, Select, Space, Tag } from 'antd';
import { Tooltip } from '../components/Tip.tsx';
import { ArrowDownOutlined, ArrowUpOutlined, CloseOutlined, DeleteOutlined, DownloadOutlined, PlusOutlined, StarFilled, SaveOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import type { AtsReport, Resume, ResumeDocument, ResumeItem, ResumeSection } from '@jobleft/contracts';
import { call, download, type UiError } from '../app/api.ts';
import { invalidate, setCached, useApi } from '../app/data.ts';
import { confirmDiscard, ui, useDirty, useLayer } from '../app/layers.ts';
import { navigate } from '../app/router.ts';
import { ConflictNotice, EmptyState, ErrorState, InlineError, Loading } from '../components/States.tsx';
import { ago, plural } from '../lib/format.ts';

let idSeq = 0;
const nid = (p: string) => `${p}_new_${Date.now().toString(36)}_${++idSeq}`;
const KINDS: Array<{ value: ResumeSection['kind']; label: string }> = [
  { value: 'summary', label: 'Summary' }, { value: 'experience', label: 'Experience' }, { value: 'education', label: 'Education' },
  { value: 'skills', label: 'Skills' }, { value: 'projects', label: 'Projects' }, { value: 'certifications', label: 'Certifications' }, { value: 'custom', label: 'Other' },
];

function newItem(): ResumeItem {
  return { id: nid('it'), heading: '', subheading: '', location: null, startDate: null, endDate: null, current: false, bullets: [''], tags: [] };
}

function ItemEditor({ kind, item, onChange, onRemove }: { kind: ResumeSection['kind']; item: ResumeItem; onChange: (i: ResumeItem) => void; onRemove: () => void }) {
  if (kind === 'skills') {
    return (
      <Select mode="tags" style={{ width: '100%' }} value={item.tags} onChange={(tags) => onChange({ ...item, tags })} placeholder="Add a skill and press Enter" aria-label="Skills" open={false} suffixIcon={null} />
    );
  }
  const labels = kind === 'education' ? ['School', 'Degree and major'] : kind === 'projects' ? ['Project', 'Your role'] : ['Employer', 'Title'];
  return (
    <div className="jl-factbox" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="jl-row jl-wrap">
        <Input style={{ flex: '1 1 200px' }} value={item.heading ?? ''} onChange={(e) => onChange({ ...item, heading: e.target.value })} placeholder={labels[0]} aria-label={labels[0]} />
        <Input style={{ flex: '1 1 200px' }} value={item.subheading ?? ''} onChange={(e) => onChange({ ...item, subheading: e.target.value })} placeholder={labels[1]} aria-label={labels[1]} />
        <Tooltip title="Remove this entry"><Button type="text" icon={<DeleteOutlined />} aria-label={`Remove ${item.heading || 'this entry'}`} onClick={onRemove} /></Tooltip>
      </div>
      <div className="jl-row jl-wrap">
        <Input style={{ width: 170 }} value={item.location ?? ''} onChange={(e) => onChange({ ...item, location: e.target.value || null })} placeholder="Location" aria-label="Location" />
        <label className="jl-row">From <Input type="month" style={{ width: 150 }} value={item.startDate?.length === 7 ? item.startDate : ''} onChange={(e) => onChange({ ...item, startDate: e.target.value || null })} aria-label="Start month" /></label>
        <label className="jl-row">To <Input type="month" style={{ width: 150 }} disabled={item.current} value={item.endDate?.length === 7 ? item.endDate : ''} onChange={(e) => onChange({ ...item, endDate: e.target.value || null })} aria-label="End month" /></label>
        <Checkbox checked={item.current} onChange={(e) => onChange({ ...item, current: e.target.checked, endDate: e.target.checked ? null : item.endDate })}>Current</Checkbox>
      </div>
      {item.bullets.map((b, i) => (
        <div className="jl-row" key={i}>
          <span aria-hidden="true">•</span>
          <Input.TextArea value={b} autoSize={{ minRows: 1, maxRows: 4 }} onChange={(e) => onChange({ ...item, bullets: item.bullets.map((x, j) => (j === i ? e.target.value : x)) })} aria-label={`Bullet ${i + 1}`} placeholder="What you did and what happened" />
          <Button type="text" size="small" icon={<ArrowUpOutlined />} disabled={i === 0} aria-label="Move bullet up" onClick={() => { const b2 = [...item.bullets]; [b2[i - 1], b2[i]] = [b2[i]!, b2[i - 1]!]; onChange({ ...item, bullets: b2 }); }} />
          <Button type="text" size="small" icon={<DeleteOutlined />} aria-label="Remove bullet" onClick={() => onChange({ ...item, bullets: item.bullets.filter((_, j) => j !== i) })} />
        </div>
      ))}
      <Button type="dashed" size="small" icon={<PlusOutlined />} style={{ alignSelf: 'flex-start' }} onClick={() => onChange({ ...item, bullets: [...item.bullets, ''] })}>Add a bullet</Button>
    </div>
  );
}

/** Plain headings for the readability rules (the report carries program codes such as "missing_education_heading"). */
const RULE_TITLES: Record<string, string> = {
  file_empty: 'The file is empty', encrypted: 'Password or encryption', not_a_pdf: 'Not a readable PDF', no_text_layer: 'No text layer',
  pages_without_text: 'Pages without text', invisible_text: 'Invisible text', white_text: 'White text', ligatures: 'Joined letters',
  unmapped_characters: 'Unreadable characters', garbled_text: 'Garbled text', tiny_text: 'Very small text', text_off_page: 'Text off the page',
  file_size: 'Large file', multi_column: 'Two columns or a table', page_count: 'Number of pages', images: 'Pictures',
  missing_experience_heading: 'No Experience heading', missing_education_heading: 'No Education heading', missing_skills_heading: 'No Skills heading',
  nonstandard_headings: 'Unusual heading names', no_jobs_read: 'No job could be read', no_history: 'No work history and no education',
  very_short: 'Very short resume', missing_name: 'No name', missing_email: 'No email address', missing_phone: 'No phone number',
  contact_in_margin: 'Contact details in the margin', no_dates: 'No dates', jobs_without_dates: 'Jobs without dates',
  end_before_start: 'A job ends before it starts', mixed_date_formats: 'Dates in more than one style',
};
export const ruleTitle = (rule: string): string => RULE_TITLES[rule] ?? (rule.charAt(0).toUpperCase() + rule.slice(1)).replace(/_/g, ' ');

function ReportDrawer({ report, open, onClose }: { report: AtsReport | null; open: boolean; onClose: () => void }) {
  const groups = ['urgent', 'critical', 'optional'] as const;
  return (
    <Drawer open={open} onClose={onClose} width="min(640px, 94vw)" title="Readability report">
      {!report ? <p>Run the check first.</p> : (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div className="jl-row"><span className={`jl-grade ${report.grade}`} style={{ width: 48, height: 48, fontSize: 22 }}>{report.grade}</span><span><strong>{report.score} of 100.</strong> Checked {ago(report.checkedAt)} on the exact PDF you would export.</span></div>
          {!report.findings.length && <Alert type="success" showIcon message="No problems found." />}
          {groups.map((g) => {
            const list = report.findings.filter((f) => f.severity === g);
            if (!list.length) return null;
            return (
              <div key={g}>
                <h3 className="jl-subhead">{g === 'urgent' ? 'Fix first' : g === 'critical' ? 'Important' : 'Nice to fix'} ({list.length})</h3>
                {list.map((f) => (
                  <div key={f.id} className={`jl-sev ${g}`} style={{ marginBottom: 8 }}>
                    <strong>{ruleTitle(f.rule)}</strong>
                    <p style={{ margin: '4px 0' }}>{f.message}</p>
                    <span className="jl-small jl-muted">{f.evidence}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </Space>
      )}
    </Drawer>
  );
}

export function ResumeEditor({ id }: { id: string }) {
  const r = useApi<Resume>(`resume:${id}`, () => call('getResume', { params: { resumeId: id } }));
  const fit = useApi<{ fitsOnePage: boolean; leftOut: string[] }>(r.data ? `resume:fit:${id}:${r.data.updatedAt}` : null, () => call('fitCheck', { params: { resumeId: id } }));
  const [doc, setDoc] = useState<ResumeDocument | null>(null);
  const [busy, setBusy] = useState<'save' | 'ats' | null>(null);
  const [err, setErr] = useState<UiError | null>(null);
  const [report, setReport] = useState(false);
  const [newer, setNewer] = useState<Resume | null>(null);
  const openedAt = useRef<string | null>(null);
  useEffect(() => { if (r.data && !doc) { setDoc(structuredClone(r.data.document)); openedAt.current = r.data.updatedAt; } }, [r.data]);
  const dirty = useMemo(() => !!doc && !!r.data && JSON.stringify(doc.sections) !== JSON.stringify(r.data.document.sections), [doc, r.data]);
  useDirty(`resume:${id}`, dirty, 'this resume');
  const close = async () => { if (await confirmDiscard(dirty ? ['this resume'] : [])) navigate('resume'); };
  useLayer(true, () => { void close(); });

  if (r.error && !r.data) return <div className="jl-page">{r.error.status === 404 ? <EmptyState art="doc" title="This resume was not found" action={<Button shape="round" onClick={() => navigate('resume')}>Back to resumes</Button>} /> : <ErrorState error={r.error} onRetry={() => { void r.reload(); }} />}</div>;
  if (!r.data || !doc) return <div className="jl-page"><Loading label="Opening the resume" /></div>;
  const res = r.data;

  const save = async (overwrite = false, docToSave: ResumeDocument = doc) => {
    setBusy('save'); setErr(null);
    try {
      // another window may have saved this resume since it was opened here: ask before overwriting it
      if (!overwrite) {
        const latest = await call('getResume', { params: { resumeId: id } });
        if (openedAt.current && latest.updatedAt !== openedAt.current) { setNewer(latest); return; }
      }
      const clean: ResumeDocument = { ...docToSave, sections: docToSave.sections.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i, bullets: i.bullets.map((b) => b.trim()).filter(Boolean) })) })) };
      const n = await call('updateResume', { params: { resumeId: id }, body: { document: clean } });
      setCached<Resume>(`resume:${id}`, () => n);
      setDoc(structuredClone(n.document));
      openedAt.current = n.updatedAt;
      invalidate('resumes');
      ui.message?.success('Resume saved.');
    } catch (e) { setErr(e as UiError); } finally { setBusy(null); }
  };
  const ats = async () => {
    if (dirty) { ui.message?.info('Save your changes first, so the check grades what you see.'); return; }
    setBusy('ats'); setErr(null);
    try {
      const rep = await call('atsCheck', { params: { resumeId: id } });
      setCached<Resume>(`resume:${id}`, (old) => ({ ...old!, atsReport: rep }));
      invalidate('resumes');
      setReport(true);
    } catch (e) { setErr(e as UiError); } finally { setBusy(null); }
  };
  // A cut bullet comes back when the person moves it up in its entry: the bullets at the end of an entry go first.
  const keepLine = async (text: string) => {
    if (dirty) { ui.message?.info('Save your changes first.'); return; }
    const next = structuredClone(doc);
    let moved = false;
    for (const sec of next.sections) for (const it of sec.items) {
      const k = it.bullets.indexOf(text);
      if (k > 0 && !moved) { it.bullets.splice(k, 1); it.bullets.unshift(text); moved = true; }
    }
    if (!moved) { ui.message?.info('That line is already first in its entry. To bring it back, shorten or remove another line, then check again.'); return; }
    setDoc(next);
    await save(false, next);
  };
  const cuts = fit.data && !fit.data.fitsOnePage ? fit.data.leftOut : [];
  const setSection = (i: number, s: ResumeSection) => setDoc({ ...doc, sections: doc.sections.map((x, j) => (j === i ? s : x)) });
  const moveSection = (i: number, d: -1 | 1) => { const s = [...doc.sections]; const j = i + d; if (j < 0 || j >= s.length) return; [s[i], s[j]] = [s[j]!, s[i]!]; setDoc({ ...doc, sections: s }); };
  const rep = res.atsReport;
  const count = (sev: 'urgent' | 'critical' | 'optional') => rep?.findings.filter((f) => f.severity === sev).length ?? 0;

  return (
    <div className="jl-page" style={{ paddingBottom: 80 }}>
      <div className="jl-page-inner">
        <div className="jl-actionbar" style={{ position: 'sticky', top: -16, paddingTop: 4 }}>
          <Tooltip title="Close (Esc)"><Button shape="circle" icon={<CloseOutlined />} aria-label="Close the editor" onClick={() => { void close(); }} /></Tooltip>
          <span className="jl-chip" style={{ height: 32, padding: '0 12px', fontSize: 13, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' }} title={res.name}>{res.isPrimary && <StarFilled style={{ color: '#0A8F5C' }} />} {res.name}</span>
          {res.kind === 'tailored' && <Tag>Tailored version</Tag>}
          <span style={{ marginLeft: 'auto' }} />
          <Button shape="round" icon={<SafetyCertificateOutlined />} loading={busy === 'ats'} onClick={() => { void ats(); }}>Check readability</Button>
          <Dropdown trigger={['click']} menu={{ items: [{ key: 'pdf', label: 'One-page PDF' }, { key: 'docx', label: 'Word (.docx)' }, ...(res.file ? [{ key: 'original', label: 'Original file (as uploaded, without your edits)' }] : [])], onClick: async ({ key }) => {
            if (dirty && key !== 'original') { ui.message?.info('Save your changes first.'); return; }
            try {
              const f = await download('exportResume', { params: { resumeId: id }, query: { format: key as 'pdf' | 'docx' | 'original' } });
              if (key === 'original') { ui.message?.success(`Saved ${f} to your Downloads.`); return; }
              if (cuts.length) ui.message?.warning(`Saved ${f} to your Downloads. To fit one page it leaves out ${plural(cuts.length, 'item')}; the list is above.`);
              else ui.message?.success(`Saved ${f} to your Downloads.`);
            } catch (e) { ui.message?.error((e as UiError).message); }
          } }}>
            <Button shape="round" icon={<DownloadOutlined />}>Export</Button>
          </Dropdown>
          <Button type="primary" shape="round" icon={<SaveOutlined />} disabled={!dirty} loading={busy === 'save'} onClick={() => { void save(); }}>Save</Button>
        </div>
        {res.kind === 'tailored' && res.jobId && <Alert type="info" showIcon style={{ marginBottom: 12 }} message={<>This version is tailored for a job. <a href={`#/jobs/${encodeURIComponent(res.jobId)}`}>Open the job</a></>} />}
        <div className="jl-card-box jl-row jl-wrap" style={{ marginBottom: 12, background: 'linear-gradient(90deg, #FFF8E6, #fff 40%)' }}>
          {rep ? <span className={`jl-grade ${rep.grade}`} style={{ width: 48, height: 48, fontSize: 22 }} aria-label={`Grade ${rep.grade}`}>{rep.grade}</span> : <span className="jl-grade" style={{ width: 48, height: 48, background: 'var(--jl-chip)' }} aria-label="Not graded">–</span>}
          <div className="jl-grow">
            <strong>{rep ? `Readability ${rep.score} of 100` : 'Not checked yet'}</strong>
            <div className="jl-small jl-muted">{rep ? `Checked ${ago(rep.checkedAt)}.` : 'Run the check to grade the PDF this resume exports to.'} {fit.data ? (fit.data.fitsOnePage ? 'Fits on one page.' : `Too long for one page: ${plural(fit.data.leftOut.length, 'item')} would be left out of the files (listed below).`) : ''}</div>
            {rep && <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setReport(true)}>View the full report</Button>}
          </div>
          <div className="jl-sev urgent"><strong>{count('urgent')}</strong> <span className="jl-small">fix first</span></div>
          <div className="jl-sev critical"><strong>{count('critical')}</strong> <span className="jl-small">important</span></div>
          <div className="jl-sev optional"><strong>{count('optional')}</strong> <span className="jl-small">nice to fix</span></div>
        </div>
        {newer && <div style={{ marginBottom: 12 }}><ConflictNotice what="resume" busy={busy === 'save'} onKeepMine={() => { setNewer(null); void save(true); }} onLoadNewer={() => { setCached<Resume>(`resume:${id}`, () => newer); setDoc(structuredClone(newer.document)); openedAt.current = newer.updatedAt; setNewer(null); }} /></div>}
        {cuts.length > 0 && (
          <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`The PDF and the Word file fit one page by leaving out ${plural(cuts.length, 'item')}`}
            description={
              <div>
                <p style={{ margin: '0 0 6px' }}>Nothing is deleted: everything stays in this resume. To bring a line back into the files, move it up in its entry (another line at the end of an entry is left out instead), or shorten or remove another line.</p>
                <ul style={{ margin: 0, paddingLeft: 18 }} aria-label="Left out of the files">
                  {cuts.map((c) => {
                    const m = /^(.*): bullet "([\s\S]*)"$/.exec(c);
                    return (
                      <li key={c} style={{ overflowWrap: 'anywhere' }}>
                        {c}{' '}
                        {m && <Button size="small" type="link" onClick={() => { void keepLine(m[2]!); }} aria-label={`Undo this cut: ${m[2]!.slice(0, 40)}`}>Undo this cut</Button>}
                      </li>
                    );
                  })}
                </ul>
              </div>
            } />
        )}
        <InlineError error={err} onRetry={err ? () => { void save(); } : undefined} />
        {dirty && <p className="jl-small" style={{ color: 'var(--jl-warn)', margin: '8px 0' }} role="status">You have unsaved changes.</p>}
        <div className="jl-paper" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <header>
            <h2 style={{ fontSize: 30, fontWeight: 700 }}>{doc.header.name || 'Your name'}</h2>
            <p className="jl-muted">{[doc.header.email, doc.header.phone, doc.header.city, ...doc.header.links.map((l) => l.url)].filter(Boolean).join(' · ') || 'No contact details yet'}</p>
            <p className="jl-small jl-muted">The header comes from your profile, character for character. <a href="#/profile">Edit it in your profile</a>.</p>
            {res.kind === 'base' && <p className="jl-small jl-muted">{res.file
              ? `Made from your file ${res.file.fileName}. The rest is yours: a profile change never rewrites it.`
              : 'Made from your profile. Until you save a change here it shows your latest profile facts; once you save one, it stays as you wrote it.'}</p>}
          </header>
          {doc.sections.map((s, i) => (
            <section key={s.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }} aria-label={s.title || 'Section'}>
              <div className="jl-row">
                <Input value={s.title} onChange={(e) => setSection(i, { ...s, title: e.target.value })} aria-label="Section title" style={{ fontWeight: 700, textTransform: 'uppercase', maxWidth: 320 }} variant="borderless" />
                <span className="jl-grow" />
                <Button type="text" size="small" icon={<ArrowUpOutlined />} disabled={i === 0} aria-label={`Move ${s.title} up`} onClick={() => moveSection(i, -1)} />
                <Button type="text" size="small" icon={<ArrowDownOutlined />} disabled={i === doc.sections.length - 1} aria-label={`Move ${s.title} down`} onClick={() => moveSection(i, 1)} />
                <Button type="text" size="small" icon={<DeleteOutlined />} aria-label={`Remove the ${s.title} section`} onClick={() => setDoc({ ...doc, sections: doc.sections.filter((_, j) => j !== i) })} />
              </div>
              {(s.kind === 'summary' || (s.kind === 'custom' && !s.items.length)) && (
                <Input.TextArea value={s.text ?? ''} autoSize={{ minRows: 2, maxRows: 8 }} onChange={(e) => setSection(i, { ...s, text: e.target.value })} aria-label={`${s.title} text`} />
              )}
              {s.kind !== 'summary' && s.items.map((it, k) => (
                <ItemEditor key={it.id} kind={s.kind} item={it} onChange={(n) => setSection(i, { ...s, items: s.items.map((x, j) => (j === k ? n : x)) })} onRemove={() => setSection(i, { ...s, items: s.items.filter((_, j) => j !== k) })} />
              ))}
              {s.kind !== 'summary' && (s.kind !== 'skills' || !s.items.length) && (
                <Button type="dashed" size="small" icon={<PlusOutlined />} style={{ alignSelf: 'flex-start' }} onClick={() => setSection(i, { ...s, items: [...s.items, newItem()] })}>Add an entry</Button>
              )}
            </section>
          ))}
          <Dropdown trigger={['click']} menu={{ items: KINDS.map((k) => ({ key: k.value, label: k.label })), onClick: ({ key }) => {
            const k = KINDS.find((x) => x.value === key)!;
            setDoc({ ...doc, sections: [...doc.sections, { id: nid('sec'), kind: k.value, title: k.label, text: k.value === 'summary' || k.value === 'custom' ? '' : null, items: k.value === 'skills' ? [{ ...newItem(), bullets: [] }] : [] }] });
          } }}>
            <Button icon={<PlusOutlined />} shape="round" style={{ alignSelf: 'flex-start' }}>Add a section</Button>
          </Dropdown>
        </div>
      </div>
      <ReportDrawer report={rep} open={report} onClose={() => setReport(false)} />
    </div>
  );
}
