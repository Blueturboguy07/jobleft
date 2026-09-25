// Changes the assistant wants to make. NOTHING is written until the person approves each one (O3):
//   * a proposal lives in memory only, so closing the app declines it;
//   * every action names ONE exact change, built from the stored records (the model's words are never the summary);
//   * approval is per action: approving one applies only that one;
//   * a proposal decided once is gone: a second decision is "not found".
// A paid web action is an action too: it runs only after the person approves the price shown in its summary.

import { TRACKER_STATUS_LABELS, nowMs, type ActionProposal, type JobDetail, type TrackerStatus } from '@jobleft/contracts';
import { newId } from './db.ts';
import { clip, localDateTime } from './views.ts';

export type ActionKind = ActionProposal['actions'][number]['kind'];

export interface StoredAction {
  id: string;
  kind: ActionKind;
  summary: string;
  target: { kind: 'job' | 'resume' | 'profile' | 'filter' | 'contact' | 'web'; id: string | null };
  costMicros: number | null;
  /** What to do on approval (never shown to the model). */
  payload: Record<string, unknown>;
}

interface Stored { id: string; chatId: string | null; actions: StoredAction[]; expiresAt: number }

export const PROPOSAL_TTL_MS = 60 * 60_000;

export class ProposalBook {
  private readonly items = new Map<string, Stored>();

  create(chatId: string | null, actions: StoredAction[]): ActionProposal {
    this.sweep();
    const id = newId('prop');
    const expiresAt = nowMs() + PROPOSAL_TTL_MS;
    this.items.set(id, { id, chatId, actions, expiresAt });
    return {
      id,
      actions: actions.map((a) => ({ id: a.id, kind: a.kind, summary: a.summary, target: a.target, ...(a.costMicros !== null ? { costMicros: a.costMicros } : {}) })),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** Takes the proposal out for a decision. null = unknown, already decided or expired. */
  take(id: string): Stored | null {
    this.sweep();
    const s = this.items.get(id);
    if (!s) return null;
    this.items.delete(id);
    return s;
  }

  peek(id: string): Stored | null { this.sweep(); return this.items.get(id) ?? null; }
  size(): number { this.sweep(); return this.items.size; }
  clear(): void { this.items.clear(); }

  private sweep(): void {
    const t = nowMs();
    for (const [k, v] of this.items) if (v.expiresAt <= t) this.items.delete(k);
  }
}

export const CHANGE_KINDS = ['tracker_status', 'like', 'unlike', 'hide', 'unhide', 'note_add', 'reminder_add', 'resume_delete', 'contact_stage', 'cover_letter', 'debrief_save'] as const;

export interface ChangeInput {
  kind: string;
  job_id?: string;
  status?: string;
  text?: string;
  due?: string;
  resume_id?: string;
  contact_id?: string;
  stage?: string;
}

const STAGES = ['to_contact', 'messaged', 'replied', 'met', 'follow_up_due'];
const STAGE_LABEL: Record<string, string> = { to_contact: 'To contact', messaged: 'Messaged', replied: 'Replied', met: 'Met', follow_up_due: 'Follow-up due' };

/** "2026-10-03" or a full date-time to an instant. A plain date means 9:00 in the person's zone. */
export function dueToIso(due: string, tz: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}T/.test(due)) { const t = Date.parse(due); return Number.isFinite(t) ? new Date(t).toISOString() : null; }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
  if (!m) return null;
  // find the UTC instant whose local time in tz is 09:00 on that date
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 9, 0, 0);
  for (let off = -14; off <= 14; off++) {
    const t = guess - off * 3_600_000;
    if (localDateTime(new Date(t).toISOString(), tz) === `${m[1]}-${m[2]}-${m[3]} 09:00`) return new Date(t).toISOString();
  }
  return new Date(guess).toISOString();
}

export interface BuildEnv {
  job(id: string): Promise<JobDetail | null>;
  resumes(): Promise<Array<{ id: string; name: string; kind: 'base' | 'tailored'; baseResumeId: string | null }>>;
  contact(id: string): Promise<{ id: string; firstName: string; lastName: string; company: string | null } | null>;
  tz: string;
}

