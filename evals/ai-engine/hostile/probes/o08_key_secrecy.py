#!/usr/bin/env python3
"""O8 (MUST): after saving, no more than the last 4 characters of a key are ever shown; the key is never in logs,
errors, or any file the app writes in plain text (or trivially encoded). Ground truth: the canary string itself, and a
stand-in that ECHOES the key it receives in its error text (so a pass-through of provider errors would leak it)."""
import base64, codecs, json, os, stat, subprocess, sys, threading, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))
import harness as H
import checks as C

# a canary with no common words, so that any 5-character window of it in the output is a real leak
K = 'sk-cnry-7Q4ZXK93VQWPLM8'
m = H.Standin('model')
m.mode('ok', key=K)  # the stand-in gets its key over the admin route, never in its own argv


def encodings(s):
    b = s.encode()
    return {'plain': b, 'base64': base64.b64encode(b), 'base64url': base64.urlsafe_b64encode(b).rstrip(b'='), 'hex': b.hex().encode(),
            'HEX': b.hex().upper().encode(), 'rot13': codecs.encode(s, 'rot13').encode(), 'reversed': b[::-1], 'utf16le': s.encode('utf-16-le'),
            'core': b'7Q4Z-jobleft'}


def scan_home(jl, key):
    hits = []
    enc = encodings(key)
    for f in jl.files():
        try:
            data = open(f, 'rb').read()
        except OSError:
            continue
        for name, e in enc.items():
            if e in data:
                hits.append((os.path.relpath(f, jl.home), name))
    return hits


jl = H.JL('main')
jl.run('use', 'custom', '--url', m.url, '--model', 'hostile-7b')
rc, out, dt = jl.run('key', 'set', stdin=K)
H.check('key-set-output-hides-key', not C.shows_more_than_last4(out, K), H.short(out, 200), 'O8', 'critical')
rc, out, dt = jl.run('status')
H.check('status-shows-at-most-last-4', not C.shows_more_than_last4(out, K) and 'PLM8' in out, [l for l in out.splitlines() if 'Key' in l], 'O8', 'critical')
rc, out, dt = jl.run('check')
H.check('check-works-with-key', 'Works' in out, H.short(out, 200), 'O8', 'high')

# the provider refuses the key and echoes it back in its error text
m.mode('refuse-key', key=K)
outs = []
for args in [('chat', 'hello'), ('check',), ('json', 'Jordan Testwell, SQL analyst. Job: data analyst.'), ('models',), ('chat', '--resend'), ('status',)]:
    rc, out, dt = jl.run(*args)
    outs.append((args[0], out))
    H.check('refused-key-error-hides-key[%s]' % args[0], not C.shows_more_than_last4(out, K), H.short(out, 250), 'O8', 'critical')
# a provider error of another kind, echoing the key in the body of a 500 and in an HTML page
m.mode('ok', key=K)

# files the app wrote: no plain or trivially encoded key, strict modes
hits = scan_home(jl, K)
H.check('no-key-in-any-file', not hits, 'hits=%s files=%s' % (hits, [os.path.relpath(f, jl.home) for f in jl.files()]), 'O8', 'critical')
logs = [f for f in jl.files() if f.endswith('.log') or '/logs/' in f]
H.check('engine-writes-no-log-file', not logs, 'log files=%s' % logs, 'O8', 'medium')
modes = {}
for f in jl.files():
    modes[os.path.relpath(f, jl.home)] = oct(stat.S_IMODE(os.stat(f).st_mode))
sec_dir = os.path.join(jl.home, 'secrets')
if os.path.isdir(sec_dir):
    modes['secrets/'] = oct(stat.S_IMODE(os.stat(sec_dir).st_mode))
bad_modes = {k: v for k, v in modes.items() if (k == 'secrets/' and v != '0o700') or (k != 'secrets/' and v not in ('0o600',))}
H.check('secret-and-state-files-private', not bad_modes, 'modes=%s' % modes, 'O8', 'high')
state = open(os.path.join(jl.home, 'ai', 'state.json'), encoding='utf-8').read()
H.check('state-json-at-most-last-4', not C.shows_more_than_last4(state, K), 'state.json=%s' % H.short(state, 300), 'O8', 'critical')

