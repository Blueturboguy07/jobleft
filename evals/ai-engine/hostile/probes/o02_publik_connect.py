#!/usr/bin/env python3
"""O2 (MUST): connecting publik needs no hand-copied key; disconnect stops all spending and removes the key.
Ground truth: the key that the evaluator's contract-faithful publik stand-in minted (the product never sees it
except over the wire), and the stand-in's own request log and key table."""
import json, os, re, subprocess, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))
import harness as H
import checks as C

pub = H.Standin('publik', '--balance', '5.00', '--price', '0.01', '--settle-delay', '0.2')


def keys():
    return pub.state()['keys']


def clipboard_has(s):
    try:
        return s in subprocess.run(['pbpaste'], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return False


# --- connect with no key typed
jl = H.JL('main', publik=pub)
rc, out, dt = jl.run('publik', 'connect', '--yes')
ks = keys()
H.check('connect-mints-one-key', rc == 0 and len(ks) == 1, 'rc=%s keys=%d out=%s' % (rc, len(ks), H.short(out, 300)), 'O2', 'high')
key = list(ks)[0] if ks else 'NO-KEY-MINTED'
prompts = [l for l in out.splitlines() if any(w in l.lower() for w in ['paste your', 'paste the', 'enter your key', 'type your key', 'api key:', 'enter key'])]
H.check('connect-asks-for-no-key', not prompts, 'key prompts=%s' % prompts, 'O2', 'high')
H.check('connect-output-has-no-key', key not in out and key[:20] not in out, 'searched stdout+stderr for the minted key', 'O2', 'critical')
H.check('key-not-on-clipboard', not clipboard_has(key), 'pbpaste checked for the minted key', 'O2', 'high')
inst = [e for e in pub.log() if e['path'].endswith('/installs')]
H.check('connect-request-has-no-key-in-url', all(key not in e['path'] for e in pub.log()), 'paths=%s' % [e['path'] for e in pub.log()], 'O2', 'high')
body = json.loads(inst[0]['body']) if inst else {}
# personal identifiers of this computer, read at run time (never written into this file)
_ids = set()
for cmd in (['scutil', '--get', 'ComputerName'], ['scutil', '--get', 'LocalHostName'], ['id', '-un'], ['id', '-F']):
    try:
        v = subprocess.run(cmd, capture_output=True, text=True, timeout=5).stdout.strip()
        if v:
            _ids.add(v.lower())
            _ids.update(w.lower() for w in re.split(r"[\s'’-]+", v) if len(w) >= 4 and w.lower() not in ('macbook', 'pro', 'air', 'imac', 'mini', 'studio'))
    except Exception:
        pass
H.check('install-request-no-personal-device-name', not any(w in json.dumps(body).lower() for w in _ids),
        'install body=%s' % H.short(body, 400), 'O2', 'medium')
H.check('key-not-in-data-folder-plaintext', not jl.grep_home(key) and not jl.grep_home(key[8:20]), 'grep hits=%s' % jl.grep_home(key), 'O2', 'critical')

# --- use and spend
jl.run('use', 'publik')
rc, out, dt = jl.run('chat', 'Reply with the word ready')
H.check('chat-through-publik', rc == 0 and pub.nonce in out, H.short(out, 300), 'O2', 'high')
time.sleep(1.0)  # let the stand-in settle the streamed call (contract: settlement happens after the stream)
charges_before = len(pub.state()['charges'])

# --- disconnect
n_before = len(pub.log())
rc, out, dt = jl.run('publik', 'disconnect')
ks = keys()
H.check('disconnect-revokes-at-publik', ks.get(key, {}).get('revoked') is True, 'key record=%s out=%s' % (ks.get(key), H.short(out, 200)), 'O2', 'high')
revoke_calls = [e for e in pub.log()[n_before:] if e['path'].endswith('/installs/revoke')]
H.check('revoke-call-carries-key-in-header-only', revoke_calls and all(key not in e['path'] and key not in e['body'] for e in revoke_calls),
        'revoke calls=%d' % len(revoke_calls), 'O2', 'high')
H.check('key-gone-from-data-folder', not jl.grep_home(key), 'hits=%s' % jl.grep_home(key), 'O2', 'high')

# the stored key must really be gone: un-revoke it at publik, then try every AI action
pub.admin('unrevoke-all', {})
n_before = len(pub.log())
outs = []
for args in [('chat', 'hello after disconnect'), ('json', 'Jordan Testwell, SQL analyst. Job: data analyst with SQL.'), ('check',), ('models',), ('status',), ('chat', '--resend')]:
    rc, out, dt = jl.run(*args)
    outs.append((args[0], rc, H.short(out, 160)))
used = [e for e in pub.log()[n_before:] if key in json.dumps(e['headers'])]
charged = len(pub.state()['charges']) - charges_before
H.check('after-disconnect-no-request-with-old-key', not used, 'requests carrying old key=%d paths=%s' % (len(used), [e['path'] for e in used]), 'O2', 'critical')
H.check('after-disconnect-no-charge', charged == 0, 'new charges=%d outs=%s' % (charged, outs), 'O2', 'critical')
# reconnect: a fresh key, and the old (un-revoked) key is never used again
n0 = len(pub.log())
jl.run('publik', 'connect', '--yes')
jl.run('use', 'publik')
jl.run('chat', 'Reply with the word ready')
later = pub.log()[n0:]
old_used = [e['path'] for e in later if key in json.dumps(e['headers'])]
new_keys = [k for k in keys() if k != key]
H.check('reconnect-mints-new-key-never-old', not old_used and len(new_keys) == 1, 'old key used on %s; new keys=%d' % (old_used, len(new_keys)), 'O2', 'high')
jl.cleanup()

# --- a second connect must not leave two usable keys, and the app must use the newest
pub2 = H.Standin('publik', '--balance', '5.00', name='publik2')
jl = H.JL('twice', publik=pub2)
jl.run('publik', 'connect', '--yes')
rc, out, dt = jl.run('publik', 'connect', '--yes')
ks = pub2.state()['keys']
live = [k for k, v in ks.items() if not v['revoked']]
H.check('second-connect-one-live-key', len(live) == 1, 'keys minted=%d live=%d second connect: %s' % (len(ks), len(live), H.short(out, 200)), 'O2', 'high')
jl.run('use', 'publik')
jl.run('chat', 'Reply with the word ready')
chat_keys = [e['headers'].get('authorization', '')[7:] for e in pub2.log() if e['path'].endswith('/chat/completions')]
H.check('app-uses-the-live-key', chat_keys and all(k in live for k in chat_keys), 'chat keys live? %s' % [k in live for k in chat_keys], 'O2', 'high')
jl.cleanup()

# --- replay: the secret store is lost, the same install id is replayed, publik answers 200 with "key": null
pub3 = H.Standin('publik', '--balance', '5.00', name='publik3')
jl = H.JL('replay', publik=pub3)
jl.run('publik', 'connect', '--yes')
for f in jl.files():
    if '/secrets/' in f:
        os.remove(f)
rc, out, dt = jl.run('publik', 'connect', '--yes')
rc2, out2, dt2 = jl.run('status')
live = [k for k, v in pub3.state()['keys'].items() if not v['revoked']]
connected_claim = 'publik: connected' in out2
jl.run('use', 'publik')
rc3, out3, dt3 = jl.run('chat', 'Reply with the word ready')
works = rc3 == 0 and pub3.nonce in out3
H.check('replay-null-key-not-half-connected', works or (not connected_claim and '$0.00' not in out2),
        'reconnect: %s | status: %s | chat: %s' % (H.short(out, 200), H.short(out2[-200:], 200), H.short(out3, 200)), 'O2', 'high')
jl.cleanup()

# --- failed connects leave the app not connected, with a plain message and no $0.00
for mode in ['unavailable', 'mintfail']:
    p = H.Standin('publik', name='pf-' + mode)
    p.mode(mode)
    jl = H.JL('fail-' + mode, publik=p)
    rc, out, dt = jl.run('publik', 'connect', '--yes')
    rc2, out2, dt2 = jl.run('status')
    ok_plain, bad = C.plain_message(out)
    H.check('failed-connect-plain[%s]' % mode, rc != 0 and ok_plain and 'publik is connected' not in out.lower(),
            'rc=%s out=%s bad=%s' % (rc, H.short(out, 250), bad), 'O2', 'medium')
    H.check('failed-connect-not-half-connected[%s]' % mode, 'publik: not connected' in out2 and '$0.00' not in out2, H.short(out2[-160:], 160), 'O2', 'high')
    jl.cleanup()
    p.stop()

# --- disconnect while publik is down: the key must still leave this computer and nothing may spend afterwards
pub4 = H.Standin('publik', '--balance', '5.00', name='publik4')
jl = H.JL('downdisc', publik=pub4)
jl.run('publik', 'connect', '--yes')
key4 = list(pub4.state()['keys'])[0]
jl.run('use', 'publik')
pub4.mode('unavailable')
rc, out, dt = jl.run('publik', 'disconnect')
pub4.mode('ok')
n0 = len(pub4.log())
rc2, out2, dt2 = jl.run('chat', 'hello')
used = [e for e in pub4.log()[n0:] if key4 in json.dumps(e['headers'])]
H.check('disconnect-while-publik-down-still-stops-spending', not used,
        'disconnect: %s | later chat: %s | requests with key=%d' % (H.short(out, 200), H.short(out2, 150), len(used)), 'O2', 'high')
H.check('disconnect-while-down-tells-truth', ('revoked at publik' not in out) or pub4.state()['keys'][key4]['revoked'],
        'out=%s key revoked at publik=%s' % (H.short(out, 250), pub4.state()['keys'][key4]['revoked']), 'O2', 'low')
jl.cleanup()

# --- disconnect when nothing is connected must not claim a revocation it did not do
pub5 = H.Standin('publik', name='publik5')
jl = H.JL('nothing', publik=pub5)
rc, out, dt = jl.run('publik', 'disconnect')
H.check('disconnect-when-not-connected-no-false-claim', 'revoked at publik' not in out, H.short(out, 200), 'O2', 'low')
jl.cleanup()

# --- a publik address that is not loopback: nothing is sent (sandbox blocks and the monitor records any attempt)
jl = H.JL('live', extra_env={'JOBLEFT_PUBLIK_BASE_URL': 'https://publikhq.com/api/v1'})
rc, out, dt = jl.run('publik', 'connect', '--yes')
nl = jl.non_loopback()
H.check('live-publik-not-contacted', not nl and rc != 0, 'attempts=%s out=%s' % (nl, H.short(out, 200)), 'O2', 'critical')
jl.cleanup()

# --- no app token: plain message, nothing sent
pub6 = H.Standin('publik', name='publik6')
jl = H.JL('notoken', publik=pub6, extra_env={'JOBLEFT_PUBLIK_APP_TOKEN': ''})
rc, out, dt = jl.run('publik', 'connect', '--yes')
H.check('no-app-token-sends-nothing', rc != 0 and not pub6.log(), 'requests=%d out=%s' % (len(pub6.log()), H.short(out, 200)), 'O2', 'medium')
jl.cleanup()

H.finish()
