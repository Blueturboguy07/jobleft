// The assistant chat. Answers stream in; Stop cancels the request upstream too. The assistant may SUGGEST changes
// (a status, a like, a note); nothing changes until the person presses Apply (one change) or ticks each one and
// presses "Apply selected". A suggestion stays under the answer until the person decides, also after a reload, and
// the decision is written into the conversation (lib/chatState.ts).
// Suggested questions only fill the box; nothing is sent without pressing Send.

import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Input } from 'antd';
import { Tooltip } from './Tip.tsx';
import { CloseOutlined, SendOutlined, StopOutlined, ReloadOutlined } from '@ant-design/icons';
import { formatDollars, type ActionProposal, type ChatThread } from '@jobleft/contracts';
import { parseMarkdown, type Span } from '../lib/markdown.ts';
import { EMPTY_CHAT, afterDecision, dropEmptyAnswer, onStreamEvent, proposalMode, startTurn, viewOfThread, type ChatView } from '../lib/chatState.ts';
import { call, streamChat, type UiError } from '../app/api.ts';
import { invalidate } from '../app/data.ts';
import { ui } from '../app/layers.ts';
import { afterTrackerChange, useAiSettings } from '../app/session.ts';
import { AiNote, afterAiStep, ensureAiConsent } from './AiNote.tsx';
import { InlineError } from './States.tsx';

let reqSeq = 0;

function Spans({ spans }: { spans: Span[] }) {
  return <>{spans.map((x, i) => (x.bold ? <strong key={i}>{x.text}</strong> : x.italic ? <em key={i}>{x.text}</em> : x.code ? <code key={i}>{x.text}</code> : <span key={i}>{x.text}</span>))}</>;
}

/** An assistant answer: its bold words and lists as text elements, never raw asterisks and never injected HTML. */
function AnswerText({ text }: { text: string }) {
  return (
    <>
      {parseMarkdown(text).map((b, i) => {
        if (b.kind === 'h') return <div key={i} style={{ fontWeight: 700, margin: '6px 0 2px' }}><Spans spans={b.spans} /></div>;
        if (b.kind === 'ul' || b.kind === 'ol') {
          const List = b.kind;
          return <List key={i} style={{ margin: '4px 0', paddingLeft: 20, whiteSpace: 'normal' }}>{b.items.map((it, j) => <li key={j} style={{ whiteSpace: 'pre-wrap' }}><Spans spans={it} /></li>)}</List>;
        }
        if (b.kind !== 'p') return null;
        return <p key={i} style={{ margin: '0 0 6px' }}>{b.lines.map((l, j) => <span key={j}>{j > 0 && <br />}<Spans spans={l} /></span>)}</p>;
      })}
    </>
  );
}

/** One suggestion: what would change, and the buttons that decide it. Nothing is ticked for the person. */
function ProposalCard({ p, onDecide }: { p: ActionProposal; onDecide: (p: ActionProposal, approve: string[]) => Promise<void> }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const decide = async (approve: string[]) => { setBusy(true); try { await onDecide(p, approve); } finally { setBusy(false); } };
  const single = proposalMode(p) === 'single';
  return (
    <div className="jl-factbox" role="group" aria-label="Suggested changes">
      <strong>{single ? 'The assistant suggests this change. Nothing changes until you choose.' : 'The assistant suggests these changes. Nothing changes until you choose.'}</strong>
      {single
        ? <div style={{ margin: '8px 0' }}>{p.actions[0]!.summary}</div>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '8px 0' }}>
            {p.actions.map((a) => (
              <Checkbox key={a.id} checked={picked.includes(a.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, a.id] : picked.filter((x) => x !== a.id))}>{a.summary}</Checkbox>
            ))}
            <span className="jl-small jl-muted">Tick the changes you want, then press Apply selected.</span>
          </div>
        )}
      <div className="jl-row">
        {single
          ? <Button size="small" type="primary" shape="round" loading={busy} onClick={() => { void decide([p.actions[0]!.id]); }}>Apply this change</Button>
          : <Button size="small" type="primary" shape="round" loading={busy} disabled={!picked.length} onClick={() => { void decide(picked); }}>Apply selected</Button>}
        <Button size="small" shape="round" disabled={busy} onClick={() => { void decide([]); }}>{single ? 'Decline' : 'Decline all'}</Button>
      </div>
    </div>
  );
}