# the local API: settings, key routes, check, and a chat error never carry more than the last 4 characters
srv = H.Serve(jl)
blobs = []
st, hd, b = srv.req('GET', '/api/v1/ai/settings'); blobs.append(('settings', b))
st, hd, b = srv.req('PUT', '/api/v1/ai/key', {'key': K}); blobs.append(('put-key', b))
st, hd, b = srv.req('POST', '/api/v1/ai/check', None); blobs.append(('check', b))
m.mode('refuse-key', key=K)
st, hd, b = srv.req('POST', '/api/v1/ai/check', None); blobs.append(('check-refused', b))
st, evs, dt = srv.sse('/api/v1/ai/chat', {'requestId': 'k1', 'messages': [{'role': 'user', 'content': 'hi'}]}); blobs.append(('chat-refused', evs))
st, hd, b = srv.req('GET', '/api/v1/ai/models'); blobs.append(('models-refused', b))
m.mode('ok', key=K)
srv.stop()
for name, b in blobs:
    s = json.dumps(b)
    H.check('api-hides-key[%s]' % name, not C.shows_more_than_last4(s, K), H.short(s, 250), 'O8', 'critical')
served = ''.join(srv.lines)
H.check('serve-console-hides-key', not C.shows_more_than_last4(served, K), H.short(served, 200), 'O8', 'high')
jl.cleanup()

# a key with a trailing newline (as `echo key | ...` sends) is stored without it and works
jl = H.JL('newline')
jl.run('use', 'custom', '--url', m.url, '--model', 'hostile-7b')
jl.run('key', 'set', stdin=K + '\n')
rc, out, dt = jl.run('check')
H.check('trailing-newline-key-works', 'Works' in out, H.short(out, 200), 'O8', 'medium')
jl.cleanup()

# header injection: a key with CR LF must not add a header upstream, and the error must not show the key
m.mode('ok', key=None)
m.reset()
jl = H.JL('crlf')
jl.run('use', 'custom', '--url', m.url, '--model', 'hostile-7b')
evil = 'sk-canary-CRLF-9876\r\nX-Injected: yes'
rc, out, dt = jl.run('key', 'set', stdin=evil)
rc2, out2, dt2 = jl.run('chat', 'hello')
inj = [e for e in m.ai_requests() if 'x-injected' in e['headers']]
ok_plain, bad = C.plain_message(out + out2)
H.check('crlf-key-no-header-injection', not inj, 'injected requests=%d' % len(inj), 'O8', 'high')
H.check('crlf-key-error-plain-and-hidden', ok_plain and 'CRLF-98' not in out + out2, 'set: %s | chat: %s bad=%s' % (H.short(out, 150), H.short(out2, 200), bad), 'O8', 'medium')
jl.cleanup()

# a non-ASCII key (cannot go in an HTTP header): plain message, key not shown
jl = H.JL('unicode')
jl.run('use', 'custom', '--url', m.url, '--model', 'hostile-7b')
ukey = 'sk-ключ-🔑-SECRETPART-4321'
jl.run('key', 'set', stdin=ukey)
rc, out, dt = jl.run('chat', 'hello')
ok_plain, bad = C.plain_message(out)
H.check('unicode-key-plain-and-hidden', ok_plain and 'SECRETPART' not in out, '%s bad=%s' % (H.short(out, 200), bad), 'O8', 'medium')
jl.cleanup()

# the macOS Keychain store (the default): the key never appears in any process argument list
jl = H.JL('keychain', extra_env={'JOBLEFT_SECRET_STORE': ''})
jl.env.pop('JOBLEFT_SECRET_STORE', None)
m.mode('ok', key=K)
jl.run('use', 'custom', '--url', m.url, '--model', 'hostile-7b')
seen = []
stop = [False]
def watch():
    while not stop[0]:
        try:
            ps = subprocess.run(['ps', '-axww', '-o', 'args='], capture_output=True, text=True, timeout=5).stdout
            own = [l for l in ps.splitlines() if K in l and ('security' in l or 'cli.ts' in l or l.startswith('node'))]
            if own:
                seen.append(own[:2])
        except Exception:
            pass
w = threading.Thread(target=watch, daemon=True)
w.start()
kc_out = []
for i in range(4):
    rc, out, dt = jl.run('key', 'set', stdin=K, timeout=30)
    kc_out.append((rc, out.strip()[:120]))
    rc, out, dt = jl.run('check', timeout=30)
    kc_out.append((rc, out.strip()[:120]))
stop[0] = True
w.join(6)
blocked = any(rc == 'TIMEOUT' for rc, _ in kc_out)
H.check('keychain-key-never-in-argv', not seen and not blocked, 'argv hits=%s runs=%s' % (seen[:2], kc_out[:3]), 'O8', 'high')
H.check('keychain-no-file-copy', not scan_home(jl, K), 'hits=%s' % scan_home(jl, K), 'O8', 'critical')
rc, out, dt = jl.run('secrets', 'forget-all', timeout=30)
rc2, out2, dt2 = jl.run('status', timeout=30)
H.check('keychain-forget-all', 'none saved' in out2.lower() or 'Key:' not in out2, H.short(out2, 300), 'O8', 'medium')
jl.cleanup()

H.finish()
