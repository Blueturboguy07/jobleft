// A minimal Chrome DevTools Protocol client over a pipe (test tool). It starts Google Chrome headless with a
// scratch profile, loads the unpacked extension (Extensions.loadUnpacked needs the pipe and
// --enable-unsafe-extension-debugging), and sends commands. No dependency.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';

export const CHROME = process.env.JOBLEFT_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

type Json = Record<string, unknown>;
interface Pending { resolve: (v: Json) => void; reject: (e: Error) => void; method: string }

export class Browser {
  private proc: ChildProcess;
  private out: Writable;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private listeners: Array<(m: { method: string; params: Json; sessionId?: string }) => void> = [];
  readonly profile: string;

  private constructor(proc: ChildProcess, profile: string) {
    this.proc = proc;
    this.profile = profile;
    this.out = proc.stdio[3] as Writable;
    const input = proc.stdio[4] as Readable;
    let buf = '';
    input.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\0')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i)) as { id?: number; result?: Json; error?: { message: string; data?: string }; method?: string; params?: Json; sessionId?: string };
        buf = buf.slice(i + 1);
        if (msg.id !== undefined) {
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message} ${msg.error.data ?? ''}`));
          else p.resolve(msg.result ?? {});
        } else if (msg.method) {
          for (const l of this.listeners) l({ method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId });
        }
      }
    });
  }

  /**
   * proxy: 'none-outside' (default) sends every request that is not to this computer to a closed local port, so a
   * test browser cannot reach the internet at all; or an explicit "host:port" proxy (the recorder's own filter).
   */
  static async launch(opts: { headless?: boolean; args?: string[]; proxy?: string } = {}): Promise<Browser> {
    const profile = mkdtempSync('/private/tmp/jl-chrome-');
    const proxy = opts.proxy ?? '127.0.0.1:9';
    const args = [
      '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${profile}`, '--no-first-run',
      '--no-default-browser-check', '--disable-sync', '--disable-background-networking', '--disable-component-update',
      '--disable-domain-reliability', '--metrics-recording-only', '--no-pings', '--window-size=1400,1000',
      '--disable-features=OptimizationHints,MediaRouter,Translate,AutofillServerCommunication,CertificateTransparencyComponentUpdater,InterestFeedContentSuggestions',
      '--safebrowsing-disable-auto-update', `--proxy-server=http://${proxy}`, ...(opts.args ?? []),
    ];
    if (opts.headless !== false) args.unshift('--headless=new');
    const proc = spawn(CHROME, [...args, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    const b = new Browser(proc, profile);
    await b.send('Browser.getVersion');
    return b;
  }

  on(l: (m: { method: string; params: Json; sessionId?: string }) => void): void { this.listeners.push(l); }

  send<T = Json>(method: string, params: Json = {}, sessionId?: string): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: Json) => void, reject, method });
      this.out.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  async close(): Promise<void> {
    try { await this.send('Browser.close'); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 300));
    try { this.proc.kill('SIGKILL'); } catch { /* ignore */ }
    try { rmSync(this.profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  async targets(): Promise<Array<{ targetId: string; type: string; url: string; title: string }>> {
    const r = await this.send<{ targetInfos: Array<{ targetId: string; type: string; url: string; title: string }> }>('Target.getTargets');
    return r.targetInfos;
  }

  async attach(targetId: string): Promise<Page> {
    const r = await this.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const p = new Page(this, r.sessionId, targetId);
    await p.send('Runtime.enable');
    await p.send('Page.enable').catch(() => undefined);
    return p;
  }

  async newPage(url: string): Promise<Page> {
    const r = await this.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const p = await this.attach(r.targetId);
    await p.goto(url);
    return p;
  }

  async waitTarget(pred: (t: { type: string; url: string }) => boolean, ms = 8000): Promise<{ targetId: string; type: string; url: string }> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const t = (await this.targets()).find(pred);
      if (t) return t;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('target did not appear');
  }
}

