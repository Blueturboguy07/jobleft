#!/usr/bin/env python3
"""O4 (MUST): every AI request ends; dead provider < 10 s; silence ends <= 120 s; cancel < 2 s and stops upstream;
a partial answer stays and is marked incomplete; no retry loop; the person's message is never lost.
Ground truth: the evaluator's stand-in log (request counts, when the client closed the socket) and wall-clock timings."""
import json, os, signal, sys, threading, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))
import harness as H
import checks as C

TIMES = {}
LONG = 'ALPHA1 BRAVO2 CHARLIE3 DELTA4 ECHO5 FOXTROT6 GOLF7 HOTEL8 INDIA9 JULIET10 KILO11 LIMA12'


def posts(server):
    return [e for e in server.ai_requests() if e['method'] == 'POST']


def closed_events(server):
    return [ev for e in server.log() for ev in e.get('events', []) if 'closed' in ev.get('what', '')]


def custom(jl, server, model='hostile-7b'):
    jl.run('use', 'custom', '--url', server.url, '--model', model)
    server.reset()


# ---------------------------------------------------------------- long cases, in parallel
def case_silence(mode):
    s = H.Standin('model', name='sil-' + mode)
    jl = H.JL('sil-' + mode)
    custom(jl, s)
    s.mode(mode)
    rc, out, dt = jl.run('chat', 'Tell me about the job', timeout=400)
    TIMES['silence_' + mode] = round(dt, 1)
    ok_plain, bad = C.plain_message(out)
    H.check('silent-provider-ends-within-120s[%s]' % mode, rc not in (0, 'TIMEOUT') and dt <= 121 and ok_plain,
            'rc=%s %.1fs out=%s bad=%s' % (rc, dt, H.short(out, 250), bad), 'O4', 'critical')
    H.check('silent-provider-one-request[%s]' % mode, len(posts(s)) == 1, 'POSTs=%d' % len(posts(s)), 'O4', 'high')
    time.sleep(1.0)
    H.check('silent-provider-upstream-closed[%s]' % mode, bool(closed_events(s)), 'events=%s' % closed_events(s), 'O4', 'medium')
    jl.cleanup(); s.stop()


def case_keepalive():
    s = H.Standin('model', name='keepalive')
    jl = H.JL('keepalive')
    custom(jl, s)
    s.mode('keepalive', ka_s=20)
    rc, out, dt = jl.run('chat', 'Tell me about the job', timeout=330)
    TIMES['keepalive_comments_only'] = round(dt, 1) if rc != 'TIMEOUT' else '>330'
    H.check('keepalive-comments-only-still-ends', rc != 'TIMEOUT', 'rc=%s %.1fs out=%s' % (rc, dt, H.short(out, 200)), 'O4', 'medium')
    jl.cleanup(); s.stop()


def case_trickle():
    s = H.Standin('model', name='trickle')
    jl = H.JL('trickle')
    custom(jl, s)
    text = ' '.join('W%02d' % i for i in range(1, 51))  # 50 words, ~200 chars -> ~34 pieces
    s.mode('slow', slow_ms=4000, content=text)
    rc, out, dt = jl.run('chat', 'Tell me about the job', timeout=400)
    TIMES['trickle_4s_gaps'] = round(dt, 1)
    H.check('slow-but-alive-stream-not-cut', rc == 0 and 'W50' in out and '[done]' in out, 'rc=%s %.1fs tail=%s' % (rc, dt, H.short(out[-150:], 150)), 'O4', 'high')
    jl.cleanup(); s.stop()


def case_slow_first_byte():
    s = H.Standin('model', name='firstbyte')
    jl = H.JL('firstbyte')
    custom(jl, s)
    s.mode('delay', delay_s=35)
    rc, out, dt = jl.run('chat', 'Reply with the word ready', timeout=200)
    TIMES['first_byte_after_35s'] = round(dt, 1)
    H.check('slow-first-byte-35s-still-answers', rc == 0 and s.nonce in out, 'rc=%s %.1fs out=%s' % (rc, dt, H.short(out, 200)), 'O4', 'high')
    jl.cleanup(); s.stop()


