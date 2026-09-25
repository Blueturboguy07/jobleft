// Writing into the application form, checking that the page kept each value, and undoing a fill.
// Rules: a field that already has a value the person typed is kept; a write is checked after the page settles and
// reported "filled" only if the page still holds it; no key is pressed (an Enter can submit); no submit, next,
// save or continue control is ever clicked; hidden fields are re-checked right before each write.
// The native-setter-plus-events write and the label-click escalation for hidden radios follow freehire
// extension/lib/form.ts and JobNavigator extension/content_autofill_fill.js (both MIT); see THIRD_PARTY_NOTICES.md.

import type { FillResponse } from '@jobleft/contracts';
import type { MatchKind } from '../options.ts';
import { isPlaceholderOption } from '../text.ts';
import { clearCombobox, displayedValues, fillCombobox } from './combobox.ts';
import type { Control, Found } from './dom.ts';
import { visibleSelf } from './dom.ts';

export interface Snapshot {
  value: string | null;
  selectedIndex: number | null;
  checked: boolean[] | null;
  files: FileList | null;
  shown: string[] | null;
}

export interface Written {
  found: Found;
  prev: Snapshot;
  /** The state right after jobleft wrote (compared before an undo, so a later edit by the person is kept). */
  after: string;
  /** What the person sees in the report. */
  display: string;
}

export type Outcome =
  | { status: 'filled'; display: string; written: Written }
  | { status: 'kept'; display: string }
  | { status: 'unchanged'; display: string }
  | { status: 'failed'; reason: string };

const MARK_FILLED = '2px solid #0f766e';
const MARK_NEEDS = '2px dashed #b45309';

function first(f: Found): Control {
  return f.els[0] as Control;
}

function isText(el: Control): el is HTMLInputElement | HTMLTextAreaElement {
  return el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['radio', 'checkbox', 'file'].includes(el.type));
}

function isComboField(f: Found): boolean {
  return f.field.combobox === true;
}

/** The field's state as one string, for "did it change" checks. */
export function repr(f: Found): string {
  const el = first(f);
  if (isComboField(f)) return `combo:${displayedValues(el).join('|')}|${(el as HTMLInputElement).value ?? ''}`;
  if (el instanceof HTMLSelectElement) return `select:${el.selectedIndex}`;
  if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox')) {
    return `check:${f.els.map((e) => ((e as HTMLInputElement).checked ? '1' : '0')).join('')}`;
  }
  if (el instanceof HTMLInputElement && el.type === 'file') return `file:${Array.from(el.files ?? []).map((x) => x.name).join('|')}`;
  if (isText(el)) return `text:${el.value}`;
  return `other:${el.textContent ?? ''}`;
}

/** What the field shows now, in words. */
export function shownValue(f: Found): string {
  const el = first(f);
  if (isComboField(f)) return displayedValues(el).join(', ');
  if (el instanceof HTMLSelectElement) {
    const o = el.options[el.selectedIndex];
    return o && !isPlaceholderOption(o.text, o.value) ? o.text.trim() : '';
  }
  if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox')) {
    if (f.els.length === 1 && el.type === 'checkbox') return el.checked ? 'checked' : '';
    return f.els.map((e, i) => ((e as HTMLInputElement).checked ? f.field.options[i]?.label ?? '' : '')).filter(Boolean).join(', ');
  }
  if (el instanceof HTMLInputElement && el.type === 'file') return Array.from(el.files ?? []).map((x) => x.name).join(', ');
  if (isText(el)) return el.value;
  return '';
}

export function isEmpty(f: Found): boolean {
  return shownValue(f).trim() === '';
}

export function snapshot(f: Found): Snapshot {
  const el = first(f);
  return {
    value: isText(el) ? el.value : null,
    selectedIndex: el instanceof HTMLSelectElement ? el.selectedIndex : null,
    checked: el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox') ? f.els.map((e) => (e as HTMLInputElement).checked) : null,
    files: el instanceof HTMLInputElement && el.type === 'file' ? el.files : null,
    shown: isComboField(f) ? displayedValues(el) : null,
  };
}

// ------------------------------------------------------------------ low-level writers (no key events, ever)

function fire(el: Element, type: string): void {
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

function setText(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value); else el.value = value;
  fire(el, 'input');
  fire(el, 'change');
  try { el.blur(); } catch { /* ignore */ }
}

function setSelect(el: HTMLSelectElement, index: number): void {
  try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
  const opt = el.options[index];
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (opt && setter) setter.call(el, opt.value);
  el.selectedIndex = index;
  fire(el, 'input');
  fire(el, 'change');
  try { el.blur(); } catch { /* ignore */ }
}

function isDangerous(el: Element): boolean {
  return !!el.closest('button, [type="submit"], a[href], [role="link"]');
}

