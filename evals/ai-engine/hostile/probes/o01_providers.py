#!/usr/bin/env python3
"""O1 (MUST): chat works through every provider type; the choice survives a restart; the label shows provider and
model; no Claude consumer-subscription sign-in. Ground truth = a random nonce that only the evaluator's stand-in knows,
and the stand-in's own request log."""
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))
import harness as H
import checks as C

m = H.Standin('model', '--models', 'hostile-7b,hostile-think-8b,hostile-embed')
single = H.Standin('model', '--models', 'only-one-model-q4', name='single')
keyed = H.Standin('model', '--key', H.CANARY, name='keyed')
pub = H.Standin('publik', '--balance', '5.00', '--price', '0.01')


def chat_ok(jl, server, label_part, cid):
    rc, out, dt = jl.run('chat', 'Reply with the word ready')
    ok = rc == 0 and server.nonce in out and label_part in out
    H.check(cid, ok, 'rc=%s %.2fs out=%s' % (rc, dt, H.short(out, 300)), 'O1', 'high')
    return ok


# 1. custom address, every spelling of the address
for i, url in enumerate(['127.0.0.1:%d' % m.port, 'http://127.0.0.1:%d' % m.port, 'http://127.0.0.1:%d/' % m.port,
                         'http://127.0.0.1:%d/v1' % m.port, 'http://127.0.0.1:%d/v1/' % m.port, 'localhost:%d' % m.port,
                         'HTTP://127.0.0.1:%d/V1' % m.port]):
    jl = H.JL('custom%d' % i)
    rc, out, dt = jl.run('use', 'custom', '--url', url, '--model', 'hostile-7b')
    H.check('custom-url-accepted[%s]' % url, rc == 0 and 'Works' in out, H.short(out), 'O1', 'high')
    chat_ok(jl, m, 'hostile-7b', 'custom-chat[%s]' % url)
    jl.cleanup()

# 2. custom address that needs a key (key read from stdin)
jl = H.JL('customkey')
jl.run('use', 'custom', '--url', keyed.url, '--model', 'hostile-7b')
rc, out, dt = jl.run('key', 'set', stdin=H.CANARY)
rc, out, dt = jl.run('check')
H.check('custom-with-key-check', rc == 0 and 'Works' in out, H.short(out), 'O1', 'high')
chat_ok(jl, keyed, 'hostile-7b', 'custom-with-key-chat')
jl.cleanup()

# 3. local server, OpenAI style, Ollama dialect, llama.cpp style with a single model and no --model
jl = H.JL('localoai')
rc, out, dt = jl.run('use', 'local', '--kind', 'openai_compatible', '--url', m.url, '--model', 'hostile-7b')
H.check('local-openai-compatible-saved', rc == 0 and 'Works' in out, H.short(out), 'O1', 'high')
chat_ok(jl, m, 'hostile-7b', 'local-openai-compatible-chat')
jl.cleanup()

m.reset()
jl = H.JL('localollama')
rc, out, dt = jl.run('use', 'local', '--kind', 'ollama', '--url', m.url, '--model', 'hostile-7b')
H.check('local-ollama-saved', rc == 0 and 'Works' in out, H.short(out), 'O1', 'high')
chat_ok(jl, m, 'hostile-7b', 'local-ollama-chat')
paths = [e['path'] for e in m.ai_requests()]
H.check('local-ollama-uses-native-api', any(p.startswith('/api/chat') for p in paths), 'paths=%s' % paths, 'O1', 'medium')
H.check('local-ollama-never-pulls', not any(p.startswith('/api/pull') for p in paths), 'paths=%s' % paths, 'O1', 'high')
jl.cleanup()

single.reset()
jl = H.JL('llamacpp')
rc, out, dt = jl.run('use', 'local', '--kind', 'llamacpp', '--url', single.url)
rc2, out2, dt2 = jl.run('chat', 'Reply with the word ready')
sent_models = sorted({json.loads(e['body']).get('model') for e in single.ai_requests() if e['method'] == 'POST' and e['body']})
H.check('llamacpp-single-model-no-fixed-name', rc2 == 0 and single.nonce in out2 and all(x in (None, 'only-one-model-q4') for x in sent_models),
        'use: %s | chat rc=%s %s | models sent=%s' % (H.short(out, 200), rc2, H.short(out2, 200), sent_models), 'O1', 'high')
jl.cleanup()

