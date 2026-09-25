// Detail panels: company facts (each with its source and date, AI-written facts marked), sponsorship (the posting's
// own words, and the company's filing history hedged as "likely" with its public source; a missing record is
// "unknown", never "no"), people you know there, and your notes and reminders.

import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Button, Checkbox, Input, Select, Space } from 'antd';
import { Tooltip } from '../../components/Tip.tsx';
import { BankOutlined, DeleteOutlined, PlusOutlined, SafetyCertificateOutlined, TeamOutlined, EditOutlined, CalendarOutlined } from '@ant-design/icons';
import {
  TRACKER_STATUSES, TRACKER_STATUS_LABELS, formatDollars, type Company, type ContactRank, type Job, type NetworkContact, type SourceRef, type TrackerEntry, type TrackerPatch,
  type TrackerStatus,
} from '@jobleft/contracts';
import { call, type UiError } from '../../app/api.ts';
import { invalidate, useApi } from '../../app/data.ts';
import { ui, useDirty } from '../../app/layers.ts';
import { navigate } from '../../app/router.ts';
import { afterTrackerChange, useAiSettings } from '../../app/session.ts';
import { DraftModal } from '../../components/DraftModal.tsx';
import { CompanyMark } from '../../components/JobCard.tsx';
import { InlineError } from '../../components/States.tsx';
import { calendarDate, dateText, dateTimeText, plural } from '../../lib/format.ts';
import { noteKeep, patchFresh, reminderKeep } from '../../lib/trackerEdit.ts';
import { ContactName, MatchExplain, ProfileLink, ReasonList, StageSelect, saveContact } from '../network/shared.tsx';