/** Turns one change the model asked for into one exact, checked action. Returns a plain sentence when it cannot. */
export async function buildAction(c: ChangeInput, env: BuildEnv): Promise<StoredAction | { error: string }> {
  const kind = c.kind as ActionKind;
  const jobPart = async (): Promise<{ id: string; label: string; detail: JobDetail } | { error: string }> => {
    if (!c.job_id) return { error: 'This change needs a job_id from a tool result.' };
    const d = await env.job(c.job_id);
    if (!d) return { error: `There is no job with the id ${c.job_id}. Use an id from a tool result.` };
    return { id: d.job.id, label: `"${d.job.title}" at ${d.job.company}`, detail: d };
  };
  const id = newId('act');
  switch (kind) {
    case 'tracker_status': {
      const j = await jobPart(); if ('error' in j) return j;
      const s = String(c.status ?? '');
      const target = s === 'none' ? null : (s as TrackerStatus);
      if (target !== null && !(target in TRACKER_STATUS_LABELS)) return { error: 'status must be one of applied, interviewing, offer_received, rejected, archived or none.' };
      const cur = j.detail.tracker?.status ?? null;
      if (cur === target) return { error: `${j.label} is already ${target ? TRACKER_STATUS_LABELS[target] : 'not applied'}. Nothing to change.` };
      return { id, kind, summary: target ? `Move ${j.label} to ${TRACKER_STATUS_LABELS[target]}` : `Clear the application stage of ${j.label}`, target: { kind: 'job', id: j.id }, costMicros: null, payload: { jobId: j.id, status: target } };
    }
    case 'like': case 'unlike': case 'hide': case 'unhide': {
      const j = await jobPart(); if ('error' in j) return j;
      const verb = { like: 'Like', unlike: 'Remove the like from', hide: 'Hide (not interested)', unhide: 'Show again' }[kind];
      const patch = { like: { liked: true }, unlike: { liked: false }, hide: { hidden: true }, unhide: { hidden: false } }[kind];
      return { id, kind, summary: `${verb} ${j.label}`, target: { kind: 'job', id: j.id }, costMicros: null, payload: { jobId: j.id, patch } };
    }
    case 'note_add': {
      const j = await jobPart(); if ('error' in j) return j;
      const text = String(c.text ?? '').trim();
      if (!text) return { error: 'A note needs text.' };
      return { id, kind, summary: `Add a note to ${j.label}: "${clip(text, 140)}"`, target: { kind: 'job', id: j.id }, costMicros: null, payload: { jobId: j.id, text } };
    }
    case 'reminder_add': {
      const j = await jobPart(); if ('error' in j) return j;
      const text = String(c.text ?? '').trim();
      const at = dueToIso(String(c.due ?? ''), env.tz);
      if (!text) return { error: 'A reminder needs text.' };
      if (!at) return { error: 'due must be a date like 2026-10-03 or a full date and time.' };
      return { id, kind, summary: `Add a reminder to ${j.label} for ${localDateTime(at, env.tz)} (${env.tz}): "${clip(text, 100)}"`, target: { kind: 'job', id: j.id }, costMicros: null, payload: { jobId: j.id, text, at } };
    }
    case 'resume_delete': {
      const list = await env.resumes();
      const r = list.find((x) => x.id === c.resume_id);
      if (!r) return { error: `There is no resume with the id ${c.resume_id ?? '(none)'}. Use list_resumes first.` };
      const versions = list.filter((x) => x.baseResumeId === r.id).length;
      return {
        id, kind, summary: `Delete the resume "${r.name}"${versions ? ` and its ${versions} tailored version${versions === 1 ? '' : 's'}` : ''}. This cannot be undone`,
        target: { kind: 'resume', id: r.id }, costMicros: null, payload: { resumeId: r.id, withVersions: versions > 0 },
      };
    }
    case 'contact_stage': {
      const ct = c.contact_id ? await env.contact(c.contact_id) : null;
      if (!ct) return { error: `There is no contact with the id ${c.contact_id ?? '(none)'}. Use list_contacts first.` };
      const stage = String(c.stage ?? '');
      if (!STAGES.includes(stage)) return { error: `stage must be one of ${STAGES.join(', ')}.` };
      return { id, kind, summary: `Set ${ct.firstName} ${ct.lastName}${ct.company ? ` (${ct.company})` : ''} to "${STAGE_LABEL[stage]}"`, target: { kind: 'contact', id: ct.id }, costMicros: null, payload: { contactId: ct.id, stage } };
    }
    case 'cover_letter': {
      const j = await jobPart(); if ('error' in j) return j;
      const rs = (await env.resumes()).filter((x) => x.kind === 'base');
      const r = rs.find((x) => x.id === c.resume_id) ?? (c.resume_id ? null : rs[0] ?? null);
      if (!r) return { error: 'A cover letter needs a base resume. Use list_resumes and pass a resume_id, or the person has no resume yet.' };
      return { id, kind, summary: `Write a cover letter draft for ${j.label} from the resume "${r.name}" and save it. It uses your AI provider, which may cost publik balance`, target: { kind: 'job', id: j.id }, costMicros: null, payload: { jobId: j.id, resumeId: r.id } };
    }
    case 'debrief_save': {
      const j = await jobPart(); if ('error' in j) return j;
      const text = String(c.text ?? '').trim();
      if (!text) return { error: 'A debrief needs the notes the person gave.' };
      return { id, kind, summary: `Save this interview debrief for ${j.label} in your question bank: "${clip(text, 140)}"`, target: { kind: 'job', id: j.id }, costMicros: null, payload: { jobId: j.id, notes: text } };
    }
    default:
      return { error: `A change of kind "${c.kind}" is not supported here. Supported: ${CHANGE_KINDS.join(', ')}. For anything else, tell the person where to do it in the app.` };
  }
}
