#!/usr/bin/env python3
"""O14 (MUST): no web page can make the app send an AI request, spend the balance, change the provider or read a key.
Probes `jl serve` (the lane's routes with the app's rules, INTERFACES 6.1) with raw HTTP (no token, guessed token,
token in URL, foreign/null Origin, changed Host, form-type bodies) and with a real headless Chrome page on another
port. Ground truth: stand-in logs (no request), the publik ledger (no change) and a hash of the data folder."""
import hashlib, http.server, json, os, re, secrets, shutil, subprocess, sys, tempfile, threading, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))
import harness as H
import checks as C

m = H.Standin('model')
m.mode('ok', key=H.CANARY)
pub = H.Standin('publik', '--balance', '5.00')
jl = H.JL('api', publik=pub)
jl.run('publik', 'connect', '--yes')
jl.run('use', 'custom', '--url', m.url, '--model', 'hostile-7b')
jl.run('key', 'set', stdin=H.CANARY)
srv = H.Serve(jl)
PORT = srv.port


def home_hash():
    h = hashlib.sha256()
    for f in sorted(jl.files()):
        h.update(f.encode())
        h.update(open(f, 'rb').read())
    return h.hexdigest()


ROUTES = [('GET', '/api/v1/ai/settings', None), ('PUT', '/api/v1/ai/settings', {'provider': 'publik'}),
          ('PUT', '/api/v1/ai/key', {'key': 'sk-attacker-0000'}), ('DELETE', '/api/v1/ai/key', None),
          ('POST', '/api/v1/ai/check', None), ('GET', '/api/v1/ai/models', None),
          ('POST', '/api/v1/ai/chat', {'requestId': 'evil', 'messages': [{'role': 'user', 'content': 'spend money'}]}),
          ('POST', '/api/v1/ai/requests/r1/cancel', None), ('GET', '/api/v1/publik', None),
          ('POST', '/api/v1/publik/connect', {'disclosureAccepted': True, 'disclosureVersion': 1}),
          ('POST', '/api/v1/publik/disconnect', None), ('POST', '/api/v1/publik/refresh', None)]

m.reset(); pub.reset()
h0 = home_hash()
bal0 = pub.state()['available_micros']
guess = secrets.token_urlsafe(32)
attacks = {
    'no-token': dict(token=False),
    'guessed-token': dict(token=False, headers={'x-jobleft-token': guess}),
    'token-in-query': dict(token=False, query='?token=%s&x-jobleft-token=%s' % (srv.token, srv.token)),
    'token-in-cookie': dict(token=False, headers={'cookie': 'x-jobleft-token=%s; token=%s' % (srv.token, srv.token)}),
    'token-as-bearer': dict(token=False, headers={'authorization': 'Bearer ' + srv.token}),
    'foreign-origin': dict(token=True, headers={'origin': 'http://evil.example'}),
    'null-origin': dict(token=True, headers={'origin': 'null'}),
    'other-local-port-origin': dict(token=True, headers={'origin': 'http://127.0.0.1:%d' % (PORT + 1)}),
    'lookalike-origin': dict(token=True, headers={'origin': 'http://127.0.0.1:%d.evil.example' % PORT}),
    'rebinding-host': dict(token=True, headers={'host': 'evil.example:%d' % PORT}),
    'lookalike-host': dict(token=True, headers={'host': '127.0.0.1.attacker.example:%d' % PORT}),
    'host-without-port': dict(token=True, headers={'host': '127.0.0.1'}),
    'host-other-port': dict(token=True, headers={'host': '127.0.0.1:%d' % (PORT + 1)}),
}
statuses = {}
for aname, a in attacks.items():
    for method, path, body in ROUTES:
        st, hd, b = srv.req(method, path + a.get('query', ''), body, headers=a.get('headers'), token=a['token'])
        statuses[(aname, method, path)] = st
        acao = hd.get('access-control-allow-origin')
        good = st in (401, 403) and not acao
        H.check('refused[%s][%s %s]' % (aname, method, path), good, 'status=%s acao=%s body=%s' % (st, acao, H.short(b, 120)), 'O14', 'critical')
# form-type bodies with a VALID token and no Origin (a page cannot set the token, but the rule must hold anyway)
for ctype in ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain;application/json',
              'text/plain; charset=application/json', 'application/json-seq', 'application/jsonp']:
    for method, path, body in ROUTES:
        if method == 'GET' or method == 'DELETE':
            continue
        raw = json.dumps(body or {}).encode()
        st, hd, b = srv.req(method, path, None, headers={'content-type': ctype}, raw_body=raw)
        H.check('form-type-refused[%s][%s %s]' % (ctype, method, path), st == 415, 'status=%s body=%s' % (st, H.short(b, 120)), 'O14', 'critical')
