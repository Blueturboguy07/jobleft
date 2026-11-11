// Passes Sign in with publik on a running app for a black-box check: the stand-in (qa/bin/publik-standin.mjs) is
// told the computer is signed in, the gate (GET /publik-gate) is watched until it asks how the app pays for AI, the
// answer is pressed (POST /publik-gate), and the script ends when the gate has passed (the UI is served at "/").
// Usage: node qa/bin/publik-gate-pass.mjs --port <app port> --token <launch token> --admin <stand-in /__admin url>
//        [--action connect|own_key] [--wait-s 90]
// The app must have been started with PUBLIK_ORIGIN pointing at the stand-in.
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean));
const port = Number(args.port); const token = args.token; const admin = args.admin;
if (!port || !token) { console.error('usage: --port <port> --token <token> [--admin <url>] [--action connect|own_key] [--wait-s 90]'); process.exit(2); }
const action = args.action === 'own_key' ? 'own_key' : 'connect';
const deadline = Date.now() + Number(args['wait-s'] ?? 90) * 1000;
const H = { 'x-jobleft-token': token, 'content-type': 'application/json' };
const state = async () => {
  const r = await fetch(`http://127.0.0.1:${port}/publik-gate`, { headers: H });
  if (r.status === 404) { console.log('this build has no gate (no publik app token): nothing to pass'); process.exit(0); }
  if (!r.ok) throw new Error(`GET /publik-gate ${r.status}`);
  return r.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let s = await state();
console.log(`gate: pending=${s.pending} screen=${s.screen?.id ?? 'none'}`);
if (!s.pending) { console.log('the gate has passed already'); process.exit(0); }
if (admin) {
  // The person signs in in the browser: at the stand-in, the install is claimed.
  const r = await fetch(`${admin}/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  console.log(`stand-in claim: ${r.status}`);
}
let pressed = false;
while (Date.now() < deadline) {
  s = await state();
  if (!s.pending) { console.log('gate passed: the UI is served'); process.exit(0); }
  if (s.screen?.id === 'choose' && !pressed) {
    const want = s.screen.buttons.some((b) => b.action === action) ? action : s.screen.buttons.at(-1)?.action;
    const r = await fetch(`http://127.0.0.1:${port}/publik-gate`, { method: 'POST', headers: H, body: JSON.stringify({ action: want }) });
    const j = await r.json();
    console.log(`pressed ${want}: ${r.status} pressed=${j.pressed}`);
    pressed = !!j.pressed;
  } else if (s.screen?.id === 'unreachable') {
    console.log(`gate says: ${s.screen.body}`);
    await fetch(`http://127.0.0.1:${port}/publik-gate`, { method: 'POST', headers: H, body: JSON.stringify({ action: 'retry' }) }).catch(() => undefined);
  }
  await sleep(1000);
}
console.error(`the gate did not pass in time (screen ${s.screen?.id ?? 'none'})`);
process.exit(1);
