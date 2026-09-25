#!/usr/bin/env python3
"""Independent stand-in AI model server for the hostile evaluation of jobleft ai-engine.

Written by the evaluator from the public wire formats only:
  - OpenAI Chat Completions (https://platform.openai.com/docs/api-reference/chat) incl. SSE streaming
  - Ollama API (https://github.com/ollama/ollama/blob/main/docs/api.md): /api/tags, /api/show, /api/chat, /api/pull
  - Anthropic Messages (https://docs.anthropic.com/en/api/messages) incl. SSE events
It shares no code with jobleft. It binds 127.0.0.1 only and logs every request (all headers, raw path, body).

Admin (no auth, loopback only):
  POST /__admin/mode   {"mode": "...", "key": "..."|null, "slow_ms": N, "redirect_to": "http://...",
                        "content": "...", "ka_s": N, "delay_s": N}
  GET  /__admin/log    -> JSON list of logged requests
  POST /__admin/reset  -> clear the log
  GET  /__admin/state
"""
import argparse, json, os, random, select, socket, string, sys, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

AP = argparse.ArgumentParser()
AP.add_argument('--port', type=int, default=0)
AP.add_argument('--log', default=None)
AP.add_argument('--mode', default='ok')
AP.add_argument('--key', default=None)
AP.add_argument('--models', default='hostile-7b,hostile-think-8b,hostile-embed')
AP.add_argument('--thinking-models', default='hostile-think-8b')
AP.add_argument('--embed-models', default='hostile-embed')
AP.add_argument('--nonce', default=None)
AP.add_argument('--portfile', default=None)
ARGS = AP.parse_args()

NONCE = ARGS.nonce or ('N' + ''.join(random.choice(string.ascii_uppercase + string.digits) for _ in range(10)))
STATE = {
    'mode': ARGS.mode, 'key': ARGS.key, 'slow_ms': 1000, 'redirect_to': None, 'content': None,
    'ka_s': 20, 'delay_s': 0, 'models': ARGS.models.split(','),
    'thinking': [m for m in ARGS.thinking_models.split(',') if m],
    'embed': [m for m in ARGS.embed_models.split(',') if m],
    'flaky_count': 0,
}
LOG = []
LOCK = threading.Lock()


def now():
    return time.time()


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
            if ARGS.log:
                with open(ARGS.log, 'a') as f:
                    f.write(json.dumps({'event_for': i, **kw, 't': now()}) + '\n')


# ---------------------------------------------------------------- JSON schema -> value
def value_for(schema, num, depth=0):
    if not isinstance(schema, dict) or depth > 8:
        return None
    if 'enum' in schema and schema['enum']:
        return schema['enum'][0]
    if 'const' in schema:
        return schema['const']
    for k in ('anyOf', 'oneOf', 'allOf'):
        if k in schema and schema[k]:
            return value_for(schema[k][0], num, depth + 1)
    t = schema.get('type')
    if isinstance(t, list):
        t = [x for x in t if x != 'null'][0] if [x for x in t if x != 'null'] else 'null'
    if t == 'object' or 'properties' in schema:
        out = {}
        for name, sub in (schema.get('properties') or {}).items():
            out[name] = value_for(sub, num, depth + 1)
        return out
    if t == 'array':
        n = max(schema.get('minItems', 2), 2)
        return [value_for(schema.get('items', {'type': 'string'}), num, depth + 1) for _ in range(n)]
    if t in ('number', 'integer'):
        if num is not None:
            return num
        lo = schema.get('minimum', 0)
        hi = schema.get('maximum', 100)
        v = lo + (hi - lo) * 0.63  # an unusual, recognisable value
        return int(round(v)) if t == 'integer' else round(v, 2)
    if t == 'boolean':
        return True
    if t == 'null':
        return None
    return 'hostile-' + NONCE


