// Reading the application form (runs in the page, only after the person presses Fill).
// It finds the visible fields of the one form that is the job application, and nothing else:
//   * never a hidden, zero-size, off-screen or clipped field (a trap "SSN" or "Email" box collects nothing);
//   * never a field of another form (job alerts, newsletter, search, sign-in, refer a friend, cookie banner, chat);
//   * never a password field; a form with one is an account step and is not filled at all.
// Ideas for question grouping, label order and hidden-control rules come from freehire extension/lib/form.ts (MIT)
// and JobNavigator extension/content_autofill_fill.js (MIT); see THIRD_PARTY_NOTICES.md. The code is written anew.

import type { AtsId, FormField } from '@jobleft/contracts';
import { classify } from '../classify.ts';
import { norm, words } from '../text.ts';

export const PANEL_TAG = 'jobleft-panel';

/** The ways a custom dropdown declares itself (freehire form.ts COMBO_WIDGET, plus Workday's listbox buttons). */
export const COMBO_WIDGET = '[role="combobox"], [aria-autocomplete="list"], [aria-autocomplete="both"], [aria-haspopup="listbox"]';

export type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLElement;

export interface Found {
  id: string;
  field: FormField;
  /** The control, or the controls of a radio or checkbox group in order. */
  els: Control[];
  /** The element to outline on the page (a visible label or widget for a hidden input). */
  mark: HTMLElement;
  container: Element;
}

export interface Scan {
  app: Found[];
  appContainer: Element | null;
  score: number;
  ambiguous: boolean;
  account: boolean;
  captcha: 'visible' | 'invisible' | null;
  otherForms: Array<{ name: string; fields: number }>;
  hiddenIgnored: number;
  blockedFrames: string[];
}

// ------------------------------------------------------------------ visibility

function win(el: Element): Window {
  return (el.ownerDocument.defaultView ?? window) as Window;
}

