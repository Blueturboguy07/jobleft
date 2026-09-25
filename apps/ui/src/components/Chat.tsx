// The assistant chat. Answers stream in; Stop cancels the request upstream too. The assistant may SUGGEST changes
// (a status, a like, a note); nothing changes until the person ticks each one and presses "Apply selected".
// Suggested questions only fill the box; nothing is sent without pressing Send.

import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Input, Tooltip } from 'antd';
import { CloseOutlined, SendOutlined, StopOutlined, ReloadOutlined } from '@ant-design/icons';
import { formatDollars, type ActionProposal, type ChatThread } from '@jobleft/contracts';
import { call, streamChat, type UiError } from '../app/api.ts';
import { invalidate } from '../app/data.ts';
import { ui } from '../app/layers.ts';
import { afterTrackerChange, useAiSettings } from '../app/session.ts';
import { AiNote, afterAiStep, ensureAiConsent } from './AiNote.tsx';
import { InlineError } from './States.tsx';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  incomplete?: boolean;
  costMicros?: number | null;
}

let reqSeq = 0;

export function Chat({ jobId, jobTitle, chatId: initialChatId, draft, onThread, onClearJob, autoFocus = false }: {
  jobId: string | null; jobTitle: string | null; chatId?: string | null; draft?: string; onThread?: (id: string) => void; onClearJob?: () => void; autoFocus?: boolean;
}) {
  const ai = useAiSettings();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [chatId, setChatIdState] = useState<string | null>(initialChatId ?? null);
  const chatIdRef = useRef<string | null>(initialChatId ?? null);
  const setChatId = (id: string | null) => { chatIdRef.current = id; setChatIdState(id); };
  const [text, setText] = useState(draft ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<UiError | null>(null);
  const [proposal, setProposal] = useState<ActionProposal | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const abort = useRef<AbortController | null>(null);
  const reqId = useRef<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => { setText(draft ?? ''); }, [draft]);
  useEffect(() => {
    if (initialChatId && initialChatId === chatIdRef.current && msgs.length) return;
    setChatId(initialChatId ?? null);
    setProposal(null);
    setErr(null);
    if (!initialChatId) { setMsgs([]); return; }
    let alive = true;
    call('getChat', { params: { chatId: initialChatId } }).then((t: ChatThread) => {
      if (alive) setMsgs(t.messages.map((m) => ({ role: m.role, content: m.content, incomplete: m.incomplete })));
    }, (e) => { if (alive) setErr(e as UiError); });
    return () => { alive = false; };
  }, [initialChatId]);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [msgs]);
  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus]);

  const send = async (content: string) => {
    const q = content.trim();
    if (!q || busy) return;
    if (!(await ensureAiConsent(ai.data, 'chatTurn'))) return;
    setErr(null);
    setProposal(null);
    const history = [...msgs.filter((m) => m.content).map((m) => ({ role: m.role, content: m.content })), { role: 'user' as const, content: q }];
    setMsgs((m) => [...m, { role: 'user', content: q }, { role: 'assistant', content: '' }]);
    setText('');
    setBusy(true);
    const ac = new AbortController();
    abort.current = ac;
    const rid = `ui-${Date.now()}-${++reqSeq}`;
    reqId.current = rid;
    let cost: number | null = null;
    try {
      await streamChat({ requestId: rid, messages: history, ...(chatId ? { chatId } : {}), ...(jobId ? { jobId } : {}) }, (ev) => {
        if (ev.type === 'delta') setMsgs((m) => { const c = [...m]; const last = c.at(-1)!; c[c.length - 1] = { ...last, content: last.content + ev.text }; return c; });
        if (ev.type === 'proposal') { setProposal(ev.proposal); setPicked([]); }
        if (ev.type === 'done') {
          cost = ev.costMicros;
          setMsgs((m) => { const c = [...m]; const last = c.at(-1)!; c[c.length - 1] = { ...last, incomplete: ev.incomplete, costMicros: ev.costMicros }; return c; });
          if (ev.chatId) { setChatId(ev.chatId); onThread?.(ev.chatId); }
        }
        if (ev.type === 'error') {
          setErr({ code: ev.error.code, status: null, message: ev.error.message, link: ev.error.link ?? null });
          setMsgs((m) => (m.at(-1)?.content === '' ? m.slice(0, -1) : m));
        }
      }, ac.signal);
      invalidate('chats');
      afterAiStep(cost);
    } catch (e) {
      setErr(e as UiError);
      setMsgs((m) => (m.at(-1)?.content === '' ? m.slice(0, -1) : m));
      invalidate('ai:publik');
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  const stop = () => {
    abort.current?.abort();
    if (reqId.current) void call('cancelAi', { params: { requestId: reqId.current } }).catch(() => undefined);
  };

  const decide = async (approve: string[]) => {
    if (!proposal) return;
    try {
      const r = await call('decideProposal', { params: { proposalId: proposal.id }, body: { approveActionIds: approve } });
      setProposal(null);
      afterTrackerChange();
      ui.message?.success(r.applied.length ? `Applied ${r.applied.length} ${r.applied.length === 1 ? 'change' : 'changes'}.` : 'No change was made.');
    } catch (e) { setErr(e as UiError); }
  };

  const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content;
  const suggestions = jobId
    ? ['How well do I fit this job?', 'What should I prepare for an interview here?', 'Summarize this posting in five lines.']
    : ['Which skills come up most in the jobs I liked?', 'Help me plan my job search this week.', 'How do I explain a gap in my work history?'];

  return (
    <div className="jl-chat">
      <div className="jl-chat-log" ref={logRef} aria-live="polite" aria-label="Conversation">
        {!msgs.length && (
          <div className="jl-bubble assistant">
            Ask about a job, your fit, or how to prepare. Answers come from the AI you chose in Settings.
            {jobTitle ? ` This conversation is about ${jobTitle}.` : ''}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`jl-bubble ${m.role}`}>
            <span className="jl-sr">{m.role === 'user' ? 'You said: ' : 'Assistant: '}</span>
            {m.content || (busy && i === msgs.length - 1 ? '…' : '')}
            {m.incomplete && <div className="jl-small" style={{ marginTop: 6, opacity: 0.8 }}>The answer stopped early. What arrived is kept.</div>}
            {m.costMicros ? <div className="jl-small" style={{ marginTop: 6, opacity: 0.8 }}>Cost: {formatDollars(m.costMicros)} from your balance</div> : null}
          </div>
        ))}
        {proposal && (
          <div className="jl-factbox" role="group" aria-label="Suggested changes">
            <strong>The assistant suggests these changes. Nothing changes until you choose.</strong>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '8px 0' }}>
              {proposal.actions.map((a) => (
                <Checkbox key={a.id} checked={picked.includes(a.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, a.id] : picked.filter((x) => x !== a.id))}>{a.summary}</Checkbox>
              ))}
            </div>
            <div className="jl-row">
              <Button size="small" type="primary" shape="round" disabled={!picked.length} onClick={() => { void decide(picked); }}>Apply selected</Button>
              <Button size="small" shape="round" onClick={() => { void decide([]); }}>Decline all</Button>
            </div>
          </div>
        )}
        {err && (
          <div>
            <InlineError error={err} />
            {lastUser && <Button size="small" type="link" icon={<ReloadOutlined />} onClick={() => { setMsgs((m) => m.slice(0, -1)); void send(lastUser); }}>Send again</Button>}
          </div>
        )}
      </div>
      <div className="jl-chat-input">
        {jobTitle && (
          <div className="jl-row jl-small">
            <span className="jl-chip" style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }} title={jobTitle}>About: {jobTitle}</span>
            {onClearJob && <Tooltip title="Stop asking about this job"><Button size="small" type="text" icon={<CloseOutlined />} aria-label="Stop asking about this job" onClick={onClearJob} /></Tooltip>}
          </div>
        )}
        {!msgs.length && (
          <div className="jl-row jl-wrap">
            {suggestions.map((s) => <Button key={s} size="small" shape="round" onClick={() => { setText(s); inputRef.current?.focus(); }}>{s}</Button>)}
          </div>
        )}
        <AiNote kind="chatTurn" what="chat" />
        <div className="jl-row" style={{ alignItems: 'flex-end' }}>
          <Input.TextArea ref={(r) => { inputRef.current = r?.resizableTextArea?.textArea ?? null; }} value={text} onChange={(e) => setText(e.target.value)} autoSize={{ minRows: 1, maxRows: 6 }}
            placeholder="Ask a question" aria-label="Message to the assistant" maxLength={20000}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(text); } }} />
          {busy
            ? <Button shape="circle" icon={<StopOutlined />} onClick={stop} aria-label="Stop the answer" />
            : <Button type="primary" shape="circle" icon={<SendOutlined />} disabled={!text.trim()} onClick={() => { void send(text); }} aria-label="Send" />}
        </div>
      </div>
    </div>
  );
}
