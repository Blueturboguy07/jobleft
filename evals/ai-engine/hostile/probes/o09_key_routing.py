#!/usr/bin/env python3
"""O9 (MUST): a key goes only to its own provider's address, only in a header, never in a URL; the publik key never
goes to another provider; switching provider never carries the old key; a redirect never carries a key elsewhere.
Ground truth: the request logs of every evaluator stand-in (each logs all headers, the raw path and the body)."""
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))
import harness as H
import checks as C

K = H.CANARY
A = H.Standin('model', name='A')
A.mode('ok', key=K)
B = H.Standin('model', name='B')
pub = H.Standin('publik', '--balance', '5.00')


def logs():
    return [('A', A.ai_requests()), ('B', B.ai_requests()), ('publik', pub.log())]


jl = H.JL('main', publik=pub)
jl.run('use', 'custom', '--url', A.url, '--model', 'hostile-7b')
jl.run('key', 'set', stdin=K)
for args in [('check',), ('chat', 'hello'), ('json', 'Jordan Testwell, SQL analyst. Job: data analyst.'), ('models',)]:
    jl.run(*args)
# switch to B: the first request (the setup check) and every later one must carry no key
jl.run('use', 'custom', '--url', B.url, '--model', 'hostile-7b')
rc, out, dt = jl.run('status')
H.check('new-address-starts-with-no-key', 'none saved' in out.lower(), [l for l in out.splitlines() if 'Key' in l], 'O9', 'high')
for args in [('chat', 'hello'), ('json', 'Jordan Testwell, SQL analyst. Job: data analyst.'), ('models',), ('check',)]:
    jl.run(*args)
b_auth = [e['path'] for e in B.ai_requests() if e['headers'].get('authorization') or e['headers'].get('x-api-key')]
H.check('switched-provider-gets-no-auth-header', not b_auth, 'B requests with an auth header: %s' % b_auth, 'O9', 'critical')
# publik connected and used: the custom key never goes to publik
jl.run('publik', 'connect', '--yes')
jl.run('use', 'publik')
jl.run('chat', 'hello')
jl.run('json', 'Jordan Testwell, SQL analyst. Job: data analyst.')
pkey = next(iter(pub.state()['keys']), 'NO-PUBLIK-KEY')
# back to A: the publik key never goes to A or B
jl.run('use', 'custom', '--url', A.url, '--model', 'hostile-7b')
jl.run('chat', 'hello again')
jl.run('use', 'custom', '--url', B.url, '--model', 'hostile-7b')
jl.run('chat', 'hello again')

hits = C.leak_positions(K, logs())
H.check('canary-only-at-A-in-authorization', C.only_in(hits, 'A', ['authorization']), 'hits=%s' % sorted(set(hits)), 'O9', 'critical')
phits = C.leak_positions(pkey, logs())
H.check('publik-key-only-at-publik-in-header', C.only_in(phits, 'publik', ['authorization', 'x-api-key']), 'hits=%s' % sorted(set(phits)), 'O9', 'critical')
url_hits = [h for h in hits + phits if h[1].startswith('url:')]
H.check('no-key-in-any-url', not url_hits, 'url hits=%s' % url_hits, 'O9', 'critical')
jl.cleanup()

# own keys: a key saved for OpenAI never goes to the Anthropic address, and the reverse
A.reset(); B.reset()
A.mode('ok', key=None); B.mode('ok', key=None)
hostmap = json.dumps({'api.openai.com': A.url, 'api.anthropic.com': B.url})
jl = H.JL('vendors', extra_env={'JOBLEFT_AI_HOST_MAP': hostmap})
jl.run('use', 'own-key', '--vendor', 'openai', '--model', 'hostile-7b')
jl.run('key', 'set', stdin='sk-openai-ONLY-1111')
jl.run('chat', 'hello')
jl.run('use', 'own-key', '--vendor', 'anthropic', '--model', 'hostile-7b')
rc, out, dt = jl.run('chat', 'hello')
jl.run('key', 'set', stdin='sk-ant-ONLY-2222')
jl.run('chat', 'hello')
jl.run('use', 'own-key', '--vendor', 'openai', '--model', 'hostile-7b')
jl.run('chat', 'hello')
h1 = C.leak_positions('sk-openai-ONLY-1111', [('A', A.ai_requests()), ('B', B.ai_requests())])
h2 = C.leak_positions('sk-ant-ONLY-2222', [('A', A.ai_requests()), ('B', B.ai_requests())])
H.check('openai-key-only-to-openai', C.only_in(h1, 'A', ['authorization']), 'hits=%s' % sorted(set(h1)), 'O9', 'critical')
H.check('anthropic-key-only-to-anthropic', C.only_in(h2, 'B', ['x-api-key']), 'hits=%s' % sorted(set(h2)), 'O9', 'critical')
jl.cleanup()

# a provider that redirects (307) to another address: the key must not follow
for vendor, hdr in [('custom', 'authorization'), ('anthropic', 'x-api-key'), ('openai', 'authorization')]:
    A.reset(); B.reset()
    A.mode('redirect', redirect_to=B.url, key=None)
    B.mode('ok', key=None)
    rkey = 'sk-redirect-%s-5555' % vendor
    if vendor == 'custom':
        jl = H.JL('redir-' + vendor)
        jl.run('use', 'custom', '--url', A.url, '--model', 'hostile-7b')
    else:
        jl = H.JL('redir-' + vendor, extra_env={'JOBLEFT_AI_HOST_MAP': json.dumps({'api.openai.com': A.url, 'api.anthropic.com': A.url})})
        jl.run('use', 'own-key', '--vendor', vendor, '--model', 'hostile-7b')
    jl.run('key', 'set', stdin=rkey)
    rc, out, dt = jl.run('chat', 'hello')
    rh = C.leak_positions(rkey, [('A', A.ai_requests()), ('B', B.ai_requests())])
    H.check('redirect-does-not-carry-key[%s]' % vendor, not [h for h in rh if h[0] == 'B'],
            'hits=%s B-requests=%d chat=%s' % (sorted(set(rh)), len(B.ai_requests()), H.short(out, 150)), 'O9', 'high')
    jl.cleanup()
A.mode('ok', key=None)

# the local API: switching provider through PUT /api/v1/ai/settings does not carry the key either
A.reset(); B.reset()
A.mode('ok', key=K)
jl = H.JL('api')
srv = H.Serve(jl)
srv.req('PUT', '/api/v1/ai/settings', {'provider': 'custom', 'baseUrl': A.url, 'model': 'hostile-7b'})
srv.req('PUT', '/api/v1/ai/key', {'key': K})
srv.sse('/api/v1/ai/chat', {'requestId': 'a1', 'messages': [{'role': 'user', 'content': 'hi'}]})
st, hd, body = srv.req('PUT', '/api/v1/ai/settings', {'provider': 'custom', 'baseUrl': B.url, 'model': 'hostile-7b'})
srv.sse('/api/v1/ai/chat', {'requestId': 'a2', 'messages': [{'role': 'user', 'content': 'hi'}]})
srv.stop()
hits = C.leak_positions(K, [('A', A.ai_requests()), ('B', B.ai_requests())])
H.check('api-switch-does-not-carry-key', C.only_in(hits, 'A', ['authorization']) and B.ai_requests(),
        'hits=%s B requests=%d put=%s' % (sorted(set(hits)), len(B.ai_requests()), H.short(body, 200)), 'O9', 'critical')
jl.cleanup()

H.finish()
