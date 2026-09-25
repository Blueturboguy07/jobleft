// Evaluator-written: open a URL in a headless Chrome (already started with --remote-debugging-port) over the
// DevTools protocol, wait, then print the text of #res. Usage: node cdp_eval.mjs <devtoolsPort> <url> <waitMs>
const [port, url, waitMs] = process.argv.slice(2);
const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
const target = await r.json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((res) => setTimeout(res, Number(waitMs || 5000)));
const out = await send('Runtime.evaluate', { expression: "document.getElementById('res') ? document.getElementById('res').textContent : 'NO-RESULT'", returnByValue: true });
console.log(out.result?.result?.value ?? 'NO-RESULT');
ws.close();
process.exit(0);