/** Ticks or unticks one box the way a person does: its label, then the box, then the property. */
function setChecked(el: HTMLInputElement, want: boolean): boolean {
  if (el.checked === want) return true;
  const label = Array.from(el.labels ?? []).find((l) => !isDangerous(l) && !l.querySelector('a[href]'));
  if (label) label.click();
  if (el.checked !== want && !isDangerous(el)) el.click();
  if (el.checked !== want) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
    if (setter) setter.call(el, want); else el.checked = want;
    fire(el, 'input');
    fire(el, 'change');
  }
  return el.checked === want;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Does the input's accept attribute allow this file? */
export function accepts(accept: string, fileName: string, mime: string): boolean {
  const list = accept.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) return true;
  const ext = `.${fileName.split('.').pop()?.toLowerCase() ?? ''}`;
  return list.some((a) => a === ext || a === mime.toLowerCase() || (a.endsWith('/*') && mime.toLowerCase().startsWith(a.slice(0, -1))));
}

// ------------------------------------------------------------------ one fill

/**
 * Writes one fill. `lastWritten` is what jobleft wrote into this field in an earlier fill on this page: a field that
 * still holds exactly that may be updated (the profile changed); any other value is the person's and is kept.
 */
export async function writeFill(f: Found, fill: FillResponse['fills'][number], lastWritten: string | undefined): Promise<Outcome> {
  const el = first(f);
  if (!el.isConnected) return { status: 'failed', reason: 'The field is no longer on the page.' };
  if (!visibleSelf(f.mark)) return { status: 'failed', reason: 'The field is hidden now, so jobleft did not write into it.' };
  const current = repr(f);
  const empty = isEmpty(f);
  const ours = lastWritten !== undefined && lastWritten === current;
  const prev = snapshot(f);
  const done = (display: string): Outcome => ({ status: 'filled', display, written: { found: f, prev, after: repr(f), display } });

  // A single tick box: "true" ticks it, "false" leaves it unticked.
  if (el instanceof HTMLInputElement && el.type === 'checkbox' && f.els.length === 1) {
    const want = fill.values[0] === 'true';
    if (el.checked === want) return { status: 'unchanged', display: want ? 'checked' : 'not checked' };
    if (!empty && !ours) return { status: 'kept', display: 'checked' };
    if (!want && !ours) return { status: 'unchanged', display: 'not checked' };
    return setChecked(el, want) ? done(want ? 'checked' : 'not checked') : { status: 'failed', reason: 'The page did not take the tick.' };
  }

  if (!empty && !ours) return { status: 'kept', display: shownValue(f) };

  if (isComboField(f)) {
    const kind = (fill.topic ?? 'exact') as MatchKind;
    const r = await fillCombobox(el as HTMLElement, kind, fill.values[0] ?? '');
    if (r.status === 'filled') return done(r.chosen ?? shownValue(f));
    if (r.status === 'no_option') return { status: 'failed', reason: 'No option in this list means exactly your profile value, so jobleft left it empty.' };
    if (r.status === 'did_not_open') return { status: 'failed', reason: 'This list did not open for jobleft. Choose the answer yourself.' };
    return { status: 'failed', reason: 'The list did not keep the choice. Choose the answer yourself.' };
  }
  if (el instanceof HTMLSelectElement) {
    const idx = Number(fill.values[0]);
    if (!Number.isInteger(idx) || !el.options[idx]) return { status: 'failed', reason: 'The option is no longer in the list.' };
    setSelect(el, idx);
    return done((el.options[idx]?.text ?? '').trim());
  }
  if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox')) {
    const picks = fill.values.map(Number).filter((i) => Number.isInteger(i) && f.els[i]);
    if (picks.length === 0) return { status: 'failed', reason: 'The option is no longer on the page.' };
    let ok = true;
    for (const i of picks) ok = setChecked(f.els[i] as HTMLInputElement, true) && ok;
    if (!ok) return { status: 'failed', reason: 'The page did not take the choice.' };
    return done(picks.map((i) => f.field.options[i]?.label ?? '').join(', '));
  }
  if (isText(el)) {
    let v = fill.values[0] ?? '';
    if (el.maxLength > 0 && v.length > el.maxLength) return { status: 'failed', reason: `The value is longer than this box allows (${el.maxLength} characters).` };
    setText(el, v);
    v = el.value;
    return done(v);
  }
  return { status: 'failed', reason: 'jobleft cannot write into this kind of field.' };
}

