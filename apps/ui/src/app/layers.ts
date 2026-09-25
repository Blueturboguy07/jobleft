// Esc closes only the top-most layer (drawer, popover, detail, chat panel) and puts focus back where the person was.
// Ant Design overlays (modals, drawers, popovers, menus) handle their own Esc; while one is open, our layers wait.
// Editors with unsaved text register as "dirty": closing their layer asks before throwing the text away.

import { useEffect, useRef } from 'react';
import type { App } from 'antd';

type AppApi = ReturnType<typeof App.useApp>;
type MessageInstance = AppApi['message'];
type ModalHookAPI = AppApi['modal'];

interface Layer { id: number; close: () => void }
const stack: Layer[] = [];
let seq = 0;

function antOverlayOpen(): boolean {
  return !!document.querySelector(
    '.ant-modal-wrap:not([style*="display: none"]) .ant-modal, .ant-drawer-open, .ant-popover:not(.ant-popover-hidden), .ant-dropdown:not(.ant-dropdown-hidden), .ant-select-dropdown:not(.ant-select-dropdown-hidden), .ant-picker-dropdown:not(.ant-picker-dropdown-hidden)',
  );
}

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (antOverlayOpen()) return;
  const top = stack.at(-1);
  if (!top) return;
  e.preventDefault();
  top.close();
});

/** Registers a layer while `active`. The latest `close` is always used. */
export function useLayer(active: boolean, close: () => void): void {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    if (!active) return;
    const id = ++seq;
    stack.push({ id, close: () => ref.current() });
    return () => { const i = stack.findIndex((l) => l.id === id); if (i >= 0) stack.splice(i, 1); };
  }, [active]);
}

// ---------------------------------------------------------------- dirty editors

const dirty = new Map<string, string>();

export function useDirty(id: string, isDirty: boolean, label: string): void {
  useEffect(() => {
    if (isDirty) dirty.set(id, label); else dirty.delete(id);
    return () => { dirty.delete(id); };
  }, [id, isDirty, label]);
}

export function dirtyLabels(): string[] {
  return [...dirty.values()];
}

export function clearDirty(): void {
  dirty.clear();
}

// Links to other screens and window reloads ask first while an editor has unsaved changes.
document.addEventListener('click', (e) => {
  const a = (e.target as Element | null)?.closest?.('a[href^="#/"]');
  if (!a || !dirty.size || e.defaultPrevented) return;
  e.preventDefault();
  const to = a.getAttribute('href')!;
  void confirmDiscard().then((ok) => { if (ok) window.location.hash = to; });
}, true);
window.addEventListener('beforeunload', (e) => {
  if (!dirty.size) return;
  e.preventDefault();
  e.returnValue = '';
});

// ---------------------------------------------------------------- themed toasts and dialogs

export const ui: { message: MessageInstance | null; modal: ModalHookAPI | null } = { message: null, modal: null };

/** Asks before unsaved text is thrown away. Resolves true when it is fine to close. */
export async function confirmDiscard(labels = dirtyLabels()): Promise<boolean> {
  if (!labels.length) return true;
  const ok = !ui.modal ? window.confirm(`Discard unsaved changes to ${labels.join(', ')}?`) : await ui.modal.confirm({
    title: 'Discard unsaved changes?',
    content: `You have unsaved changes to ${labels.join(', ')}. They will be lost.`,
    okText: 'Discard changes',
    okButtonProps: { danger: true, shape: 'round' },
    cancelText: 'Keep editing',
    cancelButtonProps: { shape: 'round' },
    autoFocusButton: 'cancel',
  }) === true;
  if (ok) dirty.clear();
  return ok;
}

/** Keeps focus where it was before a layer opened, and puts it back after. */
export function useReturnFocus(active: boolean): void {
  const prev = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (active) prev.current = document.activeElement as HTMLElement | null;
    else if (prev.current && document.contains(prev.current)) { prev.current.focus({ preventScroll: true }); prev.current = null; }
  }, [active]);
}
