// A tiny Chrome DevTools Protocol driver for the UI lane's own checks (screenshots, accessibility and text audits).
// It starts the installed Chrome headless with a throw-away profile under /private/tmp and background services off.
// No extra package: Node 24 has WebSocket built in.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export interface Browser {
  page(): Promise<Page>;
  close(): Promise<void>;
}

export interface Page {
  goto(url: string): Promise<void>;
  eval<T>(expr: string): Promise<T>;
  waitFor(expr: string, timeoutMs?: number): Promise<boolean>;
  size(w: number, h: number): Promise<void>;
  /** Sets the window in css pixels with a device scale factor (1.5 is 150% zoom). */
  sizeScaled(w: number, h: number, dpr: number): Promise<void>;
  shot(path: string): Promise<void>;
  key(key: string, code?: string, keyCode?: number, modifiers?: number): Promise<void>;
  click(selector: string): Promise<boolean>;
  type(text: string): Promise<void>;
  /** Every request the page made since the last clear (url, method, post data). */
  requests(): Array<{ url: string; method: string; body: string | null }>;
  clearRequests(): void;
  /** console.error and uncaught exception texts since the page opened. */
  errors(): string[];
  hover(selector: string): Promise<boolean>;
  /** Presses a named key (Tab, Escape, Enter, ArrowDown, ArrowUp, Space) with the right key codes. */
  press(name: string, shift?: boolean): Promise<void>;
  /** Clicks the first visible element (button, link, tab, menu item) whose text or aria-label equals `text`. */
  clickText(text: string, scope?: string): Promise<boolean>;
  /** Real mouse click on the first visible element matching `selector` whose text (or aria-label) matches the regular expression `re`; `only` limits it to one selector. */
  clickMatching(selector: string, re: string, only?: string): Promise<boolean>;
  /** Opens the Ant Design select whose search input has this aria-label (a real mouse press on it). */
  openSelect(ariaLabel: string): Promise<boolean>;
  /** Pretends the network is off for this page (the local API on 127.0.0.1 is unreachable too). */
  emulateOffline(offline: boolean): Promise<void>;
}

