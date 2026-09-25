// The Network tool, built on your own LinkedIn Connections.csv. The file stays on this Mac; jobleft never contacts
// LinkedIn or any people-lookup service, and never sends a message for you. Tabs: companies you target (and where
// you know nobody), people, your coffee-chat plan, follow-ups, and the import.

import { useRef, useState } from 'react';
import { Alert, Button, Checkbox, Drawer, Input, Popconfirm, Select, Space, Table, Tabs, Tag, Tooltip } from 'antd';
import { DeleteOutlined, ExportOutlined, MessageOutlined, UploadOutlined } from '@ant-design/icons';
import { OUTREACH_STAGES, OUTREACH_STAGE_LABELS, type CompanyCoverage, type NetworkContact, type NetworkImportSummary, type OutreachStage } from '@jobleft/contracts';
import { call, type UiError } from '../app/api.ts';
import { invalidate, useApi } from '../app/data.ts';
import { confirmDiscard, ui, useDirty } from '../app/layers.ts';
import { navigate } from '../app/router.ts';
import { DraftModal } from '../components/DraftModal.tsx';
import { EmptyState, ErrorState, InlineError, Loading } from '../components/States.tsx';
import { calendarDate, plural } from '../lib/format.ts';

const useContacts = () => useApi<NetworkContact[]>('network:contacts:', () => call('listContacts', { query: {} }));

async function update(c: NetworkContact, body: { stage?: OutreachStage; note?: string | null; followUpOn?: string | null; inPlan?: boolean }, ok: string) {
  try {
    await call('updateContact', { params: { contactId: c.id }, body });
    invalidate('network');
    ui.message?.success(ok);
    return true;
  } catch (e) { ui.message?.error((e as UiError).message); return false; }
}

function Name({ c }: { c: NetworkContact }) {
  return (
    <span>
      <strong>{c.firstName} {c.lastName}</strong>
      {c.maybeGarbled && <Tooltip title="The export may have garbled this name. It is shown exactly as in your file."><Tag style={{ marginLeft: 6 }}>as in file</Tag></Tooltip>}
      {(c as NetworkContact & { inLatestFile?: boolean }).inLatestFile === false && <Tooltip title="Not in the latest file you imported. Kept with its notes."><Tag style={{ marginLeft: 6 }}>older import</Tag></Tooltip>}
    </span>
  );
}

function ContactDrawer({ c, onClose, onDraft }: { c: NetworkContact | null; onClose: () => void; onDraft: (c: NetworkContact) => void }) {
  const [note, setNote] = useState<string | null>(null);
  const value = note ?? c?.note ?? '';
  const dirty = !!c && note !== null && note !== (c.note ?? '');
  useDirty('contact-note', dirty, 'the note');
  if (!c) return null;
  const close = async () => { if (await confirmDiscard(dirty ? ['the note'] : [])) { setNote(null); onClose(); } };
  return (
    <Drawer open={!!c} onClose={() => { void close(); }} width="min(520px, 94vw)" title={<Name c={c} />}>
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <span>{c.position ?? 'No title in your file'}{c.company ? ` at ${c.company}` : ''}</span>
        {c.connectedOn && <span className="jl-muted">Connected {calendarDate(c.connectedOn)}</span>}
        {c.email ? <span>Email in your file: {c.email}</span> : <span className="jl-muted">No email in your file.</span>}
        {c.profileUrl && <a href={c.profileUrl} target="_blank" rel="noopener noreferrer"><ExportOutlined /> Open their profile in your browser</a>}
        <label className="jl-row">Stage <Select style={{ width: 200 }} value={c.stage} onChange={(v) => { void update(c, { stage: v }, `Stage: ${OUTREACH_STAGE_LABELS[v]}.`); }} options={OUTREACH_STAGES.map((s) => ({ value: s, label: OUTREACH_STAGE_LABELS[s] }))} /></label>
        <label className="jl-row">Follow up on <Input type="date" style={{ width: 180 }} value={c.followUpOn ?? ''} onChange={(e) => { void update(c, { followUpOn: e.target.value || null }, e.target.value ? 'Follow-up date set.' : 'Follow-up date cleared.'); }} /></label>
        <Checkbox checked={c.inPlan} onChange={(e) => { void update(c, { inPlan: e.target.checked }, e.target.checked ? 'Added to your plan.' : 'Removed from your plan.'); }}>In my coffee-chat plan</Checkbox>
        <span style={{ fontWeight: 600 }}>Note</span>
        <Input.TextArea value={value} onChange={(e) => setNote(e.target.value)} autoSize={{ minRows: 3 }} maxLength={20000} aria-label="Note about this person" />
        <Space>
          <Button type="primary" shape="round" disabled={!dirty} onClick={async () => { if (await update(c, { note: value || null }, 'Note saved.')) setNote(null); }}>Save note</Button>
          <Button shape="round" icon={<MessageOutlined />} onClick={() => onDraft(c)}>Draft a message</Button>
        </Space>
        <Popconfirm title="Delete this person and everything about them?" okText="Delete" okButtonProps={{ danger: true }} onConfirm={async () => {
          try { await call('deleteContact', { params: { contactId: c.id } }); invalidate('network'); ui.message?.success('Deleted.'); onClose(); } catch (e) { ui.message?.error((e as UiError).message); }
        }}>
          <Button danger type="text" icon={<DeleteOutlined />}>Delete this person</Button>
        </Popconfirm>
      </Space>
    </Drawer>
  );
}

