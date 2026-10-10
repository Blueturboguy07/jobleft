// The interface size (Settings > Appearance, AppSettings.display.zoom). The desktop shell zooms its window, so text,
// controls and spacing grow together and popups stay where they belong. In a browser the browser's own zoom does
// this, so nothing here runs there.

/** The sizes offered, smallest first. 1 is the normal size. */
export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;

/** The step nearest to `z`, so a size saved by hand or by another version still lands on a step. */
export function nearestStep(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return ZOOM_STEPS.reduce((best, s) => (Math.abs(s - z) < Math.abs(best - z) ? s : best), 1);
}

/** The next size up (`dir` 1) or down (`dir` -1) from `z`, or `z`'s own step at either end. */
export function stepZoom(z: number, dir: 1 | -1): number {
  const i = ZOOM_STEPS.indexOf(nearestStep(z) as (typeof ZOOM_STEPS)[number]);
  return ZOOM_STEPS[Math.min(Math.max(i + dir, 0), ZOOM_STEPS.length - 1)]!;
}

/** "110%" */
export function zoomText(z: number): string {
  return `${Math.round(z * 100)}%`;
}

/**
 * What a key press asks for: 1 bigger, -1 smaller, 0 back to normal, null not a size key. Ctrl with +, = (+ without
 * Shift), - or 0, or Cmd on a Mac; the numeric keypad's + and - too.
 */
export function zoomKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, mac: boolean): 1 | -1 | 0 | null {
  if (e.altKey || !(mac ? e.metaKey : e.ctrlKey)) return null;
  if (e.key === '+' || e.key === '=') return 1;
  if (e.key === '-' || e.key === '_') return -1;
  if (e.key === '0') return 0;
  return null;
}

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

/** true inside the desktop shell (its window can be zoomed); false in a browser. */
export function canZoomWindow(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
}

/** Zooms the shell's window to `z`. Does nothing in a browser. */
export function applyZoom(z: number): void {
  const t = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  if (!t) return;
  t.invoke('plugin:webview|set_webview_zoom', { value: nearestStep(z) }).catch(() => undefined);
}
