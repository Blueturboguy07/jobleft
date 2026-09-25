"""Shared helpers for the hostile ai-engine probes. Evaluator-written; imports nothing from jobleft."""
import json, os, re, shutil, signal, socket, subprocess, sys, tempfile, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TARGET_DIR = os.environ.get('TARGET_DIR', os.path.expanduser('~/jobleft-wt/ai-engine'))
CLI = os.path.join(TARGET_DIR, 'packages', 'ai-engine', 'src', 'cli.ts')
OUT = os.path.join(ROOT, 'out')
os.makedirs(OUT, exist_ok=True)
CANARY = 'sk-canary-7Q4Z-jobleft-test'
APP_TOKEN = 'pat_jobleft_devstandin0000000000000000000000'
RESULTS = []
PROBE = os.path.splitext(os.path.basename(sys.argv[0]))[0]
_procs = []


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


def http(method, url, body=None, headers=None, timeout=15, raw=False):
    data = None
    h = dict(headers or {})
    if body is not None:
        data = body if isinstance(body, (bytes, bytearray)) else json.dumps(body).encode()
        h.setdefault('content-type', 'application/json')
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            b = r.read()
            return r.status, dict(r.headers), (b if raw else _j(b))
    except urllib.error.HTTPError as e:
        b = e.read()
        return e.code, dict(e.headers), (b if raw else _j(b))


def _j(b):
    try:
        return json.loads(b)
    except Exception:
        return b.decode('utf-8', 'replace')