function clipsAway(cs: CSSStyleDeclaration): boolean {
  const cp = cs.clipPath;
  if (cp && cp !== 'none' && /inset\(\s*(4[5-9]|50|[5-9]\d|100)%|circle\(\s*0|polygon\(\s*0px 0px,\s*0px 0px/.test(cp)) return true;
  const clip = cs.clip;
  if (clip && clip !== 'auto' && /rect\(\s*[01]px,?\s*[01]px,?\s*[01]px,?\s*[01]px\s*\)/.test(clip)) return true;
  return false;
}

/** The element itself can be seen by the person: rendered, not transparent, big enough, on the page, not clipped. */
export function visibleSelf(el: Element): boolean {
  if (!el.isConnected) return false;
  if (el.closest('[hidden], [inert]')) return false;
  const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (typeof check === 'function' && !check.call(el, { checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  const w = win(el);
  const de = el.ownerDocument.documentElement;
  const pageW = Math.max(de.scrollWidth, w.innerWidth);
  const pageH = Math.max(de.scrollHeight, w.innerHeight);
  const left = r.left + w.scrollX;
  const top = r.top + w.scrollY;
  if (left + r.width <= 1 || top + r.height <= 1 || left >= pageW - 1 || top >= pageH - 1) return false;
  const own = w.getComputedStyle(el);
  if (clipsAway(own) || Number.parseFloat(own.opacity) < 0.1) return false;
  for (let a: Element | null = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null); a; a = a.parentElement ?? ((a.getRootNode() as ShadowRoot).host ?? null)) {
    if (a === el.ownerDocument.documentElement) break;
    const cs = w.getComputedStyle(a);
    if (Number.parseFloat(cs.opacity) < 0.1 || clipsAway(cs)) return false;
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      const ar = a.getBoundingClientRect();
      if (ar.width < 2 || ar.height < 2) return false;
      const cx = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
      const cy = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
      if (cx && (r.right <= ar.left + 1 || r.left >= ar.right - 1)) return false;
      if (cy && (r.bottom <= ar.top + 1 || r.top >= ar.bottom - 1)) return false;
    }
  }
  return true;
}

/** Labels of a control that the person can see. */
function visibleLabels(el: Element): HTMLElement[] {
  const labels = Array.from((el as HTMLInputElement).labels ?? []);
  return labels.filter((l) => visibleSelf(l));
}

/**
 * For a radio, checkbox or file input that a page styles out of sight: the visible thing the person uses instead
 * (its label, or the small wrapper with its button). null when nothing visible stands for it.
 */
function visibleProxy(el: Control): HTMLElement | null {
  if (visibleSelf(el)) return el as HTMLElement;
  const input = el as HTMLInputElement;
  const type = el instanceof HTMLInputElement ? el.type : '';
  if (type !== 'radio' && type !== 'checkbox' && type !== 'file') {
    if (el instanceof HTMLSelectElement) {
      // select2 / chosen: the real select is hidden and a widget right after it is what the person sees.
      const next = el.nextElementSibling;
      if (next && /\b(select2|chosen)-container\b/.test(next.className?.toString() ?? '') && visibleSelf(next)) return next as HTMLElement;
    }
    return null;
  }
  const labels = visibleLabels(input);
  if (labels[0]) return labels[0];
  let a: HTMLElement | null = el.parentElement;
  for (let i = 0; i < 3 && a; i++, a = a.parentElement) {
    if (a.tagName === 'FORM' || a.tagName === 'BODY') break;
    if (!visibleSelf(a)) continue;
    if (type === 'file') {
      const inputs = a.querySelectorAll('input[type="file"]');
      if (inputs.length !== 1) break;
      const btn = a.querySelector('button, [role="button"], label, a');
      if (btn && visibleSelf(btn)) return a;
    } else {
      const same = a.querySelectorAll(`input[type="${type}"]`);
      if (same.length === 1) return a;
    }
  }
  return null;
}

// ------------------------------------------------------------------ text around a control

const SKIP_TEXT = new Set(['SELECT', 'OPTION', 'TEXTAREA', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'TEMPLATE', 'INPUT', 'BUTTON']);

/** The visible words of a node, without the words of controls inside it (a label wrapping a select). */
export function ownText(node: Node, max = 1000): string {
  let out = '';
  const walk = (n: Node): void => {
    if (out.length > max) return;
    if (n.nodeType === Node.TEXT_NODE) { out += n.textContent ?? ''; return; }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const e = n as Element;
    if (SKIP_TEXT.has(e.tagName) || e.tagName.toLowerCase() === PANEL_TAG) return;
    for (const c of Array.from(e.childNodes)) walk(c);
    if (/^(DIV|P|LI|BR|H[1-6]|LEGEND|LABEL)$/.test(e.tagName)) out += ' ';
  };
  walk(node);
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}

function byIds(doc: Document | ShadowRoot, ids: string | null): string {
  if (!ids) return '';
  return ids.split(/\s+/).map((id) => {
    const n = (doc as Document).getElementById?.(id) ?? null;
    return n ? ownText(n, 300) : '';
  }).filter(Boolean).join(' ');
}

/** The short text right before a control inside its field wrapper ("City" in <div><span>City</span><input></div>). */
function nearbyLabel(el: Element): string {
  let node: Element | null = el;
  for (let depth = 0; depth < 3 && node; depth++) {
    let sib = node.previousElementSibling;
    let hops = 0;
    while (sib && hops < 3) {
      if (!sib.querySelector('input, select, textarea') && sib.tagName.toLowerCase() !== PANEL_TAG) {
        const t = ownText(sib, 250);
        if (t && t.length <= 200) return t;
      } else {
        return '';
      }
      sib = sib.previousElementSibling;
      hops++;
    }
    node = node.parentElement;
    if (node && (node.tagName === 'FORM' || node.querySelectorAll('input, select, textarea').length > 3)) break;
  }
  return '';
}

/** The person-facing question of one control. */
export function labelOf(el: Element): string {
  const root = el.getRootNode() as Document | ShadowRoot;
  const labels = Array.from((el as HTMLInputElement).labels ?? []).map((l) => ownText(l, 500)).filter(Boolean);
  if (labels.length) return labels.join(' ');
  const lb = byIds(root, el.getAttribute('aria-labelledby'));
  if (lb) return lb;
  const al = el.getAttribute('aria-label');
  if (al && al.trim()) return al.trim();
  const wd = el.closest('[data-automation-id^="formField-"]');
  if (wd) {
    const l = wd.querySelector('label, legend');
    if (l) { const t = ownText(l, 300); if (t) return t; }
  }
  const near = nearbyLabel(el);
  if (near) return near;
  const title = el.getAttribute('title');
  if (title) return title;
  return '';
}

/** The question of a radio or checkbox group. */
function groupQuestion(els: Control[]): string {
  const first = els[0] as Element;
  const root = first.getRootNode() as Document | ShadowRoot;
  const fs = first.closest('fieldset');
  if (fs && els.every((e) => fs.contains(e))) {
    const legend = Array.from(fs.children).find((c) => c.tagName === 'LEGEND');
    const t = legend ? ownText(legend, 500) : '';
    if (t) return t;
  }
  const grp = first.closest('[role="radiogroup"], [role="group"]');
  if (grp && els.every((e) => grp.contains(e))) {
    const t = byIds(root, grp.getAttribute('aria-labelledby')) || (grp.getAttribute('aria-label') ?? '').trim();
    if (t) return t;
  }
  const path = first.closest('[data-field-path]');
  if (path && els.every((e) => path.contains(e))) {
    const q = path.querySelector('label:not([for]), legend, [class*="title" i], [class*="question" i], [class*="label" i], h1, h2, h3, h4, h5');
    const t = q ? ownText(q, 500) : '';
    if (t) return t;
  }
  const wd = first.closest('[data-automation-id^="formField-"]');
  if (wd && els.every((e) => wd.contains(e))) {
    const l = wd.querySelector('legend, label');
    const t = l ? ownText(l, 500) : '';
    if (t) return t;
  }
  // The nearest common wrapper's leading text.
  let common: Element | null = first.parentElement;
  while (common && !els.every((e) => common?.contains(e))) common = common.parentElement;
  for (let i = 0; i < 3 && common; i++, common = common.parentElement) {
    let sib = common.previousElementSibling;
    if (sib && !sib.querySelector('input, select, textarea')) {
      const t = ownText(sib, 400);
      if (t) return t;
    }
    const lead = common.firstElementChild;
    if (lead && !lead.querySelector('input, select, textarea') && lead !== first) {
      const t = ownText(lead, 400);
      if (t) return t;
    }
  }
  return '';
}

function optionLabel(el: Control): string {
  const t = labelOf(el);
  if (t) return t;
  return (el as HTMLInputElement).value ?? '';
}

const HEADING = 'h1, h2, h3, h4, h5, h6, legend, [role="heading"]';

/** The nearest heading before the element inside its container ("Education", "Voluntary Self-Identification"). */
function sectionOf(el: Element, headings: Element[]): string | null {
  let best: Element | null = null;
  for (const h of headings) {
    if (h.contains(el)) continue;
    const pos = h.compareDocumentPosition(el);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) best = h;
    else break;
  }
  const t = best ? ownText(best, 200) : '';
  return t || null;
}

/** Words close to the field that say who it is about ("Reference 1", "Emergency contact"). */
function contextOf(el: Element): string {
  const parts: string[] = [];
  const fs = el.closest('fieldset');
  if (fs) {
    const lg = Array.from(fs.children).find((c) => c.tagName === 'LEGEND');
    if (lg) parts.push(ownText(lg, 150));
  }
  let a: Element | null = el.parentElement;
  for (let i = 0; i < 5 && a; i++, a = a.parentElement) {
    if (a.tagName === 'FORM') break;
    const h = a.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > [role="heading"], :scope > strong, :scope > b');
    if (h && !h.contains(el)) { parts.push(ownText(h, 150)); break; }
  }
  return parts.filter(Boolean).join(' · ').slice(0, 300);
}

function isRequired(els: Control[], rawLabel: string): boolean {
  if (els.some((e) => (e as HTMLInputElement).required || e.getAttribute('aria-required') === 'true')) return true;
  return /\*\s*$|\*\s*\)|\(required\)|\brequired\b\s*$/i.test(rawLabel.trim());
}

function cleanLabel(t: string): string {
  return t.replace(/\s+/g, ' ').replace(/\s*\*+\s*$/, '').trim().slice(0, 1000);
}

// ------------------------------------------------------------------ containers

const NEGATIVE: Array<[RegExp, string]> = [
  [/\b(newsletter|subscribe|subscription|job alerts?|get alerts|alerts? for|notify me|get notified|stay (in touch|updated|connected)|talent (community|network|pool)|join our (talent|community|network)|mailing list|keep me (posted|updated)|email me (jobs|similar))\b/, 'job alerts or newsletter'],
  [/\b(sign in|log in|login|signin|forgot (your )?password|create (an |your )?account|register|sign up|signup)\b/, 'sign-in or account'],
  [/\b(refer a friend|refer someone|referral program|refer a candidate|refer your friend)\b/, 'refer a friend'],
  [/\b(cookie|cookies|consent preferences|privacy preferences|onetrust|gdpr|manage preferences)\b/, 'cookie banner'],
  [/\b(chat|live chat|message us|chatbot|intercom|drift|zendesk|hubspot messages|ask a question)\b/, 'chat'],
  [/\b(search|search jobs|find jobs|keyword|keywords|filter jobs)\b/, 'search'],
];

function containerOf(el: Element): Element {
  const f = (el as HTMLInputElement).form;
  if (f) return f;
  const c = el.closest('form, [role="form"], [role="dialog"], dialog, [role="search"], header, footer, nav, aside, [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="onetrust" i], [id*="chat" i], [class*="chat-widget" i], [class*="intercom" i]');
  if (c) return c;
  const host = (el.getRootNode() as ShadowRoot).host;
  if (host) return containerOf(host);
  return el.ownerDocument.body ?? el.ownerDocument.documentElement;
}

/** Words that describe a container: its name, headings, legends and buttons (never the labels of its fields). */
function containerWords(c: Element): string {
  const parts: string[] = [];
  for (const a of ['aria-label', 'id', 'name', 'class', 'action', 'role', 'data-testid']) parts.push(c.getAttribute(a) ?? '');
  const heads = Array.from(c.querySelectorAll('h1, h2, h3, h4, legend, [role="heading"], button, input[type="submit"], input[type="button"], [role="button"]')).slice(0, 12);
  for (const h of heads) parts.push(h instanceof HTMLInputElement ? h.value : ownText(h, 120));
  // The heading right before a form names it ("Get job alerts").
  let prev: Element | null = c.previousElementSibling;
  for (let i = 0; i < 2 && prev; i++, prev = prev.previousElementSibling) {
    if (prev.matches(HEADING) || prev.querySelector(HEADING)) { parts.push(ownText(prev, 120)); break; }
  }
  return words(splitWords(parts.join(' ')));
}

function splitWords(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ');
}

function containerName(c: Element): string {
  const al = c.getAttribute('aria-label');
  if (al) return al.trim().slice(0, 80);
  const h = c.querySelector('h1, h2, h3, h4, legend, [role="heading"]');
  if (h) { const t = ownText(h, 80); if (t) return t; }
  let prev: Element | null = c.previousElementSibling;
  for (let i = 0; i < 2 && prev; i++, prev = prev.previousElementSibling) {
    const t = ownText(prev, 80);
    if (t) return t;
  }
  const b = c.querySelector('button, input[type="submit"]');
  if (b) { const t = b instanceof HTMLInputElement ? b.value : ownText(b, 60); if (t) return `the form with the "${t}" button`; }
  return c.tagName === 'FORM' ? 'a form' : 'fields outside a form';
}

// ------------------------------------------------------------------ walking the page

function deepAll(root: Document | ShadowRoot | Element, selector: string): Element[] {
  const out: Element[] = Array.from(root.querySelectorAll(selector));
  for (const e of Array.from(root.querySelectorAll('*'))) {
    const sr = (e as HTMLElement).shadowRoot;
    if (sr && e.tagName.toLowerCase() !== PANEL_TAG) out.push(...deepAll(sr, selector));
  }
  return out;
}

const CONTROLS = `input, select, textarea, ${COMBO_WIDGET}`;
const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'range', 'color']);

