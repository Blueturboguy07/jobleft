#!/usr/bin/env python3
"""O3 (MUST): the setup check names the real problem, in plain words, within 60 s, never showing the key.
Ground truth: the evaluator injects each failure into its own stand-in, so the true cause is known in advance."""
import json, os, socket, sys, threading, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))
import harness as H
import checks as C

RESULTS_MSG = {}
m = H.Standin('model')
keyed = H.Standin('model', '--key', 'server-side-secret-0000', name='keyed')
pub0 = H.Standin('publik', '--balance', '0.00', name='publik0')


def run_case(name, setup, expect, url=None, key=None, sandbox=True, use=None, publik=None):
    jl = H.JL('c-' + name, publik=publik, sandbox=sandbox)
    setup()
    t0 = time.time()
    if use:
        rc, out, dt = jl.run(*use)
    else:
        rc, out, dt = jl.run('use', 'custom', '--url', url or m.url, '--model', 'hostile-7b')
        if key:
            jl.run('key', 'set', stdin=key)
            rc, out, dt = jl.run('check')
    total = time.time() - t0
    cats = C.categories(out)
    msg = [l for l in out.splitlines() if 'check' in l.lower() or 'problem' in l.lower()] or out.splitlines()[-1:]
    RESULTS_MSG[name] = (msg[0] if msg else out).strip()
    ok_plain, bad = C.plain_message(out)
    H.check('check-names-cause[%s]' % name, expect in cats and 'works' not in cats and all(c in (expect,) for c in cats if c != 'works'),
            'expected=%s got=%s %.1fs msg=%s' % (expect, cats, total, H.short(out, 300)), 'O3', 'high')
    H.check('check-within-60s[%s]' % name, total < 60, '%.1fs' % total, 'O3', 'high')
    H.check('check-plain-words[%s]' % name, ok_plain, 'bad=%s' % bad, 'O3', 'medium')
    if key:
        H.check('check-hides-key[%s]' % name, not C.shows_more_than_last4(out, key), H.short(out, 200), 'O3', 'critical')
    jl.cleanup()
    return total


times = {}
# 1. unreachable: nothing listens on the port
dead = H.free_port()
times['unreachable'] = run_case('unreachable', lambda: None, 'unreachable', url='http://127.0.0.1:%d' % dead)
# 2. key refused: server needs a key, the app has a wrong one; the server echoes the key it got
times['key_refused'] = run_case('key_refused', lambda: m.mode('refuse-key'), 'key_refused', key=H.CANARY)
times['key_refused_required'] = run_case('key_required_wrong', lambda: None, 'key_refused', url=keyed.url, key=H.CANARY)
# 3. model not found: the list works, chat answers 404 model_not_found
times['model_not_found'] = run_case('model_not_found', lambda: m.mode('model-not-found'), 'model_not_found')
# 4. an HTML page (for example a router login page)
times['html'] = run_case('html', lambda: m.mode('html'), 'not_ai_server')
# 5. publik balance $0.00 (connect first, then set the balance to zero at the stand-in)
jl = H.JL('pub0', publik=pub0)
jl.run('publik', 'connect', '--yes')
pub0.admin('balance', {'usd': 0})
t0 = time.time()
rc, out, dt = jl.run('use', 'publik')
cats = C.categories(out)
RESULTS_MSG['publik_balance_0_connected'] = out.strip().splitlines()[-1] if out.strip() else ''
H.check('check-names-cause[publik_balance_0_connected]', 'balance_low' in cats and 'works' not in cats and 'key_refused' not in cats,
        'got=%s %.1fs out=%s' % (cats, time.time() - t0, H.short(out, 300)), 'O3', 'high')
links = C.links(out)
H.check('balance-check-one-link', len(links) == 1, 'links=%s' % links, 'O3', 'medium')
jl.cleanup()

# the five messages are different from each other
five = [RESULTS_MSG.get(k, '') for k in ['unreachable', 'key_refused', 'model_not_found', 'html', 'publik_balance_0_connected']]
H.check('five-different-messages', len(set(five)) == 5, json.dumps(five)[:900], 'O3', 'high')