def case_publik_heartbeat():
    pub = H.Standin('publik', '--balance', '5.00', name='heartbeat')
    jl = H.JL('heartbeat', publik=pub)
    jl.run('publik', 'connect', '--yes')
    jl.run('use', 'publik')
    pub.admin('mode', {'mode': 'heartbeat'})
    rc, out, dt = jl.run('chat', 'Tell me about the job', timeout=330)
    TIMES['publik_heartbeat_no_first_byte'] = round(dt, 1) if rc != 'TIMEOUT' else '>330'
    H.check('publik-heartbeat-without-data-ends-within-120s', rc != 'TIMEOUT' and dt <= 121,
            'rc=%s %.1fs out=%s' % (rc, dt, H.short(out, 200)), 'O4', 'high')
    jl.cleanup(); pub.stop()


threads = [threading.Thread(target=f, args=a) for f, a in [(case_silence, ('stall',)), (case_silence, ('stall-after-headers',)),
                                                            (case_keepalive, ()), (case_trickle, ()), (case_slow_first_byte, ()),
                                                            (case_publik_heartbeat, ())]]
for t in threads:
    t.start()

# ---------------------------------------------------------------- short cases
m = H.Standin('model')

# dead provider (nothing listens)
jl = H.JL('dead')
dead = H.free_port()
jl.run('use', 'custom', '--url', 'http://127.0.0.1:%d' % dead, '--model', 'hostile-7b')
rc, out, dt = jl.run('chat', 'Hello from Jordan')
TIMES['dead_port'] = round(dt, 2)
ok_plain, bad = C.plain_message(out)
H.check('dead-provider-plain-within-10s', dt < 10 and rc != 0 and ok_plain and 'unreachable' in C.categories(out), '%.2fs %s' % (dt, H.short(out, 200)), 'O4', 'critical')
jl.cleanup()

# host that never answers the connect (127.0.0.2, loopback interface, not configured)
jl = H.JL('blackhole', sandbox=False)
jl.run('use', 'custom', '--url', 'http://127.0.0.2:4999', '--model', 'hostile-7b', timeout=120)
rc, out, dt = jl.run('chat', 'Hello from Jordan', timeout=120)
TIMES['blackhole_host'] = round(dt, 2)
H.check('non-answering-host-within-10s', dt <= 10.5 and rc != 0, '%.2fs (bar 10 s + CLI start) %s' % (dt, H.short(out, 200)), 'O4', 'high')
jl.cleanup()

# cancel with Ctrl-C during a slow stream
jl = H.JL('cancel')
custom(jl, m)
m.mode('slow', slow_ms=1000, content=LONG)
p = jl.popen('chat', 'Tell me about the job')
buf = []
reader = threading.Thread(target=lambda: buf.extend(iter(p.stdout.readline, '')), daemon=True)
reader.start()
time.sleep(3.2)
t0 = time.time()
p.send_signal(signal.SIGINT)
try:
    p.wait(10)
except Exception:
    p.kill()
cancel_s = time.time() - t0
reader.join(2)
out = ''.join(buf)
time.sleep(0.5)
ce = closed_events(m)
TIMES['cancel_ctrl_c'] = round(cancel_s, 2)
H.check('ctrl-c-stops-within-2s', cancel_s < 2, '%.2fs' % cancel_s, 'O4', 'critical')
H.check('ctrl-c-keeps-partial-and-marks-it', 'ALPHA1' in out and ('cancel' in out.lower() or 'incomplete' in out.lower()) and 'LIMA12' not in out,
        H.short(out, 300), 'O4', 'high')
H.check('ctrl-c-stops-upstream', bool(ce), 'stand-in events=%s' % ce, 'O4', 'critical')
n_after = len(posts(m))
time.sleep(2)
H.check('ctrl-c-no-later-request', len(posts(m)) == n_after == 1, 'POSTs=%d' % len(posts(m)), 'O4', 'high')
jl.cleanup()

