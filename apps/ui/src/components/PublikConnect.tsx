// publik first, one press: "Connect publik" sits next to the disclosure, so pressing it is the consent. The press
// connects this computer, opens the publikhq.com claim page at once (sign in, link this computer), and makes publik the
// AI provider. Until the link lands, "Finish linking on publikhq.com" opens the claim page again, and the app reads the
// connection on its own (PublikLinkWatcher) so AI turns ready with no other click. Used by the feed card, Settings >
// AI provider and Settings > Balance.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from 'antd';
import type { PublikConnection } from '@jobleft/contracts';
import { call, openExternal, type UiError } from '../app/api.ts';
import { invalidate, setCached } from '../app/data.ts';
import { ui } from '../app/layers.ts';
import { navigate } from '../app/router.ts';
import { useAiSettings, usePublik } from '../app/session.ts';
import { secureStoreText } from '../lib/format.ts';
import { OTHER_PROVIDERS_ROUTE, PUBLIK_FIRST, linkUrl, publikStage } from '../lib/aiSetup.ts';
import { WATCH_EVERY_MS, WATCH_MS, watchingBalance } from '../lib/publikWatch.ts';
import { InlineError } from './States.tsx';
import { IconSparkle } from './Icons.tsx';

/** The two-sentence disclosure (version 1). Its words are what the person accepts; change them with the version. */
export const DISCLOSURE = [
  'jobleft can send its AI requests to the publik API: each request is priced per use and paid in dollars from your publik balance. Your balance starts at $0.00; linking a publik account gives $0.05 of free use, once.',
  "Your prompts go through publik's servers to the AI model's provider, publik does not train on them, and you can change to a local model or your own key at any time.",
];
export const DISCLOSURE_VERSION = 1;
/** publik's live price list (JL-settings-25): every price the app quotes can be checked there. */
export const PRICING_URL = 'https://publikhq.com/pricing';

// ---------------------------------------------------------------- the link watch (one for the whole app)

/** How long the app keeps reading the connection after the claim page opened (or a screen asked). */
export const LINK_WATCH_MS = 5 * 60_000;
let watchUntil = 0;
const listeners = new Set<() => void>();
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
const until = () => watchUntil;

/** Starts (or extends) reading the connection every 5 s until the computer is linked, for LINK_WATCH_MS. */
export function startLinkWatch(ms: number = LINK_WATCH_MS): void {
  watchUntil = Math.max(watchUntil, Date.now() + ms);
  for (const f of listeners) f();
}

/** Opens the publikhq.com claim page of this computer (from a click) and starts the link watch. */
export function openLinkPage(c: PublikConnection | undefined): boolean {
  const url = linkUrl(c);
  if (!url) return false;
  openExternal(url);
  startLinkWatch();
  return true;
}

/**
 * Mounted once in the app shell. While a connected computer is not linked yet and the watch runs, it reads the
 * connection every 5 s (the local service reads publik at most once per 5 s), and again when the window gets focus
 * back from the browser. When the link lands, it says so once.
 */
export function PublikLinkWatcher() {
  const ai = useAiSettings();
  const u = useSyncExternalStore(subscribe, until);
  const pub = usePublik(ai.data?.provider === 'publik' || u > Date.now());
  const c = pub.data;
  const waiting = c?.state === 'connected' && c.wallet?.claimState === 'anonymous';
  const reload = pub.reload;
  useEffect(() => {
    if (!watchingBalance(c, u)) return;
    const t = setInterval(() => {
      if (Date.now() >= u) { clearInterval(t); return; }
      if (document.visibilityState === 'visible') void reload();
    }, WATCH_EVERY_MS);
    return () => clearInterval(t);
  }, [waiting, u, reload]);
  useEffect(() => {
    if (!waiting) return;
    const f = () => { void reload(); };
    window.addEventListener('focus', f);
    return () => window.removeEventListener('focus', f);
  }, [waiting, reload]);
  // Opened (or reopened) while the computer still waits for its link: read it on its own for a while, as after the
  // press, so a restart in the middle of linking needs no click either.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !waiting) return;
    started.current = true;
    startLinkWatch(WATCH_MS);
  }, [waiting]);
  const was = useRef<boolean>(false);
  useEffect(() => {
    if (was.current && c?.state === 'connected' && c.wallet?.claimState === 'claimed') {
      ui.message?.success('This computer is linked to your publik account. AI runs on publik now.');
      invalidate('ai:');
    }
    was.current = !!waiting;
  }, [waiting, c?.state, c?.wallet?.claimState]);
  return null;
}

// ---------------------------------------------------------------- one press

export function useConnectPublik() {
  const ai = useAiSettings();
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [err, setErr] = useState<UiError | null>(null);
  const connect = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    let connected = false;
    try {
      const c = await call('connectPublik', { body: { disclosureAccepted: true, disclosureVersion: DISCLOSURE_VERSION } });
      setCached('ai:publik', () => c);
      connected = true;
      // The claim page opens first, so the browser is there while jobleft makes publik the provider.
      const opened = openLinkPage(c);
      // The switch is saved at once, but its answer waits for a live test of publik: until it answers the screens say
      // the switch is under way (JL-v1-2).
      if (ai.data?.provider !== 'publik') {
        setSwitching(true);
        const r = await call('putAiSettings', { body: { provider: 'publik' } });
        setCached('ai:settings', () => r.settings);
      }
      ui.message?.success(opened ? 'Connected. Finish on publikhq.com: sign in and link this computer.' : 'Connected. AI answers now come from publik.');
    } catch (e) { setErr(e as UiError); } finally { setBusy(false); setSwitching(false); if (connected) invalidate('ai:'); }
  };
  return { connect, busy, switching, err };
}

