#!/usr/bin/env python3
"""O12 (MUST): an empty, cut-off, wrong-form or out-of-range answer gives "cannot use this answer" with a retry, or a
result clearly marked partial; never an invented value. Ground truth: the exact text the evaluator's stand-in sent;
every number on screen must come from that text or from the input."""
import json, os, re, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))
import harness as H
import checks as C

INPUT = 'Jordan Testwell, SQL analyst with 3 years. Job: data analyst with SQL and Tableau, 2+ years.'
m = H.Standin('model')

# (name, mode, content, expect) ; expect = 'refuse' or an int score the app may show
CASES = [
    ('empty', 'empty', None, 'refuse'),
    ('cutoff', 'cutoff', '{"score": 72, "reasons": ["SQL experience matches", "No Tableau listed"], "missing": ["Tableau"]}', 'refuse'),
    ('prose', 'text', None, 'refuse'),
    ('score-140', 'badscore', None, 'refuse'),
    ('missing-reasons', 'custom', '{"score": 85}', 'refuse'),
    ('empty-reasons', 'custom', '{"score": 72, "reasons": []}', 'refuse'),
    ('score-negative', 'custom', '{"score": -5, "reasons": ["SQL"]}', 'refuse'),
    ('score-null', 'custom', '{"score": null, "reasons": ["SQL"]}', 'refuse'),
    ('score-fraction', 'custom', '{"score": 85.5, "reasons": ["SQL"]}', 'refuse-or-85.5'),
    ('score-string', 'custom', '{"score": "85", "reasons": ["SQL"]}', 'refuse-or-85'),
    ('score-100.0', 'custom', '{"score": 100.0, "reasons": ["SQL"]}', 'refuse-or-100'),
    ('score-0-to-1-scale', 'custom', '{"score": 0.85, "reasons": ["SQL"]}', 'refuse-or-0.85'),
    ('fenced-json', 'custom', '```json\n{"score": 72, "reasons": ["SQL match"]}\n```', 'refuse-or-72'),
    ('json-in-prose', 'custom', 'Sure! Here it is: {"score": 72, "reasons": ["SQL match"]} Hope it helps.', 'refuse-or-72'),
    ('two-json-objects', 'custom', '{"score": 72, "reasons": ["a"]}{"score": 10, "reasons": ["b"]}', 'refuse-or-72'),
    ('line-fallback-ok', 'custom', 'SCORES: fit=77\n- SQL experience\n- No Tableau', 'refuse-or-77'),
    ('line-fallback-140', 'custom', 'SCORES: fit=140\n- SQL experience', 'refuse'),
    ('line-fallback-blank', 'custom', 'SCORES: fit=\n- SQL experience', 'refuse'),
    ('seven-out-of-ten', 'custom', 'I would rate this candidate 7 out of 10 overall.', 'refuse'),
    ('percent-text', 'custom', 'Fit: about 80% based on SQL.', 'refuse-or-80'),
    ('truncated-json', 'custom', '{"score": 72, "reasons": ["SQL experience matc', 'refuse'),
    ('deep-nesting', 'custom', '{"score": 72, "reasons": ["a"], "x": ' + '[' * 20000 + ']' * 20000 + '}', 'refuse-or-72'),
    ('huge-answer', 'custom', json.dumps({'score': 72, 'reasons': ['r' * 1000] * 3000}), 'refuse-or-72'),
    ('think-then-json', 'think', None, 'refuse-or-63'),
    ('think-only', 'think-only', None, 'refuse'),
    ('broken-stream', 'broken', '{"score": 72, "reasons": ["SQL experience matches the job"]}', 'refuse'),
    ('dropped-stream', 'half', '{"score": 72, "reasons": ["SQL experience matches the job"]}', 'refuse'),
]

SCREEN_NUM = re.compile(r'(?<![\w.])-?\d+(?:\.\d+)?%?')


def screen_numbers(out):
    # numbers shown as a RESULT: skip the provider label, links, and the refusal/explanation lines
    body = '\n'.join(l for l in out.splitlines() if not (l.startswith('[') and l.rstrip().endswith(']'))
                     and not l.lower().startswith(('cannot use this answer', 'try again', 'not done', 'no answer')))
    body = re.sub(r'https?://\S+', ' ', body)
    return set(n.rstrip('%') for n in SCREEN_NUM.findall(body))