# 4. own key for each named vendor (vendor host mapped to the stand-in, loopback only)
hostmap = json.dumps({h: keyed.url for h in ['api.openai.com', 'api.anthropic.com', 'openrouter.ai', 'generativelanguage.googleapis.com']})
for vendor, hdr in [('openai', 'authorization'), ('anthropic', 'x-api-key'), ('openrouter', 'authorization'), ('google', 'authorization')]:
    keyed.reset()
    jl = H.JL('own' + vendor, extra_env={'JOBLEFT_AI_HOST_MAP': hostmap})
    jl.run('use', 'own-key', '--vendor', vendor, '--model', 'hostile-7b')
    jl.run('key', 'set', stdin=H.CANARY)
    ok = chat_ok(jl, keyed, 'hostile-7b', 'own-key-chat[%s]' % vendor)
    hits = C.leak_positions(H.CANARY, [('keyed', keyed.ai_requests())])
    H.check('own-key-header[%s]' % vendor, C.only_in(hits, 'keyed', [hdr]), 'hits=%s' % hits, 'O1', 'high')
    jl.cleanup()

# 5. publik
jl = H.JL('publik', publik=pub)
rc, out, dt = jl.run('publik', 'connect', '--yes')
H.check('publik-connect', rc == 0 and 'connected' in out.lower(), H.short(out), 'O1', 'high')
rc, out, dt = jl.run('use', 'publik')
H.check('publik-use', rc == 0 and 'Works' in out, H.short(out), 'O1', 'high')
chat_ok(jl, pub, 'publik', 'publik-chat')
# restart: a new process still uses the saved choice, and says which
rc, out, dt = jl.run('status')
H.check('publik-choice-survives-restart', 'publik' in out.lower() and 'Provider: none' not in out, H.short(out), 'O1', 'high')
jl.cleanup()

# 6. the full option list, and no Claude subscription sign-in
jl = H.JL('opts')
rc, out, dt = jl.run('providers')
opts = [l.split()[0] for l in out.splitlines() if l.startswith('  ') and l.split()]
H.check('provider-options-are-four', opts == ['publik', 'local', 'custom', 'own-key'], 'options=%s' % opts, 'O1', 'high')
bad = [w for w in ['claude.ai', 'Claude Pro', 'Claude Max', 'setup-token', 'sign in with Claude', 'OAuth'] if w.lower() in out.lower()]
H.check('no-claude-subscription-option', not bad, 'found=%s out=%s' % (bad, H.short(out, 500)), 'O1', 'critical')
rc, out, dt = jl.run('use', 'claude')
H.check('no-hidden-claude-provider', rc != 0, H.short(out), 'O1', 'critical')
rc, out, dt = jl.run('use', 'own-key', '--vendor', 'claude-subscription', '--model', 'x')
H.check('no-hidden-claude-vendor', rc != 0, H.short(out), 'O1', 'critical')
# an unknown vendor must be refused, not saved as a broken provider that prints "undefined"
rc2, out2, dt2 = jl.run('status')
H.check('unknown-vendor-refused-not-saved', ('Saved' not in out) and ('undefined' not in out + out2),
        'use: %s | status: %s' % (H.short(out, 200), H.short(out2, 300)), 'O1', 'low')
jl.cleanup()

# 7. model list = what the server has (random names the product cannot guess)
m.mode('ok', models=['zz-rand-a1', 'zz-rand-b2'])
jl = H.JL('models')
jl.run('use', 'custom', '--url', m.url, '--model', 'zz-rand-a1')
rc, out, dt = jl.run('models')
H.check('model-list-matches-server', sorted(out.split()) == ['zz-rand-a1', 'zz-rand-b2'], H.short(out), 'O1', 'medium')
rc, out, dt = jl.run('use', 'custom', '--url', m.url, '--model', 'hostile-7b')
H.check('absent-model-is-refused-at-save', 'Works' not in out, H.short(out), 'O1', 'high')
jl.cleanup()
m.mode('ok', models=['hostile-7b', 'hostile-think-8b', 'hostile-embed'])

# 8. a custom address with a path prefix (for example a proxy at /openai/v1)
m.reset()
jl = H.JL('prefix')
rc, out, dt = jl.run('use', 'custom', '--url', m.url + '/openai/v1', '--model', 'hostile-7b')
rc2, out2, dt2 = jl.run('chat', 'Reply with the word ready')
paths = [e['path'] for e in m.ai_requests()]
H.check('custom-path-prefix-kept', rc2 == 0 and m.nonce in out2 and any(p.startswith('/openai/v1/chat/completions') for p in paths),
        'paths=%s out=%s' % (paths, H.short(out2, 200)), 'O1', 'medium')
jl.cleanup()

H.finish()
