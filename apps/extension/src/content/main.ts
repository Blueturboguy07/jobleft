// The content script. The service worker injects it into the tab (all frames it may reach) ONLY after the person
// clicks the jobleft button (activeTab). It does nothing until the worker asks: it never reads the page on its own,
// it never sends page text anywhere, and it never talks to the app (only the worker does).

import type { FillResponse } from '@jobleft/contracts';
import type { ApplyInput, CollectResult, DraftItem, Report, ReportItem, ToContent, ToWorker } from '../messages.ts';
import { atsFromPage, blockedFrames, scan, visibleSelf, type Found, type Scan } from './dom.ts';
import { attachFile, isEmpty, mark, repr, shownValue, stillHolds, undoOne, unmark, unmarkAll, writeDraft, writeFill, type Written } from './fill.ts';
import { Panel } from './panel.ts';

declare global {
  // eslint-disable-next-line no-var
  var __jobleftContent: boolean | undefined;
}

interface FrameState {
  scan: Scan | null;
  byId: Map<string, Found>;
  /** What jobleft last wrote into each control (a later fill may update only these, never the person's text). */
  lastWritten: WeakMap<Element, string>;
  undo: Written[][];
  report: Report | null;
  cancel: boolean;
  watcher: number | null;
  panel: Panel | null;
}

const S: FrameState = { scan: null, byId: new Map(), lastWritten: new WeakMap(), undo: [], report: null, cancel: false, watcher: null, panel: null };

function send(m: ToWorker): void {
  try { void chrome.runtime.sendMessage(m).catch(() => undefined); } catch { /* the extension was reloaded */ }
}

function pushReport(): void {
  if (S.report) send({ type: 'panel:report', report: structuredClone(S.report) });
}

let pushTimer: number | null = null;
function pushSoon(): void {
  if (pushTimer !== null) return;
  pushTimer = setTimeout(() => { pushTimer = null; pushReport(); }, 120) as unknown as number;
}

/** What to outline: the chosen option of a radio or checkbox group (its visible label), else the field. */
function markFor(f: Found): HTMLElement {
  if (f.els.length > 1) {
    const chosen = f.els.find((e) => (e as HTMLInputElement).checked) as HTMLInputElement | undefined;
    if (chosen) {
      if (visibleSelf(chosen)) return chosen;
      const l = Array.from(chosen.labels ?? []).find((x) => visibleSelf(x));
      if (l) return l;
    }
  }
  return f.mark;
}

function locate(fieldId: string): void {
  const f = S.byId.get(fieldId);
  if (!f) return;
  try { f.mark.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* ignore */ }
}

function panel(): Panel {
  if (!S.panel || !S.panel.attached) S.panel = new Panel(send, (id) => send({ type: 'panel:locate', fieldId: id }));
  return S.panel;
}

// ------------------------------------------------------------------ collect

function collect(): CollectResult {
  const sc = scan(document);
  S.scan = sc;
  S.byId = new Map(sc.app.map((f) => [f.id, f]));
  return {
    frameUrl: location.href,
    score: sc.score,
    fields: sc.app.map((f) => f.field),
    captcha: sc.captcha,
    account: sc.account,
    ambiguous: sc.ambiguous,
    otherForms: sc.otherForms,
    hiddenIgnored: sc.hiddenIgnored,
    blockedFrames: sc.blockedFrames,
    ats: atsFromPage(document),
    step: null,
  };
}

// ------------------------------------------------------------------ apply

function baseItems(resp: FillResponse, found: Found[]): ReportItem[] {
  const notes = new Map((resp.notes ?? []).map((n) => [n.fieldId, n]));
  return found.map((f) => {
    const note = notes.get(f.id);
    const hasValue = !isEmpty(f);
    const it: ReportItem = {
      fieldId: f.id, label: f.field.label, required: f.field.required, section: f.field.section, status: 'needs_you',
      value: null, item: null, reason: note?.message ?? 'jobleft has no value for this field.',
    };
    if (hasValue) {
      it.status = 'kept';
      it.value = shownValue(f);
      it.reason = 'It had a value before the fill. jobleft did not change it.';
    }
    return it;
  });
}

