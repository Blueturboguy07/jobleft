// Custom dropdowns (react-select style lists, Workday prompt lists, ARIA comboboxes).
// A custom dropdown ignores typed text and commits whatever it highlights, so jobleft drives it the way a person
// does: open it, read the options it shows, pick the one option that means the profile value (strict matcher),
// click it, and read back what the widget shows. It never presses a key (an Enter can submit a form), and it puts
// the widget back as it was when nothing commits.
// The approach follows ideas from freehire (extension/lib/combobox.ts, MIT) and the Workday option marker
// (data-automation-id="promptOption") noted by JobNavigator (MIT); the code is written new. See THIRD_PARTY_NOTICES.md.

import { pickOption, type MatchKind } from '../options.ts';
import { countryDisplayName } from '../places.ts';

/** Elements that are one choice in an open list, across the widget libraries seen on application forms. */
const CHOICE = '[role="option"], [data-automation-id="promptOption"], .oj-listbox-result, .oj-listbox-option';
/** Where react-select style widgets and Workday show the committed choice. */
const SHOWN = '[class*="singleValue"], [class*="single-value"], [class*="multiValue"], [class*="multi-value"], [data-automation-id="selectedItem"]';
const PROMPT = '[class*="placeholder"]';
const WIDGET = '[role="combobox"], [aria-autocomplete="list"], [aria-autocomplete="both"], [aria-haspopup="listbox"]';

