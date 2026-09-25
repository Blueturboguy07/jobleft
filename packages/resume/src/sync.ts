// Keeps a base resume in step with the profile (resume O1: a correction "appears in every later output").
// Three-way: a field of the resume that still equals the profile's old value takes the profile's new value; a field
// the person changed on this resume is left alone. Tailored versions are never synced (resume O12: an old version
// keeps its content).

import type { Profile, ProfileInput, ResumeDocument, ResumeItem, ResumeSection } from '@jobleft/contracts';
import { degreeLine, SECTION_TITLES } from './document.ts';
import { stableId } from './text.ts';
import { headerFromProfile } from './truth.ts';

type Snap = ProfileInput | Profile;

function eduBullets(e: Snap['education'][number]): string[] {
  return [...(e.gpa ? [`GPA: ${e.gpa}`] : []), ...e.achievements, ...(e.coursework.length ? [`Relevant coursework: ${e.coursework.join(', ')}`] : [])];
}

/**
 * A list on the resume (bullets, skills) after the profile's list changed from oldL to newL. An item the profile
 * edited (same neighbours, new text) is replaced; an item the profile removed is removed; an item written only on
 * this resume stays; new profile items join when the resume showed the whole old list.
 */
function syncList(cur: string[], oldL: string[], newL: string[], mirror: boolean): string[] {
  if (cur.length === oldL.length && cur.every((b, i) => b === oldL[i])) return [...newL];
  const removed = oldL.filter((x) => !newL.includes(x));
  const added = newL.filter((x) => !oldL.includes(x));
  const renamed = new Map<string, string>();
  const used = new Set<string>();
  for (const r of removed) {
    const i = oldL.indexOf(r);
    for (const a of added) {
      if (used.has(a)) continue;
      const j = newL.indexOf(a);
      const samePrev = i > 0 && j > 0 && oldL[i - 1] === newL[j - 1];
      const sameNext = i < oldL.length - 1 && j < newL.length - 1 && oldL[i + 1] === newL[j + 1];
      if (samePrev || sameNext || (oldL.length === newL.length && i === j)) { renamed.set(r, a); used.add(a); break; }
    }
  }
  const out: string[] = [];
  for (const b of cur) {
    if (!oldL.includes(b) || newL.includes(b)) { out.push(b); continue; } // written here only, or unchanged
    const to = renamed.get(b);
    if (to !== undefined) out.push(to); // edited in the profile
    // else: removed from the profile, so removed here too
  }
  if (mirror) for (const a of added) if (!used.has(a) && !out.includes(a)) out.push(a);
  return out;
}

function setIf<T>(cur: T, oldV: T, newV: T): T {
  return cur === oldV ? newV : cur;
}

interface Rec { id: string; fields: Array<[keyof ResumeItem, unknown]>; bullets: string[]; tags?: string[] }

