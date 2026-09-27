// The report panel on the page (extension O4): what jobleft wrote and from which profile item, what it kept, what
// needs the person and why, the drafts waiting for the person's accept, and the undo and "I submitted" controls.
// It lives in a CLOSED shadow root, so the page's scripts cannot read it, and it acts only on real clicks
// (event.isTrusted), so a page cannot press its buttons.

import { formatDollars } from '@jobleft/contracts';
import type { DraftItem, Report, ReportItem, ToWorker } from '../messages.ts';
import { reportGroups } from './counts.ts';
import { PANEL_TAG } from './dom.ts';

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap { position: fixed; top: 12px; right: 12px; width: 372px; max-height: calc(100vh - 24px); display: flex; flex-direction: column;
  background: #ffffff; color: #1f2933; border: 1px solid #d5dbe1; border-radius: 12px; box-shadow: 0 8px 28px rgba(15, 23, 42, .18);
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; z-index: 2147483647; overflow: hidden; }
.wrap.collapsed .body, .wrap.collapsed footer { display: none; }
header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #e6eaee; background: #f7faf9; }
.logo { font-weight: 700; letter-spacing: .2px; color: #0f766e; font-size: 14px; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #e6f4f1; color: #0f5f58; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 190px; }
.badge.partial { background: #fdf3e2; color: #8a4b08; }
.badge.not_supported { background: #eef1f4; color: #44515e; }
.spacer { flex: 1; }
button { font: inherit; cursor: pointer; border-radius: 8px; border: 1px solid #c6ced6; background: #fff; color: #1f2933; padding: 6px 10px; }
button:hover { background: #f1f4f6; }
button.primary { background: #0f766e; border-color: #0f766e; color: #fff; }
button.primary:hover { background: #0c5f59; }
button.warn { border-color: #b45309; color: #8a4b08; }
button.icon { border: none; background: transparent; padding: 2px 6px; font-size: 16px; line-height: 1; color: #52606d; }
button:disabled { opacity: .5; cursor: default; }
.body { overflow: auto; padding: 10px 12px; }
.job { font-weight: 600; margin-bottom: 4px; }
.muted { color: #616e7c; }
.small { font-size: 12px; }
.status { margin: 6px 0; display: flex; align-items: center; gap: 8px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 8px; }
.chip { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #eef1f4; }
.chip.filled { background: #e3f4f1; color: #0f5f58; }
.chip.needs { background: #fdf3e2; color: #8a4b08; }
.chip.failed { background: #fde8e8; color: #9b1c1c; }
.notice { border-left: 3px solid #b45309; background: #fffaf2; padding: 6px 8px; margin: 6px 0; border-radius: 4px; }
.notice.info { border-left-color: #0f766e; background: #f3faf8; }
.notice.error { border-left-color: #b91c1c; background: #fdf2f2; }
.notice a { color: #0f5f58; word-break: break-all; }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .5px; color: #52606d; margin: 12px 0 4px; }
.row { padding: 6px 4px; border-bottom: 1px solid #eef1f4; cursor: pointer; }
.row:hover { background: #f7faf9; }
.row .top { display: flex; gap: 6px; align-items: baseline; }
.row .label { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; }
.row .tag { font-size: 11px; padding: 1px 6px; border-radius: 999px; white-space: nowrap; }
.tag.filled, .tag.inserted, .tag.ok { background: #e3f4f1; color: #0f5f58; }
.tag.needs_you, .tag.cleared, .tag.draft_ready { background: #fdf3e2; color: #8a4b08; }
.tag.failed { background: #fde8e8; color: #9b1c1c; }
.tag.kept, .tag.edited { background: #eef1f4; color: #44515e; }
.row .value { color: #1f2933; word-break: break-word; }
.row .why { color: #616e7c; font-size: 12px; }
.req { color: #b45309; font-size: 11px; }
.draft { border: 1px solid #e0e6eb; border-radius: 8px; padding: 8px; margin: 6px 0; }
.draft textarea { width: 100%; min-height: 96px; font: inherit; border: 1px solid #c6ced6; border-radius: 6px; padding: 6px; resize: vertical; }
.draft .acts { display: flex; gap: 6px; margin-top: 6px; }
footer { border-top: 1px solid #e6eaee; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; background: #fbfcfc; }
footer .line { display: flex; gap: 8px; flex-wrap: wrap; }
.confirm { background: #f3faf8; border: 1px solid #b7e0d8; border-radius: 8px; padding: 8px; }
`;

const STATUS_WORDS: Record<ReportItem['status'], string> = {
  filled: 'filled', kept: 'kept', needs_you: 'needs you', failed: 'not filled', draft_ready: 'draft ready', inserted: 'your draft',
  cleared: 'cleared by page', edited: 'changed', ok: 'as is',
};

type Send = (m: ToWorker) => void;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Array<Node | string | null>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else e.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

export class Panel {
  private host: HTMLElement;
  private root: ShadowRoot;
  private wrap: HTMLDivElement;
  private report: Report | null = null;
  private edits = new Map<string, string>();
  private banner: { kind: 'applied' | 'error' | 'info'; text: string } | null = null;
  private confirming = false;
  private collapsed = false;
  private send: Send;
  private locate: (fieldId: string) => void;

  constructor(send: Send, locate: (fieldId: string) => void) {
    this.send = send;
    this.locate = locate;
    this.host = document.createElement(PANEL_TAG);
    this.root = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    this.wrap = el('div', { class: 'wrap', role: 'region', 'aria-label': 'jobleft fill report' });
    this.root.append(style, this.wrap);
    document.documentElement.append(this.host);
  }

  get attached(): boolean { return this.host.isConnected; }

  remove(): void { this.host.remove(); }

  show(r: Report): void {
    this.report = r;
    if (!this.host.isConnected) document.documentElement.append(this.host);
    // Do not redraw under the person's cursor while they edit a draft.
    const active = this.root.activeElement;
    if (active && active.tagName === 'TEXTAREA') { this.pending = true; return; }
    this.render();
  }

  private pending = false;

  message(kind: 'applied' | 'error' | 'info', text: string, job?: Report['job']): void {
    if (job && this.report) this.report = { ...this.report, job };
    this.banner = { kind, text };
    this.confirming = false;
    this.render();
  }

  private act(handler: () => void): (ev: Event) => void {
    return (ev: Event) => {
      if (!ev.isTrusted) return;
      ev.preventDefault();
      ev.stopPropagation();
      handler();
    };
  }

  private render(): void {
    this.pending = false;
    const r = this.report;
    this.wrap.className = `wrap${this.collapsed ? ' collapsed' : ''}`;
    this.wrap.replaceChildren();
    const badge = r ? el('span', { class: `badge ${r.support.level}`, title: r.support.message }, r.support.name ? `${r.support.name} · ${r.support.level === 'supported' ? 'supported' : r.support.level === 'partial' ? 'partial' : 'not supported'}` : 'not a supported site') : null;
    const collapse = el('button', { class: 'icon', 'aria-label': this.collapsed ? 'Open the report' : 'Fold the report' }, this.collapsed ? '▸' : '–');
    collapse.addEventListener('click', this.act(() => { this.collapsed = !this.collapsed; this.render(); }));
    const close = el('button', { class: 'icon', 'aria-label': 'Close the report' }, '×');
    close.addEventListener('click', this.act(() => this.send({ type: 'panel:close' })));
    this.wrap.append(el('header', {}, el('span', { class: 'logo' }, 'jobleft'), badge, el('span', { class: 'spacer' }), collapse, close));
    if (!r) return;

    const body = el('div', { class: 'body' });
    if (this.banner) body.append(el('div', { class: `notice ${this.banner.kind === 'error' ? 'error' : 'info'}` }, this.banner.text));
    if (r.job) {
      const title = [r.job.title, r.job.company].filter(Boolean).join(' · ');
      body.append(el('div', { class: 'job' }, title || 'A job in your jobleft app'));
      if (r.job.appliedAt) body.append(el('div', { class: 'notice info' }, `Your tracker says you applied to this job on ${r.job.appliedAt.slice(0, 10)}.`));
    } else {
      const add = el('button', {}, 'Add this job to jobleft');
      add.addEventListener('click', this.act(() => this.send({ type: 'panel:addJob' })));
      body.append(el('div', { class: 'muted small' }, 'jobleft does not know this job. It is not in your jobleft app yet.'), el('div', { class: 'line' }, add));
    }
    if (r.support.level !== 'supported') body.append(el('div', { class: 'notice' }, r.support.message));

    // Status and totals.
    const phaseWords: Record<Report['phase'], string> = {
      reading: 'Reading the application form…', asking: 'Asking your jobleft app…', filling: 'Filling…', checking: 'Checking that the page kept each value…',
      done: 'Done. Check every field, then submit the application yourself.', stopped: 'Stopped. The list shows what jobleft already wrote.',
      error: 'The fill did not run.', undone: 'Undone. jobleft put back what it changed.',
    };
    const status = el('div', { class: 'status' }, el('span', {}, phaseWords[r.phase] + (r.progress && r.phase === 'filling' ? ` ${r.progress.done} of ${r.progress.total}` : '')));
    if (r.phase === 'filling' || r.phase === 'reading' || r.phase === 'asking') {
      const stop = el('button', { class: 'warn' }, 'Stop');
      stop.addEventListener('click', this.act(() => this.send({ type: 'panel:stop' })));
      status.append(stop);
    }
    body.append(status);
    if (r.error) body.append(el('div', { class: 'notice error' }, r.error));

    // Each chip is the size of the list with the same words below (the lists do not overlap).
    const groups = reportGroups(r);
    const g = Object.fromEntries(groups.map((x) => [x.key, x])) as Record<(typeof groups)[number]['key'], (typeof groups)[number]>;
    const reqEmpty = r.items.filter((i) => i.required && ['needs_you', 'cleared', 'failed', 'draft_ready'].includes(i.status)).length;
    body.append(el('div', { class: 'chips' },
      el('span', { class: 'chip filled' }, g.filled.chip),
      el('span', { class: 'chip needs' }, g.needs.chip),
      g.failed.items.length ? el('span', { class: 'chip failed' }, g.failed.chip) : null,
      el('span', { class: 'chip' }, g.kept.chip),
      g.drafts.items.length ? el('span', { class: 'chip needs' }, g.drafts.chip) : null,
    ));
    if (r.phase === 'done' && reqEmpty > 0) body.append(el('div', { class: 'notice' }, `${reqEmpty} required ${reqEmpty === 1 ? 'field is' : 'fields are'} still empty. They are marked on the page.`));

    for (const n of r.notices) body.append(this.noticeNode(n));

    if (r.resume) {
      const rs = r.resume;
      const words = rs.status === 'attached' ? `Resume attached: ${rs.fileName}` : rs.status === 'kept' ? `A file was already attached; jobleft kept it (${rs.fileName}).` : rs.status === 'none' ? (rs.message ?? 'No resume attached.') : `Resume not attached: ${rs.message ?? 'the upload failed'}`;
      body.append(el('div', { class: `notice ${rs.status === 'attached' || rs.status === 'kept' ? 'info' : 'error'}` }, words));
    }

    if (r.drafts.length) body.append(this.draftsNode(r));

    for (const { title, items } of groups) {
      if (!items.length) continue;
      body.append(el('h3', {}, `${title} (${items.length})`));
      for (const it of items) body.append(this.itemNode(it));
    }
    if (r.otherForms.length || r.hiddenIgnored) {
      const parts: string[] = [];
      if (r.otherForms.length) parts.push(`jobleft left ${r.otherForms.length === 1 ? 'another form' : `${r.otherForms.length} other forms`} on this page alone: ${r.otherForms.map((o) => `"${o.name}" (${o.fields} ${o.fields === 1 ? 'field' : 'fields'})`).join(', ')}.`);
      if (r.hiddenIgnored) parts.push(`It did not touch ${r.hiddenIgnored} hidden ${r.hiddenIgnored === 1 ? 'field' : 'fields'}.`);
      body.append(el('div', { class: 'muted small', style: 'margin-top:10px' }, parts.join(' ')));
    }
    this.wrap.append(body);
    this.wrap.append(this.footerNode(r));
  }

  private noticeNode(n: string): HTMLElement {
    const m = n.match(/^(.*?)(https?:\/\/\S+)(.*)$/);
    if (!m) return el('div', { class: 'notice' }, n);
    const a = el('a', { href: m[2] as string, target: '_blank', rel: 'noopener noreferrer' }, m[2] as string);
    return el('div', { class: 'notice' }, m[1] ?? '', a, m[3] ?? '');
  }

  private itemNode(it: ReportItem): HTMLElement {
    const top = el('div', { class: 'top' }, el('span', { class: 'label', title: it.label }, it.label || '(no label)'),
      it.required ? el('span', { class: 'req' }, 'required') : null, el('span', { class: `tag ${it.status}` }, STATUS_WORDS[it.status]));
    const row = el('div', { class: 'row', tabindex: '0', role: 'button', 'aria-label': `Show ${it.label} on the page` }, top);
    if (it.value) row.append(el('div', { class: 'value' }, it.value.length > 300 ? `${it.value.slice(0, 300)}…` : it.value));
    if (it.item && (it.status === 'filled' || it.status === 'inserted')) row.append(el('div', { class: 'why' }, `From: ${it.item}`));
    if (it.reason) row.append(el('div', { class: 'why' }, it.reason));
    row.addEventListener('click', this.act(() => this.locate(it.fieldId)));
    return row;
  }

  private draftsNode(r: Report): HTMLElement {
    const box = el('div', {});
    box.append(el('h3', {}, 'Open questions'));
    const offer = r.draftOffer;
    const offered = r.drafts.filter((d) => d.state === 'offered');
    if (offer && offered.length) {
      const price = offer.maxPriceMicrosPerDraft;
      const total = price * offered.length;
      const costWords = price === 0 ? 'free' : `up to ${formatDollars(total)} from your balance`;
      const bal = offer.balanceMicros !== null ? ` Your balance: ${formatDollars(offer.balanceMicros)}.` : '';
      const line = `Draft ${offered.length === 1 ? 'an answer' : `${offered.length} answers`} with ${offer.provider}${offer.local ? ' (on this computer)' : ''}: ${costWords}.${price === 0 ? '' : bal}`;
      const btn = el('button', { class: 'primary' }, price === 0 ? 'Make drafts' : `Make drafts (${formatDollars(total)})`);
      btn.addEventListener('click', this.act(() => {
        btn.setAttribute('disabled', 'true');
        this.send({ type: 'panel:makeDrafts', fieldIds: offered.map((d) => d.fieldId), maxCostMicros: total });
      }));
      box.append(el('div', { class: 'draft' }, el('div', {}, line), el('div', { class: 'muted small' }, 'A draft uses only facts from your profile. Nothing goes into the form until you press Insert.'), el('div', { class: 'acts' }, btn)));
    } else if (!offer && r.drafts.some((d) => d.state === 'offered')) {
      box.append(el('div', { class: 'muted small' }, 'No draft provider is set up in the jobleft app. Write these answers yourself.'));
    }
    if (r.draftCostNote) box.append(el('div', { class: 'muted small' }, r.draftCostNote));
    for (const d of r.drafts) box.append(this.draftNode(d));
    return box;
  }

  private draftNode(d: DraftItem): HTMLElement {
    const node = el('div', { class: 'draft' }, el('div', { class: 'label', style: 'font-weight:600' }, d.label));
    if (d.state === 'offered') { node.append(el('div', { class: 'muted small' }, 'No draft yet.')); return node; }
    if (d.state === 'failed') { node.append(el('div', { class: 'muted small' }, d.message ?? 'No draft was made.')); return node; }
    if (d.state === 'inserted') { node.append(el('div', { class: 'muted small' }, 'Inserted. Edit it in the form as you like.')); return node; }
    if (d.state === 'discarded') { node.append(el('div', { class: 'muted small' }, 'Discarded.')); return node; }
    const ta = el('textarea', { 'aria-label': `Draft for ${d.label}` });
    ta.value = this.edits.get(d.fieldId) ?? d.text ?? '';
    ta.addEventListener('input', () => { this.edits.set(d.fieldId, ta.value); });
    ta.addEventListener('blur', () => { if (this.pending) setTimeout(() => this.render(), 0); });
    const insert = el('button', { class: 'primary' }, 'Insert into the form');
    insert.addEventListener('click', this.act(() => this.send({ type: 'panel:insertDraft', fieldId: d.fieldId, text: ta.value })));
    const discard = el('button', {}, 'Discard');
    discard.addEventListener('click', this.act(() => { this.edits.delete(d.fieldId); this.send({ type: 'panel:discardDraft', fieldId: d.fieldId }); }));
    node.append(ta, el('div', { class: 'muted small' }, `Draft by ${d.provider ?? 'the app'}. Read it and change it before you insert it.${d.maxLength ? ` Limit: ${d.maxLength} characters.` : ''}`), el('div', { class: 'acts' }, insert, discard));
    return node;
  }

  private footerNode(r: Report): HTMLElement {
    const f = el('footer', {});
    const busy = r.phase === 'filling' || r.phase === 'reading' || r.phase === 'asking' || r.phase === 'checking';
    const undo = el('button', {}, 'Undo fill');
    if (busy || r.phase === 'undone' || r.phase === 'error') undo.setAttribute('disabled', 'true');
    undo.addEventListener('click', this.act(() => this.send({ type: 'panel:undo' })));
    const again = el('button', {}, 'Fill again');
    if (busy) again.setAttribute('disabled', 'true');
    again.addEventListener('click', this.act(() => { this.banner = null; this.send({ type: 'panel:fillAgain' }); }));
    f.append(el('div', { class: 'line' }, undo, again));
    if (this.confirming) {
      const yes = el('button', { class: 'primary' }, 'Yes, I submitted it');
      yes.addEventListener('click', this.act(() => { this.confirming = false; this.send({ type: 'panel:markApplied' }); this.render(); }));
      const no = el('button', {}, 'Not yet');
      no.addEventListener('click', this.act(() => { this.confirming = false; this.render(); }));
      f.append(el('div', { class: 'confirm' },
        el('div', {}, 'Press this only after you pressed the employer\'s own submit button and saw that they got your application.'),
        el('div', { class: 'line', style: 'margin-top:6px' }, yes, no)));
    } else {
      const applied = el('button', { class: 'primary' }, r.job?.appliedAt ? 'I submitted it again (keeps one entry)' : 'I submitted this application');
      if (busy) applied.setAttribute('disabled', 'true');
      applied.addEventListener('click', this.act(() => { this.confirming = true; this.render(); }));
      f.append(el('div', { class: 'line' }, applied));
    }
    f.append(el('div', { class: 'muted small' }, 'jobleft never presses submit, next or save. You review and submit.'));
    return f;
  }
}
