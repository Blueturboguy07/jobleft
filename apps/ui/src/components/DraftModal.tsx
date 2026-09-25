// Drafts a short message to one of the person's own connections. jobleft never sends it: the person edits it, copies
// it and sends it themselves. Before anything leaves this computer the window shows where the text goes and exactly
// what it holds (one contact's name, title and company, one job, a short summary of the person). With no AI provider
// the plain template still works.

import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Collapse, Input, Modal, Radio, Space } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { formatDollars, type DraftPreview, type NetworkContact, type OutreachDraft, type PublikConnection } from '@jobleft/contracts';
import { call, type UiError } from '../app/api.ts';
import { invalidate, useApi } from '../app/data.ts';
import { confirmDiscard, ui, useDirty } from '../app/layers.ts';
import { navigate } from '../app/router.ts';
import { InlineError } from './States.tsx';

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* try the older way below */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

export function DraftModal({ contact, jobId, jobLabel, open, onClose }: { contact: NetworkContact | null; jobId: string | null; jobLabel: string | null; open: boolean; onClose: () => void }) {
  const [variant, setVariant] = useState<'short' | 'long'>('short');
  const [preview, setPreview] = useState<DraftPreview | null>(null);
  const [previewErr, setPreviewErr] = useState<UiError | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [draft, setDraft] = useState<OutreachDraft | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<UiError | null>(null);
  const publik = useApi<PublikConnection>(open && preview?.destination?.provider === 'publik' ? 'ai:publik' : null, () => call('getPublik'), { revalidate: true });
  const contactId = contact?.id ?? null;

  useEffect(() => { if (!open) { setDraft(null); setText(''); setErr(null); setAgreed(false); setPreview(null); setPreviewErr(null); } }, [open]);
  // What a draft would send and to whom. Nothing is sent by this call.
  useEffect(() => {
    if (!open || !contactId) return;
    let live = true;
    setPreviewErr(null);
    call('previewDraft', { params: { contactId }, body: { variant, ...(jobId ? { jobId } : {}) } })
      .then((p) => { if (live) setPreview(p); })
      .catch((e) => { if (live) setPreviewErr(e as UiError); });
    return () => { live = false; };
  }, [open, contactId, variant, jobId]);

  const edited = !!draft && text !== draft.text;
  useDirty('outreach-draft', edited, 'your edited message');
  if (!contact) return null;
  const name = `${contact.firstName} ${contact.lastName}`.trim();
  const dest = preview?.destination ?? null;

  const run = async (template: boolean) => {
    setBusy(true); setErr(null);
    try {
      const d = await call('draftOutreach', {
        params: { contactId: contact.id },
        body: { variant, ...(jobId ? { jobId } : {}), ...(template ? { template: true } : {}), ...(!template && dest?.remote && agreed ? { confirmRemote: true } : {}) },
      });
      setDraft(d); setText(d.text);
      invalidate('ai:publik', 'ai:settings');
    } catch (e) { setErr(e as UiError); invalidate('ai:publik'); } finally { setBusy(false); }
  };
  const markMessaged = async () => {
    try {
      await call('updateContact', { params: { contactId: contact.id }, body: { stage: 'messaged' } });
      invalidate('network');
      ui.message?.success(`${name} is now marked as messaged.`);
    } catch (e) { ui.message?.error((e as UiError).message); }
  };
  const wallet = publik.data?.state === 'connected' ? publik.data.wallet : null;
  const canAi = !!dest && (!dest.remote || !preview?.needsConfirmation || agreed);

  return (
    <Modal open={open} onCancel={async () => { if (await confirmDiscard(edited ? ['your edited message'] : [])) onClose(); }} title={`Message to ${name}`} footer={null} width={640} destroyOnClose>
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <span className="jl-muted">{contact.position ?? 'No title in your file'}{contact.company ? ` at ${contact.company}` : ''}{jobLabel ? ` · about ${jobLabel}` : ''}</span>
        <Radio.Group value={variant} onChange={(e) => { setVariant(e.target.value); setDraft(null); setText(''); }} aria-label="Message length">
          <Radio value="short">Short (fits a connection note)</Radio>
          <Radio value="long">Longer (for email or a message)</Radio>
        </Radio.Group>
        <InlineError error={previewErr} />
        {preview && (
          <div className="jl-provider-note" role="note" style={{ display: 'block' }}>
            {dest
              ? <p style={{ margin: 0 }}>{dest.remote
                ? <>Drafting sends the details below to <strong>{dest.label}</strong>.{dest.provider === 'publik' ? ' It charges your publik balance.' : ''}</>
                : <>Drafting runs on <strong>{dest.label}</strong>. Nothing leaves this computer and nothing is charged.</>}</p>
              : <p style={{ margin: 0 }}>No AI provider is set up. An AI provider is needed to write a draft with AI. You can use the plain template below, or choose a provider first.</p>}
            <p className="jl-small" style={{ margin: '6px 0 0' }}>
              Only this one person is included: {preview.sends.contact.firstName} {preview.sends.contact.lastName}
              {preview.sends.contact.title ? `, ${preview.sends.contact.title}` : ''}{preview.sends.contact.company ? `, ${preview.sends.contact.company}` : ''}
              {preview.sends.job ? `; the job ${preview.sends.job.title} at ${preview.sends.job.company}` : ''}
              {preview.sends.aboutMe ? '; a short summary of you.' : '.'} Never an email address or a profile link, and never the rest of your network.
            </p>
            <Collapse ghost size="small" items={[{ key: 'x', label: 'Show exactly what is sent', children: <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>{preview.messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n')}</pre> }]} />
            {dest?.provider === 'publik' && wallet && <p className="jl-small" style={{ margin: 0 }}>Your publik balance: <strong>{formatDollars(wallet.balanceMicros)}</strong></p>}
          </div>
        )}
        {dest?.remote && preview?.needsConfirmation && (
          <Checkbox checked={agreed} onChange={(e) => setAgreed(e.target.checked)}>Send this one person's details to {dest.label}</Checkbox>
        )}
        <div className="jl-row jl-wrap">
          {dest && <Button type="primary" shape="round" loading={busy} disabled={!canAi} onClick={() => { void run(false); }}>{draft ? 'Draft again with AI' : 'Draft with AI'}</Button>}
          <Button shape="round" loading={busy && !dest} onClick={() => { void run(true); }}>Use a plain template (no AI)</Button>
          {!dest && <Button type="link" onClick={() => navigate('settings/ai')}>Choose an AI provider</Button>}
        </div>
        <InlineError error={err} />
        {draft && (
          <>
            {draft.warnings.length > 0
              ? <Alert type="warning" showIcon message="Not ready: check before you send" description={<ul style={{ margin: 0, paddingLeft: 18 }}>{draft.warnings.map((w) => <li key={w}>{w}</li>)}</ul>} />
              : <Alert type="success" showIcon message="Ready: it uses only facts from your file, the job and your profile" />}
            <Input.TextArea value={text} onChange={(e) => setText(e.target.value)} autoSize={{ minRows: 4, maxRows: 12 }} aria-label="Message text" />
            {draft.charLimit && <span className={text.length > draft.charLimit ? '' : 'jl-muted'} style={text.length > draft.charLimit ? { color: 'var(--jl-error)' } : undefined}>{text.length} of {draft.charLimit} characters</span>}
            <span className="jl-small jl-muted">Written by {draft.provider}{draft.costMicros ? `. This draft cost ${formatDollars(draft.costMicros)} from your publik balance.` : '.'}</span>
            <div className="jl-row jl-wrap">
              <Button shape="round" icon={<CopyOutlined />} onClick={() => { void copyText(text).then((ok) => (ok ? ui.message?.success('Copied. Paste it where you want to send it.') : ui.message?.error('Copy did not work. Select the text and copy it yourself.'))); }}>Copy message</Button>
              <Button shape="round" onClick={() => { void markMessaged(); }}>I sent it: mark as messaged</Button>
            </div>
            <p className="jl-small jl-muted">jobleft never sends messages for you.</p>
          </>
        )}
      </Space>
    </Modal>
  );
}