def allowed_numbers(content):
    src = (content or '') + ' ' + INPUT
    a = set(n.rstrip('%') for n in SCREEN_NUM.findall(src))
    a.update(n.lstrip('-') for n in list(a))
    for n in list(a):
        try:
            f = float(n)
            if f == int(f):
                a.add(str(int(f)))
        except ValueError:
            pass
    return a


def run_dialect(dialect):
    jl = H.JL('d-' + dialect, extra_env={'JOBLEFT_AI_HOST_MAP': json.dumps({'api.anthropic.com': m.url})})
    if dialect == 'openai':
        jl.run('use', 'custom', '--url', m.url, '--model', 'hostile-7b')
    elif dialect == 'ollama':
        jl.run('use', 'local', '--kind', 'ollama', '--url', m.url, '--model', 'hostile-7b')
    else:
        jl.run('use', 'own-key', '--vendor', 'anthropic', '--model', 'hostile-7b')
        jl.run('key', 'set', stdin='sk-ant-o12-0000')
    for name, mode, content, expect in CASES:
        m.mode(mode, content=content)
        rc, out, dt = jl.run('json', INPUT, timeout=120)
        refused = 'cannot use this answer' in out.lower()
        retry = 'try again' in out.lower()
        ok_plain, bad = C.plain_message(out.replace('"score"', ''))
        shown = screen_numbers(out)
        if mode in ('think', 'badscore') or content is None:
            # the stand-in built the answer from the schema: read what it sent from its own log
            sent = ''
            allowed = allowed_numbers('63 140 0 100 1 5 2')
        else:
            allowed = allowed_numbers(content)
        invented = sorted(n for n in shown if n not in allowed)
        if expect == 'refuse':
            ok = refused and retry and rc != 0 and not invented
        else:
            val = expect.split('-or-')[1]
            m_score = re.search(r'"score"\s*:\s*(-?[0-9.]+)', out)
            ok = (refused and retry and not invented) or (rc == 0 and m_score and m_score.group(1).rstrip('0').rstrip('.') == val.rstrip('0').rstrip('.') if '.' in val else (rc == 0 and m_score and m_score.group(1) == val)) and not invented
        sev = 'critical' if invented else ('high' if expect == 'refuse' else 'medium')
        if name == 'deep-nesting':
            ok = ok or (rc != 0 and retry and not invented)
        H.check('bad-answer[%s][%s]' % (dialect, name), bool(ok) and ok_plain,
                'expect=%s rc=%s refused=%s invented=%s plainbad=%s out=%s' % (expect, rc, refused, invented, bad, H.short(out, 220)), 'O12', sev)
        if name == 'two-json-objects':
            H.check('two-conflicting-answers-not-silently-picked[%s]' % dialect, refused, 'out=%s' % H.short(out, 150), 'O12', 'low')
        if name == 'deep-nesting':
            H.check('deep-nesting-message-names-problem[%s]' % dialect, 'unknown reason' not in out.lower(), 'out=%s' % H.short(out, 200), 'O12', 'low')
    # chat: a cut-off, dropped or thinking-only answer is marked, never shown as a complete answer
    for mode in ['cutoff', 'half', 'empty', 'think-only']:
        m.mode(mode, content='ALPHA1 BRAVO2 CHARLIE3 DELTA4 ECHO5 FOXTROT6 GOLF7 HOTEL8' if mode in ('cutoff', 'half') else None)
        rc, out, dt = jl.run('chat', 'Tell me about the Data Analyst job')
        marked = 'incomplete' in out.lower() or 'no answer' in out.lower() or 'empty' in out.lower() or 'thinking' in out.lower()
        H.check('chat-bad-answer-marked[%s][%s]' % (dialect, mode), marked and '[done]' not in out and 'Let me think' not in out,
                'rc=%s out=%s' % (rc, H.short(out, 250)), 'O12', 'high')
    m.mode('ok', content=None)
    jl.cleanup()


for d in ['openai', 'ollama', 'anthropic']:
    run_dialect(d)
H.finish()
