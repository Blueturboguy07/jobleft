#!/usr/bin/env python3
"""O15 (SHOULD): paid fetch and search never spend money before the person turns them on; prices in dollars per 1,000
requests are shown first. The fetch client and job refresh live in @jobleft/sources-other (not in this lane): the
"free fetch first" part is BLOCKED here. Ground truth: the publik stand-in log (no /fetch or /search)."""
import json, os, re, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))
import harness as H

pub = H.Standin('publik', '--balance', '5.00')
jl = H.JL('m', publik=pub)
PRICE = re.compile(r'\$\d+\.\d{2}')
rc, out, dt = jl.run('metered', 'status')
H.check('off-by-default', ' off' in out.lower() and len(PRICE.findall(out)) >= 2 and '1,000' in out, H.short(out, 250), 'O15', 'high')
jl.run('publik', 'connect', '--yes')
jl.run('use', 'publik')
rc, out, dt = jl.run('metered', 'status')
H.check('connect-does-not-turn-on', ' off' in out.lower(), H.short(out, 200), 'O15', 'high')
rc, out, dt = jl.run('metered', 'on', stdin='')
rc2, out2, dt2 = jl.run('metered', 'status')
H.check('on-without-consent-stays-off', ' off' in out2.lower() and PRICE.search(out), 'on: %s | status: %s' % (H.short(out, 200), H.short(out2, 120)), 'O15', 'high')
rc, out, dt = jl.run('metered', 'on', '--yes')
rc2, out2, dt2 = jl.run('metered', 'status')
H.check('on-with-consent-shows-prices', PRICE.search(out) and ' on' in out2.lower(), 'on: %s | status: %s' % (H.short(out, 200), H.short(out2, 120)), 'O15', 'medium')
jl.run('metered', 'off')
rc, out, dt = jl.run('metered', 'status')
H.check('off-again', ' off' in out.lower(), H.short(out, 120), 'O15', 'medium')
# no AI action of this lane ever calls publik /fetch or /search
for args in [('chat', 'Look up facts about Northwind Analytics (fictional)'), ('json', 'Jordan Testwell. Job: data analyst at Northwind.'), ('check',), ('models',), ('status',)]:
    jl.run(*args)
paid = [e['path'] for e in pub.log() if e['path'].endswith('/fetch') or e['path'].endswith('/search')]
H.check('no-paid-fetch-or-search', not paid, 'paid calls=%s' % paid, 'O15', 'high')
srv = H.Serve(jl)
st, hd, b = srv.req('GET', '/api/v1/ai/settings')
H.check('api-settings-metered-off', st == 200 and (b.get('meteredFetch') or {}).get('enabled') is False, H.short(b, 250), 'O15', 'medium')
srv.stop()
jl.cleanup()
H.finish()