export function SecHead({ icon, title, id, right }: { icon: ReactNode; title: string; id?: string; right?: ReactNode }) {
  return (
    <div className="jl-sec-head">
      <span className="jl-sec-icon" aria-hidden="true">{icon}</span>
      <h2 id={id}>{title}</h2>
      {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
    </div>
  );
}

function isAi(s: SourceRef): boolean {
  return /\bAI\b/.test(s.name);
}

function Src({ s }: { s: SourceRef }) {
  return (
    <span className="jl-source">
      {isAi(s) && <span className="jl-ai-tag" style={{ marginRight: 6 }}>Written by AI</span>}
      Source: {s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer">{s.name}</a> : s.name}, read {dateText(s.retrievedAt)}
    </span>
  );
}

function FactRow({ label, children, s }: { label: string; children: ReactNode; s: SourceRef }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span className="jl-small jl-muted">{label}</span>
      <span>{children}</span>
      <Src s={s} />
    </div>
  );
}

const STAGE_TEXT = { early: 'Early stage', growth: 'Growth stage', late: 'Late stage', public: 'Public company' } as const;

export function CompanySection({ job, company }: { job: Job; company: Company | null }) {
  const ai = useAiSettings();
  const [c, setC] = useState<Company | null>(company);
  const [busy, setBusy] = useState<'free' | 'paid' | null>(null);
  const [err, setErr] = useState<UiError | null>(null);
  useEffect(() => setC(company), [company]);
  const f = c?.facts ?? {};
  const has = Object.keys(f).length > 0;
  const refresh = async (paid: boolean) => {
    setBusy(paid ? 'paid' : 'free'); setErr(null);
    try {
      const n = await call('refreshCompany', { params: { companyKey: job.companyKey }, body: paid ? { allowPaid: true, maxPriceMicros: 50_000 } : { allowPaid: false } });
      setC(n);
      if (paid) invalidate('ai:publik');
      ui.message?.success('Company facts read again.');
    } catch (e) { setErr(e as UiError); } finally { setBusy(null); }
  };
  const metered = ai.data?.meteredFetch;
  return (
    <section className="jl-detail-sec" aria-labelledby="sec-company" id="sec-company">
      <SecHead icon={<BankOutlined />} title="Company" id="sec-company-h" />
      <div className="jl-row" style={{ gap: 16, alignItems: 'flex-start', marginBottom: 12 }}>
        <div className="jl-grow">
          <h3 id="sec-company" style={{ fontSize: 22, fontWeight: 700 }}>{c?.name ?? job.company}</h3>
          {f.description && <p style={{ marginTop: 6 }}>{f.description.value}</p>}
          {f.description && <Src s={f.description.source} />}
          {c?.isStaffingAgency && <p style={{ marginTop: 6 }}><span className="jl-chip warn">Staffing or recruiting agency</span></p>}
        </div>
        <CompanyMark name={c?.name ?? job.company} keyText={job.companyKey} size={64} />
      </div>
      {!has && (
        <div className="jl-factbox">
          <p>jobleft has no facts about this company yet. Nothing is guessed.</p>
          <Space wrap style={{ marginTop: 8 }}>
            <Button shape="round" loading={busy === 'free'} onClick={() => { void refresh(false); }}>Look up company facts (free public sources)</Button>
            {metered?.enabled && (
              <Button shape="round" loading={busy === 'paid'} onClick={() => { void refresh(true); }}>Paid web search (about {formatDollars(Math.round(metered.pricesPer1000Micros.search / 1000))} from your balance)</Button>
            )}
          </Space>
        </div>
      )}
      <InlineError error={err} />
      {has && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
          {f.founded && <div className="jl-factbox"><FactRow label="Founded" s={f.founded.source}>{f.founded.value}</FactRow></div>}
          {f.headquarters && <div className="jl-factbox"><FactRow label="Headquarters" s={f.headquarters.source}>{f.headquarters.value}</FactRow></div>}
          {f.size && <div className="jl-factbox"><FactRow label="Size" s={f.size.source}>{f.size.value}</FactRow></div>}
          {f.website && <div className="jl-factbox"><FactRow label="Website" s={f.website.source}><a href={f.website.value} target="_blank" rel="noopener noreferrer">{f.website.value}</a></FactRow></div>}
          {f.industries && <div className="jl-factbox"><FactRow label="Industries" s={f.industries.source}><span className="jl-row jl-wrap">{f.industries.value.map((i) => <span key={i} className="jl-tag">{i}</span>)}</span></FactRow></div>}
          {f.stage && <div className="jl-factbox"><FactRow label="Stage" s={f.stage.source}>{STAGE_TEXT[f.stage.value]}</FactRow></div>}
          {f.totalFundingUsd && <div className="jl-factbox"><FactRow label="Total funding" s={f.totalFundingUsd.source}>${(f.totalFundingUsd.value / 1e6).toLocaleString('en-US', { maximumFractionDigits: 1 })}M</FactRow></div>}
          {f.investors && <div className="jl-factbox"><FactRow label="Investors" s={f.investors.source}>{f.investors.value.join(', ')}</FactRow></div>}
          {f.leaders && <div className="jl-factbox"><FactRow label="Leaders" s={f.leaders.source}>{f.leaders.value.map((l) => `${l.name}, ${l.title}`).join('; ')}</FactRow></div>}
          {f.news && <div className="jl-factbox" style={{ gridColumn: '1 / -1' }}><FactRow label="Recent news" s={f.news.source}>{f.news.value.map((n, i) => <div key={i}><a href={n.url} target="_blank" rel="noopener noreferrer">{n.title}</a>{n.outlet ? ` · ${n.outlet}` : ''}{n.publishedAt ? ` · ${calendarDate(n.publishedAt)}` : ''}</div>)}</FactRow></div>}
        </div>
      )}
      {has && <p className="jl-small jl-muted" style={{ marginTop: 10 }}>Each fact shows where it came from. Facts not listed are unknown.</p>}
    </section>
  );
}