export async function launch(): Promise<Browser> {
  const profile = mkdtempSync('/private/tmp/jlui-chrome-');
  const proc: ChildProcess = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication', '--no-pings', '--hide-scrollbars=false',
    '--force-device-scale-factor=1', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('Chrome did not start')), 15000);
    proc.stderr!.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) { clearTimeout(t); resolve(m[1]!); }
    });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  const listeners: Array<(m: { method: string; params: unknown; sessionId?: string }) => void> = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown; sessionId?: string };
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p?.rej(new Error(m.error.message)); else p?.res(m.result);
    } else if (m.method) for (const l of listeners) l({ method: m.method, params: m.params, sessionId: m.sessionId });
  });
  const send = <T>(method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<T>((res, rej) => {
    const i = ++id;
    pending.set(i, { res: res as (v: unknown) => void, rej });
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return {
    async page() {
      const { targetId } = await send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      const s = <T>(m: string, p: Record<string, unknown> = {}) => send<T>(m, p, sessionId);
      await s('Page.enable');
      await s('Runtime.enable');
      await s('Network.enable');
      const reqs: Array<{ url: string; method: string; body: string | null }> = [];
      const errs: string[] = [];
      listeners.push((m) => {
        if (m.sessionId !== sessionId) return;
        const pr = m.params as { request?: { url: string; method: string; postData?: string }; exceptionDetails?: { text: string; exception?: { description?: string } }; type?: string; args?: Array<{ value?: unknown; description?: string }> };
        if (m.method === 'Network.requestWillBeSent' && pr.request) reqs.push({ url: pr.request.url, method: pr.request.method, body: pr.request.postData ?? null });
        if (m.method === 'Runtime.exceptionThrown' && pr.exceptionDetails) errs.push(pr.exceptionDetails.exception?.description ?? pr.exceptionDetails.text);
        if (m.method === 'Runtime.consoleAPICalled' && pr.type === 'error') errs.push((pr.args ?? []).map((a) => String(a.value ?? a.description ?? '')).join(' '));
      });
      const KEYS: Record<string, { key: string; code: string; vk: number }> = {
        Tab: { key: 'Tab', code: 'Tab', vk: 9 }, Escape: { key: 'Escape', code: 'Escape', vk: 27 }, Enter: { key: 'Enter', code: 'Enter', vk: 13 },
        ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 }, ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 }, Space: { key: ' ', code: 'Space', vk: 32 },
        End: { key: 'End', code: 'End', vk: 35 }, Home: { key: 'Home', code: 'Home', vk: 36 },
      };
      const page: Page = {
        requests: () => [...reqs],
        clearRequests: () => { reqs.length = 0; },
        errors: () => [...errs],
        async emulateOffline(offline) { await s('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); },
        async hover(selector) {
          const box = await page.eval<{ x: number; y: number } | null>(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
          if (!box) return false;
          await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
          return true;
        },
        async press(name, shift = false) {
          const k = KEYS[name] ?? { key: name, code: name, vk: name.toUpperCase().charCodeAt(0) };
          const mods = shift ? 8 : 0;
          await s('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers: mods });
          await s('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers: mods });
        },
        async clickText(text, scope = 'body') {
          const box = await page.eval<{ x: number; y: number } | null>(`(() => {
            const roots = [...document.querySelectorAll(${JSON.stringify(scope)})];
            if (!roots.length) roots.push(document.body);
            const want = ${JSON.stringify(text)};
            const cands = roots.flatMap((root) => [...root.querySelectorAll('button, a, [role=tab], [role=menuitem], [role=button], [role=radio], label, .ant-select-item, .ant-dropdown-menu-item, li[role=menuitem], .ant-segmented-item')]);
            for (const e of cands) {
              const r = e.getBoundingClientRect(); const st = getComputedStyle(e);
              if (r.width <= 0 || r.height <= 0 || st.visibility === 'hidden' || e.closest('[inert],[aria-hidden=true]')) continue;
              const t = ((e.getAttribute('aria-label') || '') + '|' + (e.textContent || '')).split('|').map((x) => x.trim().replace(/\\s+/g, ' ').toLowerCase());
              if (t.includes(want.toLowerCase())) { e.scrollIntoView({ block: 'center' }); const q = e.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; }
            }
            return null; })()`);
          if (!box) return false;
          for (const type of ['mousePressed', 'mouseReleased']) await s('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
          return true;
        },
        async clickMatching(selector, re, only) {
          const box = await page.eval<{ x: number; y: number } | null>(`(() => {
            const rx = new RegExp(${JSON.stringify(re)}, 'i');
            const list = ${only ? `[...document.querySelectorAll(${JSON.stringify(only)})]` : `[...document.querySelectorAll(${JSON.stringify(selector)})]`};
            for (const e of list) {
              const r = e.getBoundingClientRect(); const st = getComputedStyle(e);
              if (r.width <= 0 || r.height <= 0 || st.visibility === 'hidden' || e.closest('[inert],[aria-hidden=true]')) continue;
              const t = ((e.getAttribute('aria-label') || '') + ' ' + (e.textContent || '')).trim().replace(/\\s+/g, ' ');
              if (!(${only ? 'true' : 'rx.test((e.textContent || "").trim().replace(/\\s+/g, " ")) || rx.test(t)'})) continue;
              e.scrollIntoView({ block: 'center' }); const q = e.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 };
            }
            return null; })()`);
          if (!box) return false;
          for (const type of ['mousePressed', 'mouseReleased']) await s('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
          return true;
        },
        async openSelect(ariaLabel) {
          const box = await page.eval<{ x: number; y: number } | null>(`(() => { const i = [...document.querySelectorAll('input[aria-label]')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(ariaLabel)}); if (!i) return null; const sel = i.closest('.ant-select'); sel.scrollIntoView({ block: 'center' }); const r = sel.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
          if (!box) return false;
          for (const type of ['mousePressed', 'mouseReleased']) await s('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
          return true;
        },
        async goto(url) {
          const loaded = new Promise<void>((r) => { const l = (m: { method: string; sessionId?: string }) => { if (m.method === 'Page.loadEventFired' && m.sessionId === sessionId) { listeners.splice(listeners.indexOf(l), 1); r(); } }; listeners.push(l); });
          await s('Page.navigate', { url });
          await Promise.race([loaded, new Promise((r) => setTimeout(r, 10000))]);
        },
        async eval<T>(expr: string) {
          const r = await s<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
          return r.result.value;
        },
        async waitFor(expr, timeoutMs = 10000) {
          const end = Date.now() + timeoutMs;
          while (Date.now() < end) {
            try { if (await page.eval<boolean>(`!!(${expr})`)) return true; } catch { /* keep waiting */ }
            await new Promise((r) => setTimeout(r, 100));
          }
          return false;
        },
        async size(w, h) { await s('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); },
        async sizeScaled(w, h, dpr) { await s('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: false }); },
        async shot(path) {
          const r = await s<{ data: string }>('Page.captureScreenshot', { format: 'png' });
          writeFileSync(path, Buffer.from(r.data, 'base64'));
        },
        async key(key, code = key, keyCode = 0, modifiers = 0) {
          await s('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers });
          await s('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
        },
        async click(selector) {
          const box = await page.eval<{ x: number; y: number } | null>(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
          if (!box) return false;
          for (const type of ['mousePressed', 'mouseReleased']) await s('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
          return true;
        },
        async type(text) { await s('Input.insertText', { text }); },
      };
      return page;
    },
    async close() {
      try { ws.close(); } catch { /* gone */ }
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

/** Runs inside the page: returns problems a person would notice (names, contrast, sideways scroll, banned words). */
export const AUDIT = `(() => {
  const out = { noName: [], lowContrast: [], overflowX: false, offscreen: [], banned: [], text: '' };
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !e.closest('[aria-hidden="true"],[inert]'); };
  const name = (e) => (e.getAttribute('aria-label') || e.getAttribute('title') || (e.getAttribute('aria-labelledby') || '').split(' ').map((id) => document.getElementById(id)?.textContent || '').join(' ') || e.textContent || (e.querySelector('img[alt]')?.getAttribute('alt')) || (e.querySelector('[aria-label]')?.getAttribute('aria-label')) || (e.closest('label')?.textContent) || '').trim();
  for (const e of document.querySelectorAll('button, a[href], [role=button], input:not([type=hidden]), select, textarea, [role=tab], [role=switch], [role=checkbox]')) {
    if (!vis(e)) continue;
    let n = name(e);
    if (!n && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT')) {
      n = (e.id && document.querySelector('label[for="' + e.id + '"]')?.textContent) || e.closest('label')?.textContent || e.getAttribute('placeholder') || '';
      if (e.type === 'checkbox' || e.type === 'radio') n = n || e.closest('label')?.textContent || e.parentElement?.parentElement?.textContent || '';
    }
    if (!n.trim()) out.noName.push(e.outerHTML.slice(0, 160));
  }
  const lum = (c) => { const m = c.match(/[\\d.]+/g); if (!m) return null; const [r, g, b, a] = m.map(Number); return { l: [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0), a: a === undefined ? 1 : a, rgb: [r, g, b] }; };
  const bgOf = (e) => { let x = e; while (x) { const s = getComputedStyle(x); if (s.backgroundImage && s.backgroundImage !== 'none') return null; const c = lum(s.backgroundColor); if (c && c.a > 0.95) return c; x = x.parentElement; } return lum('rgb(255,255,255)'); };
  const blend = (fg, bg) => ({ l: lum('rgb(' + fg.rgb.map((v, i) => Math.round(v * fg.a + bg.rgb[i] * (1 - fg.a))).join(',') + ')').l });
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode; const e = t.parentElement; if (!e || !t.textContent.trim() || seen.has(e) || !vis(e)) continue; seen.add(e);
    if (e.closest('svg') || e.closest('.ant-btn:disabled, [disabled], .ant-checkbox-wrapper-disabled, .ant-select-disabled')) continue;
    const s = getComputedStyle(e); const fg = lum(s.color); const bg = bgOf(e); if (!fg || !bg) continue;
    const f = fg.a < 1 ? blend(fg, bg) : fg; const L1 = Math.max(f.l, bg.l), L2 = Math.min(f.l, bg.l); const ratio = (L1 + 0.05) / (L2 + 0.05);
    const size = parseFloat(s.fontSize); const bold = parseInt(s.fontWeight) >= 700; const large = size >= 24 || (bold && size >= 18.66);
    if (ratio < (large ? 3 : 4.5)) out.lowContrast.push({ text: t.textContent.trim().slice(0, 50), ratio: Math.round(ratio * 100) / 100, color: s.color, cls: e.className && String(e.className).slice(0, 60) });
  }
  out.overflowX = document.documentElement.scrollWidth > window.innerWidth + 1;
  for (const e of document.querySelectorAll('.ant-modal-close, .ant-drawer-close, [aria-label^="Close"]')) { if (!vis(e)) continue; const r = e.getBoundingClientRect(); if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) out.offscreen.push(e.getAttribute('aria-label') || e.className); }
  const text = document.body.innerText + ' ' + [...document.querySelectorAll('[title],[aria-label],[placeholder],img[alt]')].map((e) => [e.getAttribute('title'), e.getAttribute('aria-label'), e.getAttribute('placeholder'), e.getAttribute('alt')].filter(Boolean).join(' ')).join(' ') + ' ' + document.title;
  const words = ['jobright', 'orion', 'turbo', 'credit', 'applicants', 'early applicant', 'top applicant', 'not visible on', 'no h-1b', 'no h1b', 'does not sponsor', 'undefined', 'null', 'nan', '[object object]', 'lorem', 'coming soon', 'upgrade'];
  for (const w of words) { const re = new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + '([^a-z0-9]|$)', 'i'); if (re.test(text)) { const i = text.toLowerCase().indexOf(w); out.banned.push(w + ': …' + text.slice(Math.max(0, i - 40), i + 40).replace(/\\s+/g, ' ') + '…'); } }
  if (/\\$0(\\.00)?(?![.\\d])/.test(text)) out.banned.push('$0 found');
  out.text = text.length;
  return out;
})()`;