async function apply(input: ApplyInput): Promise<void> {
  const resp = input.response;
  const found = S.scan?.app ?? [];
  S.cancel = false;
  if (S.watcher !== null) { clearInterval(S.watcher); S.watcher = null; }
  const items = baseItems(resp, found);
  const itemOf = new Map(items.map((i) => [i.fieldId, i]));
  const openIds = new Set((resp.notes ?? []).filter((n) => n.reason === 'open_question').map((n) => n.fieldId));
  const drafts: DraftItem[] = found.filter((f) => openIds.has(f.id)).map((f) => {
    const ready = resp.drafts.find((d) => d.fieldId === f.id);
    return {
      fieldId: f.id, label: f.field.label, maxLength: f.field.maxLength, text: ready?.text ?? null, provider: ready?.provider ?? null,
      state: ready ? 'ready' : 'offered', message: null,
    };
  });
  for (const d of drafts) {
    const it = itemOf.get(d.fieldId);
    if (it && it.status === 'needs_you') {
      it.status = d.state === 'ready' ? 'draft_ready' : 'needs_you';
      it.reason = d.state === 'ready' ? 'A draft is waiting in the panel. It goes in only if you press Insert.' : it.reason;
    }
  }
  const total = resp.fills.length + resp.files.length;
  S.report = {
    fillId: input.fillId, phase: 'filling', progress: { done: 0, total }, support: input.support, job: input.job, items, drafts,
    draftOffer: resp.draftOffer ?? null, draftCostNote: null, resume: null, notices: input.notices, otherForms: input.otherForms,
    hiddenIgnored: input.hiddenIgnored, error: null, applied: null, appliedMessage: null,
  };
  pushReport();

  const written: Written[] = [];
  let done = 0;
  // Keep the page where the person had it: focusing and clicking fields must not scroll it away.
  const sx = window.scrollX;
  const sy = window.scrollY;
  const keepScroll = (): void => { if (window.scrollX !== sx || window.scrollY !== sy) window.scrollTo(sx, sy); };
  for (const fill of resp.fills) {
    keepScroll();
    if (S.cancel) break;
    const f = S.byId.get(fill.fieldId);
    const it = itemOf.get(fill.fieldId);
    if (!f || !it) continue;
    const out = await writeFill(f, fill, S.lastWritten.get(f.els[0] as Element));
    if (out.status === 'filled') {
      written.push(out.written);
      S.lastWritten.set(f.els[0] as Element, out.written.after);
      Object.assign(it, { status: 'filled', value: out.display, item: fill.item ?? 'Your profile', reason: fill.needsReview ? 'Check this one: the form wanted a different format.' : null });
      mark(markFor(f), 'filled');
    } else if (out.status === 'kept') {
      Object.assign(it, { status: 'kept', value: out.display, reason: 'You (or the page) already put a value here. jobleft did not change it.' });
    } else if (out.status === 'unchanged') {
      Object.assign(it, { status: 'ok', value: out.display, item: fill.item ?? null, reason: 'Already matches your profile.' });
    } else {
      Object.assign(it, { status: 'failed', value: null, reason: out.reason });
    }
    done += 1;
    S.report.progress = { done, total };
    pushSoon();
    // A short pause between fields: the page settles, the person can follow, and "Stop" gets through.
    await new Promise((r) => setTimeout(r, 40));
  }
  for (const file of resp.files) {
    keepScroll();
    if (S.cancel) break;
    const f = S.byId.get(file.fieldId);
    const it = itemOf.get(file.fieldId);
    if (!f || !it) continue;
    const out = await attachFile(f, file);
    if (out.status === 'filled') {
      written.push(out.written);
      S.lastWritten.set(f.els[0] as Element, out.written.after);
      Object.assign(it, { status: 'filled', value: file.fileName, item: 'Resume from the app', reason: null });
      S.report.resume = { fileName: file.fileName, status: 'attached', message: null };
      mark(f.mark, 'filled');
    } else if (out.status === 'kept') {
      Object.assign(it, { status: 'kept', value: out.display, reason: 'A file was already attached. jobleft did not replace it.' });
      S.report.resume = { fileName: out.display, status: 'kept', message: null };
    } else if (out.status === 'failed') {
      Object.assign(it, { status: 'failed', value: null, reason: out.reason });
      S.report.resume = { fileName: file.fileName, status: 'failed', message: out.reason };
    }
    done += 1;
    S.report.progress = { done, total };
    pushSoon();
  }
  if (!S.report.resume && found.some((f) => f.field.kind === 'file')) {
    const why = (resp.notes ?? []).find((n) => n.reason === 'file' && found.find((f) => f.id === n.fieldId)?.field.kind === 'file');
    S.report.resume = { fileName: '', status: 'none', message: why?.message ?? 'No resume was attached.' };
  }
  keepScroll();
  S.undo.push(written);

  // Check that the page kept every value (a page can reject or clear a value after the events).
  S.report.phase = S.cancel ? 'stopped' : 'checking';
  pushReport();
  await new Promise((r) => setTimeout(r, 800));
  for (const w of written) {
    const it = itemOf.get(w.found.id);
    if (!it || stillHolds(w)) continue;
    if (isEmpty(w.found)) Object.assign(it, { status: 'failed', value: null, reason: 'The page did not keep this value (it is empty now).' });
    else Object.assign(it, { status: 'failed', value: shownValue(w.found), reason: 'The page changed this value after jobleft wrote it. Check it.' });
    unmark(w.found.mark);
    unmark(markFor(w.found));
  }
  for (const it of items) {
    if (it.status === 'needs_you' || it.status === 'failed' || it.status === 'draft_ready') {
      const f = S.byId.get(it.fieldId);
      if (f && (it.required || it.status === 'failed' || it.status === 'draft_ready')) mark(f.mark, 'needs');
    }
  }
  if (!S.cancel) S.report.phase = 'done';
  else S.report.phase = 'stopped';
  pushReport();
  watch(written);
}

