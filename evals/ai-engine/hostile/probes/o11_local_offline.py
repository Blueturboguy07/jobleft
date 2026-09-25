#!/usr/bin/env python3
"""O11 (MUST): with a local model, chat and every AI action work with the network off, and no AI data leaves the
computer. Network off = a macOS sandbox that denies every non-loopback connection and DNS; an in-process monitor
records every connect/DNS attempt. Uses the real local Ollama when it runs (qwen2.5:7b), else the stand-in."""
import json, os, sys, time, urllib.request
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))
import harness as H
import checks as C

RESUME = open(os.path.join(H.ROOT, 'data', 'persona-resume.txt'), encoding='utf-8').read()
JOB = open(os.path.join(H.ROOT, 'data', 'jobs.json'), encoding='utf-8').read()
JOB1 = json.loads(JOB)[0]


def ollama_model():
    try:
        with urllib.request.urlopen('http://127.0.0.1:11434/api/tags', timeout=2) as r:
            names = [m['name'] for m in json.load(r)['models']]
        for want in ['qwen2.5:7b', 'qwen2.5:14b', 'llama3.1:8b', 'mistral:7b']:
            if want in names:
                return want
    except Exception:
        return None
    return None


model = ollama_model()
jl = H.JL('real')
if model:
    rc, out, dt = jl.run('use', 'local', '--kind', 'ollama', '--model', model, timeout=200)
    H.check('real-local-model-setup', 'Works' in out, H.short(out, 200), 'O11', 'high')
else:
    s = H.Standin('model')
    jl.run('use', 'local', '--kind', 'ollama', '--url', s.url, '--model', 'hostile-7b')
t0 = time.time()
rc, out, dt = jl.run('chat', 'In one sentence: what is this job about? ' + JOB1['title'] + ' at ' + JOB1['company'], timeout=300)
H.check('local-chat-works-offline', rc == 0 and '[done]' in out, '%.1fs model=%s out=%s' % (dt, model, H.short(out, 200)), 'O11', 'high')
rc, out, dt = jl.run('json', 'Candidate resume:\n' + RESUME + '\n\nJob:\n' + JOB1['title'] + ' at ' + JOB1['company'] + '\n' + JOB1['description'], timeout=300)
H.check('local-json-works-offline', rc == 0 and 'Cannot use' not in out and '"score"' in out, '%.1fs out=%s' % (dt, H.short(out, 300)), 'O11', 'high')
rc, out, dt = jl.run('detect', timeout=60)
nl = jl.non_loopback()
H.check('no-non-loopback-attempt', not nl, 'attempts=%s' % nl[:5], 'O11', 'critical')
jl.cleanup()

# JOBLEFT_OFFLINE=1: loopback works; a non-loopback custom address is refused with a plain message and never tried
s = H.Standin('model', name='offline')
jl = H.JL('offline', extra_env={'JOBLEFT_OFFLINE': '1'})
jl.run('use', 'local', '--kind', 'openai_compatible', '--url', s.url, '--model', 'hostile-7b')
rc, out, dt = jl.run('chat', 'Reply with the word ready')
H.check('offline-mode-loopback-works', rc == 0 and s.nonce in out, H.short(out, 150), 'O11', 'high')
rc, out, dt = jl.run('use', 'custom', '--url', 'https://ai-provider.example/v1', '--model', 'm')
rc2, out2, dt2 = jl.run('chat', RESUME[:200])
H.check('offline-mode-refuses-remote', 'offline' in (out + out2).lower() and not jl.non_loopback(),
        'use: %s | chat: %s | attempts=%s' % (H.short(out, 150), H.short(out2, 150), jl.non_loopback()), 'O11', 'high')
jl.cleanup()

# a "local" provider must really be on this computer: tricky addresses must be refused and never contacted
tricky = ['http://192.168.1.20:8080', 'http://127.0.0.1@ai-provider.example:%d' % s.port, 'http://127.0.0.1.nip.io:%d' % s.port,
          'http://localhost.ai-provider.example:%d' % s.port, 'http://ai-provider.example#@127.0.0.1:%d' % s.port,
          'http://ai-provider.example/127.0.0.1:%d' % s.port, 'http://ai-provider.example?h=127.0.0.1', 'http://[fe80::1]:8080',
          'http://10.0.0.5:11434', 'http://example.com:11434']
for url in tricky:
    jl = H.JL('tricky')
    rc, out, dt = jl.run('use', 'local', '--kind', 'openai_compatible', '--url', url, '--model', 'hostile-7b')
    rc2, out2, dt2 = jl.run('status')
    accepted = ('Saved' in out) and ('local AI server' in out2 or 'local' in out2.split('Provider:')[-1][:60].lower())
    nl = jl.non_loopback()
    H.check('local-refuses-non-loopback[%s]' % url, not accepted and not nl, 'accepted=%s attempts=%s out=%s' % (accepted, nl[:3], H.short(out, 200)), 'O11', 'high')
    jl.cleanup()
# loopback spellings that ARE this computer may be accepted
for url in ['http://[::1]:%d' % s.port, 'http://localhost:%d' % s.port]:
    jl = H.JL('loopok')
    rc, out, dt = jl.run('use', 'local', '--kind', 'openai_compatible', '--url', url, '--model', 'hostile-7b')
    H.check('local-accepts-loopback[%s]' % url, 'Saved' in out, H.short(out, 200), 'O11', 'low')
    jl.cleanup()
H.finish()