function isCombo(el: Element): boolean {
  if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) return false;
  if (el instanceof HTMLInputElement && !['text', 'search', ''].includes(el.type)) return false;
  return el.matches(COMBO_WIDGET);
}

interface Raw {
  els: Control[];
  mark: HTMLElement;
  kind: FormField['kind'];
  combobox: boolean;
  container: Element;
}

function kindOf(el: Control): FormField['kind'] {
  if (el instanceof HTMLTextAreaElement) return 'textarea';
  if (el instanceof HTMLSelectElement) return 'select';
  if (!(el instanceof HTMLInputElement)) return 'select';
  switch (el.type) {
    case 'email': return 'email';
    case 'tel': return 'tel';
    case 'url': return 'url';
    case 'number': return 'number';
    case 'date': case 'month': return 'date';
    case 'file': return 'file';
    case 'radio': return 'radio';
    case 'checkbox': return 'checkbox';
    case 'text': case 'search': case '': return 'text';
    default: return 'unknown';
  }
}

/** Every visible control of the document, grouped into questions, plus the number of hidden ones left out. */
function rawControls(doc: Document): { raws: Raw[]; hidden: Map<Element, number>; passwords: Element[] } {
  const raws: Raw[] = [];
  const hidden = new Map<Element, number>();
  const passwords: Element[] = [];
  const seen = new Set<Element>();
  const groups = new Map<string, Raw>();
  const all = deepAll(doc, CONTROLS).filter((e) => !e.closest(PANEL_TAG));
  for (const node of all) {
    if (seen.has(node)) continue;
    seen.add(node);
    const el = node as Control;
    if (el instanceof HTMLInputElement && SKIP_TYPES.has(el.type)) continue;
    if ((el as HTMLInputElement).disabled) continue;
    if (el instanceof HTMLInputElement && el.readOnly && el.type !== 'file' && !isCombo(el)) continue;
    // A combobox role on a wrapper around an input we also list: keep the input.
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) {
      if (el.querySelector('input, select, textarea')) continue;
      if (el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'combobox') continue;
    }
    const container = containerOf(el);
    const mark = visibleProxy(el);
    if (el instanceof HTMLInputElement && el.type === 'password') {
      if (mark) passwords.push(el);
      continue;
    }
    if (!mark) {
      hidden.set(container, (hidden.get(container) ?? 0) + 1);
      continue;
    }
    const kind = kindOf(el);
    const combobox = isCombo(el);
    if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox')) {
      const scope = el.form ?? container;
      const key = el.name ? `${el.type}:${el.name}` : '';
      if (key) {
        const gkey = `${key}#${scopeKey(scope)}`;
        const open = groups.get(gkey);
        if (open) { open.els.push(el); continue; }
        const r: Raw = { els: [el], mark, kind, combobox: false, container };
        groups.set(gkey, r);
        raws.push(r);
        continue;
      }
      if (el.type === 'checkbox') {
        // Unnamed checkboxes that share a labelled group (fieldset, role=group, Ashby data-field-path) are one question.
        const box = el.closest('fieldset, [role="group"], [data-field-path]');
        if (box && box.querySelectorAll('input[type="checkbox"]').length > 1) {
          const gkey = `cbgroup#${scopeKey(box)}`;
          const open = groups.get(gkey);
          if (open) { open.els.push(el); continue; }
          const r: Raw = { els: [el], mark, kind, combobox: false, container };
          groups.set(gkey, r);
          raws.push(r);
          continue;
        }
      }
    }
    raws.push({ els: [el], mark, kind, combobox, container });
  }
  return { raws, hidden, passwords };
}