/** Keeps the report true while it is open: a page that clears a value later, or a section that loads late. */
function watch(written: Written[]): void {
  const started = Date.now();
  const container = S.scan?.appContainer ?? null;
  const countNow = (): number => container ? Array.from(container.querySelectorAll('input:not([type=hidden]), select, textarea')).filter((e) => visibleSelf(e)).length : 0;
  const before = countNow();
  let told = false;
  S.watcher = setInterval(() => {
    const r = S.report;
    if (!r || Date.now() - started > 180_000) { if (S.watcher !== null) clearInterval(S.watcher); S.watcher = null; return; }
    let changed = false;
    for (const w of written) {
      const it = r.items.find((i) => i.fieldId === w.found.id);
      if (!it || (it.status !== 'filled' && it.status !== 'inserted')) continue;
      if (stillHolds(w)) continue;
      if (isEmpty(w.found)) Object.assign(it, { status: 'cleared', value: null, reason: 'The page cleared this value after the fill.' });
      else Object.assign(it, { status: 'edited', value: shownValue(w.found), reason: 'Changed after the fill.' });
      unmark(w.found.mark);
      unmark(markFor(w.found));
      changed = true;
    }
    if (!told && container && countNow() > before) {
      r.notices = [...r.notices, 'New fields appeared on the form after the fill. Press "Fill again" to fill them. jobleft keeps what you typed.'];
      told = true;
      changed = true;
    }
    if (changed) pushReport();
  }, 1500) as unknown as number;
}

async function undo(): Promise<void> {
  const last = S.undo.pop();
  const r = S.report;
  if (!last || !r) return;
  if (S.watcher !== null) { clearInterval(S.watcher); S.watcher = null; }
  let failed = 0;
  let keptEdits = 0;
  for (const w of [...last].reverse()) {
    const res = await undoOne(w);
    unmark(w.found.mark);
    const it = r.items.find((i) => i.fieldId === w.found.id);
    if (res === 'restored') {
      S.lastWritten.delete(w.found.els[0] as Element);
      if (it) Object.assign(it, { status: isEmpty(w.found) ? 'needs_you' : 'kept', value: isEmpty(w.found) ? null : shownValue(w.found), reason: 'Put back as it was before the fill.' });
    } else if (res === 'kept_edit') {
      keptEdits += 1;
      if (it) Object.assign(it, { status: 'edited', value: shownValue(w.found), reason: 'You changed this after the fill, so undo kept your change.' });
    } else {
      failed += 1;
      if (it) Object.assign(it, { status: 'failed', reason: 'jobleft could not put this back. Clear it yourself.' });
    }
  }
  unmarkAll();
  if (r.resume?.status === 'attached') r.resume = { ...r.resume, status: 'none', message: 'The resume was removed by undo. If the page still shows the file name, remove it with the page\'s own button.' };
  r.phase = 'undone';
  r.notices = [...r.notices.filter((n) => !n.startsWith('Undo:')),
    `Undo: ${last.length - failed - keptEdits} put back${keptEdits ? `, ${keptEdits} kept because you changed them` : ''}${failed ? `, ${failed} could not be put back` : ''}.`];
  pushReport();
  // When everything went back, the page looks as it did before the fill: the panel goes away too, after a moment.
  if (failed === 0) setTimeout(() => { if (S.report?.phase === 'undone') send({ type: 'panel:close' }); }, 2500);
}

