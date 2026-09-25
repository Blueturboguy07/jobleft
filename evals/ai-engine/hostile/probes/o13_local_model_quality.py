#!/usr/bin/env python3
"""O13 (SHOULD): a common 7B-14B local model gives a usable result in at least 4 of 5 tries per action; thinking is
never shown; long texts are not silently cut. Ground truth: the evaluator's own fit labels and score bands for 5
fictional jobs (data/jobs.json). Needs a local Ollama with a 7B-14B model; otherwise the real-model part is BLOCKED."""
import json, os, re, sys, time, urllib.request
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))
import harness as H
import checks as C

RESUME = open(os.path.join(H.ROOT, 'data', 'persona-resume.txt'), encoding='utf-8').read()
JOBS = json.load(open(os.path.join(H.ROOT, 'data', 'jobs.json'), encoding='utf-8'))
TRIES = int(os.environ.get('O13_TRIES', '5'))
table = {}


def ollama_model():
    try:
        with urllib.request.urlopen('http://127.0.0.1:11434/api/tags', timeout=2) as r:
            models = json.load(r)['models']
        for mm in models:
            size = (mm.get('details') or {}).get('parameter_size', '')
            if 'completion' in (mm.get('capabilities') or ['completion']) and re.match(r'^(7|8|9|1[0-4])(\.\d+)?B$', size):
                return mm['name']
    except Exception:
        return None
    return None


model = ollama_model()
if not model:
    print(json.dumps({'probe': 'o13', 'blocked': 'no local Ollama with a 7B-14B model'}))
else:
    jl = H.JL('real')
    jl.run('use', 'local', '--kind', 'ollama', '--model', model, timeout=200)
    for job in JOBS:
        ok_n, rows = 0, []
        for t in range(TRIES):
            text = 'Candidate resume:\n' + RESUME + '\n\nJob posting:\n' + job['title'] + ' at ' + job['company'] + '\n' + job['description']
            rc, out, dt = jl.run('json', text, timeout=300)
            m_score = re.search(r'"score"\s*:\s*(\d+)', out)
            reasons = re.findall(r'"reasons"\s*:\s*\[(.*?)\]', out, re.S)
            score = int(m_score.group(1)) if m_score else None
            lo, hi = job['band']
            usable = rc == 0 and score is not None and lo <= score <= hi and reasons and len(reasons[0].strip()) > 5
            ok_n += bool(usable)
            rows.append({'try': t + 1, 'rc': rc, 'score': score, 'band': job['band'], 'usable': bool(usable), 'secs': round(dt, 1)})
        table['fit:' + job['id']] = {'label': job['label'], 'usable': ok_n, 'of': TRIES, 'rows': rows}
        H.check('fit-usable-4-of-5[%s %s]' % (job['id'], job['label']), ok_n >= min(4, TRIES), 'usable %d/%d scores=%s band=%s' % (ok_n, TRIES, [r['score'] for r in rows], job['band']), 'O13', 'medium')
    # ordering: the mean score of the strong fits is above the mean of the weak/none fits (evaluator labels)
    def mean(ids):
        v = [r['score'] for i in ids for r in table['fit:' + i]['rows'] if r['score'] is not None]
        return sum(v) / len(v) if v else None
    strong, weak = mean(['j1', 'j3']), mean(['j2', 'j4'])
    fit_ok = sum(table['fit:' + j['id']]['usable'] for j in JOBS)
    fit_n = sum(table['fit:' + j['id']]['of'] for j in JOBS)
    H.check('fit-action-usable-overall-80pct', fit_ok >= 0.8 * fit_n, 'usable %d/%d (bar: 4 of 5 = 80%%)' % (fit_ok, fit_n), 'O13', 'medium')
    H.check('fit-ranks-strong-above-weak', strong is not None and weak is not None and strong > weak + 15, 'strong=%s weak=%s' % (strong, weak), 'O13', 'medium')
    # chat usable
    ok_n, rows = 0, []
    for t in range(TRIES):
        rc, out, dt = jl.run('chat', 'Here is my resume:\n' + RESUME + '\nIn two sentences: which skill should I learn next for data analyst jobs?', timeout=300)
        usable = rc == 0 and '[done]' in out and len(out.split()) > 12 and '<think>' not in out
        ok_n += bool(usable)
        rows.append({'try': t + 1, 'rc': rc, 'usable': bool(usable), 'secs': round(dt, 1)})
    table['chat'] = {'usable': ok_n, 'of': TRIES, 'rows': rows}
    H.check('chat-usable-4-of-5', ok_n >= min(4, TRIES), 'usable %d/%d' % (ok_n, TRIES), 'O13', 'medium')
    jl.cleanup()

# long text: the stand-in plays Ollama with a 32,768-token model; a text that cannot fit is refused before sending,
# a long text that fits gets a larger context (num_ctx), so Ollama does not cut it silently
m = H.Standin('model')
jl = H.JL('long')
jl.run('use', 'local', '--kind', 'ollama', '--url', m.url, '--model', 'hostile-7b')
for label, n_chars, expect in [('fits-60k-chars', 60000, 'send'), ('too-big-600k-chars', 600000, 'refuse')]:
    m.reset()
    big = ('Jordan Testwell used SQL and Power BI to build weekly reports. ' * (n_chars // 64 + 1))[:n_chars]
    rc, out, dt = jl.run('json', 'Candidate resume:\n' + big + '\nJob: data analyst with SQL.', timeout=200)
    chats = [json.loads(e['body']) for e in m.ai_requests() if e['path'] == '/api/chat' and e['body']]
    if expect == 'send':
        ctx = [((b.get('options') or {}).get('num_ctx')) for b in chats]
        H.check('long-text-gets-larger-context[%s]' % label, chats and all(c and c >= n_chars // 4 for c in ctx), 'num_ctx=%s rc=%s out=%s' % (ctx, rc, H.short(out, 150)), 'O13', 'medium')
    else:
        ok_plain, bad = C.plain_message(out)
        H.check('too-long-text-refused-before-send[%s]' % label, not chats and rc != 0 and ok_plain, 'requests=%d out=%s' % (len(chats), H.short(out, 200)), 'O13', 'medium')
# thinking: shown answer only, and a think-only answer says so (stand-in, since no reasoning model is installed)
m.mode('think')
rc, out, dt = jl.run('chat', 'Reply with the word ready')
H.check('thinking-hidden-in-chat', m.nonce in out and 'Let me think' not in out, H.short(out, 200), 'O13', 'medium')
m.mode('think-only')
rc, out, dt = jl.run('chat', 'Reply with the word ready')
H.check('think-only-says-so', 'think' in out.lower() and '[done]' not in out, H.short(out, 200), 'O13', 'medium')
jl.cleanup()

with open(os.path.join(H.OUT, 'o13-table.json'), 'w') as f:
    json.dump({'model': model, 'table': table}, f, indent=1)
print(json.dumps({'model': model, 'summary': {k: '%d/%d' % (v['usable'], v['of']) for k, v in table.items()}}))
H.finish()