export function Chat({ jobId, jobTitle, chatId: initialChatId, draft, onThread, onClearJob, autoFocus = false }: {
  jobId: string | null; jobTitle: string | null; chatId?: string | null; draft?: string; onThread?: (id: string) => void; onClearJob?: () => void; autoFocus?: boolean;
}) {
  const ai = useAiSettings();
  const [view, setView] = useState<ChatView>(EMPTY_CHAT);
  const msgs = view.msgs;
  const [chatId, setChatIdState] = useState<string | null>(initialChatId ?? null);
  const chatIdRef = useRef<string | null>(initialChatId ?? null);
  const setChatId = (id: string | null) => { chatIdRef.current = id; setChatIdState(id); };
  const [text, setText] = useState(draft ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<UiError | null>(null);
  const abort = useRef<AbortController | null>(null);
  const reqId = useRef<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => { setText(draft ?? ''); }, [draft]);
  useEffect(() => {
    if (initialChatId && initialChatId === chatIdRef.current && msgs.length) return;
    setChatId(initialChatId ?? null);
    setErr(null);
    if (!initialChatId) { setView(EMPTY_CHAT); return; }
    let alive = true;
    call('getChat', { params: { chatId: initialChatId } }).then((t: ChatThread) => {
      if (alive) setView(viewOfThread(t));
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
    const history = [...msgs.filter((m) => m.content).map((m) => ({ role: m.role, content: m.content })), { role: 'user' as const, content: q }];
    setView((v) => startTurn(v, q));
    setText('');
    setBusy(true);
    const ac = new AbortController();
    abort.current = ac;
    const rid = `ui-${Date.now()}-${++reqSeq}`;
    reqId.current = rid;
    let cost: number | null = null;
    try {
      await streamChat({ requestId: rid, messages: history, ...(chatId ? { chatId } : {}), ...(jobId ? { jobId } : {}) }, (ev) => {
        setView((v) => onStreamEvent(v, ev));
        if (ev.type === 'done') {
          cost = ev.costMicros;
          if (ev.chatId) { setChatId(ev.chatId); onThread?.(ev.chatId); }
        }
        if (ev.type === 'error') setErr({ code: ev.error.code, status: null, message: ev.error.message, link: ev.error.link ?? null });
      }, ac.signal);
      invalidate('chats');
      afterAiStep(cost);
    } catch (e) {
      setErr(e as UiError);
      setView(dropEmptyAnswer);
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

  const decide = async (p: ActionProposal, approve: string[]) => {
    try {
      const r = await call('decideProposal', { params: { proposalId: p.id }, body: { approveActionIds: approve } });
      setView((v) => afterDecision(v, p.id));
      afterTrackerChange();
      invalidate('chats');
      ui.message?.success(r.applied.length ? `Applied ${r.applied.length} ${r.applied.length === 1 ? 'change' : 'changes'}.` : 'No change was made.');
      // The server wrote the decision into the conversation: show it as saved.
      const id = chatIdRef.current;
      if (id) { try { const t = await call('getChat', { params: { chatId: id } }); setView(viewOfThread(t)); } catch { /* the toast said what happened */ } }
    } catch (e) {
      setErr(e as UiError);
      // Expired or already decided: it cannot be decided here any more, so it leaves the screen.
      if ((e as UiError).code === 'not_found') setView((v) => afterDecision(v, p.id));
    }
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
            {m.content ? (m.role === 'assistant' ? <AnswerText text={m.content} /> : m.content) : (busy && i === msgs.length - 1 ? '…' : '')}
            {m.incomplete && <div className="jl-small" style={{ marginTop: 6, opacity: 0.8 }}>The answer stopped early. What arrived is kept.</div>}
            {m.costMicros ? <div className="jl-small" style={{ marginTop: 6, opacity: 0.8 }}>Cost: {formatDollars(m.costMicros)} from your balance</div> : null}
          </div>
        ))}
        {view.proposals.map((p) => <ProposalCard key={p.id} p={p} onDecide={decide} />)}
        {err && (
          <div>
            <InlineError error={err} />
            {lastUser && <Button size="small" type="link" icon={<ReloadOutlined />} onClick={() => { setView((v) => (v.msgs.at(-1)?.role === 'user' ? { ...v, msgs: v.msgs.slice(0, -1) } : v)); void send(lastUser); }}>Send again</Button>}
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
