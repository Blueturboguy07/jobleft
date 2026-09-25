#!/usr/bin/env python3
"""O6 (MUST): balance too low -> one short plain message with the balance in dollars and exactly one link; the typed
text is kept; no other provider is tried; no automatic retry; after money is added it works with no restart.
Ground truth: the publik contract's own 402 body (CONTRACT section 1, R21 2.5) served by the evaluator's stand-in,
whose `top_up_url` is the one link the app must show; the stand-in request log counts requests."""
import json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))
import harness as H
import checks as C

pub = H.Standin('publik', '--balance', '5.00', '--price', '0.01', '--settle-delay', '0.2')
other = H.Standin('model', '--key', H.CANARY, name='other')

jl = H.JL('main', publik=pub)
# a second provider was set up before (custom with a key), then the person chose publik
jl.run('use', 'custom', '--url', other.url, '--model', 'hostile-7b')
jl.run('key', 'set', stdin=H.CANARY)
jl.run('publik', 'connect', '--yes')
jl.run('use', 'publik')
other.reset()
pub.admin('balance', {'usd': 0})
expected_link = pub.state() and H.http('GET', pub.url + '/__admin/state')[2]  # state for the record
wallet_link = 'https://publikhq.com/claim/HK7F-2QWD'  # the stand-in's top_up_url while anonymous (contract: claim_url)

MSG = 'my question about the Data Analyst role 🙂'
n0 = len(pub.log())
rc, out, dt = jl.run('chat', MSG)
chat_reqs = [e for e in pub.log()[n0:] if e['path'].endswith('/chat/completions')]
ls = C.links(out)
bad_words = C.forbidden_money_words(out)
ok_plain, bad = C.plain_message(out)
H.check('chat-402-plain-words', ('balance' in out.lower()) and ('ran out' in out.lower() or 'too low' in out.lower()) and ok_plain and not bad_words,
        'forbidden=%s bad=%s out=%s' % (bad_words, bad, H.short(out, 400)), 'O6', 'high')
H.check('chat-402-shows-dollars', '$0.00' in out, H.short(out, 300), 'O6', 'high')
H.check('chat-402-exactly-one-link', len(ls) == 1 and ls[0] == wallet_link, 'links=%s expected=%s' % (ls, wallet_link), 'O6', 'high')
H.check('chat-402-one-request', len(chat_reqs) == 1, 'chat requests=%d' % len(chat_reqs), 'O6', 'high')
H.check('chat-402-no-other-provider', not other.ai_requests(), 'other provider requests=%d' % len(other.ai_requests()), 'O6', 'critical')
H.check('chat-402-not-echo-publik-credit-text', 'Not enough publik credit' not in out, H.short(out, 300), 'O6', 'medium')
unsent = os.path.join(jl.home, 'ai', 'unsent.json')
kept = open(unsent, encoding='utf-8').read() if os.path.exists(unsent) else ''
H.check('typed-text-kept-not-sent', MSG in json.loads(kept).get('text', kept) if kept.startswith('{') else MSG in kept,
        'unsent.json=%s' % H.short(kept, 300), 'O6', 'high')

# the other AI action
n0 = len(pub.log())
rc, out2, dt = jl.run('json', 'Jordan Testwell, SQL analyst. Job: data analyst with SQL and Tableau.')
reqs = [e for e in pub.log()[n0:] if not e['path'].endswith('/wallet') and not e['path'].endswith('/balance')]
ls2 = C.links(out2)
H.check('json-402-one-link-one-request', len(ls2) == 1 and len(reqs) == 1 and not C.forbidden_money_words(out2),
        'links=%s requests=%s out=%s' % (ls2, [e['path'] for e in reqs], H.short(out2, 300)), 'O6', 'high')
H.check('json-402-no-invented-score', not C.invented_numbers(out2, {'0.00', '0', '1', '2'}) or all(n in ('0.00',) for n in C.invented_numbers(out2, set())),
        'numbers=%s' % C.invented_numbers(out2, set()), 'O6', 'high')

