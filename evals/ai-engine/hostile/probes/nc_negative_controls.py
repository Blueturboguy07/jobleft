#!/usr/bin/env python3
"""Negative controls: each one feeds a deliberately wrong or doctored result through the SAME check the real probe
uses and confirms that the check FAILS. A negative control "passes" only when its check failed as intended."""
import json, os, re, subprocess, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))
import harness as H
import checks as C

NC = []


def control(name, check_result, evidence):
    """check_result = what the real check returned on the doctored input; it must be False."""
    failed_as_intended = check_result is False or check_result == [] or check_result is None
    NC.append({'name': name, 'probeFailedAsIntended': bool(failed_as_intended), 'evidence': evidence})
    H.check('negative-control[%s]' % name, failed_as_intended, evidence, 'NC', 'critical')


# 1. O7 balance: the stand-in secretly charges $0.02, the probe still expects $4.97 -> must fail
pub = H.Standin('publik', '--balance', '5.00', '--price', '0.02', '--hold', '0.05', '--settle-delay', '0.2')
jl = H.JL('nc-balance', publik=pub)
jl.run('publik', 'connect', '--yes')
jl.run('use', 'publik')
for i in range(3):
    jl.run('chat', 'Reply with the word ready')
time.sleep(2)
rc, out, dt = jl.run('status')
ok, shown = C.expect_balance(out, '$4.97')
control('O7-balance-with-doctored-price', ok, 'shown=%s (true balance $4.94)' % shown)
jl.cleanup()

# 2. O8 leak scan: plant the canary in a file in the data folder -> the scan must find it
m = H.Standin('model')
jl = H.JL('nc-leak')
jl.run('use', 'custom', '--url', m.url, '--model', 'hostile-7b')
jl.run('key', 'set', stdin=H.CANARY)
os.makedirs(os.path.join(jl.home, 'logs'), exist_ok=True)
open(os.path.join(jl.home, 'logs', 'debug.log'), 'w').write('request headers: authorization: Bearer ' + H.CANARY + '\n')
hits = jl.grep_home(H.CANARY)
control('O8-planted-canary-is-found', not hits, 'hits=%s' % [os.path.relpath(h, jl.home) for h in hits])
jl.cleanup()

# 3. O9 routing: send the canary to stand-in B by hand -> "only at A" must fail
A = H.Standin('model', name='A')
B = H.Standin('model', name='B')
H.http('GET', A.url + '/v1/models', headers={'authorization': 'Bearer ' + H.CANARY})
H.http('GET', B.url + '/v1/models?key=' + H.CANARY, headers={'authorization': 'Bearer ' + H.CANARY})
hits = C.leak_positions(H.CANARY, [('A', A.ai_requests()), ('B', B.ai_requests())])
control('O9-canary-at-wrong-server-is-caught', C.only_in(hits, 'A', ['authorization']), 'hits=%s' % sorted(set(hits)))

# 4. O6 link count: a doctored message with two links -> "exactly one link" must fail
doctored = 'Your publik balance ran out ($0.00 left).\nAdd money: https://publikhq.com/claim/HK7F-2QWD\nSee plans: https://publikhq.com/developers#plans'
control('O6-two-links-are-caught', len(C.links(doctored)) == 1, 'links=%s' % C.links(doctored))
control('O6-credit-word-is-caught', not C.forbidden_money_words('Not enough publik credit (error 402).'), 'found=%s' % C.forbidden_money_words('Not enough publik credit (error 402).'))

# 5. O14: a request WITH the valid token and no Origin -> the "refused" condition must fail
jl = H.JL('nc-api')
srv = H.Serve(jl)
st, hd, b = srv.req('GET', '/api/v1/ai/settings')
control('O14-valid-token-is-not-refused', st in (401, 403), 'status=%s' % st)
srv.stop()
jl.cleanup()

# 6. O12: a screen that shows a number the model never sent -> the invented-number check must catch it
shown = 'Fit score: 50%\nReasons: SQL'
invented = C.invented_numbers(shown, {'140'})
control('O12-invented-50-is-caught', invented == [] , 'invented=%s' % invented)

# 7. O1: the chat output checked against a nonce the stand-in never sent -> must fail
jl = H.JL('nc-nonce')
jl.run('use', 'custom', '--url', m.url, '--model', 'hostile-7b')
rc, out, dt = jl.run('chat', 'Reply with the word ready')
control('O1-wrong-nonce-is-caught', 'NWRONGNONCE0' in out, 'real nonce %s present=%s' % (m.nonce, m.nonce in out))
jl.cleanup()

# 8. O3: a vague message must not count as naming "key refused"
control('O3-vague-message-is-caught', 'key_refused' in C.categories('Something went wrong. Please try again.'), 'categories=%s' % C.categories('Something went wrong. Please try again.'))

# 9. O10: a request that DID reach the publik stand-in -> "zero requests" must fail
pub2 = H.Standin('publik', name='nc-publik2')
H.http('GET', pub2.url + '/api/v1/wallet', headers={'authorization': 'Bearer pk_test_x'})
control('O10-request-to-publik-is-caught', not pub2.log(), 'publik log entries=%d' % len(pub2.log()))

# 10. O11: the network monitor sees a non-loopback attempt (the sandbox blocks it; nothing leaves)
jl = H.JL('nc-net')
subprocess.run(['sandbox-exec', '-f', os.path.join(H.HERE, 'loopback-only.sb'), 'node', '-e',
                'fetch("http://192.0.2.10:81/").catch(()=>{}); require("dns").lookup("blocked.invalid", ()=>{})'],
               env=jl.env, capture_output=True, text=True, timeout=30)
time.sleep(0.5)
nl = jl.non_loopback()
control('O11-monitor-sees-outbound-attempt', not nl, 'attempts=%s' % nl[:3])
jl.cleanup()

# 11. O4: a stand-in that answers only after 3 s, timed against a 1 s bar -> the timing check must fail
m.mode('delay', delay_s=3)
jl = H.JL('nc-time')
jl.run('use', 'custom', '--url', m.url, '--model', 'hostile-7b')
m.mode('delay', delay_s=3)
rc, out, dt = jl.run('chat', 'hello')
control('O4-slow-answer-fails-a-1s-bar', dt < 1.0, '%.2fs' % dt)
m.mode('ok')
jl.cleanup()

with open(os.path.join(H.OUT, 'negative-controls.json'), 'w') as f:
    json.dump(NC, f, indent=1)
H.finish()