const scopeIds = new WeakMap<Element, number>();
let scopeSeq = 0;
function scopeKey(e: Element): number {
  let k = scopeIds.get(e);
  if (k === undefined) { k = ++scopeSeq; scopeIds.set(e, k); }
  return k;
}

// ------------------------------------------------------------------ describing a question as a FormField

function describe(r: Raw, id: string, headings: Element[]): FormField {
  const first = r.els[0] as Control;
  const isGroup = r.els.length > 1 || (first instanceof HTMLInputElement && first.type === 'radio');
  const rawLabel = isGroup ? (groupQuestion(r.els) || labelOf(first)) : labelOf(first);
  const input = first as HTMLInputElement;
  let options: FormField['options'] = [];
  if (first instanceof HTMLSelectElement) {
    options = Array.from(first.options).map((o, i) => ({ value: String(i), label: (o.textContent ?? '').replace(/\s+/g, ' ').trim() }));
  } else if (isGroup) {
    options = r.els.map((e, i) => ({ value: String(i), label: cleanLabel(optionLabel(e)) }));
  }
  const kind: FormField['kind'] = r.els.length > 1 && first instanceof HTMLInputElement && first.type === 'checkbox' ? 'checkbox' : r.kind;
  const name = first.getAttribute('name') || first.getAttribute('data-automation-id') || first.closest('[data-field-path]')?.getAttribute('data-field-path')
    || (first.id && !/^[:\d]|[:]/.test(first.id) && first.id.length < 60 ? first.id : null);
  const maxLength = (first instanceof HTMLInputElement || first instanceof HTMLTextAreaElement) && first.maxLength > 0 ? first.maxLength : null;
  const section = sectionOf(first, headings);
  const field: FormField = {
    fieldId: id,
    label: cleanLabel(rawLabel || (first.getAttribute('placeholder') ?? '')),
    name: name ? name.slice(0, 200) : null,
    kind,
    required: isRequired(r.els, rawLabel),
    options: options.slice(0, 500),
    maxLength,
    section: section ? section.slice(0, 200) : null,
  };
  const ac = first.getAttribute('autocomplete');
  if (ac) field.autocomplete = ac.slice(0, 100);
  const ph = first.getAttribute('placeholder');
  if (ph) field.placeholder = ph.slice(0, 300);
  if (first instanceof HTMLInputElement) field.inputType = input.type.slice(0, 40);
  const ctx = contextOf(first);
  if (ctx) field.context = ctx;
  if (r.combobox) field.combobox = true;
  if (first instanceof HTMLInputElement && first.type === 'file') field.accept = (first.getAttribute('accept') ?? '').slice(0, 300);
  return field;
}

