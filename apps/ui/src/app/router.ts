// Hash routing: "#/jobs", "#/jobs/liked", "#/jobs/<jobId>", "#/resume/<id>", "#/settings/ai" ...
// The screens and their hashes are listed in src/index.ts (SCREENS).

import { useSyncExternalStore } from 'react';
import { confirmDiscard, dirtyLabels } from './layers.ts';

function current(): string {
  const h = window.location.hash.replace(/^#\/?/, '');
  return h.split('?')[0] ?? '';
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

/** The route as path segments, each URI-decoded. */
export function useRoute(): string[] {
  const path = useSyncExternalStore(subscribe, current);
  return path.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
}

export function href(...segments: string[]): string {
  return `#/${segments.map((s) => encodeURIComponent(s)).join('/')}`;
}

export function navigate(to: string, opts: { replace?: boolean; force?: boolean } = {}): void {
  const target = to.startsWith('#') ? to : `#/${to.replace(/^\/+/, '')}`;
  if (!opts.force && dirtyLabels().length) {
    void confirmDiscard().then((ok) => { if (ok) navigate(to, { ...opts, force: true }); });
    return;
  }
  if (opts.replace) {
    window.history.replaceState(null, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else window.location.hash = target;
}

export function queryParam(name: string): string | null {
  const q = window.location.hash.split('?')[1];
  return q ? new URLSearchParams(q).get(name) : null;
}
