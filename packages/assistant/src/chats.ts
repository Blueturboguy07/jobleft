// Saved conversations. They stay on the laptop, they survive a restart, and a delete is real (see db.ts).
// The person's message is saved BEFORE the model is asked, so a failure never loses it. A cut-off answer is saved
// with `incomplete = 1` and is never treated as a finished answer later.

import type { DatabaseSync } from 'node:sqlite';
import { nowIso, type ChatThread } from '@jobleft/contracts';
import { newId, scrub, tx } from './db.ts';

export interface JobRef { id: string; title: string; company: string }
export interface ChatRow { id: string; title: string; jobId: string | null; updatedAt: string }

export class ChatStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  list(): ChatRow[] {
    return (this.db.prepare('SELECT id, title, job_id, updated_at FROM ai_chats ORDER BY updated_at DESC, id').all() as Array<{ id: string; title: string; job_id: string | null; updated_at: string }>)
      .map((r) => ({ id: r.id, title: r.title, jobId: r.job_id, updatedAt: r.updated_at }));
  }

  exists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM ai_chats WHERE id = ?').get(id) !== undefined;
  }

  get(id: string): ChatThread | null {
    const c = this.db.prepare('SELECT * FROM ai_chats WHERE id = ?').get(id) as { id: string; title: string; job_id: string | null; created_at: string; updated_at: string } | undefined;
    if (!c) return null;
    const msgs = this.db.prepare('SELECT role, content, at, incomplete, refs_json FROM ai_chat_messages WHERE chat_id = ? ORDER BY id').all(id) as Array<{ role: string; content: string; at: string; incomplete: number; refs_json: string | null }>;
    return {
      id: c.id, title: c.title, jobId: c.job_id,
      messages: msgs.map((m) => {
        const jobs = m.refs_json ? (JSON.parse(m.refs_json) as JobRef[]) : [];
        return { role: m.role === 'assistant' ? 'assistant' as const : 'user' as const, content: m.content, at: m.at, ...(m.incomplete ? { incomplete: true } : {}), ...(jobs.length ? { jobs } : {}) };
      }),
      createdAt: c.created_at, updatedAt: c.updated_at,
    };
  }

  /** Creates the conversation when `chatId` is null or unknown, and appends one message. Returns the chat id. */
  append(chatId: string | null, role: 'user' | 'assistant', content: string, meta: { jobId: string | null; preset?: string | null; incomplete?: boolean; jobs?: JobRef[] }): string {
    const at = nowIso();
    return tx(this.db, () => {
      let id = chatId;
      if (!id || !this.exists(id)) {
        id = id && /^chat_/.test(id) ? id : newId('chat');
        const title = [...content.replace(/\s+/g, ' ').trim()].slice(0, 60).join('') || 'Conversation';
        this.db.prepare('INSERT INTO ai_chats (id, title, job_id, preset, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, title, meta.jobId, meta.preset ?? null, at, at);
      }
      this.db.prepare('INSERT INTO ai_chat_messages (chat_id, role, content, at, incomplete, refs_json) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, role, content, at, meta.incomplete ? 1 : 0, meta.jobs?.length ? JSON.stringify(meta.jobs) : null);
      this.db.prepare('UPDATE ai_chats SET updated_at = ? WHERE id = ?').run(at, id);
      return id;
    });
  }

  /** Starts an assistant message that is marked incomplete until `finishAssistant` says otherwise (a crash leaves it incomplete). */
  beginAssistant(chatId: string): number {
    const r = this.db.prepare('INSERT INTO ai_chat_messages (chat_id, role, content, at, incomplete) VALUES (?, ?, ?, ?, 1)').run(chatId, 'assistant', '', nowIso());
    return Number(r.lastInsertRowid);
  }

  setAssistant(rowid: number, content: string, meta: { incomplete: boolean; jobs?: JobRef[] }): void {
    this.db.prepare('UPDATE ai_chat_messages SET content = ?, incomplete = ?, refs_json = ?, at = ? WHERE id = ?')
      .run(content, meta.incomplete ? 1 : 0, meta.jobs?.length ? JSON.stringify(meta.jobs) : null, nowIso(), rowid);
  }

  removeMessage(rowid: number): void {
    this.db.prepare('DELETE FROM ai_chat_messages WHERE id = ?').run(rowid);
  }

  touch(chatId: string): void {
    this.db.prepare('UPDATE ai_chats SET updated_at = ? WHERE id = ?').run(nowIso(), chatId);
  }

  /** Deletes the conversation and all its messages for real. */
  delete(id: string): boolean {
    const gone = tx(this.db, () => Number(this.db.prepare('DELETE FROM ai_chats WHERE id = ?').run(id).changes) > 0);
    if (gone) scrub(this.db);
    return gone;
  }

  /** Deletes every conversation for real. */
  deleteAll(): number {
    const n = tx(this.db, () => Number(this.db.prepare('DELETE FROM ai_chats').run().changes));
    scrub(this.db);
    return n;
  }

  count(): number {
    return Number((this.db.prepare('SELECT count(*) AS n FROM ai_chats').get() as { n: number }).n);
  }
}
