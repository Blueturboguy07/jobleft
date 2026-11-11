// The publik module's GateUI on the app window. The shell opens the one window at "/" as soon as the server
// answers health; while the gate is pending, "/" serves this small page instead of the UI, and every API route except
// health, shutdown and the gate's own answers 503 not_ready. The page shows the module's current screen (Sign in with
// publik, Choose how to pay for AI, Connect your plan), sends a button press back, and reloads itself once the gate
// has passed: the UI then loads as before, with the launch token still in the URL fragment.
// Nothing here talks to publik: main.ts runs ensureSignedIn(gate) from src/publik.ts, and that module does.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { JSON_BODY_LIMIT } from '@jobleft/contracts';
import { ApiFailure } from '../errors.ts';
import { parseJsonBody, readBody } from './body.ts';
import { sendError, sendJson, setSecurityHeaders } from './respond.ts';
import { UI_CSP } from './static.ts';
import { terminalUI, type GateAction, type GateScreen, type GateUI } from '../publik.ts';

export const GATE_PATH = '/publik-gate';
export const GATE_SCRIPT_PATH = '/publik-gate.js';

const ACTIONS: ReadonlySet<string> = new Set<GateAction>(['sign_in', 'retry', 'get_plan', 'connect', 'own_key']);

export interface GateState {
  /** true until the person is signed in (and, when the app uses AI, has answered how it pays for it). */
  pending: boolean;
  screen: GateScreen | null;
  /** The last link the module asked the browser to open (the page shows it in case the browser did not open). */
  link: string | null;
}

export class PublikGate implements GateUI {
  pending = true;
  private screen: GateScreen | null = null;
  private link: string | null = null;
  private waiting: ((a: GateAction) => void) | null = null;

  /** The module's screen: shown until a button is pressed, or until the module stops asking (the signal aborts). */
  show(screen: GateScreen, signal: AbortSignal): Promise<GateAction> {
    this.screen = screen;
    return new Promise<GateAction>((resolve) => {
      const settle = (a: GateAction) => resolve(a);
      this.waiting = settle;
      signal.addEventListener('abort', () => { if (this.waiting === settle) this.waiting = null; }, { once: true });
    });
  }

  openUrl(url: string): void {
    this.link = url;
    terminalUI().openUrl(url);
  }

  /** A button on the page. false: nothing is waiting for a press (the screen changed, or the gate passed). */
  press(action: string): boolean {
    if (!ACTIONS.has(action) || !this.waiting) return false;
    if (!this.screen?.buttons.some((b) => b.action === action)) return false;
    const w = this.waiting;
    this.waiting = null;
    w(action as GateAction);
    return true;
  }

  /** The gate passed: "/" serves the UI again and the API answers. */
  finish(): void {
    this.pending = false;
    this.screen = null;
    this.link = null;
    this.waiting = null;
  }

  state(): GateState {
    return { pending: this.pending, screen: this.screen, link: this.link };
  }

  /** GET /publik-gate (the state), POST /publik-gate ({ action }). The caller has checked the launch token. */
  async handle(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
    if (method === 'GET') { sendJson(req, res, 200, this.state()); return; }
    if (method !== 'POST') { sendError(req, res, new ApiFailure('not_found', 'There is nothing here.')); return; }
    let body: unknown;
    try { body = parseJsonBody(await readBody(req, JSON_BODY_LIMIT)); } catch { sendError(req, res, new ApiFailure('bad_request', 'The request needs a JSON body.')); return; }
    const action = body && typeof body === 'object' ? (body as { action?: unknown }).action : undefined;
    if (typeof action !== 'string' || !ACTIONS.has(action)) { sendError(req, res, new ApiFailure('bad_request', 'action must be one of the screen\'s buttons.')); return; }
    const pressed = this.press(action);
    sendJson(req, res, 200, { pressed, ...this.state() });
  }

  /** The page at "/" while the gate is pending. */
  page(req: IncomingMessage, res: ServerResponse): void {
    sendText(req, res, 'text/html; charset=utf-8', GATE_HTML);
  }