export class Page {
  readonly browser: Browser;
  readonly sessionId: string;
  readonly targetId: string;
  constructor(b: Browser, sessionId: string, targetId: string) { this.browser = b; this.sessionId = sessionId; this.targetId = targetId; }

  send<T = Json>(method: string, params: Json = {}): Promise<T> { return this.browser.send<T>(method, params, this.sessionId); }

  async goto(url: string): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      const done = (m: { method: string; sessionId?: string }): void => { if (m.sessionId === this.sessionId && m.method === 'Page.loadEventFired') resolve(); };
      this.browser.on(done);
      setTimeout(resolve, 8000);
    });
    await this.send('Page.navigate', { url });
    await loaded;
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }

  async screenshot(): Promise<Buffer> {
    const r = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return Buffer.from(r.data, 'base64');
  }

  /** A trusted mouse click at the center of the first element matching `selector`, searching inside shadow roots too (closed ones included). */
  async clickDeep(selector: string, textIncludes?: string): Promise<boolean> {
    const doc = await this.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: -1, pierce: true });
    const ids = await this.findDeep(doc.root as unknown as DomNode, selector, textIncludes);
    const nodeId = ids[0];
    if (nodeId === undefined) return false;
    await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: nodeId }).catch(() => undefined);
    const box = await this.send<{ model: { content: number[] } }>('DOM.getBoxModel', { backendNodeId: nodeId });
    const q = box.model.content;
    const x = ((q[0] ?? 0) + (q[2] ?? 0)) / 2;
    const y = ((q[1] ?? 0) + (q[5] ?? 0)) / 2;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return true;
  }

  /** Text of every element matching `selector` (shadow roots included). */
  async textsDeep(selector: string): Promise<string[]> {
    const doc = await this.send<{ root: DomNode }>('DOM.getDocument', { depth: -1, pierce: true });
    const ids = await this.findDeep(doc.root, selector);
    const out: string[] = [];
    for (const id of ids) {
      const r = await this.send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId: id });
      const v = await this.send<{ result: { value: string } }>('Runtime.callFunctionOn', { objectId: r.object.objectId, functionDeclaration: 'function(){return this.innerText || this.textContent || ""}', returnByValue: true });
      out.push(v.result.value);
    }
    return out;
  }

  private async findDeep(root: DomNode, selector: string, textIncludes?: string): Promise<number[]> {
    // Collect every shadow root and document, then querySelectorAll in each through Runtime.
    const scopes: number[] = [];
    const walk = (n: DomNode): void => {
      if (n.nodeName === '#document' || n.nodeName === '#document-fragment') scopes.push(n.backendNodeId);
      for (const c of n.children ?? []) walk(c);
      for (const s of n.shadowRoots ?? []) walk(s);
      if (n.contentDocument) walk(n.contentDocument);
    };
    walk(root);
    const found: number[] = [];
    for (const s of scopes) {
      const r = await this.send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId: s }).catch(() => null);
      if (!r) continue;
      const res = await this.send<{ result: { objectId?: string } }>('Runtime.callFunctionOn', {
        objectId: r.object.objectId,
        functionDeclaration: `function(sel, txt){ return Array.from(this.querySelectorAll(sel)).filter(function(e){ return !txt || (e.textContent||'').indexOf(txt) >= 0; }); }`,
        arguments: [{ value: selector }, { value: textIncludes ?? '' }],
      });
      if (!res.result.objectId) continue;
      const props = await this.send<{ result: Array<{ name: string; value?: { objectId?: string } }> }>('Runtime.getProperties', { objectId: res.result.objectId, ownProperties: true });
      for (const p of props.result) {
        if (!/^\d+$/.test(p.name) || !p.value?.objectId) continue;
        const d = await this.send<{ node: { backendNodeId: number } }>('DOM.describeNode', { objectId: p.value.objectId });
        found.push(d.node.backendNodeId);
      }
    }
    return found;
  }
}

interface DomNode { nodeName: string; backendNodeId: number; children?: DomNode[]; shadowRoots?: DomNode[]; contentDocument?: DomNode }