function Importer({ onDone }: { onDone: (s: NetworkImportSummary) => void }) {
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<UiError | null>(null);
  const run = async (f: File) => {
    setBusy(true); setErr(null);
    try {
      if (f.size > 10 * 1024 * 1024) throw { code: 'payload_too_large', status: null, message: 'The file is larger than 10 MB.', link: null } satisfies UiError;
      const bytes = new Uint8Array(await f.arrayBuffer());
      const s = await call('importNetwork', { body: bytes, contentType: 'text/csv', fileName: f.name });
      invalidate('network', 'jobs:', 'job:', 'match:');
      onDone(s);
    } catch (e) { setErr(e as UiError); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  return (
    <section className="jl-card-box" aria-labelledby="imp-h" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 id="imp-h" className="jl-section-title">Import your connections</h2>
      <p>jobleft reads the connections file LinkedIn lets you download. The file stays on this Mac. jobleft never contacts LinkedIn.</p>
      <ol style={{ margin: 0, paddingLeft: 20 }}>
        <li>On LinkedIn, open <strong>Me</strong>, then <strong>Settings &amp; Privacy</strong>, then <strong>Data privacy</strong>.</li>
        <li>Choose <strong>Get a copy of your data</strong>, pick the larger archive, and request it.</li>
        <li>When the email arrives, download and unzip the archive.</li>
        <li>Import the file named <code>Connections.csv</code> here.</li>
      </ol>
      <p className="jl-small jl-muted">The file lists only your first-degree connections. Many emails are blank. Some names in Chinese, Japanese or Hebrew come out garbled; jobleft shows them as in the file.</p>
      <input ref={input} type="file" accept=".csv,text/csv" style={{ display: 'none' }} aria-label="Connections file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void run(f); }} />
      <Button type="primary" shape="round" size="large" icon={<UploadOutlined />} loading={busy} style={{ alignSelf: 'flex-start' }} onClick={() => input.current?.click()}>Choose Connections.csv</Button>
      <InlineError error={err} />
    </section>
  );
}

function Summary({ s }: { s: NetworkImportSummary }) {
  if (s.notAConnectionsFile) return <Alert type="error" showIcon message="This file is not a connections export. Nothing was imported." />;
  const x = s as NetworkImportSummary & { total?: number };
  return (
    <Alert type="success" showIcon message={`Imported: ${plural(s.imported, 'new person', 'new people')}, ${s.updated} updated, ${s.unchanged} unchanged.`}
      description={<>
        {s.missingFromFile > 0 && <p>{plural(s.missingFromFile, 'person', 'people')} from an earlier file are not in this one. They are kept with their notes.</p>}
        {s.skipped.length > 0 && <p>{plural(s.skipped.length, 'row')} skipped: {s.skipped.slice(0, 3).map((r) => `line ${r.line} (${r.reason})`).join('; ')}{s.skipped.length > 3 ? '…' : ''}</p>}
        {s.warnings.map((w) => <p key={w}>{w}</p>)}
        {x.total !== undefined && <p>You now have {plural(x.total, 'connection')} in jobleft.</p>}
      </>} />
  );
}

export function NetworkScreen({ tab }: { tab: string | null }) {
  const contacts = useContacts();
  const coverage = useApi<CompanyCoverage[]>('network:coverage', () => call('networkCoverage'));
  const [open, setOpen] = useState<NetworkContact | null>(null);
  const [draftFor, setDraftFor] = useState<NetworkContact | null>(null);
  const [summary, setSummary] = useState<NetworkImportSummary | null>(null);
  const [q, setQ] = useState('');
  const [stage, setStage] = useState<OutreachStage | 'all'>('all');
  const active = tab ?? 'companies';

  if (contacts.error && !contacts.data) return <div className="jl-page"><ErrorState error={contacts.error} onRetry={() => { void contacts.reload(); }} /></div>;
  if (!contacts.data) return <div className="jl-page"><Loading label="Loading your network" /></div>;
  const all = contacts.data;
  const byId = new Map(all.map((c) => [c.id, c]));
  const current = open ? byId.get(open.id) ?? null : null;
  const today = new Date().toISOString().slice(0, 10);
  const due = all.filter((c) => c.followUpOn && c.followUpOn <= today);
  const plan = all.filter((c) => c.inPlan);

  if (!all.length) {
    return (
      <div className="jl-page"><div className="jl-page-inner" style={{ maxWidth: 820 }}>
        {summary && <Summary s={summary} />}
        <Importer onDone={setSummary} />
      </div></div>
    );
  }

  const people = all.filter((c) => (stage === 'all' || c.stage === stage) && (!q || `${c.firstName} ${c.lastName} ${c.company ?? ''} ${c.position ?? ''}`.toLowerCase().includes(q.toLowerCase())));
  const peopleTable = (list: NetworkContact[]) => (
    <Table size="middle" rowKey="id" dataSource={list} pagination={{ pageSize: 20, hideOnSinglePage: true }}
      columns={[
        { title: 'Name', key: 'n', render: (_, c) => <Button type="link" style={{ padding: 0, height: 'auto', textAlign: 'left', whiteSpace: 'normal' }} onClick={() => setOpen(c)}><Name c={c} /></Button> },
        { title: 'Company', key: 'c', render: (_, c) => c.company ?? <span className="jl-muted">Not in file</span> },
        { title: 'Title', key: 't', render: (_, c) => c.position ?? '' },
        { title: 'Stage', key: 's', width: 170, render: (_, c) => <Select size="small" style={{ width: 150 }} value={c.stage} aria-label={`Stage of ${c.firstName} ${c.lastName}`} onChange={(v) => { void update(c, { stage: v }, `Stage: ${OUTREACH_STAGE_LABELS[v]}.`); }} options={OUTREACH_STAGES.map((s) => ({ value: s, label: OUTREACH_STAGE_LABELS[s] }))} /> },
        { title: 'Follow up', key: 'f', render: (_, c) => calendarDate(c.followUpOn) ?? '' },
        { title: <span className="jl-sr">Actions</span>, key: 'a', render: (_, c) => <Button size="small" shape="round" icon={<MessageOutlined />} onClick={() => setDraftFor(c)} aria-label={`Draft a message to ${c.firstName} ${c.lastName}`}>Draft</Button> },
      ]} />
  );

  const cov = coverage.data ?? [];
  const known = cov.filter((x) => x.count > 0);
  const unknown = cov.filter((x) => x.count === 0);

  return (
    <div className="jl-page">
      <div className="jl-page-inner">
        {summary && <div style={{ marginBottom: 12 }}><Summary s={summary} /></div>}
        <Tabs activeKey={active} onChange={(k) => navigate(`network/${k}`)} items={[
          {
            key: 'companies', label: 'Companies',
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <p className="jl-muted">Companies from your liked, applied and added jobs, and from saved filters.</p>
                {coverage.error && <InlineError error={coverage.error} onRetry={() => { void coverage.reload(); }} />}
                {!cov.length && coverage.data && <EmptyState art="people" title="No target companies yet" text="Like or apply to jobs, and their companies show here with the people you know there." action={<Button shape="round" type="primary" onClick={() => navigate('jobs')}>Browse jobs</Button>} />}
                {known.length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
                    {known.map((x) => (
                      <section key={x.companyKey} className="jl-card-box" style={{ padding: 16 }} aria-label={x.companyName}>
                        <strong style={{ fontSize: 16 }}>{x.companyName}</strong>
                        <p>You know {plural(x.count, 'person', 'people')} here.</p>
                        {x.topContactIds.map((id) => { const c = byId.get(id); return c ? <div key={id} className="jl-row"><Button type="link" style={{ padding: 0 }} onClick={() => setOpen(c)}>{c.firstName} {c.lastName}</Button><span className="jl-small jl-muted">{c.position}</span></div> : null; })}
                      </section>
                    ))}
                  </div>
                )}
                {unknown.length > 0 && (
                  <section className="jl-card-box">
                    <h2 className="jl-section-title" style={{ fontSize: 17 }}>Where you know nobody yet ({unknown.length})</h2>
                    <div className="jl-row jl-wrap">{unknown.map((x) => <Tag key={x.companyKey}>{x.companyName}</Tag>)}</div>
                  </section>
                )}
              </div>
            ),
          },
          {
            key: 'people', label: `People (${all.length})`,
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="jl-row jl-wrap">
                  <Input.Search allowClear placeholder="Search name, company or title" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} aria-label="Search your connections" />
                  <Select value={stage} onChange={setStage} style={{ width: 180 }} aria-label="Filter by stage" options={[{ value: 'all', label: 'Every stage' }, ...OUTREACH_STAGES.map((s) => ({ value: s, label: OUTREACH_STAGE_LABELS[s] }))]} />
                  <span className="jl-muted">{plural(people.length, 'person', 'people')}</span>
                </div>
                {peopleTable(people)}
              </div>
            ),
          },
          {
            key: 'plan', label: `Plan (${plan.length})`,
            children: plan.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {[...new Set(plan.map((c) => c.company ?? 'Company not in file'))].map((co) => (
                  <section key={co} className="jl-card-box" aria-label={co}>
                    <strong style={{ fontSize: 16 }}>{co}</strong>
                    {plan.filter((c) => (c.company ?? 'Company not in file') === co).map((c) => (
                      <div key={c.id} className="jl-row" style={{ padding: '6px 0' }}>
                        <Button type="link" style={{ padding: 0 }} onClick={() => setOpen(c)}>{c.firstName} {c.lastName}</Button>
                        <span className="jl-grow jl-small jl-muted">{c.position}</span>
                        <Tag>{OUTREACH_STAGE_LABELS[c.stage]}</Tag>
                        <span className="jl-small">Next: {c.stage === 'to_contact' ? 'draft and send a short note' : c.stage === 'messaged' ? 'wait, then follow up' : c.stage === 'replied' ? 'set up a chat' : c.stage === 'met' ? 'send a thank-you' : 'follow up today'}</span>
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            ) : <EmptyState art="people" title="Your plan is empty" text="Open a person and tick “In my coffee-chat plan” to add them." />,
          },
          {
            key: 'followups', label: `Follow-ups (${due.length})`,
            children: due.length ? peopleTable(due) : <EmptyState art="bell" title="No follow-ups due" text="Set a follow-up date on a person, and they show here on that day." />,
          },
          {
            key: 'import', label: 'Import and data',
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 820 }}>
                <Importer onDone={setSummary} />
                <section className="jl-card-box">
                  <h2 className="jl-section-title" style={{ fontSize: 17 }}>Delete network data</h2>
                  <p>Deletes every person, note and stage from jobleft. Your own file is not touched.</p>
                  <Popconfirm title={`Delete all ${plural(all.length, 'connection')} from jobleft?`} okText="Delete all" okButtonProps={{ danger: true }} onConfirm={async () => {
                    try { const r = await call('deleteNetwork'); invalidate('network', 'jobs:', 'job:'); ui.message?.success(`Deleted ${plural(r.deleted, 'connection')}.`); } catch (e) { ui.message?.error((e as UiError).message); }
                  }}>
                    <Button danger shape="round" icon={<DeleteOutlined />}>Delete all network data</Button>
                  </Popconfirm>
                </section>
              </div>
            ),
          },
        ]} />
      </div>
      <ContactDrawer c={current} onClose={() => setOpen(null)} onDraft={(c) => setDraftFor(c)} />
      <DraftModal contact={draftFor} jobId={null} jobLabel={null} open={!!draftFor} onClose={() => setDraftFor(null)} />
    </div>
  );
}
