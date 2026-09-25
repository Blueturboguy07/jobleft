#!/usr/bin/env python3
"""O7 (MUST): the publik balance is in US dollars and cents, matches what publik holds, changes after paid use with no
restart, never "credits". Ground truth: the evaluator's own arithmetic (5.00 - 3 x 0.01 = 4.97) and the stand-in's
ledger, which follows the contract (a hold at admission, the real charge settled after the stream)."""
import glob, json, os, re, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))
import harness as H
import checks as C

pub = H.Standin('publik', '--balance', '5.00', '--price', '0.01', '--hold', '0.05', '--settle-delay', '1.0')
jl = H.JL('cli', publik=pub)
jl.run('publik', 'connect', '--yes')
jl.run('use', 'publik')
shown_after_call = []
for i in range(3):
    rc, out, dt = jl.run('chat', 'Reply with the word ready')
    shown_after_call += C.dollar_amounts(out)
time.sleep(10)
expected = 5.00 - 3 * 0.01
truth = pub.state()['available_micros']
H.check('stand-in-ledger-agrees-with-arithmetic', truth == 4_970_000, 'stand-in available=%d expected=%d' % (truth, round(expected * 1e6)), 'O7', 'high')
rc, out, dt = jl.run('status')
ok, shown = C.expect_balance(out, '$4.97')
H.check('cli-status-balance-4.97', ok, 'shown=%s after-call lines=%s' % (shown, shown_after_call), 'O7', 'high')
rc, out, dt = jl.run('publik', 'status')
ok, shown = C.expect_balance(out, '$4.97')
H.check('cli-publik-status-balance-4.97', ok, 'shown=%s out=%s' % (shown, H.short(out, 200)), 'O7', 'high')
jl.cleanup()

# the long-lived app process: 3 paid chats, wait 10 s, read the balance the UI would show (GET /api/v1/publik)
pub2 = H.Standin('publik', '--balance', '5.00', '--price', '0.01', '--hold', '0.05', '--settle-delay', '1.0', name='publik2')
jl = H.JL('api', publik=pub2)
jl.run('publik', 'connect', '--yes')
jl.run('use', 'publik')
srv = H.Serve(jl)
st, hd, body = srv.req('GET', '/api/v1/publik')
before = (body.get('wallet') or {}).get('balanceMicros') if isinstance(body, dict) else None
for i in range(3):
    srv.sse('/api/v1/ai/chat', {'requestId': 'b%d' % i, 'messages': [{'role': 'user', 'content': 'Reply with the word ready'}]})
time.sleep(10)
st, hd, body = srv.req('GET', '/api/v1/publik')
after = (body.get('wallet') or {}).get('balanceMicros') if isinstance(body, dict) else None
H.check('api-balance-fresh-after-10s', after == 4_970_000, 'before=%s after(GET /api/v1/publik)=%s stand-in=%s' % (before, after, pub2.state()['available_micros']), 'O7', 'high')
# someone adds money on the publik website: the app shows it without a restart
pub2.admin('add', {'usd': 2.5})
time.sleep(1)
st, hd, body = srv.req('GET', '/api/v1/publik')
after2 = (body.get('wallet') or {}).get('balanceMicros') if isinstance(body, dict) else None
st, hd, body_r = srv.req('POST', '/api/v1/publik/refresh', None)
after3 = (body_r.get('wallet') or {}).get('balanceMicros') if isinstance(body_r, dict) else None
H.check('api-balance-sees-top-up-without-restart', after2 == 7_470_000 or after3 == 7_470_000, 'GET=%s refresh=%s' % (after2, after3), 'O7', 'high')
srv.stop()
jl.cleanup()

# the same with a short, realistic settlement delay (0.2 s after the stream ends)
pub4 = H.Standin('publik', '--balance', '5.00', '--price', '0.01', '--hold', '0.05', '--settle-delay', '0.2', name='publik4')
jl = H.JL('api-fast', publik=pub4)
jl.run('publik', 'connect', '--yes')
jl.run('use', 'publik')
srv = H.Serve(jl)
srv.sse('/api/v1/ai/chat', {'requestId': 'f1', 'messages': [{'role': 'user', 'content': 'Reply with the word ready'}]})
time.sleep(10)
st, hd, body = srv.req('GET', '/api/v1/publik')
got = (body.get('wallet') or {}).get('balanceMicros') if isinstance(body, dict) else None
H.check('api-balance-fresh-after-10s[settle 0.2s]', got == 4_990_000, 'GET=%s stand-in=%s' % (got, pub4.state()['available_micros']), 'O7', 'high')
st, hd, body = srv.req('POST', '/api/v1/publik/refresh', None)
got2 = (body.get('wallet') or {}).get('balanceMicros') if isinstance(body, dict) else None
H.check('api-manual-refresh-corrects-it', got2 == 4_990_000, 'refresh=%s' % got2, 'O7', 'medium')
srv.stop()
jl.cleanup()

# rounding at the edges (expected strings computed by hand)
pub3 = H.Standin('publik', name='publik3')
jl = H.JL('round', publik=pub3)
jl.run('publik', 'connect', '--yes')
cases = [(0.0, ['$0.00']), (0.004, ['<$0.01']), (0.000001, ['<$0.01']), (0.01, ['$0.01']), (0.019999, ['$0.01', '$0.02']),
         (4.969999, ['$4.96', '$4.97']), (1234567.891, ['$1,234,567.89', '$1234567.89']), (-0.25, ['$0.00', '-$0.25', '−$0.25'])]
for usd, allowed in cases:
    pub3.admin('balance', {'usd': usd})
    rc, out, dt = jl.run('publik', 'status')
    shown = [a for l in out.splitlines() if 'balance' in l.lower() for a in C.dollar_amounts(l)]
    bal_lines = [l for l in out.splitlines() if 'balance:' in l.lower()]
    raw = [a for l in bal_lines for a in re.findall(r'-?\$[0-9][0-9,]*\.[0-9]{2}|<\$0\.01|−\$[0-9.]+', l)]
    H.check('rounding[%s]' % usd, any(a in allowed for a in raw) and not any(a not in allowed for a in raw),
            'allowed=%s shown=%s line=%s' % (allowed, raw, [l for l in out.splitlines() if 'alance' in l][:1]), 'O7', 'high' if usd in (0.004, 0.000001, 0.0, -0.25) else 'medium')
jl.cleanup()

# "credit(s)" or "tokens" as money in any text the product printed during every probe run so far
hits = []
for f in glob.glob(os.path.join(H.OUT, '*-transcript.json')):
    for line in open(f, encoding='utf-8'):
        d = json.loads(line)
        for r in d['runs']:
            txt = (r.get('out') or '') + (r.get('err') or '')
            for m in re.finditer(r'[^\n]*\b(credits?|tokens? left|out of tokens)\b[^\n]*', txt, re.I):
                hits.append((os.path.basename(f), r['args'][:2], m.group(0)[:160]))
jl = H.JL('help')
rc, out, dt = jl.run('help')
for m in re.finditer(r'[^\n]*\bcredits?\b[^\n]*', out, re.I):
    hits.append(('help', 'help', m.group(0)))
jl.cleanup()
H.check('no-credit-wording-in-any-output', not hits, 'hits=%s' % hits[:10], 'O7', 'high')
H.finish()