function words(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function seen(el: Element): boolean {
  if (el.closest('[hidden]')) return false;
  const view = el.ownerDocument.defaultView;
  const cv = (el as Element & { checkVisibility?: () => boolean }).checkVisibility;
  if (typeof cv === 'function' && !cv.call(el)) return false;
  let node: Element | null = el;
  while (node && view) {
    const st = view.getComputedStyle(node);
    if (st.visibility === 'hidden' || st.visibility === 'collapse' || st.opacity === '0') return false;
    node = node.parentElement;
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Waits until `ok()` holds or the time runs out; returns the last answer. */
export async function waitUntil(ok: () => boolean, ms = 1200): Promise<boolean> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (ok()) return true;
    await sleep(30);
  }
  return ok();
}

/** A mouse click as the page sees it (pointer down, mouse down, up, click) on that element. Never a key. */
export function tap(el: Element): void {
  const view = el.ownerDocument.defaultView ?? window;
  const opts = { bubbles: true, cancelable: true, composed: true, button: 0 };
  if (typeof view.PointerEvent === 'function') el.dispatchEvent(new view.PointerEvent('pointerdown', opts));
  el.dispatchEvent(new view.MouseEvent('mousedown', opts));
  el.dispatchEvent(new view.MouseEvent('mouseup', opts));
  el.dispatchEvent(new view.MouseEvent('click', opts));
}

class Widget {
  readonly el: HTMLElement;
  constructor(el: HTMLElement) { this.el = el; }

  /** The text box inside the widget (the widget itself for an input). */
  get box(): HTMLInputElement | null {
    return this.el instanceof HTMLInputElement ? this.el : this.el.querySelector('input');
  }

  /** The list the widget names in aria-controls or aria-owns (on itself or on its combobox wrapper). */
  list(): Element | null {
    const refs: string[] = [];
    for (const holder of [this.el, this.el.closest('[aria-controls], [aria-owns]')]) {
      if (!holder) continue;
      refs.push(...`${holder.getAttribute('aria-controls') ?? ''} ${holder.getAttribute('aria-owns') ?? ''}`.split(/\s+/).filter(Boolean));
    }
    const found = refs.map((id) => this.el.ownerDocument.getElementById(id)).filter((x): x is HTMLElement => x !== null);
    return found.find((x) => x.getAttribute('role') === 'listbox' || x.querySelector(CHOICE) !== null) ?? found[0] ?? null;
  }

  /** Is the list showing? The widget's own aria-expanded wins; without it, the list's visibility decides. */
  open(): boolean {
    const holder = this.el.hasAttribute('aria-expanded') ? this.el : this.el.closest(`${WIDGET}[aria-expanded]`);
    const said = holder?.getAttribute('aria-expanded');
    if (said === 'true') return true;
    if (said === 'false') return false;
    const l = this.list();
    return l !== null && seen(l);
  }

  /** The choices shown now. A widget that names no list may use the one visible list on the page, never two. */
  choices(): Element[] {
    const l = this.list();
    if (l) return Array.from(l.querySelectorAll(CHOICE)).filter(seen);
    const lists = Array.from(this.el.ownerDocument.querySelectorAll('[role="listbox"], [data-automation-id="activeListContainer"]')).filter(seen);
    return lists.length === 1 ? Array.from((lists[0] as Element).querySelectorAll(CHOICE)).filter(seen) : [];
  }

  /** The nearest wrapper that holds only this widget (so a neighbour's value is never read). */
  private own(): Element | null {
    let node = this.el.parentElement;
    let last: Element | null = null;
    while (node && node.tagName !== 'FORM') {
      if (node.querySelectorAll(WIDGET).length > 1) break;
      last = node;
      if (node.querySelector(SHOWN) || node.querySelector(PROMPT)) return node;
      node = node.parentElement;
    }
    return last;
  }

  hasShownSlot(): boolean {
    const o = this.own();
    return !!o && !!o.querySelector(SHOWN);
  }

  /** What the widget shows as chosen (one entry per chip); empty when it shows a prompt or nothing. */
  shown(): string[] {
    if (this.el.tagName === 'BUTTON') {
      const t = words(this.el);
      return t && !/^(select one|select|choose|--)/i.test(t) ? [t] : [];
    }
    const o = this.own();
    const slots = o ? Array.from(o.querySelectorAll(SHOWN)).map(words).filter(Boolean) : [];
    if (slots.length) return slots;
    if (this.hasShownSlot()) return [];
    const v = this.box?.value?.trim() ?? '';
    return v ? [v] : [];
  }

  type(text: string): void {
    const b = this.box;
    if (!b) return;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (set) set.call(b, text); else b.value = text;
    b.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/** What to type into a searchable list so it shows the wanted option (the city, the country's name, the text). */
export function searchWord(kind: MatchKind, wanted: string): string | null {
  if (kind === 'country') return wanted.length === 2 ? (countryDisplayName(wanted) ?? wanted) : wanted;
  if (kind === 'location') return wanted.split('|')[0] ?? null;
  if (kind === 'exact' || kind === 'degree') return wanted;
  return null;
}

export type ComboStatus = 'filled' | 'no_option' | 'did_not_open' | 'did_not_commit';

/** Opens the widget, picks the one option that means `wanted`, and checks that the widget shows it. */
export async function fillCombobox(el: HTMLElement, kind: MatchKind, wanted: string): Promise<{ status: ComboStatus; chosen: string | null }> {
  const w = new Widget(el);
  const box = w.box;
  const before = box?.value ?? '';
  const putBack = (): void => {
    if (box && box.value !== before) w.type(before);
    if (w.open()) tap(el);
    box?.blur();
  };
  const choose = (list: Element[]): number | null => pickOption(kind, wanted, list.map((n) => ({ value: '', label: words(n) })))?.index ?? null;

  try { (box ?? el).focus({ preventScroll: true }); } catch { /* ignore */ }
  if (!w.open()) {
    tap(el);
    await waitUntil(() => w.open() || w.choices().length > 0, 800);
  }
  let list = w.choices();
  let pick = choose(list);
  const word = searchWord(kind, wanted);
  let typed: string | null = null;
  if (pick === null && box && word && !box.readOnly) {
    typed = word;
    w.type(word);
    await waitUntil(() => { list = w.choices(); pick = choose(list); return pick !== null; }, 2500);
    list = w.choices();
    pick = choose(list);
  }
  if (pick === null) {
    const opened = list.length > 0 || w.open();
    putBack();
    return { status: opened ? 'no_option' : 'did_not_open', chosen: null };
  }
  const target = list[pick] as Element;
  const label = words(target);
  tap(target);
  const took = (): boolean => {
    if (el.tagName === 'BUTTON' || w.hasShownSlot()) return w.shown().some((s) => label.toLowerCase().includes(s.toLowerCase()));
    // A plain search box must now hold the option's text, not only the word jobleft typed.
    const v = (box?.value ?? '').trim().toLowerCase();
    return v !== '' && v !== (typed ?? '').toLowerCase() && label.toLowerCase().includes(v);
  };
  await waitUntil(() => took() && !w.open());
  if (!took()) { putBack(); return { status: 'did_not_commit', chosen: null }; }
  try { box?.blur(); } catch { /* ignore */ }
  return { status: 'filled', chosen: label };
}

/** What the widget shows as chosen (for the report and for undo). */
export function displayedValues(el: Element): string[] {
  return new Widget(el as HTMLElement).shown();
}

/** Clears the widget through its own clear control, when it has one. */
export async function clearCombobox(el: HTMLElement): Promise<boolean> {
  const w = new Widget(el);
  let node: Element | null = el.parentElement;
  for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
    if (node.querySelectorAll(WIDGET).length > 1) break;
    const clear = node.querySelector('[aria-label^="clear" i], [aria-label^="remove" i], [class*="clear-indicator" i], [class*="clearIndicator"]');
    if (clear) {
      tap(clear);
      await waitUntil(() => w.shown().length === 0, 600);
      return w.shown().length === 0;
    }
  }
  return w.shown().length === 0;
}