def find_schema(body):
    rf = body.get('response_format')
    if isinstance(rf, dict):
        js = rf.get('json_schema')
        if isinstance(js, dict) and isinstance(js.get('schema'), dict):
            return js['schema']
        if rf.get('type') == 'json_object':
            return {}
    fmt = body.get('format')
    if isinstance(fmt, dict):
        return fmt
    if fmt == 'json':
        return {}
    # Anthropic style: a tool with input_schema
    for t in body.get('tools') or []:
        if isinstance(t, dict) and isinstance(t.get('input_schema'), dict):
            return t['input_schema']
    return None


def last_user_text(body):
    msgs = body.get('messages') or []
    for m in reversed(msgs):
        if m.get('role') == 'user':
            c = m.get('content')
            if isinstance(c, str):
                return c
            if isinstance(c, list):
                return ' '.join(p.get('text', '') for p in c if isinstance(p, dict))
    return body.get('prompt') or ''


def answer_text(body, mode):
    """Returns (text, json_expected)."""
    schema = find_schema(body)
    wants_json = schema is not None
    if STATE['content'] is not None and mode in ('custom', 'slow', 'half', 'cutoff', 'broken'):
        return STATE['content'], wants_json
    if mode == 'empty':
        return '', wants_json
    if mode == 'text':
        return 'I think this candidate is a good fit overall. ' + NONCE, wants_json
    if wants_json:
        num = 140 if mode == 'badscore' else None
        v = value_for(schema, num) if schema else {'score': (140 if num else 63), 'reasons': ['hostile-' + NONCE]}
        return json.dumps(v), True
    if mode == 'badscore':
        return 'Score: 140%', False
    u = last_user_text(body)
    if 'ready' in u.lower():
        return 'ready ' + NONCE, False
    return 'hostile answer ' + NONCE + ' to a message of %d characters.' % len(u), False


def pieces(text, n=6):
    return [text[i:i + n] for i in range(0, len(text), n)] or ['']