/** The disclosure, the one button, and where the key is kept. */
export function ConnectBody({ size = 'normal', showOther = false }: { size?: 'normal' | 'small'; showOther?: boolean }) {
  const { connect, busy, switching, err } = useConnectPublik();
  const small = size === 'small';
  return (
    <>
      {DISCLOSURE.map((d) => <p key={d} className={small ? 'jl-small' : undefined} style={{ margin: 0 }}>{d}</p>)}
      <p className="jl-small" style={{ margin: 0 }}><a href={PRICING_URL} target="_blank" rel="noopener noreferrer">See publik's prices per tier</a></p>
      <div className="jl-row jl-wrap" style={{ gap: 8, alignItems: 'center' }}>
        <Button className="jl-accent-btn" type="primary" shape="round" loading={busy} onClick={() => { void connect(); }}>{PUBLIK_FIRST.button}</Button>
        {showOther && <Button size="small" type="link" style={{ padding: 0 }} onClick={() => navigate(OTHER_PROVIDERS_ROUTE)}>{PUBLIK_FIRST.other}</Button>}
      </div>
      <p className="jl-small jl-muted" style={{ margin: 0 }}>Pressing {PUBLIK_FIRST.button} accepts the two lines above, connects this computer and opens publikhq.com, where you link it to your publik account. No key is typed: jobleft keeps the connection key in {secureStoreText()}.</p>
      {switching && <p className="jl-small jl-muted" role="status" style={{ margin: 0 }}>Making publik your AI provider. jobleft is testing the connection; this can take a few seconds.</p>}
      <InlineError error={err} />
    </>
  );
}

/** "Finish linking on publikhq.com": opens the claim page again; the app sees the link by itself. */
export function LinkBody({ c, size = 'normal' }: { c: PublikConnection | undefined; size?: 'normal' | 'small' }) {
  const u = useSyncExternalStore(subscribe, until);
  const checking = watchingBalance(c, u);
  return (
    <>
      <p className={size === 'small' ? 'jl-small' : undefined} style={{ margin: 0 }}>{PUBLIK_FIRST.linkBody}</p>
      <div className="jl-row jl-wrap" style={{ gap: 8, alignItems: 'center' }}>
        <Button className="jl-accent-btn" type="primary" shape="round" onClick={() => { openLinkPage(c); }}>{PUBLIK_FIRST.link}</Button>
        {checking && <span className="jl-small jl-muted" role="status">Waiting for the link…</span>}
      </div>
    </>
  );
}

/** "Could not load your publik balance · Try again". */
export function WalletErrorBody() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<UiError | null>(null);
  const retry = async () => {
    setBusy(true); setErr(null);
    try { const c = await call('refreshPublik'); setCached('ai:publik', () => c); } catch (e) { setErr(e as UiError); } finally { setBusy(false); }
  };
  return (
    <>
      <p style={{ margin: 0 }}>{PUBLIK_FIRST.walletError}. publik may be busy, or this computer may be offline. Nothing was charged.</p>
      <Button shape="round" style={{ alignSelf: 'flex-start' }} loading={busy} onClick={() => { void retry(); }}>{PUBLIK_FIRST.retry}</Button>
      <InlineError error={err} />
    </>
  );
}

/** Reads the balance again (the chip's "Try again"). */
export async function retryPublik(): Promise<void> {
  try { const c = await call('refreshPublik'); setCached('ai:publik', () => c); } catch (e) { ui.message?.error((e as UiError).message); }
}

/**
 * The publik-first card: "AI runs on publik API" with the one button before AI is set up, "Finish linking on
 * publikhq.com" while the link is missing. Nothing once AI can run, or when another provider is chosen.
 */
export function PublikSetupCard({ id, narrow = false, showOther = true }: { id: string; narrow?: boolean; showOther?: boolean }) {
  const ai = useAiSettings();
  const pub = usePublik(ai.data?.provider === 'publik');
  const st = publikStage(ai.data, pub.data, { publikError: !!pub.error });
  if (st !== 'connect' && st !== 'linking') return null;
  return (
    <section className={`jl-publik-first${narrow ? ' jl-narrow-only' : ''}`} aria-labelledby={id}>
      <h2 id={id}><span style={{ color: 'var(--jl-accent-ink)', display: 'inline-flex' }} aria-hidden="true"><IconSparkle size={16} /></span>{st === 'connect' ? PUBLIK_FIRST.title : PUBLIK_FIRST.link}</h2>
      {st === 'connect'
        ? <><p style={{ margin: 0, fontWeight: 600 }}>No key needed.</p><ConnectBody size="small" showOther={showOther} /></>
        : <LinkBody c={pub.data} size="small" />}
    </section>
  );
}