# add $5 at publik, resend: works, no restart needed
pub.admin('add', {'usd': 5})
rc, out3, dt = jl.run('chat', '--resend')
sent = [json.loads(e['body'])['messages'][-1]['content'] for e in pub.log() if e['path'].endswith('/chat/completions') and e['body']]
H.check('resend-after-top-up-works', rc == 0 and pub.nonce in out3 and sent and sent[-1] == MSG, 'rc=%s out=%s' % (rc, H.short(out3, 200)), 'O6', 'high')

# claimed install: the one link is add_credit_url
pub.admin('claim', {'claimed': True})
pub.admin('balance', {'usd': 0})
rc, out4, dt = jl.run('chat', 'another question')
ls4 = C.links(out4)
H.check('claimed-402-link-is-add-credit', ls4 == ['https://publikhq.com/dashboard/api/add'], 'links=%s' % ls4, 'O6', 'medium')
pub.admin('claim', {'claimed': False})

# money left but less than one call ($0.004 with a $0.01 price): must not read as "$0.00 left"
pub.admin('balance', {'usd': 0.004})
rc, out5, dt = jl.run('chat', 'tiny balance question')
H.check('sub-cent-balance-not-shown-as-0.00', '$0.00' not in out5, H.short(out5, 300), 'O6', 'low')

# a 402 link on a foreign host must not be shown (CONTRACT 11.4: links are always on https://publikhq.com; apps drop any other host)
pub.admin('links', {'host': 'https://pay-publik.example'})
pub.admin('balance', {'usd': 0})
rc, out6, dt = jl.run('chat', 'foreign link question')
H.check('foreign-top-up-link-dropped', not any('example' in l for l in C.links(out6)), 'links=%s' % C.links(out6), 'O6', 'medium')
pub.admin('links', {'host': 'https://publikhq.com'})
jl.cleanup()

# the local API: an error event with code insufficient_balance and one link; then add money, same process, works
pub2 = H.Standin('publik', '--balance', '5.00', name='publik2')
jl = H.JL('serve', publik=pub2)
jl.run('publik', 'connect', '--yes')
jl.run('use', 'publik')
srv = H.Serve(jl)
pub2.admin('balance', {'usd': 0})
st, evs, dt = srv.sse('/api/v1/ai/chat', {'requestId': 'm1', 'messages': [{'role': 'user', 'content': 'hello'}]})
blob = json.dumps([o for _, o in evs])
errs = [o for _, o in evs if isinstance(o, dict) and (o.get('type') == 'error' or 'error' in o)]
e = errs[-1] if errs else {}
e = e.get('error', e)
link = e.get('link') if isinstance(e, dict) else None
link = link.get('url') if isinstance(link, dict) else link  # ApiError.schema.json: link = {label, url}
H.check('api-402-code-and-one-link', isinstance(e, dict) and e.get('code') == 'insufficient_balance' and link == 'https://publikhq.com/claim/HK7F-2QWD'
        and not C.forbidden_money_words(e.get('message', '')), 'status=%s events=%s' % (st, H.short(blob, 400)), 'O6', 'high')
pub2.admin('add', {'usd': 5})
st, evs, dt = srv.sse('/api/v1/ai/chat', {'requestId': 'm2', 'messages': [{'role': 'user', 'content': 'hello'}]})
text = ''.join(o.get('text', '') for _, o in evs if isinstance(o, dict) and o.get('type') == 'delta')
H.check('api-works-after-top-up-no-restart', pub2.nonce in text, 'text=%r' % text[:80], 'O6', 'high')
st, hd, body = srv.req('GET', '/api/v1/publik')
H.check('api-balance-not-stuck-at-zero-after-top-up', st == 200 and '"balanceMicros": 0,' not in json.dumps(body), 'publik=%s' % H.short(body, 300), 'O6', 'high')
srv.stop()
jl.cleanup()

H.finish()
