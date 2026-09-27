// The assistant, full screen: saved conversations (kept on this Mac) and the chat.

import { useRef } from 'react';
import { Button, Popconfirm } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { ChatThread } from '@jobleft/contracts';
import { call, type UiError } from '../app/api.ts';
import { invalidate, useApi } from '../app/data.ts';
import { ui } from '../app/layers.ts';
import { navigate } from '../app/router.ts';
import { Chat } from '../components/Chat.tsx';
import { InlineError } from '../components/States.tsx';
import { ago } from '../lib/format.ts';
import { adoptChat, chatKeyFor, type ChatKeyState } from '../lib/chatState.ts';

type Item = { id: string; title: string; jobId: string | null; updatedAt: string };

export function AssistantScreen({ chatId }: { chatId: string | null }) {
  const list = useApi<Item[]>('chats', () => call('listChats'));
  const thread = useApi<ChatThread>(chatId ? `chat:${chatId}` : null, () => call('getChat', { params: { chatId: chatId! } }));
  const job = thread.data?.jobId ?? null;
  const jobInfo = useApi(job ? `job:${job}` : null, () => call('getJob', { params: { jobId: job! } }));
  // The same chat stays on screen when a new conversation gets its id (its open suggestion must not vanish).
  const keyState = useRef<ChatKeyState>({ key: 0, chatId, adopted: null });
  keyState.current = chatKeyFor(keyState.current, chatId);
  return (
    <div className="jl-2col">
      <aside style={{ width: 280, flex: '0 0 280px', background: '#fff', borderRight: '1px solid var(--jl-line)', display: 'flex', flexDirection: 'column', minHeight: 0 }} aria-label="Conversations">
        <div style={{ padding: 12 }}><Button block shape="round" icon={<PlusOutlined />} onClick={() => navigate('assistant')}>New conversation</Button></div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 12px' }}>
          {list.error && <InlineError error={list.error} onRetry={() => { void list.reload(); }} />}
          {list.data && !list.data.length && <p className="jl-muted" style={{ padding: 8 }}>No saved conversations yet. They stay on this Mac.</p>}
          {list.data?.map((c) => (
            <div key={c.id} className="jl-row" style={{ borderRadius: 8, background: c.id === chatId ? 'var(--jl-chip)' : undefined, padding: '6px 8px' }}>
              <a href={`#/assistant/${encodeURIComponent(c.id)}`} className="jl-grow" style={{ color: '#000', textDecoration: 'none', minWidth: 0 }} aria-current={c.id === chatId ? 'page' : undefined}>
                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</div>
                <div className="jl-small jl-muted">{ago(c.updatedAt)}</div>
              </a>
              <Popconfirm title="Delete this conversation for good?" okText="Delete" okButtonProps={{ danger: true }} onConfirm={async () => {
                try { await call('deleteChat', { params: { chatId: c.id } }); invalidate('chats'); if (c.id === chatId) navigate('assistant'); ui.message?.success('Conversation deleted.'); } catch (e) { ui.message?.error((e as UiError).message); }
              }}>
                <Button size="small" type="text" icon={<DeleteOutlined />} aria-label={`Delete conversation ${c.title}`} />
              </Popconfirm>
            </div>
          ))}
        </div>
      </aside>
      <section style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: '#fff' }} aria-label="Chat">
        <div style={{ maxWidth: 860, width: '100%', margin: '0 auto', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {thread.error && <InlineError error={thread.error} onRetry={() => { void thread.reload(); }} />}
          <Chat key={keyState.current.key} chatId={chatId} jobId={job} jobTitle={jobInfo.data ? `${jobInfo.data.job.title} at ${jobInfo.data.job.company}` : null}
            onThread={(id) => { invalidate('chats'); if (id !== chatId) { keyState.current = adoptChat(keyState.current, id); navigate(`assistant/${encodeURIComponent(id)}`, { replace: true }); } }} autoFocus />
        </div>
      </section>
    </div>
  );
}