/** 0-based repeat of a question inside its section ("School" of the second education block = 1). */
function assignEntries(found: Found[]): void {
  const count = new Map<string, number>();
  for (const f of found) {
    const sec = words(f.field.section ?? '').replace(/\b\d+\b/g, '').replace(/\b(first|second|third|additional|another|other)\b/g, '').trim();
    const key = `${sec}|${words(f.field.label)}|${f.field.kind}`;
    const n = count.get(key) ?? 0;
    count.set(key, n + 1);
    if (n > 0) f.field.entry = Math.min(n, 50);
  }
}

// ------------------------------------------------------------------ captcha and frames

function captchaState(doc: Document): 'visible' | 'invisible' | null {
  const frames = deepAll(doc, 'iframe') as HTMLIFrameElement[];
  const cap = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|captcha|arkoselabs|funcaptcha|geetest/i;
  let invisible = false;
  for (const f of frames) {
    if (!cap.test(f.src || f.getAttribute('title') || '')) continue;
    if (visibleSelf(f) && f.getBoundingClientRect().height > 30) return 'visible';
    invisible = true;
  }
  const boxes = deepAll(doc, '.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], [id*="captcha" i], [class*="captcha" i], [name*="captcha" i], [data-captcha]');
  for (const b of boxes) {
    if (b.closest(PANEL_TAG)) continue;
    if (visibleSelf(b)) return 'visible';
    invisible = true;
  }
  if (doc.querySelector('.grecaptcha-badge')) invisible = true;
  return invisible ? 'invisible' : null;
}