function insertDraft(fieldId: string, textValue: string): void {
  const r = S.report;
  const f = S.byId.get(fieldId);
  const d = r?.drafts.find((x) => x.fieldId === fieldId);
  if (!r || !f || !d) return;
  const it = r.items.find((i) => i.fieldId === fieldId);
  if (!isEmpty(f) && S.lastWritten.get(f.els[0] as Element) !== repr(f)) {
    d.message = 'The box already has text. jobleft did not replace it.';
    if (it) Object.assign(it, { status: 'kept', value: shownValue(f), reason: 'It already had text. The draft was not inserted.' });
    pushReport();
    return;
  }
  const out = writeDraft(f, textValue);
  if (out.status === 'filled') {
    d.state = 'inserted';
    S.lastWritten.set(f.els[0] as Element, out.written.after);
    const lastFill = S.undo[S.undo.length - 1];
    if (lastFill) lastFill.push(out.written); else S.undo.push([out.written]);
    if (it) Object.assign(it, { status: 'inserted', value: textValue, item: 'The draft you accepted', reason: null });
    mark(f.mark, 'filled');
  } else if (out.status === 'failed') {
    d.message = out.reason;
  }
  pushReport();
}

function mergeDrafts(m: Extract<ToContent, { type: 'drafts' }>): void {
  const r = S.report;
  if (!r) return;
  for (const d of m.drafts) {
    const item = r.drafts.find((x) => x.fieldId === d.fieldId);
    if (!item) continue;
    Object.assign(item, { text: d.text, provider: d.provider, state: 'ready', message: null });
    const it = r.items.find((i) => i.fieldId === d.fieldId);
    if (it && it.status === 'needs_you') Object.assign(it, { status: 'draft_ready', reason: 'A draft is waiting in the panel. It goes in only if you press Insert.' });
  }
  for (const s of m.skipped) {
    const item = r.drafts.find((x) => x.fieldId === s.fieldId);
    if (item) Object.assign(item, { state: 'failed', message: s.message });
  }
  r.draftCostNote = m.costNote;
  pushReport();
}

function close(): void {
  if (S.watcher !== null) { clearInterval(S.watcher); S.watcher = null; }
  unmarkAll();
  S.panel?.remove();
  S.panel = null;
}

// ------------------------------------------------------------------ messages from the worker

if (!globalThis.__jobleftContent) {
  globalThis.__jobleftContent = true;
  chrome.runtime.onMessage.addListener((msg: ToContent, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return false;
    switch (msg.type) {
      case 'probe': reply({ ats: atsFromPage(document), blockedFrames: blockedFrames(document) }); return false;
      case 'collect': reply(collect()); return false;
      case 'apply': void apply(msg.input).then(() => reply({ ok: true }), (e: unknown) => reply({ ok: false, error: String(e) })); return true;
      case 'stop': S.cancel = true; reply({ ok: true }); return false;
      case 'undo': void undo().then(() => reply({ ok: true })); return true;
      case 'insertDraft': insertDraft(msg.fieldId, msg.text); reply({ ok: true }); return false;
      case 'discardDraft': {
        const d = S.report?.drafts.find((x) => x.fieldId === msg.fieldId);
        if (d) { d.state = 'discarded'; d.text = null; }
        const it = S.report?.items.find((i) => i.fieldId === msg.fieldId);
        if (it && it.status === 'draft_ready') Object.assign(it, { status: 'needs_you', reason: 'You discarded the draft. Write your own answer.' });
        pushReport();
        reply({ ok: true });
        return false;
      }
      case 'drafts': mergeDrafts(msg); reply({ ok: true }); return false;
      case 'close': close(); reply({ ok: true }); return false;
      case 'locate': locate(msg.fieldId); reply({ ok: true }); return false;
      case 'panel:show': {
        if (window.top !== window) { reply({ ok: false }); return false; }
        panel().show(msg.report);
        reply({ ok: true });
        return false;
      }
      case 'panel:message': {
        if (window.top !== window) { reply({ ok: false }); return false; }
        panel().message(msg.kind, msg.text, msg.job);
        reply({ ok: true });
        return false;
      }
    }
    return false;
  });
}
