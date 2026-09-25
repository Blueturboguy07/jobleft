#!/usr/bin/env python3
"""Independent publik API stand-in for the hostile evaluation of jobleft ai-engine.

Built by the evaluator from the publik build contract (~/publik-api-research/CONTRACT.md sections 1, 3.1, 3.2, 5, 11, 12)
and memo R21 sections 2.1 to 2.6 -- NOT from jobleft code. The relevant contract text is copied to
../data/publik-contract-excerpt.md. Faithful details that a lenient mock might skip:
  - the 402 body is the contract's (type insufficient_credit, message "Not enough publik credit for this request.",
    top_up_url = claim_url while anonymous, add_credit_url once claimed);
  - streamed calls RESERVE a hold at admission (x-publik-balance = available after the hold) and SETTLE the real
    price only after the stream ends, after `settle_delay_s` (Next `after()`), so /wallet right after a stream still
    shows the hold;
  - a revoked key answers 401 key_revoked (CONTRACT section 1);
  - a replayed install_id whose key is not revoked answers 200 with "key": null.
Binds 127.0.0.1 only. Logs every request with all headers.
"""
import argparse, json, random, select, socket, string, threading, time, uuid
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

AP = argparse.ArgumentParser()
AP.add_argument('--port', type=int, default=0)
AP.add_argument('--log', default=None)
AP.add_argument('--balance', type=float, default=5.0)
AP.add_argument('--price', type=float, default=0.01)
AP.add_argument('--hold', type=float, default=0.05)
AP.add_argument('--settle-delay', type=float, default=1.0)
AP.add_argument('--portfile', default=None)
ARGS = AP.parse_args()

M = 1_000_000
NONCE = 'P' + ''.join(random.choice(string.ascii_uppercase + string.digits) for _ in range(10))
S = {
    'posted': int(round(ARGS.balance * M)), 'holds': {}, 'price': int(round(ARGS.price * M)),
    'hold': int(round(ARGS.hold * M)), 'settle_delay': ARGS.settle_delay, 'claim_state': 'anonymous',
    'mode': 'ok', 'link_host': 'https://publikhq.com', 'base_url_override': None,
    'keys': {}, 'installs': {}, 'charges': [], 'revoked_status': 401,
}
LOG = []
LOCK = threading.Lock()
CODE = 'HK7F-2QWD'


def now():
    return time.time()


def rnd(n, alphabet=string.ascii_lowercase + string.digits):
    return ''.join(random.choice(alphabet) for _ in range(n))


def available():
    return S['posted'] - sum(S['holds'].values())


def links():
    host = S['link_host']
    return {'claim_url': host + '/claim/' + CODE if S['claim_state'] == 'anonymous' else None,
            'add_credit_url': host + '/dashboard/api/add',
            'plans_url': host + '/developers#plans'}


def top_up_url():
    l = links()
    return l['claim_url'] if S['claim_state'] == 'anonymous' else l['add_credit_url']


def wallet_body(key_rec):
    l = links()
    av = available()
    return {'install_id': key_rec['install_id'] if key_rec else None, 'app_slug': 'jobleft', 'claim_state': S['claim_state'],
            'balance_micros': av, 'available_micros': av,
            'starter': {'remaining_micros': 0, 'expires_at': '2026-10-25T00:00:00Z'},
            'plan': {'id': 'none', 'label': 'No plan', 'monthly_micros': 0},
            'week': {'used_micros': sum(c['micros'] for c in S['charges']), 'budget_micros': None, 'resets_at': '2026-10-01T00:00:00Z', 'window_days': 7},
            'daily_cap_micros': 250000, 'spent_today_micros': 0,
            'claim_code': CODE if S['claim_state'] == 'anonymous' else None,
            'claim_url': l['claim_url'], 'add_credit_url': l['add_credit_url'], 'plans_url': l['plans_url'],
            'top_up_url': top_up_url(), 'price_epoch': '2026-09-22'}


