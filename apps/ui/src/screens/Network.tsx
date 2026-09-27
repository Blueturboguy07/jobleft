// The Network tool, built on your own LinkedIn Connections.csv. The file is read on this computer; jobleft never
// contacts LinkedIn or any people-lookup service, never guesses an email, and never sends a message for you.
// Tabs: Companies (people you know at the companies you target, and where you know nobody), People, Plan (the
// coffee-chat list), Follow-ups, and Import and data (how to get the file, the report, delete everything).

import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Drawer, Input, Popconfirm, Select, Space, Table, Tabs, Tag } from 'antd';
import { CheckOutlined, DeleteOutlined, MessageOutlined, PlusOutlined } from '@ant-design/icons';
import {
  OUTREACH_STAGE_LABELS, type CoffeeChatPlanEntry, type CompanyCoverage, type ContactRank, type NetworkCompanyGroup, type NetworkImportSummary,
} from '@jobleft/contracts';
import { call, type UiError } from '../app/api.ts';
import { invalidate, useApi } from '../app/data.ts';
import { confirmDiscard, ui, useDirty } from '../app/layers.ts';
import { navigate } from '../app/router.ts';
import { DraftModal } from '../components/DraftModal.tsx';
import { EmptyState, ErrorState, InlineError, Loading } from '../components/States.tsx';
import { calendarDate, plural } from '../lib/format.ts';
import { DeletePanel, ImportReport, Importer } from './network/Import.tsx';
import { ContactName, MatchExplain, NobodyTag, ProfileLink, ReasonList, StageSelect, emailText, fullName, saveContact, type Contact } from './network/shared.tsx';

const PAGE = 50;
const todayText = () => new Date().toISOString().slice(0, 10);

/** How many people the network holds (the sum of the company groups), and the groups themselves. */
const useGroups = () => useApi<NetworkCompanyGroup[]>('network:companies', () => call('networkCompanies'));

function ContactDrawer({ c: start, onClose, onDraft }: { c: Contact | null; onClose: () => void; onDraft: (c: Contact) => void }) {
  const [c, setC] = useState<Contact | null>(start);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { setC(start); setNote(null); }, [start?.id]);
  const value = note ?? c?.note ?? '';
  const dirty = !!c && note !== null && note !== (c.note ?? '');
  useDirty('contact-note', dirty, 'the note');
  if (!c) return null;
  const cur = c;
  const close = async () => { if (await confirmDiscard(dirty ? ['the note'] : [])) { setNote(null); onClose(); } };
  const save = async (body: Parameters<typeof saveContact>[1], ok: string) => { const s = await saveContact(cur, body, ok); if (s) setC(s); return s; };
  return (
    <Drawer open onClose={() => { void close(); }} width="min(520px, 94vw)" title={<ContactName c={cur} />}>
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <span>{cur.position ?? 'No title in your file'}{cur.company ? ` at ${cur.company}` : ' · no company in your file'}</span>
        {cur.connectedOn && <span className="jl-muted">Connected {calendarDate(cur.connectedOn)}</span>}
        <span className={cur.email ? '' : 'jl-muted'}>{cur.email ? `Email in your file: ${cur.email}` : emailText(cur)}</span>
        <ProfileLink c={cur} />
        <label className="jl-row">Stage <StageSelect c={cur} size="middle" /></label>
        <label className="jl-row">Follow up on <Input type="date" style={{ width: 180 }} value={cur.followUpOn ?? ''} aria-label="Follow-up date" onChange={(e) => { void save({ followUpOn: e.target.value || null }, e.target.value ? 'Follow-up date set.' : 'Follow-up date cleared.'); }} /></label>
        <Checkbox checked={cur.inPlan} onChange={(e) => { void save({ inPlan: e.target.checked }, e.target.checked ? 'Added to your coffee-chat list.' : 'Removed from your coffee-chat list.'); }}>In my coffee-chat list</Checkbox>
        <span style={{ fontWeight: 600 }}>Note</span>
        <Input.TextArea value={value} onChange={(e) => setNote(e.target.value)} autoSize={{ minRows: 3 }} maxLength={20000} aria-label="Note about this person" />
        <Space>
          <Button type="primary" shape="round" disabled={!dirty} onClick={async () => { if (await save({ note: value || null }, 'Note saved.')) setNote(null); }}>Save note</Button>
          <Button shape="round" icon={<MessageOutlined />} onClick={() => onDraft(cur)}>Draft a message</Button>
        </Space>
        <Popconfirm title="Delete this person and everything about them?" okText="Delete" okButtonProps={{ danger: true }} onConfirm={async () => {
          try { await call('deleteContact', { params: { contactId: cur.id } }); invalidate('network', 'jobs:', 'job:', 'notifications'); ui.message?.success('Deleted.'); setNote(null); onClose(); } catch (e) { ui.message?.error((e as UiError).message); }
        }}>
          <Button danger type="text" icon={<DeleteOutlined />}>Delete this person</Button>
        </Popconfirm>
      </Space>
    </Drawer>
  );
}