function syncSection(sec: ResumeSection, oldRecs: Rec[], newRecs: Rec[], mode: 'profile' | 'import', make: (r: Rec) => ResumeItem): void {
  const oldIds = new Set(oldRecs.map((r) => r.id));
  const mirror = oldRecs.length > 0 && oldRecs.every((r) => sec.items.some((i) => i.id === r.id));
  const items: ResumeItem[] = [];
  for (const it of sec.items) {
    const o = oldRecs.find((r) => r.id === it.id);
    const n = newRecs.find((r) => r.id === it.id);
    if (!o) { items.push(it); continue; }
    if (!n) { if (mode === 'import') items.push(it); continue; }
    const next = { ...it } as Record<string, unknown>;
    o.fields.forEach(([k, ov], idx) => { next[k as string] = setIf(next[k as string], ov, n.fields[idx]![1]); });
    next.bullets = syncList(it.bullets, o.bullets, n.bullets, true);
    if (o.tags && n.tags) next.tags = syncList(it.tags, o.tags, n.tags, true);
    items.push(next as unknown as ResumeItem);
  }
  if (mirror && mode === 'profile') {
    for (const n of newRecs) if (!oldIds.has(n.id) && !items.some((i) => i.id === n.id)) items.push(make(n));
    // Keep the profile's order for items that come from it.
    const order = new Map(newRecs.map((r, i) => [r.id, i]));
    const fromProfile = items.filter((i) => order.has(i.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    let k = 0;
    for (let i = 0; i < items.length; i++) if (order.has(items[i]!.id)) items[i] = fromProfile[k++]!;
  }
  sec.items = items;
}

const workRecs = (p: Snap): Rec[] => p.work.map((w) => ({
  id: w.id,
  fields: [['heading', w.company], ['subheading', w.title], ['location', w.location], ['startDate', w.startDate], ['endDate', w.current ? null : w.endDate], ['current', w.current]],
  bullets: [...(w.summary && w.summary.trim() ? [w.summary] : []), ...w.bullets],
}));
const eduRecs = (p: Snap): Rec[] => p.education.map((e) => ({
  id: e.id,
  fields: [['heading', e.school], ['subheading', degreeLine(e.degree, e.major)], ['startDate', e.startDate], ['endDate', e.current ? null : e.endDate], ['current', e.current]],
  bullets: eduBullets(e),
}));
const projRecs = (p: Snap): Rec[] => p.projects.map((pr) => ({
  id: pr.id,
  fields: [['heading', pr.name], ['subheading', pr.description], ['startDate', pr.startDate], ['endDate', pr.endDate]],
  bullets: [...pr.bullets], tags: pr.url ? [pr.url] : [],
}));
const certRecs = (p: Snap): Rec[] => p.certifications.map((c, i) => ({
  id: stableId('cert-', c.name), fields: [['heading', c.name], ['subheading', c.issuer], ['startDate', c.date]], bullets: [], tags: [String(i)],
}));

function makeItem(r: Rec): ResumeItem {
  const base: ResumeItem = { id: r.id, heading: null, subheading: null, location: null, startDate: null, endDate: null, current: false, bullets: [...r.bullets], tags: r.tags ? [...r.tags] : [] };
  for (const [k, v] of r.fields) (base as Record<string, unknown>)[k as string] = v;
  return base;
}

/** The base document after the profile changed from `old` to `now`. Returns a new document. */
export function syncBaseDocument(doc: ResumeDocument, old: Snap, now: Profile, mode: 'profile' | 'import'): ResumeDocument {
  const out = structuredClone(doc);
  out.header = headerFromProfile(now);
  const ensure = (kind: ResumeSection['kind'], id: string): ResumeSection | null => {
    let s = out.sections.find((x) => x.kind === kind);
    if (!s && mode === 'profile') {
      s = { id, kind, title: SECTION_TITLES[kind], text: null, items: [] };
      out.sections.push(s);
    }
    return s ?? null;
  };
  // Summary.
  const sum = out.sections.find((s) => s.kind === 'summary');
  if (sum && sum.text === old.summary) sum.text = now.summary;
  else if (!sum && !old.summary && now.summary && mode === 'profile') out.sections.unshift({ id: 'summary', kind: 'summary', title: SECTION_TITLES.summary, text: now.summary, items: [] });
  const pairs: Array<[ResumeSection['kind'], string, (p: Snap) => Rec[]]> = [['experience', 'experience', workRecs], ['education', 'education', eduRecs], ['projects', 'projects', projRecs]];
  for (const [kind, id, recs] of pairs) {
    const o = recs(old);
    const n = recs(now);
    const sec = n.length && !o.length ? ensure(kind, id) : out.sections.find((s) => s.kind === kind) ?? null;
    if (sec) syncSection(sec, o, n, mode, makeItem);
  }
  // Certifications pair by position when names change.
  const cs = out.sections.find((s) => s.kind === 'certifications');
  if (cs) {
    const o = certRecs(old);
    const n = certRecs(now);
    cs.items = cs.items.flatMap((it) => {
      const i = o.findIndex((r) => r.fields[0]![1] === it.heading);
      if (i < 0) return [it];
      const same = n.find((r) => r.fields[0]![1] === it.heading);
      if (same) return [{ ...it, subheading: setIf(it.subheading, o[i]!.fields[1]![1] as string | null, same.fields[1]![1] as string | null), startDate: setIf(it.startDate, o[i]!.fields[2]![1] as string | null, same.fields[2]![1] as string | null) }];
      if (o.length === n.length) { const r = n[i]!; return [{ ...it, id: r.id, heading: r.fields[0]![1] as string, subheading: r.fields[1]![1] as string | null, startDate: r.fields[2]![1] as string | null }]; }
      return mode === 'profile' ? [] : [it];
    });
  }
  // Skills: renames pair by position; removals leave; additions join when the resume showed every skill.
  const sk = out.sections.find((s) => s.kind === 'skills')?.items[0];
  const oldNames = old.skills.map((s) => s.name);
  const newNames = now.skills.map((s) => s.name);
  if (sk) {
    const mirror = oldNames.length > 0 && oldNames.every((n) => sk.tags.includes(n));
    sk.tags = syncList(sk.tags, oldNames, newNames, mirror);
  } else if (newNames.length && !oldNames.length && mode === 'profile') {
    out.sections.push({ id: 'skills', kind: 'skills', title: SECTION_TITLES.skills, text: null, items: [{ id: 'skills-list', heading: null, subheading: null, location: null, startDate: null, endDate: null, current: false, bullets: [], tags: [...newNames] }] });
  }
  // Extra sections: lines follow the profile when they were copied from it.
  for (const s of out.sections) {
    if (s.kind !== 'custom' || !s.id.startsWith('x-')) continue;
    const xid = s.id.slice(2);
    const o = (old.extraSections ?? []).find((x) => x.id === xid);
    const n = (now.extraSections ?? []).find((x) => x.id === xid);
    const it = s.items[0];
    if (!o || !it) continue;
    if (!n) { if (mode === 'profile') it.bullets = []; continue; }
    it.bullets = syncList(it.bullets, o.lines, n.lines, true);
    s.title = setIf(s.title, o.title, n.title);
  }
  out.sections = out.sections.filter((s) => !!(s.text && s.text.trim()) || s.items.some((i) => i.bullets.length || i.tags.length || i.heading || i.subheading) || s.kind === 'summary' && false);
  return out;
}

/** True when every entry of the document comes from the profile (an import the person has adopted). */
export function linkedToProfile(doc: ResumeDocument, p: Profile): boolean {
  const ids = new Set([...p.work.map((w) => w.id), ...p.education.map((e) => e.id), ...p.projects.map((x) => x.id)]);
  for (const s of doc.sections) {
    if (s.kind !== 'experience' && s.kind !== 'education' && s.kind !== 'projects') continue;
    for (const it of s.items) if (!ids.has(it.id)) return false;
  }
  return true;
}

export function snapshotOf(p: Profile | ProfileInput): ProfileInput {
  const { id: _id, version: _v, updatedAt: _u, ...rest } = p as Profile;
  void _id; void _v; void _u;
  return structuredClone(rest) as ProfileInput;
}
