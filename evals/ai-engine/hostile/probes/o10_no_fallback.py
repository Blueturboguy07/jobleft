#!/usr/bin/env python3
"""O10 (MUST): when the chosen provider fails, the app reports it and never sends the request to another provider.
Ground truth: request logs of the publik stand-in and a second model stand-in (pass: zero requests), and the
publik stand-in's ledger (pass: no change)."""
import json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))
import harness as H
import checks as C

pub = H.Standin('publik', '--balance', '5.00')
second = H.Standin('model', name='second')
local = H.Standin('model', name='local')

jl = H.JL('main', publik=pub)
# everything is set up: publik connected, a custom provider with a key, then the person chooses the local server
jl.run('publik', 'connect', '--yes')
jl.run('use', 'custom', '--url', second.url, '--model', 'hostile-7b')
jl.run('key', 'set', stdin='sk-second-provider-7777')
jl.run('use', 'local', '--kind', 'openai_compatible', '--url', local.url, '--model', 'hostile-7b')
bal_before = pub.state()['available_micros']
pub.reset(); second.reset()
RESUME = 'Jordan Testwell. Skills: SQL, Excel. Email jordan.testwell@example.com'

for label, prep in [('stopped', lambda: local.stop()), ]:
    prep()
    outs = []
    for args in [('chat', 'Tell me about my resume: ' + RESUME), ('json', RESUME + ' Job: data analyst.'), ('check',), ('models',), ('chat', '--resend')]:
        rc, out, dt = jl.run(*args)
        outs.append((args[0], rc, H.short(out, 120)))
    H.check('local-%s-reports-failure' % label, all(rc != 0 for _, rc, _ in outs[:2]) and all('unreachable' in C.categories(o) or 'nothing answers' in o.lower() for _, _, o in outs[:2]),
            'outs=%s' % outs, 'O10', 'high')
H.check('no-request-to-publik', not pub.log(), 'publik requests=%s' % [(e['method'], e['path']) for e in pub.log()], 'O10', 'critical')
H.check('no-request-to-second-provider', not second.ai_requests(), 'second requests=%d' % len(second.ai_requests()), 'O10', 'critical')
H.check('balance-unchanged', pub.state()['available_micros'] == bal_before, 'before=%d after=%d' % (bal_before, pub.state()['available_micros']), 'O10', 'critical')

# the local server answers with errors of every kind: still no other provider
local = H.Standin('model', name='local2')
jl.run('use', 'local', '--kind', 'openai_compatible', '--url', local.url, '--model', 'hostile-7b')
pub.reset(); second.reset()
for mode in ['error500', 'refuse-key', 'model-not-found', 'html', 'quota429', 'half', 'empty', 'text']:
    local.mode(mode)
    jl.run('chat', 'hello ' + mode)
    jl.run('json', RESUME + ' Job: data analyst.')
H.check('errors-never-fall-back', not pub.log() and not second.ai_requests(),
        'publik=%d second=%d' % (len(pub.log()), len(second.ai_requests())), 'O10', 'critical')

# Ollama dialect, stopped
ol = H.Standin('model', name='ollama')
jl.run('use', 'local', '--kind', 'ollama', '--url', ol.url, '--model', 'hostile-7b')
ol.stop()
pub.reset(); second.reset()
jl.run('chat', 'hello')
jl.run('json', RESUME)
H.check('ollama-stopped-no-fallback', not pub.log() and not second.ai_requests(), 'publik=%d second=%d' % (len(pub.log()), len(second.ai_requests())), 'O10', 'critical')

# the reverse: publik chosen and failing (503, 402, revoked) never falls back to the local or custom provider
local3 = H.Standin('model', name='local3')
jl.run('use', 'local', '--kind', 'openai_compatible', '--url', local3.url, '--model', 'hostile-7b')
jl.run('use', 'publik')
local3.reset(); second.reset()
for mode, bal in [('unavailable', 5), ('ok', 0), ('ratelimit', 5)]:
    pub.admin('mode', {'mode': mode})
    pub.admin('balance', {'usd': bal})
    jl.run('chat', 'hello via publik')
    jl.run('json', RESUME)
pub.admin('mode', {'mode': 'ok'})
pub.admin('revoke-all', {})
jl.run('chat', 'hello via publik')
H.check('publik-failing-never-falls-back', not local3.ai_requests() and not second.ai_requests(),
        'local3=%d second=%d' % (len(local3.ai_requests()), len(second.ai_requests())), 'O10', 'critical')

# the local API, same rule
local4 = H.Standin('model', name='local4')
jl.run('use', 'local', '--kind', 'openai_compatible', '--url', local4.url, '--model', 'hostile-7b')
local4.stop()
pub.reset(); second.reset()
srv = H.Serve(jl)
st, evs, dt = srv.sse('/api/v1/ai/chat', {'requestId': 'f1', 'messages': [{'role': 'user', 'content': RESUME}]})
srv.req('POST', '/api/v1/ai/check', None)
srv.req('GET', '/api/v1/ai/models')
srv.stop()
H.check('api-no-fallback', not second.ai_requests() and not [e for e in pub.log() if 'chat' in e['path'] or 'embeddings' in e['path']],
        'publik=%s second=%d last=%s' % ([e['path'] for e in pub.log()], len(second.ai_requests()), H.short(evs[-1][1] if evs else None, 200)), 'O10', 'critical')
jl.cleanup()
H.finish()