time.sleep(1)
H.check('no-ai-request-from-refused-calls', not m.ai_requests(), 'model stand-in requests=%s' % [(e['method'], e['path']) for e in m.ai_requests()][:5], 'O14', 'critical')
H.check('no-publik-request-from-refused-calls', not pub.log(), 'publik requests=%s' % [e['path'] for e in pub.log()][:5], 'O14', 'critical')
H.check('balance-unchanged', pub.state()['available_micros'] == bal0, 'before=%d after=%d' % (bal0, pub.state()['available_micros']), 'O14', 'critical')
H.check('data-folder-unchanged', home_hash() == h0, 'hash changed' if home_hash() != h0 else 'same', 'O14', 'critical')

# error bodies follow ApiError; health reveals nothing personal
st, hd, b = srv.req('GET', '/api/v1/ai/settings', token=False)
H.check('error-body-is-api-error', isinstance(b, dict) and isinstance(b.get('error'), dict) and b['error'].get('code') == 'unauthorized', H.short(b, 200), 'O14', 'low')
st, hd, b = srv.req('GET', '/api/v1/health', token=False)
blob = json.dumps(b)
H.check('health-reveals-nothing', st == 200 and jl.home not in blob and os.path.expanduser('~') not in blob and srv.token not in blob, H.short(b, 200), 'O14', 'medium')
# OPTIONS preflight never grants CORS
st, hd, b = srv.req('OPTIONS', '/api/v1/ai/chat', token=False, headers={'origin': 'http://evil.example', 'access-control-request-method': 'POST',
                                                                           'access-control-request-headers': 'x-jobleft-token,content-type'})
H.check('preflight-no-cors', 'access-control-allow-origin' not in hd, 'status=%s headers=%s' % (st, {k: v for k, v in hd.items() if k.startswith('access')}), 'O14', 'critical')
# body limit and validation before work
m.reset()
st, hd, b = srv.req('POST', '/api/v1/ai/chat', {'requestId': 'big', 'messages': [{'role': 'user', 'content': 'x' * (2 * 1024 * 1024)}]})
H.check('over-1mib-body-413-no-work', st == 413 and not m.ai_requests(), 'status=%s requests=%d' % (st, len(m.ai_requests())), 'O14', 'high')
for bad in [{'provider': 'claude'}, {'provider': 'custom', 'baseUrl': 'file:///etc/passwd'}, {'provider': 'custom', 'baseUrl': 'javascript:alert(1)'}]:
    st, hd, b = srv.req('PUT', '/api/v1/ai/settings', bad)
    H.check('invalid-settings-400[%s]' % json.dumps(bad), st == 400, 'status=%s body=%s' % (st, H.short(b, 150)), 'O14', 'medium')
st, hd, b = srv.req('POST', '/api/v1/ai/chat', None, raw_body=b'{"requestId": "x", "messages": [', headers={'content-type': 'application/json'})
H.check('malformed-json-400', st == 400, 'status=%s' % st, 'O14', 'medium')
# the token: long, and a new one on every start
H.check('token-long', len(srv.token) >= 32, 'len=%d' % len(srv.token), 'O14', 'high')
lsof = subprocess.run(['lsof', '-nP', '-a', '-p', str(srv.proc.pid), '-iTCP', '-sTCP:LISTEN'], capture_output=True, text=True).stdout
H.check('listens-on-loopback-only', lsof and all('127.0.0.1:' in l for l in lsof.splitlines()[1:]), H.short(lsof, 300), 'O14', 'critical')
srv.stop()
srv2 = H.Serve(jl)
H.check('new-token-each-start', srv2.token != srv.token, 'differs=%s' % (srv2.token != srv.token), 'O14', 'medium')
st, hd, b = srv2.req('GET', '/api/v1/ai/settings', token=False, headers={'x-jobleft-token': srv.token})
H.check('old-token-refused-after-restart', st == 401, 'status=%s' % st, 'O14', 'high')

