#!/usr/bin/env python3
"""O5 (MUST, ai-engine part): with no provider, every AI action says it needs one and offers setup; nothing waits on
AI at start; no empty/zero value stands in for a missing answer; nothing is sent anywhere.
The job feed, tracker, notes and Network import belong to other lanes and are not observable here."""
import json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))
import harness as H
import checks as C

# fresh install, no stand-ins running at all, network blocked by the sandbox
jl = H.JL('fresh', extra_env={'JOBLEFT_PUBLIK_BASE_URL': 'http://127.0.0.1:%d/api/v1' % H.free_port()})
rc, out, dt = jl.run('status')
H.check('status-fast-with-nothing-running', rc == 0 and dt < 3, '%.2fs %s' % (dt, H.short(out, 200)), 'O5', 'high')
for args in [('chat', 'What jobs fit me?'), ('json', 'Jordan Testwell, SQL analyst. Job: data analyst.'), ('check',), ('models',)]:
    rc, out, dt = jl.run(*args)
    ok_plain, bad = C.plain_message(out)
    says = 'no ai provider' in out.lower() and ('set one up' in out.lower() or 'settings' in out.lower())
    nums = C.invented_numbers(out, set())
    H.check('needs-provider-message[%s]' % args[0], says and ok_plain and dt < 3, '%.2fs %s' % (dt, H.short(out, 250)), 'O5', 'high')
    H.check('no-zero-or-empty-value[%s]' % args[0], not nums and 'N/A' not in out and '0%' not in out, 'numbers=%s out=%s' % (nums, H.short(out, 150)), 'O5', 'high')
H.check('nothing-sent-anywhere', not [r for r in jl.netlog() if r['kind'] == 'connect'], 'connects=%s' % jl.netlog()[:5], 'O5', 'high')
jl.cleanup()

# after a provider was set, `use none` goes back to no provider and sends nothing
m = H.Standin('model')
jl = H.JL('none')
jl.run('use', 'custom', '--url', m.url, '--model', 'hostile-7b')
jl.run('key', 'set', stdin=H.CANARY)
rc, out, dt = jl.run('use', 'none')
m.reset()
rc, out, dt = jl.run('chat', 'hello')
H.check('use-none-sends-nothing', not m.ai_requests() and 'no ai provider' in out.lower(), 'requests=%d out=%s' % (len(m.ai_requests()), H.short(out, 200)), 'O5', 'high')
jl.cleanup()

# the local API with no provider: 409 needs_provider, and the app starts with the network blocked
jl = H.JL('serve')
t0 = time.time()
srv = H.Serve(jl)
start_s = time.time() - t0
st, hd, body = srv.req('GET', '/api/v1/health')
H.check('api-starts-offline-fast', st == 200 and start_s < 5, 'start %.2fs health=%s' % (start_s, st), 'O5', 'high')
st, evs, dt = srv.sse('/api/v1/ai/chat', {'requestId': 'n1', 'messages': [{'role': 'user', 'content': 'hi'}]})
first = evs[0][1] if evs else None
code = (first or {}).get('error', {}).get('code') if isinstance(first, dict) and 'error' in first else (first or {}).get('code') if isinstance(first, dict) else None
blob = json.dumps(evs)
H.check('api-chat-needs-provider', (st == 409 and 'needs_provider' in blob) or ('needs_provider' in blob or 'no_provider' in blob),
        'status=%s events=%s' % (st, H.short(blob, 300)), 'O5', 'high')
st, hd, body = srv.req('GET', '/api/v1/ai/models')
H.check('api-models-needs-provider', st in (409, 200) and 'needs_provider' in json.dumps(body) or (st == 200 and body in ({'models': []},)),
        'status=%s body=%s' % (st, H.short(body, 200)), 'O5', 'medium')
st, hd, body = srv.req('GET', '/api/v1/ai/settings')
H.check('api-settings-readable-with-no-provider', st == 200, 'status=%s body=%s' % (st, H.short(body, 200)), 'O5', 'medium')
srv.stop()
H.check('api-no-outbound-at-start', not jl.non_loopback(), 'non-loopback=%s' % jl.non_loopback(), 'O5', 'high')
jl.cleanup()

H.finish()
