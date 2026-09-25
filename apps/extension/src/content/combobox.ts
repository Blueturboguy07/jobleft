// Custom dropdowns (react-select, Workday prompt lists, ARIA comboboxes): open, read what they offer, pick one with
// the strict matcher, confirm what the widget committed. Writing text into such a widget commits whatever it
// highlights, so it is never typed into and left; and no key is ever pressed (an Enter can submit a form).
//
// Ported from freehire (https://github.com/strelov1/freehire), extension/lib/combobox.ts and extension/lib/form.ts,
// commit e58b1af64414b2dca7d1566d5d0db17f44a82ac2, MIT licence, Copyright (c) 2026 freehire contributors:
// comboListbox, comboOptionNodes, isOnScreen, isOpen/expandedState, displayedValues, press and settle.
// Workday's option selector (div[data-automation-id="promptOption"]) comes from JobNavigator
// (https://github.com/vesaias/JobNavigator, extension/lib/ats_combobox.js, commit 972e796, MIT).
// Changes: option choice goes through jobleft's strict pickOption (never "contains"), typing is limited to a search
// word for typeahead lists, and a widget that did not commit is put back as it was.

import { pickOption, type MatchKind } from '../options.ts';
import { countryDisplayName } from '../places.ts';

const OPTION_NODES = '[role="option"], [data-automation-id="promptOption"], .oj-listbox-result, .oj-listbox-option';
const VALUE_NODE = '[class*="singleValue"], [class*="single-value"], [class*="multiValue"], [class*="multi-value"], [data-automation-id="selectedItem"]';
const PLACEHOLDER_NODE = '[class*="placeholder"]';
const COMBO = '[role="combobox"], [aria-autocomplete="list"], [aria-autocomplete="both"], [aria-haspopup="listbox"]';

const SETTLE_MS = 1200;
const POLL_MS = 30;

function text(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function isOnScreen(el: Element): boolean {
  if (el.closest('[hidden]')) return false;
  const cv = (el as Element & { checkVisibility?: () => boolean }).checkVisibility;
  if (typeof cv === 'function' && !cv.call(el)) return false;
  const view = el.ownerDocument.defaultView;
  if (!view) return true;
  for (let node: Element | null = el; node; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (style.opacity === '0') return false;
  }
  return true;
}

export function comboListbox(el: Element): Element | null {
  const ids = (el.getAttribute('aria-controls') || el.getAttribute('aria-owns') || '').split(/\s+/).filter(Boolean);
  const owner = el.closest('[aria-controls], [aria-owns]');
  if (owner && owner !== el) ids.push(...(owner.getAttribute('aria-controls') || owner.getAttribute('aria-owns') || '').split(/\s+/).filter(Boolean));
  const named = ids.map((id) => el.ownerDocument.getElementById(id)).filter((n): n is HTMLElement => !!n);
  const listbox = named.find((n) => n.getAttribute('role') === 'listbox' || n.querySelector(OPTION_NODES));
  return listbox ?? named[0] ?? null;
}

function expandedState(widget: Element): string | null {
  if (widget.hasAttribute('aria-expanded')) return widget.getAttribute('aria-expanded');
  const owner = widget.closest('[role="combobox"][aria-expanded], [aria-haspopup="listbox"][aria-expanded], [aria-autocomplete][aria-expanded]');
  return owner?.getAttribute('aria-expanded') ?? null;
}

export function isOpen(widget: Element): boolean {
  const expanded = expandedState(widget);
  if (expanded !== null) return expanded === 'true';
  const lb = comboListbox(widget);
  return lb !== null && isOnScreen(lb);
}

/** Options the widget offers now. Falls back to the one visible list on the page when the widget names none. */
export function optionNodes(widget: Element): Element[] {
  const lb = comboListbox(widget);
  if (lb) return Array.from(lb.querySelectorAll(OPTION_NODES)).filter(isOnScreen);
  const lists = Array.from(widget.ownerDocument.querySelectorAll('[role="listbox"], [data-automation-id="activeListContainer"]')).filter(isOnScreen);
  if (lists.length === 1) return Array.from((lists[0] as Element).querySelectorAll(OPTION_NODES)).filter(isOnScreen);
  return [];
}

/** What the widget shows as chosen now (one entry per chip). Stops at a neighbour so it never reads its value. */
export function displayedValues(widget: Element): string[] {
  if (widget.tagName === 'BUTTON') {
    const t = text(widget);
    return t && !/^(select one|select|choose|--)/i.test(t) ? [t] : [];
  }
  for (let el = widget.parentElement; el; el = el.parentElement) {
    if (el.querySelectorAll(COMBO).length > 1) return [];
    const shown = Array.from(el.querySelectorAll(VALUE_NODE));
    if (shown.length) return shown.map(text).filter(Boolean);
    if (el.querySelector(PLACEHOLDER_NODE)) return [];
    if (el.tagName === 'FORM') break;
  }
  const v = (widget as HTMLInputElement).value;
  return typeof v === 'string' && v.trim() ? [v.trim()] : [];
}

/** The pointer sequence of a real click, on the element itself. Never a key press. */
export function press(el: Element): void {
  const view = el.ownerDocument.defaultView ?? window;
  if (typeof view.PointerEvent === 'function') {
    el.dispatchEvent(new view.PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }));
  }
  for (const type of ['mousedown', 'mouseup', 'click']) {
    el.dispatchEvent(new view.MouseEvent(type, { bubbles: true, cancelable: true, composed: true, button: 0 }));
  }
}