export function SponsorSection({ job, company }: { job: Job; company: Company | null }) {
  const h = company?.h1b ?? null;
  const s = job.statements.sponsorship;
  const ev = job.evidence.sponsorship?.text;
  const max = h ? Math.max(1, ...h.byYear.map((y) => y.count)) : 1;
  return (
    <section className="jl-detail-sec" aria-labelledby="sec-visa-h" id="sec-visa">
      <SecHead icon={<SafetyCertificateOutlined />} title="Visa sponsorship" id="sec-visa-h" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <strong>What the posting says: </strong>
          {s === 'yes' ? 'it offers visa sponsorship.' : s === 'no' ? 'it cannot sponsor a visa for this role.' : 'nothing about visa sponsorship.'}
          {ev && <blockquote style={{ margin: '6px 0 0', paddingLeft: 10, borderLeft: '3px solid var(--jl-border)', color: 'var(--jl-text2)' }}>“{ev}”</blockquote>}
          {(job.statements.usCitizenOnly || job.statements.clearanceRequired) && (
            <p style={{ marginTop: 6 }}>{job.statements.usCitizenOnly && 'The posting requires US citizenship. '}{job.statements.clearanceRequired && 'The posting requires a security clearance.'}</p>
          )}
        </div>
        {h ? (
          <div className="jl-factbox" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <strong>{h.status === 'likely' ? 'H-1B sponsorship likely, based on past filings' : 'Some H-1B filing history'}</strong>
            <span>{plural(h.certifiedFilings, 'certified H-1B filing')} from {calendarDate(h.window.from)} to {calendarDate(h.window.to)}.{h.similarRoleShare !== null && h.roleFamily ? ` About ${Math.round(h.similarRoleShare * 100)}% were for ${h.roleFamily} roles.` : ''}</span>
            <div className="jl-bars" aria-label="Filings by year">
              {h.byYear.map((y) => (
                <div className="jl-bar-row" key={y.year}>
                  <span>{y.yearKind === 'fiscal' ? 'Fiscal ' : ''}{y.year}{y.partial ? ' (part year)' : ''}</span>
                  <span className="jl-bar" aria-hidden="true"><span style={{ width: `${(100 * y.count) / max}%` }} /></span>
                  <span>{y.count.toLocaleString('en-US')}</span>
                </div>
              ))}
            </div>
            <span className="jl-small">{h.note}</span>
            <span className="jl-source">Source: {h.source}. Data through {calendarDate(h.dataThrough)}. Filer names: {h.filerEntities.join(', ')}.</span>
          </div>
        ) : (
          <div className="jl-factbox">
            <strong>Sponsorship history: unknown.</strong>
            <p style={{ marginTop: 4 }}>jobleft's copy of the US Department of Labor filings has no record under this company's name. That tells you nothing either way; ask the employer.</p>
          </div>
        )}
      </div>
    </section>
  );
}