# cancel while nothing has arrived yet (stall before headers)
jl = H.JL('cancel-stall')
custom(jl, m)
m.mode('stall')
p = jl.popen('chat', 'Tell me about the job')
time.sleep(2.0)
t0 = time.time()
p.send_signal(signal.SIGINT)
try:
    p.wait(10)
except Exception:
    p.kill()
cancel_s = time.time() - t0
TIMES['cancel_ctrl_c_before_first_byte'] = round(cancel_s, 2)
time.sleep(0.5)
H.check('ctrl-c-before-first-byte-within-2s', cancel_s < 2 and bool(closed_events(m)), '%.2fs events=%s' % (cancel_s, closed_events(m)), 'O4', 'critical')
jl.cleanup()

# half an answer, then the connection drops
for mode in ['half', 'broken', 'cutoff']:
    jl = H.JL('part-' + mode)
    custom(jl, m)
    m.mode(mode, content=LONG)
    rc, out, dt = jl.run('chat', 'Tell me about the job')
    ok_plain, bad = C.plain_message(out)
    H.check('partial-kept-and-marked[%s]' % mode, 'ALPHA1' in out and 'incomplete' in out.lower() and '[done]' not in out and ok_plain,
            'rc=%s %s bad=%s' % (rc, H.short(out, 300), bad), 'O4', 'high')
    H.check('partial-one-request[%s]' % mode, len(posts(m)) == 1, 'POSTs=%d' % len(posts(m)), 'O4', 'high')
    jl.cleanup()

# no retry loop: 500, a flaky server (fails once), dead server
for mode in ['error500', 'flaky']:
    jl = H.JL('retry-' + mode)
    custom(jl, m)
    m.mode(mode)
    rc, out, dt = jl.run('chat', 'Tell me about the job')
    H.check('no-auto-retry[%s]' % mode, len(posts(m)) == 1 and rc != 0, 'POSTs=%d rc=%s out=%s' % (len(posts(m)), rc, H.short(out, 200)), 'O4', 'high')
    jl.cleanup()

# publik 503 and 429: exactly one request each, no retry
pub = H.Standin('publik', '--balance', '5.00')
jl = H.JL('pubretry', publik=pub)
jl.run('publik', 'connect', '--yes')
jl.run('use', 'publik')
for mode in ['unavailable', 'ratelimit']:
    pub.admin('mode', {'mode': mode})
    n0 = len([e for e in pub.log() if e['path'].endswith('/chat/completions')])
    rc, out, dt = jl.run('chat', 'Tell me about the job')
    n1 = len([e for e in pub.log() if e['path'].endswith('/chat/completions')])
    ok_plain, bad = C.plain_message(out)
    H.check('publik-no-auto-retry[%s]' % mode, n1 - n0 == 1 and rc != 0 and ok_plain, 'requests=%d out=%s' % (n1 - n0, H.short(out, 200)), 'O4', 'high')
pub.admin('mode', {'mode': 'ok'})
jl.cleanup()

# the person's message is never lost: Unicode, emoji, RTL and a newline survive a failure and --resend byte for byte
MSG = 'Héllo 👋🏽 Jördan — ¿qué tal? 你好 עברית\nsecond line with "quotes" and \\backslash'
jl = H.JL('keep')
custom(jl, m)
m.mode('error500')
rc, out, dt = jl.run('chat', MSG)
m.mode('ok')
m.reset()
rc2, out2, dt2 = jl.run('chat', '--resend')
sent = [json.loads(e['body'])['messages'][-1]['content'] for e in posts(m) if e['body']]
H.check('failed-message-kept-and-resent-exactly', rc2 == 0 and sent and sent[-1] == MSG, 'resent=%r' % (sent[-1] if sent else None), 'O4', 'high')
jl.cleanup()

