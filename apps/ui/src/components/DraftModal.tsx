// Drafts a short message to one of the person's own connections. jobleft never sends it: the person copies it
// and sends it themselves. The draft request carries only this contact's name, title and company, one job, and a
// short summary of the person.

import { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal, Radio, Space } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import type { NetworkContact, OutreachDraft } from '@jobleft/contracts';
import { call, type UiError } from '../app/api.ts';
import { invalidate } from '../app/data.ts';
import { confirmDiscard, ui, useDirty } from '../app/layers.ts';
import { useAiSettings } from '../app/session.ts';
import { AiNote, afterAiStep, ensureAiConsent } from './AiNote.tsx';
import { InlineError } from './States.tsx';

export function DraftModal({ contact, jobId, jobLabel, open, onClose }: { contact: NetworkContact | null; jobId: string | null; jobLabel: string | null; open: boolean; onClose: () => void }) {
  const ai = useAiSettings();
  const [variant, setVariant] = useState<'short' | 'long'>('short');
  const [draft, setDraft] = useState<OutreachDraft | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<UiError | null>(null);
  useEffect(() => { if (!open) { setDraft(null); setText(''); setErr(null); } }, [open]);
  const edited = !!draft && text !== draft.text;
  useDirty('outreach-draft', edited, 'your edited message');
  if (!contact) return null;
  const name = `${contact.firstName} ${contact.lastName}`.trim();
  const run = async () => {
    if (!(await ensureAiConsent(ai.data, 'outreachDraft'))) return;
    setBusy(true); setErr(null);
    try {
      const d = await call('draftOutreach', { params: { contactId: contact.id }, body: { variant, ...(jobId ? { jobId } : {}) } });
      setDraft(d); setText(d.text);
      afterAiStep(d.costMicros);
    } catch (e) { setErr(e as UiError); invalidate('ai:publik'); } finally { setBusy(false); }
  };
  const markMessaged = async () => {
    try {
      await call('updateContact', { params: { contactId: contact.id }, body: { stage: 'messaged' } });
      invalidate('network');
      ui.message?.success(`${name} is now marked as messaged.`);
    } catch (e) { ui.message?.error((e as UiError).message); }
  };
  return (
    <Modal open={open} onCancel={async () => { if (await confirmDiscard(edited ? ['your edited message'] : [])) onClose(); }} title={`Message to ${name}`} footer={null} width={620} destroyOnClose>
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <span className="jl-muted">{contact.position ?? 'No title in your file'}{contact.company ? ` at ${contact.company}` : ''}{jobLabel ? ` · about ${jobLabel}` : ''}</span>
        <Radio.Group value={variant} onChange={(e) => setVariant(e.target.value)} aria-label="Message length">
          <Radio value="short">Short (fits a connection note)</Radio>
          <Radio value="long">Longer (for email or a message)</Radio>
        </Radio.Group>
        <p className="jl-small jl-muted">The request sends only {name}'s name, title and company{jobLabel ? ', this job' : ''}, and a short summary of you.</p>
        <AiNote kind="outreachDraft" what="draft a message" />
        <Button type="primary" shape="round" loading={busy} onClick={() => { void run(); }}>{draft ? 'Draft again' : 'Draft a message'}</Button>
        <InlineError error={err} />
        {draft && (
          <>
            {draft.warnings.length > 0 && <Alert type="warning" showIcon message="Check before you send" description={draft.warnings.join(' ')} />}
            <Input.TextArea value={text} onChange={(e) => setText(e.target.value)} autoSize={{ minRows: 4, maxRows: 12 }} aria-label="Message text" />
            {draft.charLimit && <span className={text.length > draft.charLimit ? '' : 'jl-muted'} style={text.length > draft.charLimit ? { color: 'var(--jl-error)' } : undefined}>{text.length} of {draft.charLimit} characters</span>}
            <div className="jl-row jl-wrap">
              <Button shape="round" icon={<CopyOutlined />} onClick={() => { void navigator.clipboard?.writeText(text).then(() => ui.message?.success('Copied. Paste it where you want to send it.')); }}>Copy message</Button>
              <Button shape="round" onClick={() => { void markMessaged(); }}>I sent it: mark as messaged</Button>
            </div>
            <p className="jl-small jl-muted">jobleft never sends messages for you.</p>
          </>
        )}
      </Space>
    </Modal>
  );
}