export function NetworkSection({ job, networkCount }: { job: Job; networkCount: number | null }) {
  const ranks = useApi<ContactRank[]>(networkCount ? `network:rank:${job.companyKey}:${job.id}` : null, () => call('rankContacts', { query: { companyKey: job.companyKey, jobId: job.id } }));
  const people = useApi<NetworkContact[]>(networkCount ? `network:contacts:c:${job.companyKey}` : null, () => call('listContacts', { query: { companyKey: job.companyKey } }));
  const any = useApi<NetworkContact[]>(!networkCount ? 'network:contacts:any' : null, () => call('listContacts', { query: { limit: '1' } }));
  const [draftFor, setDraftFor] = useState<NetworkContact | null>(null);
  const [all, setAll] = useState(false);
  const byId = new Map((people.data ?? []).map((p) => [p.id, p]));
  // The list is the ranked people who are really at this company: the same people the count on the card counts.
  const ranked = (ranks.data ?? []).filter((r) => byId.has(r.contactId));
  const shown = all ? ranked : ranked.slice(0, 10);
  return (
    <section className="jl-detail-sec" aria-labelledby="sec-net-h" id="sec-network">
      <SecHead icon={<TeamOutlined />} title={networkCount ? `You know ${plural(networkCount, 'person', 'people')} at ${job.company}` : 'People you know here'} id="sec-net-h" />
      {!networkCount && (
        any.data && any.data.length
          ? <p>None of your imported connections work at {job.company}.</p>
          : any.data
            ? <p>Import your LinkedIn connections file to see who you know here. The file is read on this computer. <Button type="link" onClick={() => navigate('network/import')}>Import connections</Button></p>
            : null
      )}
      {networkCount && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {ranks.error && <InlineError error={ranks.error} onRetry={() => { void ranks.reload(); }} />}
          {people.error && <InlineError error={people.error} onRetry={() => { void people.reload(); }} />}
          <span className="jl-small jl-muted">Best person to contact first is at the top. Each reason comes from your file.</span>
          {shown.map((r) => {
            const p = byId.get(r.contactId)!;
            return (
              <div key={r.contactId} className="jl-factbox jl-row" style={{ alignItems: 'flex-start' }}>
                <div className="jl-avatar" style={{ width: 32, height: 32, fontSize: 13 }} aria-hidden="true">{([...(p.firstName || '?')][0] ?? '?').toUpperCase()}</div>
                <div className="jl-grow">
                  <ContactName c={p} />
                  <div className="jl-small">{p.position ?? 'No title in your file'}</div>
                  <div><ProfileLink c={p} /></div>
                  <ReasonList reasons={r.reasons} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                  <StageSelect c={p} />
                  <Button size="small" shape="round" onClick={() => setDraftFor(p)}>Draft a message</Button>
                  <Button size="small" shape="round" aria-pressed={p.inPlan} onClick={() => { void saveContact(p, { inPlan: !p.inPlan }, p.inPlan ? 'Removed from your coffee-chat list.' : 'Added to your coffee-chat list.'); }}>{p.inPlan ? 'In my coffee-chat list' : 'Add to coffee-chat list'}</Button>
                </div>
              </div>
            );
          })}
          {ranked.length > 10 && <Button type="link" style={{ alignSelf: 'flex-start', padding: 0 }} onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${ranked.length}`}</Button>}
          <MatchExplain companyKey={job.companyKey} companyName={job.company} />
          <Button type="link" style={{ alignSelf: 'flex-start', padding: 0 }} onClick={() => navigate('network')}>Open the Network tool</Button>
        </div>
      )}
      <DraftModal contact={draftFor} jobId={job.id} jobLabel={`${job.title} at ${job.company}`} open={!!draftFor} onClose={() => setDraftFor(null)} />
    </section>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function NotesSection({ job, entry, onChange }: { job: Job; entry: TrackerEntry | null; onChange: (e: TrackerEntry) => void }) {
  const [newNote, setNewNote] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [remAt, setRemAt] = useState('');
  const [remText, setRemText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<UiError | null>(null);
  const notes = entry?.notes ?? [];
  const reminders = entry?.reminders ?? [];
  useDirty(`note:${job.id}`, !!newNote.trim() || (!!editing && editing.text !== (notes.find((n) => n.id === editing.id)?.text ?? '')), 'your note');
  // every save reads the newest copy first (see lib/trackerEdit.ts), so a second window never overwrites the first
  const save = async (build: (fresh: TrackerEntry | null) => TrackerPatch | null, ok: string): Promise<boolean> => {
    setBusy(true); setErr(null);
    try {
      const r = await patchFresh(job.id, build);
      if (r.entry) onChange(r.entry);
      afterTrackerChange();
      if (r.stale) { ui.message?.info('That was already changed in another window. This list is up to date now.'); return false; }
      ui.message?.success(ok);
      return true;
    } catch (e) { setErr(e as UiError); return false; } finally { setBusy(false); }
  };
  return (
    <section className="jl-detail-sec" aria-labelledby="sec-notes-h" id="sec-notes">
      <SecHead icon={<EditOutlined />} title="Your notes and reminders" id="sec-notes-h"
        right={
          <label className="jl-row">Status
            <Select style={{ width: 170 }} value={entry?.status ?? 'none'} disabled={busy} aria-label="Application status"
              options={[{ value: 'none', label: 'Not applied' }, ...TRACKER_STATUSES.map((s) => ({ value: s, label: TRACKER_STATUS_LABELS[s] }))]}
              onChange={(v) => { void save(() => ({ status: v === 'none' ? null : (v as TrackerStatus) }), v === 'none' ? 'Status cleared.' : `Moved to ${TRACKER_STATUS_LABELS[v as TrackerStatus]}.`); }} />
          </label>
        } />
      <InlineError error={err} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {notes.map((n) => (
          <div key={n.id} className="jl-factbox">
            {editing?.id === n.id ? (
              <Space direction="vertical" style={{ width: '100%' }}>
                <Input.TextArea value={editing.text} onChange={(e) => setEditing({ id: n.id, text: e.target.value })} autoSize={{ minRows: 2 }} aria-label="Edit note" maxLength={20000} />
                <Space>
                  <Button size="small" type="primary" shape="round" loading={busy} disabled={!editing.text.trim()} onClick={async () => { if (await save((f) => (f?.notes.some((x) => x.id === n.id) ? { notes: noteKeep(f).map((k) => (k.id === n.id ? { id: n.id, text: editing.text } : k)) } : null), 'Note saved.')) setEditing(null); }}>Save</Button>
                  <Button size="small" shape="round" onClick={() => setEditing(null)}>Cancel</Button>
                </Space>
              </Space>
            ) : (
              <div className="jl-row" style={{ alignItems: 'flex-start' }}>
                <p className="jl-grow" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{n.text}</p>
                <Button size="small" type="text" icon={<EditOutlined />} aria-label="Edit note" onClick={() => setEditing({ id: n.id, text: n.text })} />
                <Button size="small" type="text" icon={<DeleteOutlined />} aria-label="Delete note" onClick={() => { void save((f) => ({ notes: noteKeep(f).filter((k) => k.id !== n.id) }), 'Note deleted.'); }} />
              </div>
            )}
            <span className="jl-source">Written {dateText(n.createdAt)}{n.updatedAt !== n.createdAt ? `, changed ${dateText(n.updatedAt)}` : ''}</span>
          </div>
        ))}
        <Input.TextArea value={newNote} onChange={(e) => setNewNote(e.target.value)} autoSize={{ minRows: 2 }} placeholder="Add a note, for example who you talked to" aria-label="New note" maxLength={20000} />
        <Button shape="round" icon={<PlusOutlined />} style={{ alignSelf: 'flex-start' }} disabled={!newNote.trim()} loading={busy}
          onClick={async () => { const text = newNote.trim(); if (await save((f) => ({ notes: [...noteKeep(f), { text }] }), 'Note saved.')) setNewNote(''); }}>Save note</Button>
      </div>
      <h3 className="jl-subhead"><CalendarOutlined /> Reminders</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {!reminders.length && <span className="jl-muted">No reminders. jobleft shows a notification at the time you set.</span>}
        {reminders.map((r) => (
          <div key={r.id} className="jl-row">
            <Checkbox checked={r.done} onChange={(e) => { const done = e.target.checked; void save((f) => ({ reminders: reminderKeep(f).map((k) => (k.id === r.id ? { ...k, done } : k)) }), done ? 'Reminder done.' : 'Reminder open again.'); }} aria-label={`Done: ${r.text}`} />
            <span className="jl-grow" style={r.done ? { textDecoration: 'line-through', color: 'var(--jl-text3)' } : undefined}>{dateTimeText(r.at)}: {r.text || 'Follow up'}</span>
            <Button size="small" type="text" icon={<DeleteOutlined />} aria-label="Delete reminder" onClick={() => { void save((f) => ({ reminders: reminderKeep(f).filter((k) => k.id !== r.id) }), 'Reminder deleted.'); }} />
          </div>
        ))}
        <div className="jl-row jl-wrap">
          <Input type="datetime-local" value={remAt} onChange={(e) => setRemAt(e.target.value)} style={{ width: 220 }} aria-label="Reminder date and time" min={toLocalInput(new Date().toISOString())} />
          <Input value={remText} onChange={(e) => setRemText(e.target.value)} placeholder="What to do" aria-label="Reminder text" style={{ width: 240 }} maxLength={500} />
          <Button shape="round" icon={<PlusOutlined />} disabled={!remAt} loading={busy}
            onClick={async () => { const at = new Date(remAt).toISOString(); const text = remText.trim() || 'Follow up'; if (await save((f) => ({ reminders: [...reminderKeep(f), { at, text, done: false }] }), 'Reminder set.')) { setRemAt(''); setRemText(''); } }}>Add reminder</Button>
        </div>
      </div>
    </section>
  );
}

export { Alert };