# a crash (kill -9) in the middle of a stream: is the message still there?
jl = H.JL('crash')
custom(jl, m)
m.mode('slow', slow_ms=1000, content=LONG)
p = jl.popen('chat', 'crash test message 42')
time.sleep(2.5)
p.kill()
p.wait()
m.mode('ok')
m.reset()
rc, out, dt = jl.run('chat', '--resend')
sent = [json.loads(e['body'])['messages'][-1]['content'] for e in posts(m) if e['body']]
H.check('message-survives-crash-mid-stream', 'crash test message 42' in sent, 'resend rc=%s out=%s sent=%s' % (rc, H.short(out, 150), sent), 'O4', 'low')
jl.cleanup()

# ---------------------------------------------------------------- the local API (one long-lived process)
jl = H.JL('serve')
custom(jl, m)
srv = H.Serve(jl)
m.mode('stall')
res = {}
def stalled_chat():
    res['stall'] = srv.sse('/api/v1/ai/chat', {'requestId': 'r-stall', 'messages': [{'role': 'user', 'content': 'hello'}]}, timeout=200)
t = threading.Thread(target=stalled_chat)
t.start()
time.sleep(2)
lat = {}
for path in ['/api/v1/health', '/api/v1/ai/settings', '/api/v1/publik']:
    t0 = time.time()
    st, _, _ = srv.req('GET', path)
    lat[path] = (st, round(time.time() - t0, 3))
H.check('app-usable-while-waiting', all(v[0] == 200 and v[1] < 1.0 for v in lat.values()), 'latency=%s' % lat, 'O4', 'high')
t0 = time.time()
st, _, body = srv.req('POST', '/api/v1/ai/requests/r-stall/cancel', {})
t.join(10)
api_cancel = time.time() - t0
TIMES['cancel_api_route'] = round(api_cancel, 2)
evs = res.get('stall', (None, [], 0))[1]
last = evs[-1][1] if evs else None
time.sleep(0.5)
H.check('api-cancel-ends-stream-within-2s', not t.is_alive() and api_cancel < 2 and isinstance(last, dict) and last.get('type') in ('done', 'error'),
        'cancel status=%s body=%s %.2fs last=%s' % (st, body, api_cancel, last), 'O4', 'critical')
H.check('api-cancel-stops-upstream', bool(closed_events(m)), 'events=%s' % closed_events(m), 'O4', 'critical')
# half via the API: done with incomplete true, partial text delivered
m.reset()
m.mode('half', content=LONG)
st, evs, dt = srv.sse('/api/v1/ai/chat', {'requestId': 'r-half', 'messages': [{'role': 'user', 'content': 'hello'}]})
text = ''.join(o.get('text', '') for _, o in evs if isinstance(o, dict) and o.get('type') == 'delta')
last = evs[-1][1] if evs else {}
H.check('api-half-done-incomplete', 'ALPHA1' in text and isinstance(last, dict) and last.get('type') == 'done' and last.get('incomplete') is True,
        'text=%r last=%s' % (text[:60], last), 'O4', 'high')
# cancel during a slow stream via the API: no delta after the cancel returns
m.reset()
m.mode('slow', slow_ms=700, content=LONG)
res2 = {}
t = threading.Thread(target=lambda: res2.setdefault('r', srv.sse('/api/v1/ai/chat', {'requestId': 'r-slow', 'messages': [{'role': 'user', 'content': 'hello'}]})))
t.start()
time.sleep(2.5)
tc = time.time()
srv.req('POST', '/api/v1/ai/requests/r-slow/cancel', {})
t.join(10)
evs = res2.get('r', (None, [], 0))[1]
t_start = tc - (time.time() - 0)  # placeholder
late = [o for (tr, o) in evs if isinstance(o, dict) and o.get('type') == 'delta' and 'LIMA12' in o.get('text', '')]
H.check('api-cancel-no-text-after-cancel', not late and not t.is_alive(), 'events=%d late=%s' % (len(evs), late), 'O4', 'high')
srv.stop()
jl.cleanup()

for t in threads:
    t.join()
with open(os.path.join(H.OUT, 'o04-timings.json'), 'w') as f:
    json.dump(TIMES, f)
print(json.dumps({'timings_s': TIMES}))
H.finish()