const ATS_FRAME = /greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|myworkdayjobs\.com|myworkdaysite\.com|icims\.com/i;

/** Frames from another site that hold an application form this frame cannot reach. */
export function blockedFrames(doc: Document): string[] {
  const out: string[] = [];
  for (const f of deepAll(doc, 'iframe') as HTMLIFrameElement[]) {
    let src: URL;
    try { src = new URL(f.src, doc.baseURI); } catch { continue; }
    if (!/^https?:$/.test(src.protocol) || src.origin === doc.location.origin) continue;
    const r = f.getBoundingClientRect();
    const big = r.width >= 300 && r.height >= 200 && visibleSelf(f);
    if (ATS_FRAME.test(src.hostname) && visibleSelf(f)) out.push(src.href);
    else if (big && /apply|application|job|career/i.test(src.href)) out.push(src.href);
  }
  return [...new Set(out)].slice(0, 5);
}

// ------------------------------------------------------------------ the scan

export function scan(doc: Document): Scan {
  const { raws, hidden, passwords } = rawControls(doc);
  const headingsAll = deepAll(doc, HEADING).filter((h) => !h.closest(PANEL_TAG));
  const byContainer = new Map<Element, Found[]>();
  let seq = 0;
  for (const r of raws) {
    const id = `f${++seq}`;
    const heads = headingsAll.filter((h) => r.container.contains(h));
    const field = describe(r, id, heads);
    const f: Found = { id, field, els: r.els, mark: r.mark, container: r.container };
    const list = byContainer.get(r.container) ?? [];
    list.push(f);
    byContainer.set(r.container, list);
  }

  interface Cand { c: Element; fields: Found[]; score: number; resume: boolean; negative: string | null; account: boolean }
  const cands: Cand[] = [];
  for (const [c, fields] of byContainer) {
    const cw = containerWords(c);
    let negative: string | null = null;
    for (const [re, why] of NEGATIVE) if (re.test(cw)) { negative = why; break; }
    if (c.matches('[role="search"]') || fields.every((f) => f.field.inputType === 'search')) negative = 'search';
    const account = passwords.some((p) => c.contains(p));
    let score = 0;
    let resume = false;
    for (const f of fields) {
      const t = classify(f.field).topic;
      if (t === 'resume_file') { resume = true; score += 100; }
      else if (['first_name', 'last_name', 'full_name', 'email', 'phone'].includes(t)) score += 6;
      else if (t.startsWith('edu_') || t.startsWith('work_') || t.startsWith('eeo_') || t === 'pro_profile' || t === 'location' || t === 'current_company') score += 3;
      else if (t !== 'unknown') score += 1;
    }
    if (/\b(apply|application|submit application|apply now|apply for this job|send application)\b/.test(cw)) score += 20;
    if (negative && !resume) score = Math.min(score, 0);
    if (negative && resume && /job alerts|newsletter|talent/.test(negative)) score = Math.min(score, 0);
    cands.push({ c, fields, score, resume, negative, account });
  }

  let pool = cands.filter((x) => x.score > 0);
  if (pool.some((x) => x.resume)) pool = pool.filter((x) => x.resume);
  pool.sort((a, b) => b.score - a.score);
  let chosen: Cand | null = pool[0] ?? null;
  let ambiguous = false;
  if (chosen && pool[1] && !chosen.resume && pool[1].score >= chosen.score - 10) {
    const active = doc.activeElement;
    const inside = pool.find((x) => active && x.c.contains(active));
    if (inside) chosen = inside;
    else { ambiguous = true; chosen = null; }
  }
  if (chosen && chosen.score < 12 && !chosen.resume) chosen = null;

  const account = chosen ? chosen.account : passwords.length > 0;
  const app = chosen && !chosen.account ? chosen.fields : [];
  assignEntries(app);
  const otherForms = cands.filter((x) => x !== chosen && x.fields.length > 0).map((x) => ({ name: containerName(x.c), fields: x.fields.length }));
  let hiddenIgnored = 0;
  for (const [c, n] of hidden) if (!chosen || chosen.c === c || chosen.c.contains(c) || c.contains(chosen.c)) hiddenIgnored += n;
  return {
    app,
    appContainer: chosen?.c ?? null,
    score: chosen ? chosen.score : 0,
    ambiguous,
    account,
    captcha: captchaState(doc),
    otherForms,
    hiddenIgnored,
    blockedFrames: blockedFrames(doc),
  };
}

