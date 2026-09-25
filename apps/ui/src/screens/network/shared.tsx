// Small pieces the Network tool shares between its tabs and the job detail: the person's name, the stage picker, the
// reasons list, the profile link and the one function that saves a change. Every value is shown as in the file;
// a missing value is said plainly ("No email in your file"), never "undefined" or "null".

import { useState } from 'react';
import { Button, Select, Tag } from 'antd';
import { ExportOutlined } from '@ant-design/icons';
import { OUTREACH_STAGES, OUTREACH_STAGE_LABELS, type CompanyMatchExplanation, type NetworkContact, type OutreachStage } from '@jobleft/contracts';
import { Tooltip } from '../../components/Tip.tsx';
import { call, type UiError } from '../../app/api.ts';
import { invalidate, useApi } from '../../app/data.ts';
import { ui } from '../../app/layers.ts';
import { InlineError } from '../../components/States.tsx';

export type Contact = NetworkContact;

/** Saves a change and returns the contact as the server now holds it (null when it failed; the reason is shown). */
export async function saveContact(c: Contact, body: { stage?: OutreachStage; note?: string | null; followUpOn?: string | null; inPlan?: boolean }, ok: string): Promise<Contact | null> {
  try {
    const saved = await call('updateContact', { params: { contactId: c.id }, body });
    invalidate('network', 'notifications');
    ui.message?.success(ok);
    return saved;
  } catch (e) { ui.message?.error((e as UiError).message); return null; }
}

export function fullName(c: Contact): string {
  return `${c.firstName} ${c.lastName}`.trim() || 'Name not in file';
}

export function ContactName({ c }: { c: Contact }) {
  return (
    <span>
      <strong>{fullName(c)}</strong>
      {c.maybeGarbled && <Tooltip title="The export may have garbled this name. It is shown exactly as in your file."><Tag style={{ marginLeft: 6 }}>as in file</Tag></Tooltip>}
      {c.inLatestFile === false && <Tooltip title="Not in the latest file you imported. Kept with its notes until you delete it."><Tag style={{ marginLeft: 6 }}>no longer in your file</Tag></Tooltip>}
    </span>
  );
}

export function StageSelect({ c, size = 'small' }: { c: Contact; size?: 'small' | 'middle' }) {
  return (
    <Select size={size} style={{ width: 150 }} value={c.stage} aria-label={`Stage of ${fullName(c)}`}
      onChange={(v) => { void saveContact(c, { stage: v }, `${fullName(c)}: ${OUTREACH_STAGE_LABELS[v]}.`); }}
      options={OUTREACH_STAGES.map((s) => ({ value: s, label: OUTREACH_STAGE_LABELS[s] }))} />
  );
}

export function ReasonList({ reasons }: { reasons: Array<{ code: string; text: string }> }) {
  if (!reasons.length) return null;
  return <ul className="jl-small" style={{ margin: '4px 0 0', paddingLeft: 18, color: 'var(--jl-text2)' }}>{reasons.map((r) => <li key={r.code + r.text}>{r.text}</li>)}</ul>;
}

/** A plain link: nothing is loaded until the person clicks, and then their own browser opens it. */
export function ProfileLink({ c }: { c: Contact }) {
  if (!c.profileUrl) return <span className="jl-small jl-muted">No profile link in your file</span>;
  return <a className="jl-small" href={c.profileUrl} target="_blank" rel="noopener noreferrer"><ExportOutlined /> Open profile</a>;
}

export function emailText(c: Contact): string {
  return c.email ? c.email : 'No email in your file';
}

/** How a count was made: the names counted, and near names that were NOT counted, with the reason. */
export function MatchExplain({ companyKey, companyName }: { companyKey: string; companyName: string }) {
  const [open, setOpen] = useState(false);
  const x = useApi<CompanyMatchExplanation>(open ? `network:match:${companyKey}` : null, () => call('explainCompanyMatch', { query: { companyKey, companyName } }));
  return (
    <div>
      <Button type="link" size="small" style={{ padding: 0 }} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide how this was counted' : 'How was this counted?'}</Button>
      {open && x.data && (
        <div className="jl-small" style={{ marginTop: 4 }}>
          <div>Counted: {x.data.matched.map((m) => `"${m.name}" (${m.count})`).join(', ')}</div>
          {x.data.notCounted.length > 0
            ? <div>Not counted, because they are different companies: {x.data.notCounted.map((m) => `"${m.name}" (${m.count})`).join(', ')}</div>
            : <div className="jl-muted">No similar company names were left out.</div>}
        </div>
      )}
      {open && x.error && <InlineError error={x.error} />}
    </div>
  );
}