def log_entry(e):
    with LOCK:
        e['i'] = len(LOG)
        LOG.append(e)
        if ARGS.log:
            with open(ARGS.log, 'a') as f:
                f.write(json.dumps(e) + '\n')


def log_event(i, **kw):
    with LOCK:
        if 0 <= i < len(LOG):
            LOG[i].setdefault('events', []).append(dict(kw, t=now()))


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def read_body(self):
        te = self.headers.get('transfer-encoding', '')
        if 'chunked' in te.lower():
            data = b''
            while True:
                line = self.rfile.readline()
                size = int(line.strip().split(b';')[0] or b'0', 16)
                if size == 0:
                    self.rfile.readline()
                    break
                data += self.rfile.read(size)
                self.rfile.readline()
            return data
        n = int(self.headers.get('content-length') or 0)
        return self.rfile.read(n) if n else b''

    def common(self):
        self.send_header('cache-control', 'no-store')
        self.send_header('x-content-type-options', 'nosniff')
        self.send_header('x-publik-request-id', 'req_' + rnd(12))

    def send(self, code, obj, extra=None, ctype='application/json'):
        body = (obj if isinstance(obj, str) else json.dumps(obj)).encode() if obj is not None else b''
        self.send_response(code)
        if obj is not None:
            self.send_header('content-type', ctype)
        self.send_header('content-length', str(len(body)))
        self.common()
        for k, v in (extra or {}).items():
            self.send_header(k, str(v))
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def err(self, code, typ, msg, **extra):
        hdr = {}
        if code in (401, 402, 403, 429):
            hdr['x-should-retry'] = 'false'
        if 'retry_after' in extra:
            hdr['retry-after'] = extra.pop('retry_after')
        e = {'type': typ, 'message': msg}
        e.update(extra)
        self.send(code, {'error': e}, hdr)

    def client_closed(self):
        try:
            r, _, _ = select.select([self.connection], [], [], 0)
            if r:
                return self.connection.recv(1, socket.MSG_PEEK) == b''
        except Exception:
            return True
        return False

    def do_GET(self): self.handle_any('GET')
    def do_POST(self): self.handle_any('POST')
    def do_PUT(self): self.handle_any('PUT')
    def do_DELETE(self): self.handle_any('DELETE')
    def do_OPTIONS(self): self.handle_any('OPTIONS')

    def handle_any(self, method):
        raw = self.read_body()
        path = self.path
        h = {k.lower(): v for k, v in self.headers.items()}
        if path.startswith('/__admin/'):
            return self.admin(path, raw)
        entry = {'t': now(), 'method': method, 'path': path, 'headers': h, 'body': raw[:100000].decode('utf-8', 'replace')}
        log_entry(entry)
        try:
            body = json.loads(raw) if raw else {}
        except Exception:
            body = {}
        p = path.split('?')[0]
        if p.startswith('/api/v1'):
            p = p[len('/api/v1'):]
        try:
            self.route(method, p, h, body, entry['i'])
        except (BrokenPipeError, ConnectionResetError):
            log_event(entry['i'], what='client closed the connection (write failed)')

    def admin(self, path, raw):
        b = json.loads(raw or b'{}') if raw else {}
        with LOCK:
            if path.startswith('/__admin/log'):
                return self.send(200, list(LOG))
            if path.startswith('/__admin/reset-log'):
                LOG.clear()
                return self.send(200, {'ok': True})
            if path.startswith('/__admin/state'):
                return self.send(200, {'posted_micros': S['posted'], 'available_micros': available(), 'holds': S['holds'],
                                       'charges': S['charges'], 'keys': S['keys'], 'installs': S['installs'],
                                       'mode': S['mode'], 'claim_state': S['claim_state'], 'nonce': NONCE})
            if path.startswith('/__admin/balance'):
                S['posted'] = int(round(float(b['usd']) * M)) + sum(S['holds'].values())
            elif path.startswith('/__admin/add'):
                S['posted'] += int(round(float(b['usd']) * M))
            elif path.startswith('/__admin/price'):
                S['price'] = int(round(float(b['usd']) * M))
            elif path.startswith('/__admin/hold'):
                S['hold'] = int(round(float(b['usd']) * M))
            elif path.startswith('/__admin/settle-delay'):
                S['settle_delay'] = float(b['s'])
            elif path.startswith('/__admin/claim'):
                S['claim_state'] = 'claimed' if b.get('claimed') else 'anonymous'
            elif path.startswith('/__admin/mode'):
                S['mode'] = b['mode']
            elif path.startswith('/__admin/links'):
                S['link_host'] = b['host']
            elif path.startswith('/__admin/base-url'):
                S['base_url_override'] = b.get('url')
            elif path.startswith('/__admin/revoke-all'):
                for k in S['keys'].values():
                    k['revoked'] = True
                    k['reason'] = 'dashboard'
            elif path.startswith('/__admin/unrevoke-all'):
                for k in S['keys'].values():
                    k['revoked'] = False
            elif path.startswith('/__admin/revoked-status'):
                S['revoked_status'] = int(b['status'])
            else:
                return self.send(404, {'error': 'no such admin route'})
            return self.send(200, {'ok': True, 'posted_micros': S['posted'], 'available_micros': available()})

    def auth(self, h):
        a = h.get('authorization', '')
        k = a[7:] if a.lower().startswith('bearer ') else h.get('x-api-key')
        if not k or k not in S['keys']:
            self.err(401, 'invalid_api_key', 'Invalid publik API key.')
            return None
        rec = S['keys'][k]
        if rec.get('revoked'):
            self.err(S['revoked_status'], 'key_revoked', 'This publik API key was revoked.', reprovision=False)
            return None
        return rec

    def route(self, method, p, h, body, idx):
        mode = S['mode']
        if mode == 'unavailable':
            return self.err(503, 'gateway_unavailable', 'publik is briefly unavailable.', retry_after='30')
        if mode == 'stall':
            t0 = now()
            while now() - t0 < 900:
                if self.client_closed():
                    log_event(idx, what='client closed the connection', after_s=round(now() - t0, 3))
                    return
                time.sleep(0.1)
            return
        if p == '/installs' and method == 'POST':
            return self.installs(h, body)
        if p == '/installs/revoke' and method == 'POST':
            rec = self.auth(h)
            if rec is None:
                return
            with LOCK:
                rec['revoked'] = True
                rec['reason'] = 'user'
            return self.send(204, None)
        if p in ('/wallet', '/balance') and method == 'GET':
            rec = self.auth(h)
            if rec is None:
                return
            with LOCK:
                return self.send(200, wallet_body(rec))
        if p == '/models' and method == 'GET':
            rec = self.auth(h)
            if rec is None:
                return
            return self.send(200, {'object': 'list', 'data': [
                {'id': 'publik-fast', 'object': 'model', 'tier': 'fast', 'resolves_to': 'hostile-luna'},
                {'id': 'publik-balanced', 'object': 'model', 'tier': 'balanced', 'resolves_to': 'hostile-terra'},
                {'id': 'publik-smart', 'object': 'model', 'tier': 'smart', 'resolves_to': 'hostile-sol'}]})
        if method == 'POST' and p in ('/chat/completions', '/embeddings', '/fetch', '/search', '/responses', '/messages'):
            return self.metered(p, h, body, idx)
        return self.err(404, 'not_found', 'No such route.')

    def installs(self, h, body):
        tok = body.get('app_token') or (h.get('authorization', '')[7:] if h.get('authorization', '').lower().startswith('bearer ') else None)
        import re
        if not tok or not re.match(r'^pat_([a-z0-9]+(?:[a-z0-9-]{0,62}[a-z0-9])?)_([a-z0-9]{32})$', tok):
            return self.err(401, 'invalid_app_token', 'Invalid app token.')
        if S['mode'] == 'mintfail':
            return self.err(500, 'mint_failed', 'Could not mint an install.')
        iid = body.get('install_id') or str(uuid.uuid4())
        with LOCK:
            existing = S['installs'].get(iid)
            if existing and not S['keys'][existing]['revoked']:
                b = self.install_body(iid, None)
                b['claim_state'] = S['claim_state']
                return self.send(200, b)
            key = 'pk_test_%s_%s' % (rnd(12), rnd(32))
            S['keys'][key] = {'id': key[8:20], 'install_id': iid, 'revoked': False, 'minted_at': now()}
            S['installs'][iid] = key
            b = self.install_body(iid, key)
        return self.send(201, b)

    def install_body(self, iid, key):
        l = links()
        return {'install_id': iid, 'key': key, 'key_id': key[8:20] if key else None,
                'base_url': S['base_url_override'] or ('http://127.0.0.1:%d/api/v1' % self.server.server_address[1]),
                'models': {'fast': 'publik-fast', 'balanced': 'publik-balanced', 'smart': 'publik-smart'},
                'dialects': ['chat_completions', 'responses', 'messages'], 'claim_code': CODE,
                'claim_url': l['claim_url'] or (S['link_host'] + '/claim/' + CODE), 'claim_expires_at': '2026-10-25T00:00:00Z',
                'starter_micros': 0, 'balance_micros': available(), 'starting_credit_micros': 0,
                'wallet': wallet_body(S['keys'].get(key) if key else None),
                'disclosure': {'version': 1,
                               'cost': 'jobleft runs on publik API. Every request is priced per use from your publik balance.',
                               'data_path': 'Your prompts go through publik servers to a model provider.'}}

    def metered(self, p, h, body, idx):
        rec = self.auth(h)
        if rec is None:
            return
        mode = S['mode']
        if mode == 'ratelimit':
            return self.err(429, 'rate_limit_exceeded', 'Too many requests.', retry_after='20')
        model = body.get('model')
        if p == '/chat/completions' and model not in ('publik-fast', 'publik-balanced', 'publik-smart', 'publik-default', 'gpt-4o-mini', 'gpt-4o'):
            return self.err(400, 'unknown_model', 'Unknown model; use publik-fast, publik-balanced or publik-smart.')
        l = links()
        if model == 'publik-smart' and S['claim_state'] == 'anonymous':
            return self.err(402, 'model_requires_claim', 'publik-smart needs a linked account.', top_up_url=l['claim_url'], claim_url=l['claim_url'])
        with LOCK:
            need = S['hold'] if body.get('stream') else S['price']
            if available() < need or available() <= 0:
                return self.err(402, 'insufficient_credit', 'Not enough publik credit for this request.',
                                available_micros=available(), required_micros=need, claim_state=S['claim_state'],
                                top_up_url=top_up_url(), claim_url=l['claim_url'], add_credit_url=l['add_credit_url'],
                                plans_url=l['plans_url'],
                                week={'used_micros': 0, 'budget_micros': None, 'resets_at': '2026-10-01T00:00:00Z'})
            rid = 'res_' + rnd(8)
            S['holds'][rid] = need
        hdr = {'x-publik-model': 'hostile-terra', 'x-publik-balance': available(), 'x-publik-claim-state': S['claim_state'],
               'x-publik-week-used': 0, 'x-publik-week-budget': 'none', 'x-publik-week-resets-at': '2026-10-01T00:00:00Z'}
        def settle(delay):
            def run():
                time.sleep(delay)
                with LOCK:
                    S['holds'].pop(rid, None)
                    S['posted'] -= S['price']
                    S['charges'].append({'route': p, 'micros': S['price'], 't': now(), 'request_log_index': idx})
            threading.Thread(target=run, daemon=True).start()
        if p != '/chat/completions':
            with LOCK:
                S['holds'].pop(rid, None)
                S['posted'] -= S['price']
                S['charges'].append({'route': p, 'micros': S['price'], 't': now(), 'request_log_index': idx})
            return self.send(200, {'ok': True, 'route': p}, dict(hdr, **{'x-publik-charge-micros': S['price']}))
        text = 'ready ' + NONCE
        schema = None
        rf = body.get('response_format')
        if isinstance(rf, dict) and isinstance(rf.get('json_schema'), dict):
            schema = rf['json_schema'].get('schema')
        if schema:
            props = (schema.get('properties') or {})
            obj = {}
            for k, sub in props.items():
                t = sub.get('type')
                obj[k] = 66 if t in ('number', 'integer') else (['publik-reason-' + NONCE] if t == 'array' else 'publik-' + NONCE)
            text = json.dumps(obj)
        if not body.get('stream'):
            with LOCK:
                S['holds'].pop(rid, None)
                S['posted'] -= S['price']
                S['charges'].append({'route': p, 'micros': S['price'], 't': now(), 'request_log_index': idx})
                hdr['x-publik-balance'] = available()
            hdr['x-publik-charge-micros'] = S['price']
            return self.send(200, {'id': 'chatcmpl-p', 'object': 'chat.completion', 'model': model,
                                   'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': text}, 'finish_reason': 'stop'}],
                                   'usage': {'prompt_tokens': 10, 'completion_tokens': 3, 'total_tokens': 13}}, hdr)
        hdr['x-publik-reserved-micros'] = need
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.send_header('transfer-encoding', 'chunked')
        self.common()
        for k, v in hdr.items():
            self.send_header(k, str(v))
        self.end_headers()
        def chunk(s):
            b = s.encode()
            self.wfile.write(b'%x\r\n' % len(b) + b + b'\r\n')
            self.wfile.flush()
        try:
            if mode == 'heartbeat':
                # CONTRACT 3.1: "forward upstream with a 15 s SSE-comment heartbeat until first byte"; the upstream
                # never sends a first byte here, and publik bounds its reader at 300 s.
                t0 = now()
                while now() - t0 < 300:
                    chunk(': publik heartbeat\n\n')
                    for _ in range(150):
                        if self.client_closed():
                            log_event(idx, what='client closed the connection', after_s=round(now() - t0, 3))
                            return
                        time.sleep(0.1)
                return
            if mode == 'half':
                chunk('data: ' + json.dumps({'choices': [{'index': 0, 'delta': {'content': text[:5]}}]}) + '\n\n')
                settle(S['settle_delay'])
                self.connection.shutdown(socket.SHUT_RDWR)
                self.close_connection = True
                return
            for i in range(0, len(text), 6):
                chunk('data: ' + json.dumps({'id': 'c', 'object': 'chat.completion.chunk', 'model': model, 'choices': [{'index': 0, 'delta': {'content': text[i:i + 6]}, 'finish_reason': None}]}) + '\n\n')
            chunk('data: ' + json.dumps({'id': 'c', 'object': 'chat.completion.chunk', 'model': model, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 10, 'completion_tokens': 3, 'total_tokens': 13}}) + '\n\n')
            chunk('data: [DONE]\n\n')
            self.wfile.write(b'0\r\n\r\n')
            self.wfile.flush()
        finally:
            # client disconnect never skips settlement (contract 3.1)
            if mode != 'half':
                settle(S['settle_delay'])


def main():
    srv = ThreadingHTTPServer(('127.0.0.1', ARGS.port), H)
    srv.daemon_threads = True
    port = srv.server_address[1]
    if ARGS.portfile:
        with open(ARGS.portfile, 'w') as f:
            f.write(str(port))
    print('standin-publik listening on 127.0.0.1:%d' % port, flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