/** Attaches the resume file. The page must accept its type; the report says so when it does not. */
export async function attachFile(f: Found, file: FillResponse['files'][number]): Promise<Outcome> {
  const el = first(f);
  if (!(el instanceof HTMLInputElement) || el.type !== 'file') return { status: 'failed', reason: 'This is not a file field.' };
  if (!visibleSelf(f.mark)) return { status: 'failed', reason: 'The upload box is hidden now, so jobleft did not attach the file.' };
  if ((el.files?.length ?? 0) > 0) return { status: 'kept', display: Array.from(el.files ?? []).map((x) => x.name).join(', ') };
  const accept = el.getAttribute('accept') ?? '';
  if (!accepts(accept, file.fileName, file.mimeType)) {
    return { status: 'failed', reason: `Upload failed: this box accepts only ${accept}, and your resume is ${file.fileName}.` };
  }
  const prev = snapshot(f);
  try {
    const dt = new DataTransfer();
    dt.items.add(new File([base64ToBytes(file.base64) as BlobPart], file.fileName, { type: file.mimeType }));
    el.files = dt.files;
    fire(el, 'input');
    fire(el, 'change');
  } catch {
    return { status: 'failed', reason: 'Upload failed: the page did not accept the file.' };
  }
  await new Promise((r) => setTimeout(r, 400));
  const kept = Array.from(el.files ?? []).some((x) => x.name === file.fileName);
  const wrapper = f.mark.closest('div, fieldset, section, li') ?? f.mark;
  const named = (wrapper.textContent ?? '').includes(file.fileName);
  const errorShown = !!Array.from(wrapper.querySelectorAll('[role="alert"], .error, [class*="error" i], [aria-live]'))
    .find((n) => /invalid|not (allowed|supported|accepted)|too (large|big)|failed|error|unsupported/i.test(n.textContent ?? '') && visibleSelf(n));
  if (errorShown) return { status: 'failed', reason: 'Upload failed: the page showed an error for the file.' };
  if (!kept && !named) return { status: 'failed', reason: 'Upload failed: the page did not keep the file.' };
  return { status: 'filled', display: file.fileName, written: { found: f, prev, after: repr(f), display: file.fileName } };
}

/** Writes a draft the person accepted, into that one field only. */
export function writeDraft(f: Found, textValue: string): Outcome {
  const el = first(f);
  if (!isText(el)) return { status: 'failed', reason: 'This field does not take text.' };
  if (!visibleSelf(f.mark)) return { status: 'failed', reason: 'The field is hidden now.' };
  const prev = snapshot(f);
  setText(el, textValue);
  return { status: 'filled', display: textValue, written: { found: f, prev, after: repr(f), display: textValue } };
}

/** Does the page still hold what jobleft wrote? */
export function stillHolds(w: Written): boolean {
  return w.found.els[0]?.isConnected === true && repr(w.found) === w.after;
}

/** Puts one field back as it was before the fill, unless the person changed it since. */
export async function undoOne(w: Written): Promise<'restored' | 'kept_edit' | 'failed'> {
  const f = w.found;
  const el = first(f);
  if (!el.isConnected) return 'failed';
  if (repr(f) !== w.after) return 'kept_edit';
  const p = w.prev;
  try {
    if (isComboField(f)) {
      if ((p.shown?.length ?? 0) > 0) return 'failed';
      return (await clearCombobox(el as HTMLElement)) ? 'restored' : 'failed';
    }
    if (el instanceof HTMLSelectElement && p.selectedIndex !== null) { setSelect(el, p.selectedIndex); return 'restored'; }
    if (el instanceof HTMLInputElement && el.type === 'file') {
      el.files = p.files && p.files.length > 0 ? p.files : new DataTransfer().files;
      fire(el, 'input');
      fire(el, 'change');
      return (el.files?.length ?? 0) === (p.files?.length ?? 0) ? 'restored' : 'failed';
    }
    if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox') && p.checked) {
      f.els.forEach((e, i) => {
        const input = e as HTMLInputElement;
        const want = p.checked?.[i] ?? false;
        if (input.checked === want) return;
        if (input.type === 'checkbox') setChecked(input, want);
        else if (want) setChecked(input, true);
        else {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
          if (setter) setter.call(input, false); else input.checked = false;
          fire(input, 'input');
          fire(input, 'change');
        }
      });
      return f.els.every((e, i) => (e as HTMLInputElement).checked === (p.checked?.[i] ?? false)) ? 'restored' : 'failed';
    }
    if (isText(el) && p.value !== null) { setText(el, p.value); return el.value === p.value ? 'restored' : 'failed'; }
  } catch {
    return 'failed';
  }
  return 'failed';
}

// ------------------------------------------------------------------ marks on the page

const marked = new Map<HTMLElement, { outline: string; offset: string }>();

export function mark(el: HTMLElement, kind: 'filled' | 'needs'): void {
  if (!marked.has(el)) marked.set(el, { outline: el.style.outline, offset: el.style.outlineOffset });
  el.style.outline = kind === 'filled' ? MARK_FILLED : MARK_NEEDS;
  el.style.outlineOffset = '2px';
}

export function unmark(el: HTMLElement): void {
  const was = marked.get(el);
  if (!was) return;
  el.style.outline = was.outline;
  el.style.outlineOffset = was.offset;
  if (!el.getAttribute('style')) el.removeAttribute('style');
  marked.delete(el);
}

export function unmarkAll(): void {
  for (const el of [...marked.keys()]) unmark(el);
}