function CompanyCard({ x, onOpen, onEveryone }: { x: CompanyCoverage; onOpen: (c: Contact) => void; onEveryone: () => void }) {
  const ranks = useApi<ContactRank[]>(`network:rank:${x.companyKey}:`, () => call('rankContacts', { query: { companyKey: x.companyKey } }));
  const people = useApi<Contact[]>(`network:contacts:c:${x.companyKey}`, () => call('listContacts', { query: { companyKey: x.companyKey } }));
  const byId = new Map((people.data ?? []).map((c) => [c.id, c]));
  const top = (ranks.data ?? []).slice(0, 3);
  const addTop = async () => {
    try {
      const added = await call('planTopContacts', { body: { companyKey: x.companyKey, count: 2 } });
      invalidate('network');
      ui.message?.success(`${plural(added.length, 'person', 'people')} from ${x.companyName} are in your coffee-chat list.`);
    } catch (e) { ui.message?.error((e as UiError).message); }
  };
  return (
    <section className="jl-card-box" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }} aria-label={x.companyName}>
      <strong style={{ fontSize: 16 }}>{x.companyName}</strong>
      <span>You know {plural(x.count, 'person', 'people')} at {x.companyName}</span>
      <div>
        <div className="jl-small" style={{ fontWeight: 600 }}>Who to contact first</div>
        {top.map((r, i) => {
          const c = byId.get(r.contactId);
          return c ? (
            <div key={r.contactId} style={{ padding: '4px 0' }}>
              <Button type="link" style={{ padding: 0, height: 'auto' }} onClick={() => onOpen(c)}>{i + 1}. {fullName(c)}</Button>
              <span className="jl-small jl-muted"> {c.position ?? 'No title in your file'}</span>
              <ReasonList reasons={r.reasons} />
            </div>
          ) : null;
        })}
      </div>
      <div className="jl-row jl-wrap">
        <Button size="small" shape="round" icon={<PlusOutlined />} onClick={() => { void addTop(); }}>Add top 2 to my coffee-chat list</Button>
        {x.count > 3 && <Button size="small" shape="round" onClick={onEveryone}>Everyone at {x.companyName} ({x.count})</Button>}
      </div>
      <MatchExplain companyKey={x.companyKey} companyName={x.companyName} />
    </section>
  );
}

function CompaniesTab({ onOpen, onEveryone }: { onOpen: (c: Contact) => void; onEveryone: (key: string, name: string) => void }) {
  const coverage = useApi<CompanyCoverage[]>('network:coverage', () => call('networkCoverage'));
  const cov = coverage.data ?? [];
  const known = cov.filter((x) => x.count > 0);
  const nobody = cov.filter((x) => x.count === 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <p className="jl-muted" style={{ margin: 0 }}>Your target companies are the companies of jobs you liked, applied to or added. For each one, jobleft shows who you know there and who to contact first.</p>
      {coverage.error && <InlineError error={coverage.error} onRetry={() => { void coverage.reload(); }} />}
      {coverage.data && !cov.length && <EmptyState art="people" title="No target companies yet" text="Like, track or add a job, and its company becomes a target. Then this page shows who you know there, and where you know nobody yet." action={<Button shape="round" type="primary" onClick={() => navigate('jobs')}>Browse jobs</Button>} />}
      {known.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
          {known.map((x) => <CompanyCard key={x.companyKey} x={x} onOpen={onOpen} onEveryone={() => onEveryone(x.companyKey, x.companyName)} />)}
        </div>
      )}
      {cov.length > 0 && (
        <section className="jl-card-box" aria-labelledby="nobody-h">
          <h2 id="nobody-h" className="jl-section-title" style={{ fontSize: 17 }}>Where you know nobody yet ({nobody.length})</h2>
          {nobody.length
            ? <><p className="jl-muted">These target companies have nobody from your file. These are the places to build new contacts. Click a company to see similar names in your file that were not counted, and why.</p><div className="jl-row jl-wrap">{nobody.map((x) => <NobodyTag key={x.companyKey} companyKey={x.companyKey} companyName={x.companyName} />)}</div></>
            : <p className="jl-muted">You know someone at every target company.</p>}
        </section>
      )}
    </div>
  );
}