  /** Its script (the UI's content security policy allows no inline script). */
  script(req: IncomingMessage, res: ServerResponse): void {
    sendText(req, res, 'text/javascript; charset=utf-8', GATE_JS);
  }
}

function sendText(req: IncomingMessage, res: ServerResponse, type: string, text: string): void {
  setSecurityHeaders(res, false);
  res.setHeader('content-security-policy', UI_CSP);
  res.setHeader('content-type', type);
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-length', Buffer.byteLength(text));
  res.statusCode = 200;
  if (req.method === 'HEAD') { res.end(); return; }
  res.end(text);
}

const GATE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in with publik</title>
<style>
  :root { color-scheme: light dark; --ink: #1a1a1a; --muted: #5a5a5a; --bg: #f6f5f2; --card: #ffffff; --line: #e2e0da; --accent: #1f6feb; }
  @media (prefers-color-scheme: dark) { :root { --ink: #ececec; --muted: #a8a8a8; --bg: #141414; --card: #1e1e1e; --line: #333; --accent: #4c8dff; } }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--ink); font: 15px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; }
  main { min-height: 100%; display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; }
  section { width: min(440px, 100%); background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px; box-sizing: border-box; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { margin: 0 0 10px; }
  #note { color: var(--muted); }
  #buttons { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
  button { font: inherit; padding: 9px 16px; border-radius: 999px; border: 1px solid var(--line); background: var(--card); color: var(--ink); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button[disabled] { opacity: .6; cursor: default; }
  #link { font-size: 13px; color: var(--muted); margin-top: 14px; word-break: break-all; }
  #link a { color: var(--accent); }
</style>
</head>
<body>
<main><section aria-live="polite">
  <h1 id="title">Sign in with publik</h1>
  <p id="body">jobleft is starting.</p>
  <p id="note" hidden></p>
  <div id="buttons"></div>
  <p id="link" hidden></p>
</section></main>
<script src="/publik-gate.js"></script>
</body>
</html>
`;

const GATE_JS = `(() => {
  const token = (new URLSearchParams(location.hash.slice(1)).get('token') || '').trim();
  const H = { 'x-jobleft-token': token, 'content-type': 'application/json' };
  const el = (id) => document.getElementById(id);
  let shown = '';
  let busy = false;
  function draw(state) {
    if (!state.pending) { location.reload(); return; }
    const s = state.screen;
    const key = JSON.stringify([s, state.link]);
    if (key === shown) return;
    shown = key;
    if (!s) { el('title').textContent = 'Sign in with publik'; el('body').textContent = 'jobleft is starting.'; el('buttons').replaceChildren(); return; }
    el('title').textContent = s.title;
    document.title = s.title;
    el('body').textContent = s.body;
    el('note').hidden = !s.note;
    el('note').textContent = s.note || '';
    const buttons = s.buttons.map((b, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.label;
      if (i === 0) btn.className = 'primary';
      btn.addEventListener('click', () => press(b.action));
      return btn;
    });
    el('buttons').replaceChildren(...buttons);
    const link = el('link');
    link.hidden = !state.link;
    if (state.link) {
      link.replaceChildren();
      link.append('If your browser did not open: ');
      const a = document.createElement('a');
      a.href = state.link; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = state.link;
      link.append(a);
    }
  }
  async function read() {
    try {
      const r = await fetch('/publik-gate', { headers: { 'x-jobleft-token': token } });
      if (r.status === 401) { el('body').textContent = 'Open jobleft from the app, not from this address.'; return; }
      if (r.ok) draw(await r.json());
    } catch {}
  }
  async function press(action) {
    if (busy) return;
    busy = true;
    for (const b of el('buttons').querySelectorAll('button')) b.disabled = true;
    try {
      const r = await fetch('/publik-gate', { method: 'POST', headers: H, body: JSON.stringify({ action }) });
      if (r.ok) { shown = ''; draw(await r.json()); }
    } catch {} finally {
      busy = false;
      for (const b of el('buttons').querySelectorAll('button')) b.disabled = false;
    }
  }
  if (!token) { el('body').textContent = 'Open jobleft from the app, not from this address.'; return; }
  read();
  setInterval(read, 1000);
})();
`;