def extract_key(h, path):
    a = h.get('authorization', '')
    if a.lower().startswith('bearer '):
        return a[7:]
    for k in ('x-api-key', 'x-goog-api-key', 'api-key'):
        if h.get(k):
            return h[k]
    if 'key=' in path:
        return path.split('key=', 1)[1].split('&')[0]
    return None


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    # ------------------------------------------------------------ plumbing
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

    def send(self, code, obj, ctype='application/json', extra=None):
        body = obj if isinstance(obj, (bytes, bytearray)) else (obj if isinstance(obj, str) else json.dumps(obj)).encode()
        self.send_response(code)
        self.send_header('content-type', ctype)
        self.send_header('content-length', str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def start_stream(self, ctype='text/event-stream'):
        self.send_response(200)
        self.send_header('content-type', ctype)
        self.send_header('cache-control', 'no-cache')
        self.send_header('transfer-encoding', 'chunked')
        self.end_headers()
        self.wfile.flush()

    def chunk(self, s):
        b = s.encode() if isinstance(s, str) else s
        self.wfile.write(b'%x\r\n' % len(b) + b + b'\r\n')
        self.wfile.flush()

    def end_chunks(self):
        self.wfile.write(b'0\r\n\r\n')
        self.wfile.flush()

    def client_closed(self):
        try:
            r, _, _ = select.select([self.connection], [], [], 0)
            if r:
                d = self.connection.recv(1, socket.MSG_PEEK)
                return d == b''
        except Exception:
            return True
        return False

    def wait_until_closed(self, idx, limit=900):
        t0 = now()
        while now() - t0 < limit:
            if self.client_closed():
                log_event(idx, what='client closed the connection', after_s=round(now() - t0, 3))
                return
            time.sleep(0.1)
        log_event(idx, what='stall limit reached')

    def drop(self, idx, why):
        log_event(idx, what='server dropped the connection', why=why)
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except Exception:
            pass
        self.close_connection = True

    def sleep_or_closed(self, idx, secs):
        t0 = now()
        while now() - t0 < secs:
            if self.client_closed():
                log_event(idx, what='client closed the connection', after_s=round(now() - t0, 3))
                return True
            time.sleep(0.05)
        return False

    # ------------------------------------------------------------ dispatch
    def do_GET(self): self.handle_any('GET')
    def do_POST(self): self.handle_any('POST')
    def do_PUT(self): self.handle_any('PUT')
    def do_DELETE(self): self.handle_any('DELETE')
    def do_OPTIONS(self): self.handle_any('OPTIONS')
    def do_HEAD(self): self.handle_any('HEAD')

    def handle_any(self, method):
        raw = self.read_body()
        path = self.path
        h = {k.lower(): v for k, v in self.headers.items()}
        if path.startswith('/__admin/'):
            return self.admin(method, path, raw)
        try:
            body = json.loads(raw) if raw else {}
        except Exception:
            body = {'_unparsed': raw[:2000].decode('utf-8', 'replace')}
        entry = {'t': now(), 'method': method, 'path': path, 'headers': h,
                 'body': raw[:300000].decode('utf-8', 'replace'), 'mode': STATE['mode']}
        log_entry(entry)
        idx = entry['i']
        try:
            self.route(method, path.split('?')[0], h, body, idx)
        except (BrokenPipeError, ConnectionResetError):
            log_event(idx, what='client closed the connection (write failed)')

    def admin(self, method, path, raw):
        if path.startswith('/__admin/log'):
            with LOCK:
                return self.send(200, list(LOG))
        if path.startswith('/__admin/reset'):
            with LOCK:
                LOG.clear()
            return self.send(200, {'ok': True})
        if path.startswith('/__admin/state'):
            return self.send(200, dict(STATE, nonce=NONCE))
        if path.startswith('/__admin/mode'):
            b = json.loads(raw or b'{}')
            for k in ('mode', 'key', 'slow_ms', 'redirect_to', 'content', 'ka_s', 'delay_s', 'models'):
                if k in b:
                    STATE[k] = b[k]
            STATE['flaky_count'] = 0
            return self.send(200, dict(STATE, nonce=NONCE))
        self.send(404, {'error': 'no such admin route'})

    def route(self, method, p, h, body, idx):
        mode = STATE['mode']
        is_models = (p.endswith('/models') or p.endswith('/api/tags')) and method == 'GET'
        is_show = p in ('/api/show',)
        is_chat = p.endswith('/chat/completions') or p in ('/api/chat', '/api/generate', '/v1/messages', '/messages')
        is_embed = p.endswith('/embeddings') or p in ('/api/embed', '/api/embeddings')
        if p == '/api/pull':
            log_event(idx, what='REFUSED model pull')
            return self.send(403, {'error': 'this stand-in refuses /api/pull'})
        if p == '/api/version':
            return self.send(200, {'version': '0.12.0'})
        if mode == 'redirect' and STATE['redirect_to']:
            return self.send(307, b'', 'text/plain', {'location': STATE['redirect_to'].rstrip('/') + self.path})
        if mode == 'html':
            return self.send(200, '<!doctype html><html><head><title>Router login</title></head><body><h1>Welcome</h1><p>Please sign in.</p></body></html>', 'text/html; charset=utf-8')
        if mode == 'stall' and (is_chat or is_models or is_show or is_embed):
            return self.wait_until_closed(idx)
        if mode == 'delay' and STATE['delay_s']:
            if self.sleep_or_closed(idx, STATE['delay_s']):
                return
        # key check
        k = extract_key(h, self.path)
        if mode == 'refuse-key' and (is_chat or is_models or is_embed):
            return self.refuse(p, 'Incorrect API key provided: %s. You can find your API key at https://example.invalid/keys.' % k)
        if mode == 'quota401' and (is_chat or is_embed):
            return self.send(401, {'error': {'message': 'Invalid authentication. Check your billing, credit balance and API key settings.', 'type': 'invalid_request_error', 'code': 'invalid_api_key'}})
        if mode == 'quota429' and (is_chat or is_embed):
            return self.send(429, {'error': {'message': 'You exceeded your current quota, please check your plan and billing details.', 'type': 'insufficient_quota', 'code': 'insufficient_quota'}})
        if STATE['key'] and (is_chat or is_models or is_embed or is_show) and k != STATE['key']:
            return self.refuse(p, 'Incorrect API key provided.')
        if is_models:
            return self.models(p)
        if is_show:
            name = body.get('model') or body.get('name')
            if name not in STATE['models']:
                return self.send(404, {'error': "model '%s' not found" % name})
            caps = ['embedding'] if name in STATE['embed'] else (['completion', 'thinking'] if name in STATE['thinking'] else ['completion', 'tools'])
            return self.send(200, {'modelfile': '', 'parameters': '', 'template': '', 'details': {'family': 'qwen2', 'parameter_size': '7.6B'},
                                   'model_info': {'general.architecture': 'qwen2', 'qwen2.context_length': 32768}, 'capabilities': caps})
        if is_embed:
            n = body.get('input')
            n = len(n) if isinstance(n, list) else 1
            if p in ('/api/embed', '/api/embeddings'):
                return self.send(200, {'model': body.get('model'), 'embeddings': [[0.1, 0.2, 0.3]] * n})
            return self.send(200, {'object': 'list', 'data': [{'object': 'embedding', 'index': i, 'embedding': [0.1, 0.2, 0.3]} for i in range(n)], 'model': body.get('model')})
        if not is_chat:
            return self.send(404, {'error': {'message': 'Unknown path ' + p, 'type': 'invalid_request_error'}})
        if mode == 'error500':
            return self.send(500, {'error': {'message': 'internal server error', 'type': 'server_error'}})
        if mode == 'flaky':
            STATE['flaky_count'] += 1
            if STATE['flaky_count'] == 1:
                return self.send(500, {'error': {'message': 'temporary failure', 'type': 'server_error'}})
        if mode == 'jsonmode400' and (body.get('response_format') or body.get('format')):
            return self.send(400, {'error': {'message': "'response_format' is not supported by this server", 'type': 'invalid_request_error'}})
        model = body.get('model')
        if mode == 'model-not-found' or (model and model not in STATE['models']):
            if p in ('/v1/messages', '/messages'):
                return self.send(404, {'type': 'error', 'error': {'type': 'not_found_error', 'message': 'model: %s' % model}})
            if p in ('/api/chat', '/api/generate'):
                return self.send(404, {'error': "model '%s' not found" % model})
            return self.send(404, {'error': {'message': 'The model `%s` does not exist or you do not have access to it.' % model, 'type': 'invalid_request_error', 'code': 'model_not_found'}})
        if p in ('/api/chat', '/api/generate'):
            return self.ollama(body, idx, mode)
        if p in ('/v1/messages', '/messages'):
            return self.anthropic(body, idx, mode)
        return self.openai(body, idx, mode)

    def refuse(self, p, msg):
        if p in ('/v1/messages', '/messages'):
            return self.send(401, {'type': 'error', 'error': {'type': 'authentication_error', 'message': msg}})
        if p in ('/api/chat', '/api/generate', '/api/tags', '/api/show'):
            return self.send(401, {'error': msg})
        return self.send(401, {'error': {'message': msg, 'type': 'invalid_request_error', 'code': 'invalid_api_key'}})

    def models(self, p):
        ms = STATE['models']
        if p.endswith('/api/tags'):
            return self.send(200, {'models': [{'name': m, 'model': m, 'modified_at': '2026-09-01T00:00:00Z', 'size': 1, 'digest': 'x',
                                               'details': {'family': 'qwen2', 'parameter_size': '7.6B', 'quantization_level': 'Q4_K_M'}} for m in ms]})
        return self.send(200, {'object': 'list', 'data': [{'id': m, 'object': 'model', 'created': 0, 'owned_by': 'hostile', 'type': 'model', 'display_name': m} for m in ms], 'has_more': False})

    # ------------------------------------------------------------ dialects
    def plan(self, body, mode):
        text, wants_json = answer_text(body, mode)
        think = None
        if mode in ('think', 'think-only'):
            think = 'Let me think step by step about this. ' + ('x ' * 40)
            if mode == 'think-only':
                text = ''
        return text, think

    def openai(self, body, idx, mode):
        text, think = self.plan(body, mode)
        model = body.get('model') or 'unknown'
        if mode == 'think' and think:
            text = '<think>' + think + '</think>' + text
        if mode == 'think-only' and think:
            text = '<think>' + think + '</think>'
        stream = bool(body.get('stream'))
        finish = 'length' if mode in ('cutoff',) else 'stop'
        ps = pieces(text)
        if mode in ('cutoff', 'half'):
            ps = ps[:max(1, len(ps) // 2)]
        if not stream:
            if mode == 'half':
                return self.drop(idx, 'half (non-stream)')
            return self.send(200, {'id': 'chatcmpl-hostile', 'object': 'chat.completion', 'created': int(now()), 'model': model,
                                   'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': ''.join(ps)}, 'finish_reason': finish}],
                                   'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}})
        self.start_stream()
        if mode == 'stall-after-headers':
            return self.wait_until_closed(idx)
        if mode == 'keepalive':
            t0 = now()
            while now() - t0 < 900:
                self.chunk(': keep-alive\n\n')
                if self.sleep_or_closed(idx, STATE['ka_s']):
                    return
            return
        def ev(o):
            self.chunk('data: ' + json.dumps(o) + '\n\n')
        base = {'id': 'chatcmpl-hostile', 'object': 'chat.completion.chunk', 'created': int(now()), 'model': model}
        ev(dict(base, choices=[{'index': 0, 'delta': {'role': 'assistant', 'content': ''}, 'finish_reason': None}]))
        for i, pc in enumerate(ps):
            if mode == 'slow' and self.sleep_or_closed(idx, STATE['slow_ms'] / 1000.0):
                return
            ev(dict(base, choices=[{'index': 0, 'delta': {'content': pc}, 'finish_reason': None}]))
            if mode == 'broken' and i == 0:
                self.chunk('data: {"choices": [ {"delta": {"content": "unterminated\n\n')
                self.chunk('data: <<<not json at all>>>\n\n')
                self.end_chunks()
                log_event(idx, what='broken stream sent')
                return
        if mode == 'half':
            return self.drop(idx, 'half')
        ev(dict(base, choices=[{'index': 0, 'delta': {}, 'finish_reason': finish}]))
        self.chunk('data: [DONE]\n\n')
        self.end_chunks()
        log_event(idx, what='stream complete')

    def ollama(self, body, idx, mode):
        text, think = self.plan(body, mode)
        model = body.get('model')
        if body.get('think') not in (None, False) and model not in STATE['thinking']:
            return self.send(400, {'error': '"%s" does not support thinking' % model})
        if mode == 'think' and think and body.get('think') in (None,):
            text = '<think>' + think + '</think>' + text
        stream = body.get('stream', True)
        ps = pieces(text)
        if mode in ('cutoff', 'half'):
            ps = ps[:max(1, len(ps) // 2)]
        reason = 'length' if mode == 'cutoff' else 'stop'
        chatp = 'message' in body or 'messages' in body
        def obj(content, done, thinking=None):
            o = {'model': model, 'created_at': '2026-09-25T00:00:00Z', 'done': done}
            if chatp:
                o['message'] = {'role': 'assistant', 'content': content}
                if thinking:
                    o['message']['thinking'] = thinking
            else:
                o['response'] = content
            if done:
                o.update({'done_reason': reason, 'total_duration': 1, 'eval_count': 5, 'prompt_eval_count': 10})
            return o
        if not stream:
            if mode == 'half':
                return self.drop(idx, 'half')
            return self.send(200, obj(''.join(ps), True, think if (think and body.get('think') not in (None, False)) else None))
        self.start_stream('application/x-ndjson')
        if mode == 'stall-after-headers':
            return self.wait_until_closed(idx)
        if think and mode in ('think', 'think-only') and body.get('think') not in (None, False):
            self.chunk(json.dumps(obj('', False, think)) + '\n')
        if mode == 'think-only' and body.get('think') in (None, False):
            self.chunk(json.dumps(obj('<think>' + think + '</think>', False)) + '\n')
        for i, pc in enumerate(ps):
            if mode == 'slow' and self.sleep_or_closed(idx, STATE['slow_ms'] / 1000.0):
                return
            self.chunk(json.dumps(obj(pc, False)) + '\n')
            if mode == 'broken' and i == 0:
                self.chunk('{"model": "x", "message": {"content": "unterminated\n')
                self.end_chunks()
                return
        if mode == 'half':
            return self.drop(idx, 'half')
        self.chunk(json.dumps(obj('', True)) + '\n')
        self.end_chunks()
        log_event(idx, what='stream complete')

    def anthropic(self, body, idx, mode):
        text, think = self.plan(body, mode)
        model = body.get('model')
        stream = bool(body.get('stream'))
        ps = pieces(text)
        if mode in ('cutoff', 'half'):
            ps = ps[:max(1, len(ps) // 2)]
        stop = 'max_tokens' if mode == 'cutoff' else 'end_turn'
        tools = body.get('tools') or []
        use_tool = bool(tools) and mode not in ('text', 'empty') and text.strip().startswith('{')
        if not stream:
            if mode == 'half':
                return self.drop(idx, 'half')
            if use_tool:
                content = [{'type': 'tool_use', 'id': 'toolu_h', 'name': tools[0].get('name'), 'input': json.loads(text)}]
                stop = 'tool_use' if mode != 'cutoff' else stop
            else:
                content = [{'type': 'text', 'text': ''.join(ps)}]
            return self.send(200, {'id': 'msg_hostile', 'type': 'message', 'role': 'assistant', 'model': model, 'content': content,
                                   'stop_reason': stop, 'usage': {'input_tokens': 10, 'output_tokens': 5}})
        self.start_stream()
        def ev(name, o):
            self.chunk('event: %s\ndata: %s\n\n' % (name, json.dumps(o)))
        ev('message_start', {'type': 'message_start', 'message': {'id': 'msg_hostile', 'type': 'message', 'role': 'assistant', 'model': model, 'content': [], 'stop_reason': None, 'usage': {'input_tokens': 10, 'output_tokens': 1}}})
        if mode == 'stall-after-headers':
            return self.wait_until_closed(idx)
        if use_tool:
            ev('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'tool_use', 'id': 'toolu_h', 'name': tools[0].get('name'), 'input': {}}})
            for pc in ps:
                ev('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': pc}})
            stop = 'tool_use' if mode != 'cutoff' else stop
        else:
            ev('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}})
            for i, pc in enumerate(ps):
                if mode == 'slow' and self.sleep_or_closed(idx, STATE['slow_ms'] / 1000.0):
                    return
                ev('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': pc}})
                if mode == 'broken' and i == 0:
                    self.chunk('event: content_block_delta\ndata: {not json\n\n')
                    self.end_chunks()
                    return
        if mode == 'half':
            return self.drop(idx, 'half')
        ev('content_block_stop', {'type': 'content_block_stop', 'index': 0})
        ev('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': stop, 'stop_sequence': None}, 'usage': {'output_tokens': 5}})
        ev('message_stop', {'type': 'message_stop'})
        self.end_chunks()
        log_event(idx, what='stream complete')


def main():
    srv = ThreadingHTTPServer(('127.0.0.1', ARGS.port), H)
    srv.daemon_threads = True
    port = srv.server_address[1]
    if ARGS.portfile:
        with open(ARGS.portfile, 'w') as f:
            f.write(str(port))
    print('standin-model listening on 127.0.0.1:%d nonce=%s' % (port, NONCE), flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