export async function settle(holds: () => boolean, ms = SETTLE_MS): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += POLL_MS) {
    if (holds()) return true;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return holds();
}

function searchInput(widget: Element): HTMLInputElement | null {
  if (widget instanceof HTMLInputElement) return widget;
  return widget.querySelector('input');
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, value); else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The word to type into a typeahead so it lists the wanted option (the city, the country name, the text). */
export function searchWord(kind: MatchKind, wanted: string): string | null {
  switch (kind) {
    case 'country': return wanted.length === 2 ? (countryDisplayName(wanted) ?? wanted) : wanted;
    case 'location': return wanted.split('|')[0] ?? null;
    case 'region': return null;
    case 'exact': case 'degree': return wanted;
    default: return null;
  }
}

export type ComboStatus = 'filled' | 'no_option' | 'did_not_open' | 'did_not_commit';

/** Opens the widget, picks the one option that means `wanted`, and confirms the widget shows it. */
export async function fillCombobox(widget: HTMLElement, kind: MatchKind, wanted: string): Promise<{ status: ComboStatus; chosen: string | null }> {
  const input = searchInput(widget);
  const before = input?.value ?? '';
  const restore = (): void => {
    if (input && input.value !== before) setInput(input, before);
    if (isOpen(widget)) press(widget);
    input?.blur();
  };
  const pickFrom = (nodes: Element[]): number | null => {
    const p = pickOption(kind, wanted, nodes.map((n) => ({ value: '', label: text(n) })));
    return p ? p.index : null;
  };
  try { (input ?? widget).focus({ preventScroll: true }); } catch { /* ignore */ }
  if (!isOpen(widget)) {
    press(widget);
    await settle(() => isOpen(widget) || optionNodes(widget).length > 0, 800);
  }
  let nodes = optionNodes(widget);
  let chosenIndex = pickFrom(nodes);
  const word = searchWord(kind, wanted);
  let typed: string | null = null;
  if (chosenIndex === null && input && word && !input.readOnly) {
    setInput(input, word);
    typed = word;
    await settle(() => { nodes = optionNodes(widget); chosenIndex = pickFrom(nodes); return chosenIndex !== null; }, 2500);
    nodes = optionNodes(widget);
    chosenIndex = pickFrom(nodes);
  }
  if (chosenIndex === null) {
    const opened = nodes.length > 0 || isOpen(widget);
    restore();
    return { status: opened ? 'no_option' : 'did_not_open', chosen: null };
  }
  const node = nodes[chosenIndex] as Element;
  const label = text(node);
  press(node);
  const committed = (): boolean => {
    if (hasValueNode(widget)) return displayedValues(widget).some((s) => label.toLowerCase().includes(s.toLowerCase()));
    if (widget.tagName === 'BUTTON') return displayedValues(widget).some((s) => label.toLowerCase().includes(s.toLowerCase()));
    // A plain typeahead input: it must now hold the option text, not only the word jobleft typed.
    const v = (input?.value ?? '').trim().toLowerCase();
    return v !== '' && v !== (typed ?? '').toLowerCase() && label.toLowerCase().includes(v);
  };
  await settle(() => committed() && !isOpen(widget));
  if (!committed()) { restore(); return { status: 'did_not_commit', chosen: null }; }
  try { input?.blur(); } catch { /* ignore */ }
  return { status: 'filled', chosen: label };
}

function hasValueNode(widget: Element): boolean {
  for (let el = widget.parentElement; el; el = el.parentElement) {
    if (el.querySelectorAll(COMBO).length > 1) return false;
    if (el.querySelector(VALUE_NODE)) return true;
    if (el.tagName === 'FORM') break;
  }
  return false;
}

/** Clears a widget's choice through its own clear control, when it has one. */
export async function clearCombobox(widget: HTMLElement): Promise<boolean> {
  let box: Element | null = widget.parentElement;
  for (let i = 0; i < 6 && box; i++, box = box.parentElement) {
    if (box.querySelectorAll(COMBO).length > 1) break;
    const clear = box.querySelector('[aria-label^="clear" i], [aria-label^="remove" i], [class*="clear-indicator" i], [class*="clearIndicator"], [class*="indicatorContainer"]:first-child[aria-hidden="true"]');
    if (clear) {
      press(clear);
      await settle(() => displayedValues(widget).length === 0, 600);
      return displayedValues(widget).length === 0;
    }
  }
  return displayedValues(widget).length === 0;
}