// ------------------------------------------------------------------ the system behind the page (markers only)

/** Which system made this page, from markers (never text). Works on saved copies of real pages too. */
export function atsFromPage(doc: Document): AtsId | null {
  const saved = (() => {
    for (const n of Array.from(doc.childNodes)) {
      if (n.nodeType === Node.COMMENT_NODE) {
        const m = (n.textContent ?? '').match(/saved from url=\(\d+\)(\S+)/i);
        if (m) return m[1] ?? '';
      }
    }
    const canon = doc.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? doc.querySelector('meta[property="og:url"]')?.getAttribute('content') ?? '';
    return canon;
  })();
  const host = (() => { try { return new URL(saved).hostname; } catch { return ''; } })();
  if (/greenhouse\.io$/.test(host)) return 'greenhouse';
  if (/lever\.co$/.test(host)) return 'lever';
  if (/ashbyhq\.com$/.test(host)) return 'ashby';
  if (/workable\.com$/.test(host)) return 'workable';
  if (/myworkday(jobs|site)?\.com$/.test(host)) return 'workday';
  if (/icims\.com$/.test(host)) return 'icims';
  const q = (s: string): boolean => !!doc.querySelector(s);
  if (q('[data-automation-id="applyFlowPage"], [data-automation-id^="formField-"], [data-automation-id="legalNameSection_firstName"]')) return 'workday';
  if (q('#application_form, form#application-form, input[name^="job_application["], [id^="job-application"], .application--form, #application-form')
    || q('a[href*="greenhouse.io"], img[src*="greenhouse.io"], link[href*="greenhouse.io"], script[src*="greenhouse.io"]')) return 'greenhouse';
  if (q('.application-form input[name^="urls["], form[action*="lever.co"], .lever-application, input[name="urls[Other]"], input[name="urls[GitHub]"]')
    || q('a[href*="lever.co"], img[src*="lever.co"], link[href*="lever.co"]')) return 'lever';
  if (q('[data-field-path^="_systemfield_"], [class*="ashby-application-form"]') || q('a[href*="ashbyhq.com"], link[href*="ashbyhq.com"], img[src*="ashbyhq.com"]')) return 'ashby';
  if (q('[data-ui="application-form"], form[data-ui]') || q('a[href*="workable.com"], link[href*="workable.com"], img[src*="workable.com"]')) return 'workable';
  if (q('[class*="iCIMS_"], #iCIMS_Content, [id*="icims" i]')) return 'icims';
  return null;
}