# ---- hostile extras
# a 401 whose text talks about billing/credit must still read as a refused key, never as "balance too low"
run_case('401_with_billing_words', lambda: m.mode('quota401'), 'key_refused', key=H.CANARY)
# a 429 insufficient_quota from a custom provider: must not claim works, must not talk about the publik balance
jl = H.JL('q429')
m.mode('quota429')
rc, out, dt = jl.run('use', 'custom', '--url', m.url, '--model', 'hostile-7b')
H.check('429-quota-not-works-not-publik', 'works' not in C.categories(out) and 'publik' not in out.lower(), H.short(out, 300), 'O3', 'medium')
jl.cleanup()
# model list works but chat answers 500: the check must not say "works"
jl = H.JL('e500')
m.mode('error500')
rc, out, dt = jl.run('use', 'custom', '--url', m.url, '--model', 'hostile-7b')
H.check('list-ok-chat-500-not-works', 'works' not in C.categories(out) and rc != 0, H.short(out, 300), 'O3', 'high')
jl.cleanup()
# a JSON API that is not an AI server (answers {"status":"ok"} to everything)
import http.server
class J(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _a(self):
        n = int(self.headers.get('content-length') or 0); self.rfile.read(n)
        b = b'{"status":"ok"}'; self.send_response(200); self.send_header('content-type', 'application/json'); self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b)
    do_GET = do_POST = _a
js = http.server.ThreadingHTTPServer(('127.0.0.1', 0), J); threading.Thread(target=js.serve_forever, daemon=True).start()
jl = H.JL('json-api')
rc, out, dt = jl.run('use', 'custom', '--url', 'http://127.0.0.1:%d' % js.server_address[1], '--model', 'hostile-7b')
H.check('json-non-ai-server-not-works', 'works' not in C.categories(out) and rc != 0, H.short(out, 300), 'O3', 'high')
jl.cleanup()
# a server that resets every connection
rs = socket.socket(); rs.bind(('127.0.0.1', 0)); rs.listen(50)
def resetter():
    import struct
    while True:
        c, _ = rs.accept(); c.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0)); c.close()
threading.Thread(target=resetter, daemon=True).start()
jl = H.JL('reset')
t0 = time.time()
rc, out, dt = jl.run('use', 'custom', '--url', 'http://127.0.0.1:%d' % rs.getsockname()[1], '--model', 'hostile-7b')
ok_plain, bad = C.plain_message(out)
H.check('reset-connection-plain-not-works', 'works' not in C.categories(out) and ok_plain and time.time() - t0 < 60, '%.1fs %s bad=%s' % (time.time() - t0, H.short(out, 300), bad), 'O3', 'medium')
jl.cleanup()
# https:// to a plain-http port
m.mode('ok')
jl = H.JL('tls')
rc, out, dt = jl.run('use', 'custom', '--url', 'https://127.0.0.1:%d' % m.port, '--model', 'hostile-7b')
ok_plain, bad = C.plain_message(out)
H.check('tls-to-http-plain-not-works', 'works' not in C.categories(out) and ok_plain, '%s bad=%s' % (H.short(out, 300), bad), 'O3', 'medium')
jl.cleanup()
# a host that never answers the TCP connect (127.0.0.2 is on the loopback interface but not configured)
jl = H.JL('blackhole', sandbox=False)
t0 = time.time()
rc, out, dt = jl.run('use', 'custom', '--url', 'http://127.0.0.2:4999', '--model', 'hostile-7b', timeout=120)
times['blackhole'] = time.time() - t0
H.check('blackhole-host-ends-within-60s-unreachable', times['blackhole'] < 60 and 'unreachable' in C.categories(out), '%.1fs %s' % (times['blackhole'], H.short(out, 300)), 'O3', 'high')
jl.cleanup()
# a server that accepts and then says nothing: the check still ends within 60 s
jl = H.JL('stall')
m.mode('stall')
t0 = time.time()
rc, out, dt = jl.run('use', 'custom', '--url', m.url, '--model', 'hostile-7b', timeout=150)
times['stall'] = time.time() - t0
H.check('stalled-server-check-within-60s', times['stall'] < 60 and 'works' not in C.categories(out), '%.1fs %s' % (times['stall'], H.short(out, 300)), 'O3', 'high')
jl.cleanup()
m.mode('ok')

# the person can fix a refused key from the same place: set the right key, check again -> works
jl = H.JL('fix')
jl.run('use', 'custom', '--url', keyed.url, '--model', 'hostile-7b')
jl.run('key', 'set', stdin='wrong-key-1234')
jl.run('key', 'set', stdin='server-side-secret-0000')
rc, out, dt = jl.run('check')
H.check('fix-key-then-works', 'works' in C.categories(out), H.short(out, 200), 'O3', 'medium')
jl.cleanup()

with open(os.path.join(H.OUT, 'o03-timings.json'), 'w') as f:
    json.dump({k: round(v, 2) for k, v in times.items()}, f)
print(json.dumps({'timings_s': {k: round(v, 2) for k, v in times.items()}, 'messages': RESULTS_MSG}))
H.finish()
