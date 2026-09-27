import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";const CHROME = process.env.JOBLEFT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
class Browser {
  proc;
  out;
  seq = 0;
  pending = /* @__PURE__ */ new Map();
  listeners = [];
  profile;
  constructor(proc, profile) {
    this.proc = proc;
    this.profile = profile;
    this.out = proc.stdio[3];
    const input = proc.stdio[4];
    let buf = "";
    input.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\0")) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.id !== void 0) {
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message} ${msg.error.data ?? ""}`));
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
  static async launch(opts = {}) {
    const profile = mkdtempSync(join(tmpdir(), "jl-chrome-"));
    const proxy = opts.proxy ?? "127.0.0.1:9";
    const args = [
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-domain-reliability",
      "--metrics-recording-only",
      "--no-pings",
      "--window-size=1400,1000",
      "--disable-features=OptimizationHints,MediaRouter,Translate,AutofillServerCommunication,CertificateTransparencyComponentUpdater,InterestFeedContentSuggestions",
      "--safebrowsing-disable-auto-update",
      `--proxy-server=http://${proxy}`,
      ...opts.args ?? []
    ];
    if (opts.headless !== false) args.unshift("--headless=new");
    const proc = spawn(CHROME, [...args, "about:blank"], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    const b = new Browser(proc, profile);
    await b.send("Browser.getVersion");
    return b;
  }
  on(l) {
    this.listeners.push(l);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.out.write(`${JSON.stringify({ id, method, params, ...sessionId ? { sessionId } : {} })}\0`);
    });
  }
  async close() {
    try {
      await this.send("Browser.close");
    } catch {
    }
    await new Promise((r) => setTimeout(r, 300));
    try {
      this.proc.kill("SIGKILL");
    } catch {
    }
    try {
      rmSync(this.profile, { recursive: true, force: true });
    } catch {
    }
  }
  async targets() {
    const r = await this.send("Target.getTargets");
    return r.targetInfos;
  }
  async attach(targetId) {
    const r = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const p = new Page(this, r.sessionId, targetId);
    await p.send("Runtime.enable");
    await p.send("Page.enable").catch(() => void 0);
    return p;
  }
  async newPage(url) {
    const r = await this.send("Target.createTarget", { url: "about:blank" });
    const p = await this.attach(r.targetId);
    await p.goto(url);
    return p;
  }
  async waitTarget(pred, ms = 8e3) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const t = (await this.targets()).find(pred);
      if (t) return t;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("target did not appear");
  }
}
class Page {
  browser;
  sessionId;
  targetId;
  constructor(b, sessionId, targetId) {
    this.browser = b;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }
  send(method, params = {}) {
    return this.browser.send(method, params, this.sessionId);
  }
  async close() {
    await this.browser.send("Target.closeTarget", { targetId: this.targetId }).catch(() => void 0);
  }
  async goto(url) {
    const loaded = new Promise((resolve) => {
      const done = (m) => {
        if (m.sessionId === this.sessionId && m.method === "Page.loadEventFired") resolve();
      };
      this.browser.on(done);
      setTimeout(resolve, 8e3);
    });
    await this.send("Page.navigate", { url });
    await loaded;
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  async screenshot() {
    const r = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    return Buffer.from(r.data, "base64");
  }
  /** A trusted mouse click at the center of the first element matching `selector`, searching inside shadow roots too (closed ones included). */
  async clickDeep(selector, textIncludes) {
    const doc = await this.send("DOM.getDocument", { depth: -1, pierce: true });
    const ids = await this.findDeep(doc.root, selector, textIncludes);
    const nodeId = ids[0];
    if (nodeId === void 0) return false;
    await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: nodeId }).catch(() => void 0);
    const box = await this.send("DOM.getBoxModel", { backendNodeId: nodeId });
    const q = box.model.content;
    const x = ((q[0] ?? 0) + (q[2] ?? 0)) / 2;
    const y = ((q[1] ?? 0) + (q[5] ?? 0)) / 2;
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    return true;
  }
  /** Text of every element matching `selector` (shadow roots included). */
  async textsDeep(selector) {
    const doc = await this.send("DOM.getDocument", { depth: -1, pierce: true });
    const ids = await this.findDeep(doc.root, selector);
    const out = [];
    for (const id of ids) {
      const r = await this.send("DOM.resolveNode", { backendNodeId: id });
      const v = await this.send("Runtime.callFunctionOn", { objectId: r.object.objectId, functionDeclaration: 'function(){return this.innerText || this.textContent || ""}', returnByValue: true });
      out.push(v.result.value);
    }
    return out;
  }
  async findDeep(root, selector, textIncludes) {
    const scopes = [];
    const walk = (n) => {
      if (n.nodeName === "#document" || n.nodeName === "#document-fragment") scopes.push(n.backendNodeId);
      for (const c of n.children ?? []) walk(c);
      for (const s of n.shadowRoots ?? []) walk(s);
      if (n.contentDocument) walk(n.contentDocument);
    };
    walk(root);
    const found = [];
    for (const s of scopes) {
      const r = await this.send("DOM.resolveNode", { backendNodeId: s }).catch(() => null);
      if (!r) continue;
      const res = await this.send("Runtime.callFunctionOn", {
        objectId: r.object.objectId,
        functionDeclaration: `function(sel, txt){ return Array.from(this.querySelectorAll(sel)).filter(function(e){ return !txt || (e.textContent||'').indexOf(txt) >= 0; }); }`,
        arguments: [{ value: selector }, { value: textIncludes ?? "" }]
      });
      if (!res.result.objectId) continue;
      const props = await this.send("Runtime.getProperties", { objectId: res.result.objectId, ownProperties: true });
      for (const p of props.result) {
        if (!/^\d+$/.test(p.name) || !p.value?.objectId) continue;
        const d = await this.send("DOM.describeNode", { objectId: p.value.objectId });
        found.push(d.node.backendNodeId);
      }
    }
    return found;
  }
}
export {
  Browser,
  CHROME,
  Page
};