function PeopleTab({ company, clearCompany, onOpen, onDraft, groups }: { company: { key: string; name: string } | null; clearCompany: () => void; onOpen: (c: Contact) => void; onDraft: (c: Contact) => void; groups: NetworkCompanyGroup[] | undefined }) {
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [stage, setStage] = useState<string>('all');
  const [noCompany, setNoCompany] = useState(false);
  const [pages, setPages] = useState(1);
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 200); return () => clearTimeout(t); }, [q]);
  useEffect(() => { setPages(1); }, [dq, stage, noCompany, company?.key]);
  const limit = PAGE * pages;
  const key = `network:contacts:p:${dq}|${stage}|${noCompany}|${company?.key ?? ''}|${limit}`;
  const list = useApi<Contact[]>(key, () => call('listContacts', {
    query: { limit: String(limit), ...(dq ? { q: dq } : {}), ...(stage !== 'all' ? { stage: stage as never } : {}), ...(noCompany ? { noCompany: 'true' } : {}), ...(company ? { companyKey: company.key } : {}) },
  } as never));
  const total = groups ? groups.reduce((n, g) => n + g.count, 0) : null;
  const rows = list.data ?? [];
  const filtered = !!dq || stage !== 'all' || noCompany || !!company;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="jl-row jl-wrap">
        <Input.Search allowClear placeholder="Search name, company or title" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} aria-label="Search your connections" />
        <Select value={stage} onChange={setStage} style={{ width: 170 }} aria-label="Filter by stage" options={[{ value: 'all', label: 'Every stage' }, ...Object.entries(OUTREACH_STAGE_LABELS).map(([value, label]) => ({ value, label }))]} />
        <Checkbox checked={noCompany} onChange={(e) => setNoCompany(e.target.checked)}>No company in the file</Checkbox>
        {company && <Tag closable onClose={clearCompany}>Company: {company.name}</Tag>}
        <span className="jl-muted" role="status">{list.data ? (filtered ? `${plural(rows.length, 'person', 'people')} shown` : total !== null ? `${plural(total, 'person', 'people')} in your network` : '') : ''}</span>
      </div>
      {list.error && <InlineError error={list.error} onRetry={() => { void list.reload(); }} />}
      {!list.data && !list.error && <Loading label="Loading people" />}
      {list.data && !rows.length && <EmptyState art="people" title={filtered ? 'Nobody matches' : 'No people yet'} text={filtered ? 'Change the search or the filters.' : 'Import your connections file to see people here.'} />}
      {rows.length > 0 && (
        <Table size="middle" rowKey="id" dataSource={rows} pagination={false} scroll={{ x: 'max-content' }}
          columns={[
            { title: 'Name', key: 'n', render: (_, c) => <div><Button type="link" style={{ padding: 0, height: 'auto', textAlign: 'left', whiteSpace: 'normal' }} onClick={() => onOpen(c)}><ContactName c={c} /></Button><div><ProfileLink c={c} /></div></div> },
            { title: 'Company', key: 'c', render: (_, c) => c.company ?? <span className="jl-muted">Company not in file</span> },
            { title: 'Title', key: 't', render: (_, c) => c.position ?? <span className="jl-muted">No title in file</span> },
            { title: 'Email', key: 'e', render: (_, c) => <span className={c.email ? '' : 'jl-muted'}>{emailText(c)}</span> },
            { title: 'Stage', key: 's', width: 170, render: (_, c) => <StageSelect c={c} /> },
            { title: 'Follow up', key: 'f', render: (_, c) => calendarDate(c.followUpOn) ?? '' },
            { title: <span className="jl-sr">Actions</span>, key: 'a', render: (_, c) => (
              <Space size={4} wrap>
                <Button size="small" shape="round" icon={c.inPlan ? <CheckOutlined /> : <PlusOutlined />} aria-pressed={c.inPlan} aria-label={c.inPlan ? `Remove ${fullName(c)} from my coffee-chat list` : `Add ${fullName(c)} to my coffee-chat list`}
                  onClick={() => { void saveContact(c, { inPlan: !c.inPlan }, c.inPlan ? 'Removed from your coffee-chat list.' : 'Added to your coffee-chat list.'); }}>{c.inPlan ? 'In my list' : 'Add to list'}</Button>
                <Button size="small" shape="round" icon={<MessageOutlined />} onClick={() => onDraft(c)} aria-label={`Draft a message to ${fullName(c)}`}>Draft</Button>
              </Space>) },
          ]} />
      )}
      {list.data && rows.length === limit && <Button shape="round" style={{ alignSelf: 'flex-start' }} onClick={() => setPages(pages + 1)}>Show {PAGE} more</Button>}
    </div>
  );
}