class Standin:
    def __init__(self, kind, *args, name=None):
        self.kind = kind
        self.name = name or kind
        self.port = free_port()
        self.logfile = os.path.join(OUT, '%s-%s-%d.log' % (PROBE, self.name, self.port))
        script = os.path.join(HERE, 'standin_%s.py' % kind)
        self.args = [sys.executable, script, '--port', str(self.port), '--log', self.logfile] + list(args)
        self.start()

    def start(self):
        self.proc = subprocess.Popen(self.args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        _procs.append(self.proc)
        line = self.proc.stdout.readline()
        m = re.search(r'nonce=(\S+)', line)
        self.nonce = m.group(1) if m else None
        for _ in range(50):
            try:
                socket.create_connection(('127.0.0.1', self.port), 0.2).close()
                break
            except OSError:
                time.sleep(0.1)
        if self.kind == 'publik':
            self.nonce = self.state()['nonce']

    def stop(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()

    @property
    def url(self):
        return 'http://127.0.0.1:%d' % self.port

    def admin(self, path, body=None):
        return http('POST' if body is not None else 'GET', self.url + '/__admin/' + path, body)[2]

    def mode(self, mode, **kw):
        return self.admin('mode', dict(kw, mode=mode))

    def log(self):
        return self.admin('log')

    def reset(self):
        return self.admin('reset' if self.kind == 'model' else 'reset-log', {})

    def state(self):
        return self.admin('state')

    def ai_requests(self):
        return [e for e in self.log() if not e['path'].startswith('/__admin')]


class JL:
    def __init__(self, tag, publik=None, extra_env=None, keep=False, sandbox=True):
        self.sandbox = sandbox
        self.home = tempfile.mkdtemp(prefix='jlh-%s-%s-' % (PROBE, tag), dir='/private/tmp')
        self.env = dict(os.environ)
        for k in list(self.env):
            if k.startswith('JOBLEFT_'):
                del self.env[k]
        self.env.update({'JOBLEFT_HOME': self.home, 'JOBLEFT_SECRET_STORE': 'file',
                         'JOBLEFT_PUBLIK_APP_TOKEN': APP_TOKEN,
                         'JOBLEFT_PUBLIK_BASE_URL': (publik.url + '/api/v1') if publik else 'http://127.0.0.1:9/api/v1'})
        self.netlog_path = os.path.join(self.home + '.netmon.jsonl')
        self.env.update({'NODE_OPTIONS': '--import ' + os.path.join(HERE, 'netmon.mjs'), 'HOSTILE_NETMON_LOG': self.netlog_path})
        self.env.update(extra_env or {})
        self.transcript = []

    def cmd(self, args):
        # every product run is loopback-only: a sandbox denies all other network and DNS
        if not self.sandbox:
            return ['node', CLI] + list(args)
        return ['sandbox-exec', '-f', os.path.join(HERE, 'loopback-only.sb'), 'node', CLI] + list(args)

    def netlog(self):
        try:
            with open(self.netlog_path) as f:
                return [json.loads(l) for l in f if l.strip()]
        except OSError:
            return []

    def non_loopback(self):
        out = []
        for r in self.netlog():
            h = r.get('host')
            if r.get('path'):
                continue
            if h in (None, '127.0.0.1', 'localhost', '::1', '[::1]'):
                continue
            out.append(r)
        return out

    def run(self, *args, stdin=None, timeout=200, env=None):
        e = dict(self.env)
        e.update(env or {})
        t0 = time.time()
        try:
            p = subprocess.run(self.cmd(args), input=stdin, capture_output=True, text=True, timeout=timeout,
                               cwd=TARGET_DIR, env=e)
            rc, out, err = p.returncode, p.stdout, p.stderr
        except subprocess.TimeoutExpired as ex:
            rc, out, err = 'TIMEOUT', (ex.stdout or b'').decode() if isinstance(ex.stdout, bytes) else (ex.stdout or ''), \
                (ex.stderr or b'').decode() if isinstance(ex.stderr, bytes) else (ex.stderr or '')
        dt = time.time() - t0
        self.transcript.append({'args': list(args), 'rc': rc, 'out': out, 'err': err, 'secs': round(dt, 2)})
        return rc, out + err, dt

    def popen(self, *args, env=None):
        e = dict(self.env)
        e.update(env or {})
        p = subprocess.Popen(self.cmd(args), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.PIPE,
                             text=True, cwd=TARGET_DIR, env=e)
        _procs.append(p)
        return p

    def files(self):
        out = []
        for d, _, fs in os.walk(self.home):
            for f in fs:
                out.append(os.path.join(d, f))
        return out

    def grep_home(self, needle):
        hits = []
        nb = needle.encode()
        for f in self.files():
            try:
                with open(f, 'rb') as fh:
                    if nb in fh.read():
                        hits.append(f)
            except OSError:
                pass
        return hits

    def save_transcript(self):
        with open(os.path.join(OUT, '%s-transcript.json' % PROBE), 'a') as f:
            f.write(json.dumps({'home': self.home, 'runs': self.transcript}) + '\n')

    def cleanup(self):
        self.save_transcript()
        shutil.rmtree(self.home, ignore_errors=True)
        try:
            os.remove(self.netlog_path)
        except OSError:
            pass


def check(cid, ok, evidence, outcome=None, severity=None):
    r = {'probe': PROBE, 'check': cid, 'pass': bool(ok), 'evidence': evidence}
    if outcome:
        r['outcome'] = outcome
    if severity and not ok:
        r['severity'] = severity
    RESULTS.append(r)
    print(json.dumps(r), flush=True)
    return ok


def finish():
    for p in _procs:
        try:
            if p.poll() is None:
                p.kill()
        except Exception:
            pass
    fails = [r for r in RESULTS if not r['pass']]
    with open(os.path.join(OUT, '%s-results.json' % PROBE), 'w') as f:
        json.dump(RESULTS, f, indent=1)
    print(json.dumps({'probe': 'ai-engine/hostile/' + PROBE, 'n': len(RESULTS), 'score': (len(RESULTS) - len(fails)) / max(1, len(RESULTS)),
                      'pass': not fails, 'bar': 'every check passes'}), flush=True)
    sys.exit(1 if fails else 0)


URL_RE = re.compile(r'https?://[^\s\)\]"\'<>]+')


def links_in(text):
    return URL_RE.findall(text)


def short(s, n=400):
    s = s if isinstance(s, str) else json.dumps(s)
    return s if len(s) <= n else s[:n] + '...'


class Serve:
    """`jl serve` under the sandbox; reads the printed address and launch token."""
    def __init__(self, jl):
        import threading
        self.jl = jl
        self.proc = jl.popen('serve')
        self.lines = []
        self.port = None
        self.token = None
        t0 = time.time()
        while time.time() - t0 < 15 and (self.port is None or self.token is None):
            line = self.proc.stdout.readline()
            if not line:
                break
            self.lines.append(line)
            m = re.search(r'http://127\.0\.0\.1:(\d+)', line)
            if m:
                self.port = int(m.group(1))
            m = re.search(r'header\):\s*(\S+)', line)
            if m:
                self.token = m.group(1)
        def drain():
            for line in self.proc.stdout:
                self.lines.append(line)
        threading.Thread(target=drain, daemon=True).start()

    @property
    def base(self):
        return 'http://127.0.0.1:%d' % self.port

    def req(self, method, path, body=None, headers=None, token=True, timeout=30, raw_body=None):
        import http.client
        h = {'host': '127.0.0.1:%d' % self.port}
        if token:
            h['x-jobleft-token'] = self.token
        data = None
        if raw_body is not None:
            data = raw_body
        elif body is not None:
            data = json.dumps(body).encode()
            h['content-type'] = 'application/json'
        h.update(headers or {})
        if data is not None and not any(k.lower() in ('content-length', 'transfer-encoding') for k in h):
            h['content-length'] = str(len(data))
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=timeout)
        c.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        for k, v in h.items():
            if v is not None:
                c.putheader(k, v)
        c.endheaders(data)
        r = c.getresponse()
        b = r.read()
        c.close()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, _j(b)

    def sse(self, path, body, timeout=300, on_event=None, token=True):
        """POST and read `data:` events. Returns (status, events[(t_rel, obj)], total_secs)."""
        import http.client
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=timeout)
        h = {'content-type': 'application/json'}
        if token:
            h['x-jobleft-token'] = self.token
        t0 = time.time()
        c.request('POST', path, json.dumps(body).encode(), h)
        r = c.getresponse()
        evs = []
        if r.status != 200:
            b = r.read()
            c.close()
            return r.status, [(time.time() - t0, _j(b))], time.time() - t0
        buf = b''
        while True:
            try:
                chunk = r.read1(65536) if hasattr(r, 'read1') else r.read(1)
            except Exception as e:
                evs.append((time.time() - t0, {'type': '__read_error', 'error': str(e)}))
                break
            if not chunk:
                break
            buf += chunk
            while b'\n\n' in buf:
                block, buf = buf.split(b'\n\n', 1)
                for line in block.split(b'\n'):
                    if line.startswith(b'data:'):
                        o = _j(line[5:].strip())
                        evs.append((time.time() - t0, o))
                        if on_event:
                            on_event(o)
        c.close()
        return 200, evs, time.time() - t0

    def stop(self):
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(5)
            except Exception:
                self.proc.kill()