# ---- a real browser: a page on another local port tries every trick it can without the token
m.reset(); pub.reset()
bal0 = pub.state()['available_micros']
h0 = home_hash()
API = 'http://127.0.0.1:%d' % srv2.port
PAGE = """<!doctype html><html><body><h1>evil page</h1>
<form id=f1 method=POST action="%(api)s/api/v1/ai/chat" enctype="text/plain" target=ifr><input name='{"requestId":"f1","messages":[{"role":"user","content":"x"}],"pad":"' value='"}'></form>
<form id=f2 method=POST action="%(api)s/api/v1/publik/connect" enctype="application/x-www-form-urlencoded" target=ifr><input name=disclosureAccepted value=true></form>
<iframe name=ifr></iframe>
<script>
const api = "%(api)s"; const out = [];
async function go(){
  const body = JSON.stringify({requestId:"p1", messages:[{role:"user", content:"spend"}]});
  for (const [m, p, b, h] of [
    ["POST","/api/v1/ai/chat",body,{"content-type":"text/plain"}],
    ["POST","/api/v1/ai/chat",body,{"content-type":"application/json"}],
    ["PUT","/api/v1/ai/settings",JSON.stringify({provider:"publik"}),{"content-type":"application/json"}],
    ["GET","/api/v1/ai/settings",null,{}],
    ["POST","/api/v1/publik/connect",JSON.stringify({disclosureAccepted:true,disclosureVersion:1}),{"content-type":"text/plain"}],
    ["POST","/api/v1/ai/check",null,{}]]) {
    for (const mode of ["cors","no-cors"]) {
      try { const r = await fetch(api + p, {method:m, body:b, headers:h, mode, credentials:"include"});
            let t = ""; try { t = await r.text(); } catch(e) {}
            out.push([m,p,mode,r.status,r.type,t.slice(0,80)]); }
      catch(e) { out.push([m,p,mode,"ERR",String(e).slice(0,60)]); }
    }
  }
  try { navigator.sendBeacon(api + "/api/v1/ai/chat", body); out.push(["beacon","sent"]); } catch(e) { out.push(["beacon", String(e)]); }
  document.getElementById("f1").submit();
  setTimeout(()=>{ document.getElementById("f2").submit(); }, 300);
  setTimeout(()=>{ document.title = "DONE"; const pre = document.createElement("pre"); pre.id="res"; pre.textContent = JSON.stringify(out); document.body.appendChild(pre); }, 1200);
}
go();
</script></body></html>""" % {'api': API}


class P(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        b = PAGE.encode()
        self.send_response(200); self.send_header('content-type', 'text/html'); self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b)


ps = http.server.ThreadingHTTPServer(('127.0.0.1', 0), P)
threading.Thread(target=ps.serve_forever, daemon=True).start()
page_url = 'http://127.0.0.1:%d/' % ps.server_address[1]
chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
prof = tempfile.mkdtemp(prefix='jlh-chrome-', dir='/private/tmp')
dom = ''
if os.path.exists(chrome):
    cp = subprocess.Popen([chrome, '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + prof,
                           '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-pings',
                           '--disable-domain-reliability', '--disable-client-side-phishing-detection', '--metrics-recording-only',
                           '--remote-debugging-port=0', 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    dport = None
    for _ in range(40):
        try:
            dport = open(os.path.join(prof, 'DevToolsActivePort')).readline().strip()
            if dport:
                break
        except OSError:
            time.sleep(0.25)
    try:
        r = subprocess.run(['node', os.path.join(H.HERE, 'cdp_eval.mjs'), dport or '0', page_url, '6000'], capture_output=True, text=True, timeout=60)
        dom = '<pre id="res">' + r.stdout.strip() + '</pre>' if r.stdout.strip() not in ('', 'NO-RESULT') else 'no result: ' + r.stdout + r.stderr
    except Exception as e:
        dom = 'chrome failed: %s' % e
    cp.terminate()
    try:
        cp.wait(5)
    except Exception:
        cp.kill()
    time.sleep(1.5)
    res = re.search(r'<pre id="res">(.*?)</pre>', dom, re.S)
    got = json.loads(res.group(1).replace('&quot;', '"').replace('&amp;', '&')) if res else None
    readable = [x for x in (got or []) if len(x) > 5 and x[3] == 200 and x[4] in ('cors', 'basic')]
    H.check('browser-page-ran', got is not None, 'dom=%s' % H.short(dom, 200), 'O14', 'medium')
    H.check('browser-page-reads-nothing', not readable, 'readable responses=%s' % readable, 'O14', 'critical')
    H.check('browser-page-no-ai-request', not m.ai_requests(), 'model stand-in requests=%d' % len(m.ai_requests()), 'O14', 'critical')
    H.check('browser-page-no-publik-request', not pub.log() and pub.state()['available_micros'] == bal0, 'publik requests=%d' % len(pub.log()), 'O14', 'critical')
    H.check('browser-page-changed-nothing', home_hash() == h0, 'data folder hash %s' % ('same' if home_hash() == h0 else 'CHANGED'), 'O14', 'critical')
    with open(os.path.join(H.OUT, 'o14-browser.json'), 'w') as f:
        json.dump(got, f)
else:
    print(json.dumps({'probe': 'o14', 'blocked': 'no Chrome'}))
shutil.rmtree(prof, ignore_errors=True)
srv2.stop()
jl.cleanup()
H.finish()
