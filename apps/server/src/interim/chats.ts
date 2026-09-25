// INTERIM stand-in for @jobleft/store ChatStore (tables srv_chats, srv_chat_messages). Conversations stay on the
// laptop; delete is real.

import type { DatabaseSync } from 'node:sqlite';
import { nowIso, type ChatThread } from '@jobleft/contracts';
import { b, newId, tx } from '../db/util.ts';

export class ChatService {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  list(): Array<Pick<ChatThread, 'id' | 'title' | 'jobId' | 'updatedAt'>> {
    return (this.db.prepare('SELECT id, title, job_id, updated_at FROM srv_chats ORDER BY updated_at DESC, id').all() as Array<{ id: string; title: string; job_id: string | null; updated_at: string }>)
      .map((r) => ({ id: r.id, title: r.title, jobId: r.job_id, updatedAt: r.updated_at }));
  }

  get(id: string): ChatThread | null {
    const c = this.db.prepare('SELECT * FROM srv_chats WHERE id = ?').get(id) as { id: string; title: string; job_id: string | null; created_at: string; updated_at: string } | undefined;
    if (!c) return null;
    const msgs = this.db.prepare('SELECT role, content, at, incomplete FROM srv_chat_messages WHERE chat_id = ? ORDER BY id').all(id) as Array<{ role: string; content: string; at: string; incomplete: number }>;
    return {
      id: c.id, title: c.title, jobId: c.job_id,
      messages: msgs.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content, at: m.at, ...(m.incomplete ? { incomplete: true } : {}) })),
      createdAt: c.created_at, updatedAt: c.updated_at,
    };
  }

  exists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM srv_chats WHERE id = ?').get(id) !== undefined;
  }

  /** Creates the conversation when needed and appends one message, in one transaction. Returns the chat id. */
  append(chatId: string | null, role: 'user' | 'assistant', content: string, meta: { jobId: string | null; incomplete?: boolean }): string {
    const now = nowIso();
    return tx(this.db, () => {
      let id = chatId;
      if (!id) {
        id = newId('chat');
        const title = [...content.replace(/\s+/g, ' ').trim()].slice(0, 60).join('') || 'Conversation';
        this.db.prepare('INSERT INTO srv_chats (id, title, job_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, title, meta.jobId, now, now);
      }
      this.db.prepare('INSERT INTO srv_chat_messages (chat_id, role, content, at, incomplete) VALUES (?, ?, ?, ?, ?)').run(id, role, content, now, b(meta.incomplete ?? false));
      this.db.prepare('UPDATE srv_chats SET updated_at = ? WHERE id = ?').run(now, id);
      return id;
    });
  }

  delete(id: string): boolean {
    return tx(this.db, () => Number(this.db.prepare('DELETE FROM srv_chats WHERE id = ?').run(id).changes) > 0);
  }

  count(): number {
    return Number((this.db.prepare('SELECT count(*) AS n FROM srv_chats').get() as { n: number }).n);
  }
}
