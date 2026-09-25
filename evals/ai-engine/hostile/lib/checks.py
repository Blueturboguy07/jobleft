"""Pure check functions. Probes and negative controls use the SAME functions, so a negative control that feeds a
doctored input proves the check can fail."""
import re

URL_RE = re.compile(r'https?://[^\s\)\]"\'<>]+')
MONEY_RE = re.compile(r'(?<![\w.])(?:<)?\$\s?(-?[0-9][0-9,]*(?:\.[0-9]+)?)')


def links(text):
    return URL_RE.findall(text or '')


def top_up_links(text, allowed_prefixes):
    """Links in the text that are not the provider's own address; returns (all_links, money_links)."""
    ls = links(text)
    return ls, [l for l in ls if any(l.startswith(a) for a in allowed_prefixes)]


def dollar_amounts(text):
    return [m.group(0) for m in MONEY_RE.finditer(text or '')]


def expect_balance(text, expected_str):
    """True when the text shows exactly the expected dollar string (e.g. '$4.97') and no other balance figure in the
    same 'balance' line."""
    lines = [l for l in (text or '').splitlines() if 'balance' in l.lower()]
    shown = [a for l in lines for a in dollar_amounts(l)]
    return (expected_str in shown) and all(a == expected_str for a in shown), shown


def forbidden_money_words(text):
    """'credit(s)' used as a unit of money, 'tokens' as money, raw codes the outcome forbids in the out-of-money copy."""
    bad = []
    for pat in [r'\bcredits?\b', r'\b402\b', r'quota', r'insufficient_credit', r'\btokens? left\b']:
        for m in re.finditer(pat, text or '', re.I):
            bad.append(m.group(0))
    return bad


def leak_positions(needle, logs):
    """logs: list of (server_name, entries). Returns list of (server, where) for each place the needle appears."""
    hits = []
    for name, entries in logs:
        for e in entries:
            if needle in e.get('path', ''):
                hits.append((name, 'url:' + e['path']))
            for k, v in (e.get('headers') or {}).items():
                if needle in str(v):
                    hits.append((name, 'header:' + k))
            if needle in (e.get('body') or ''):
                hits.append((name, 'body'))
    return hits


def only_in(hits, server, header_names):
    """Every hit is on `server` and in one of `header_names`, and there is at least one hit."""
    if not hits:
        return False
    return all(h[0] == server and h[1] in ['header:' + x for x in header_names] for h in hits)


def invented_numbers(output, allowed_numbers):
    """Numbers that appear in the product output but not in the stand-in answer or the input."""
    nums = set(re.findall(r'(?<![\w.])\d+(?:\.\d+)?%?', output or ''))
    return sorted(n for n in nums if n.rstrip('%') not in allowed_numbers)


def shows_more_than_last4(text, key):
    """True when any 5-character window of the key appears in the text."""
    for i in range(len(key) - 4):
        if key[i:i + 5] in (text or ''):
            return True
    return False


def plain_message(text):
    """No stack trace, no raw JSON dump, no 'undefined'/'[object Object]'."""
    bad = []
    for pat in [r'\n\s+at [\w.<>]+ \(', r'node:internal', r'\bTypeError\b', r'\bReferenceError\b', r'\[object Object\]',
                r'\bundefined\b', r'ECONNREFUSED', r'UND_ERR', r'"error"\s*:', r'Traceback', r'ERR_[A-Z_]+']:
        if re.search(pat, text or ''):
            bad.append(pat)
    return not bad, bad


CATEGORIES = {
    'unreachable': [r'cannot be reached', r'can.t be reached', r'nothing answers', r'not reachable', r'could not reach', r'unreachable', r'does not answer', r'no answer from'],
    'key_refused': [r'key was refused', r'refused the key', r'key refused', r'rejected the key', r'key .*not accepted', r'wrong key', r'key .*(invalid|refused)'],
    'model_not_found': [r'model not found', r'model .*(does not exist|is not on|not found)', r'no model named'],
    'not_ai_server': [r'not an ai server', r'not an ai answer', r'is not an ai', r'web page', r'not an openai'],
    'balance_low': [r'balance (ran out|is too low|too low)', r'ran out', r'balance is empty'],
    'works': [r'\bworks\b'],
}


def categories(text):
    t = (text or '').lower()
    return sorted(c for c, pats in CATEGORIES.items() if any(re.search(p, t) for p in pats))