function PlanTab({ onOpen, onDraft }: { onOpen: (c: Contact) => void; onDraft: (c: Contact) => void }) {
  const plan = useApi<CoffeeChatPlanEntry[]>('network:plan', () => call('networkPlan'));
  const people = useApi<Contact[]>('network:contacts:plan', () => call('listContacts', { query: { inPlan: 'true' } }));
  const byId = new Map((people.data ?? []).map((c) => [c.id, c]));
  if (plan.error && !plan.data) return <ErrorState error={plan.error} onRetry={() => { void plan.reload(); }} />;
  if (!plan.data) return <Loading label="Loading your coffee-chat list" />;
  if (!plan.data.length) return <EmptyState art="people" title="Your coffee-chat list is empty" text="You choose who goes on it. Add someone from the People tab, or press “Add top 2” on a company. Nobody is added for you." />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {plan.data.map((co) => (
        <section key={co.companyKey ?? co.companyName} className="jl-card-box" aria-label={co.companyName}>
          <strong style={{ fontSize: 16 }}>{co.companyName}</strong>
          {co.contacts.map((p) => {
            const c = byId.get(p.contactId);
            return (
              <div key={p.contactId} style={{ padding: '8px 0', borderTop: '1px solid var(--jl-line)' }}>
                <div className="jl-row jl-wrap">
                  {c ? <Button type="link" style={{ padding: 0 }} onClick={() => onOpen(c)}>{p.firstName} {p.lastName}</Button> : <strong>{p.firstName} {p.lastName}</strong>}
                  <span className="jl-grow jl-small jl-muted">{p.position ?? 'No title in your file'}</span>
                  {c && <StageSelect c={c} />}
                  {c && <Button size="small" shape="round" icon={<MessageOutlined />} onClick={() => onDraft(c)}>Draft</Button>}
                  {c && <Button size="small" shape="round" onClick={() => { void saveContact(c, { inPlan: false }, `${p.firstName} ${p.lastName} is off your coffee-chat list. They are still in your network.`); }}>Remove from list</Button>}
                </div>
                <ReasonList reasons={p.reasons} />
                <div className="jl-small">Next: {p.nextStep}</div>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

function FollowUpsTab({ onOpen, onDraft }: { onOpen: (c: Contact) => void; onDraft: (c: Contact) => void }) {
  const due = useApi<Contact[]>('network:contacts:due', () => call('listContacts', { query: { due: 'true' } }));
  const soon = useApi<Contact[]>('network:contacts:soon', () => call('listContacts', { query: { withFollowUp: 'true', due: 'false' } }));
  const table = (rows: Contact[]) => (
    <Table size="middle" rowKey="id" dataSource={rows} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 'max-content' }} columns={[
      { title: 'Name', key: 'n', render: (_, c) => <Button type="link" style={{ padding: 0 }} onClick={() => onOpen(c)}><ContactName c={c} /></Button> },
      { title: 'Company', key: 'c', render: (_, c) => c.company ?? <span className="jl-muted">Company not in file</span> },
      { title: 'Stage', key: 's', render: (_, c) => <StageSelect c={c} /> },
      { title: 'Follow up', key: 'f', render: (_, c) => calendarDate(c.followUpOn) ?? '' },
      { title: <span className="jl-sr">Actions</span>, key: 'a', render: (_, c) => <Button size="small" shape="round" icon={<MessageOutlined />} onClick={() => onDraft(c)}>Draft</Button> },
    ]} />
  );
  const sorted = (soon.data ?? []).slice().sort((a, b) => ((a.followUpOn ?? '') < (b.followUpOn ?? '') ? -1 : 1));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section aria-labelledby="due-h">
        <h2 id="due-h" className="jl-section-title" style={{ fontSize: 17 }}>Due today or earlier ({due.data?.length ?? 0})</h2>
        {due.error && <InlineError error={due.error} onRetry={() => { void due.reload(); }} />}
        {due.data && (due.data.length ? table(due.data) : <EmptyState art="bell" title="No follow-ups due" text="Set a follow-up date on a person. jobleft reminds you on that day." />)}
      </section>
      {sorted.length > 0 && (
        <section aria-labelledby="soon-h">
          <h2 id="soon-h" className="jl-section-title" style={{ fontSize: 17 }}>Coming up ({sorted.length})</h2>
          {table(sorted)}
        </section>
      )}
    </div>
  );
}

export function NetworkScreen({ tab }: { tab: string | null }) {
  const groups = useGroups();
  const [open, setOpen] = useState<Contact | null>(null);
  const [draftFor, setDraftFor] = useState<Contact | null>(null);
  const [summary, setSummary] = useState<NetworkImportSummary | null>(null);
  const [company, setCompany] = useState<{ key: string; name: string } | null>(null);
  const due = useApi<Contact[]>('network:contacts:due', () => call('listContacts', { query: { due: 'true' } }));
  const planCount = useApi<Contact[]>('network:contacts:plan', () => call('listContacts', { query: { inPlan: 'true' } }));
  const active = tab ?? 'companies';
  const total = useMemo(() => (groups.data ? groups.data.reduce((n, g) => n + g.count, 0) : null), [groups.data]);

  if (groups.error && !groups.data) return <div className="jl-page"><ErrorState error={groups.error} onRetry={() => { void groups.reload(); }} /></div>;
  if (!groups.data) return <div className="jl-page"><Loading label="Loading your network" /></div>;

  // Before any import (or after "delete all"): the empty state, with how to get the file. No sample people.
  if (total === 0) {
    return (
      <div className="jl-page"><div className="jl-page-inner" style={{ maxWidth: 820, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {summary && <ImportReport s={summary} />}
        <Alert type="info" showIcon message="Your network is empty" description="jobleft shows only people from your own connections file. Nothing is added for you, and nothing is looked up." />
        <Importer first onDone={setSummary} />
      </div></div>
    );
  }

  return (
    <div className="jl-page">
      <div className="jl-page-inner">
        {summary && <div style={{ marginBottom: 12 }}><ImportReport s={summary} /></div>}
        <Tabs activeKey={active} onChange={(k) => navigate(`network/${k}`)} items={[
          { key: 'companies', label: 'Companies', children: <CompaniesTab onOpen={setOpen} onEveryone={(key, name) => { setCompany({ key, name }); navigate('network/people'); }} /> },
          { key: 'people', label: `People (${(total ?? 0).toLocaleString('en-US')})`, children: <PeopleTab company={company} clearCompany={() => setCompany(null)} onOpen={setOpen} onDraft={setDraftFor} groups={groups.data} /> },
          { key: 'plan', label: `Coffee chats (${planCount.data?.length ?? 0})`, children: <PlanTab onOpen={setOpen} onDraft={setDraftFor} /> },
          { key: 'followups', label: `Follow-ups (${due.data?.length ?? 0})`, children: <FollowUpsTab onOpen={setOpen} onDraft={setDraftFor} /> },
          {
            key: 'import', label: 'Import and data',
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 820 }}>
                <Importer onDone={setSummary} />
                <DeletePanel total={total} />
              </div>
            ),
          },
        ]} />
      </div>
      <ContactDrawer c={open} onClose={() => setOpen(null)} onDraft={(c) => setDraftFor(c)} />
      <DraftModal contact={draftFor} jobId={null} jobLabel={null} open={!!draftFor} onClose={() => setDraftFor(null)} />
    </div>
  );
}
