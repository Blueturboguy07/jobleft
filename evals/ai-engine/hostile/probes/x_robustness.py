#!/usr/bin/env python3
"""Cross-cutting hostile environment: corrupt or empty files, concurrent runs, kill -9 mid-write, missing
permissions, a Unicode data-folder path, a lost encryption key. Pass = plain messages, no stack traces, no silent reset
to a default provider, no corrupt settings after concurrency. Serves O1 (choice survives), O4 (never hangs) and O8."""
import json, os, random, shutil, signal, stat, subprocess, sys, threading, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))
import harness as H
import checks as C

A = H.Standin('model', name='A')
B = H.Standin('model', name='B')


def setup(tag):
    jl = H.JL(tag)
    jl.run('use', 'custom', '--url', A.url, '--model', 'hostile-7b')
    return jl


# 1. corrupt, empty and wrong-typed settings file
for label, content in [('garbage', b'{not json at all \xff\xfe'), ('empty', b''), ('wrong-types', b'{"provider": 42, "model": ["x"], "baseUrl": {"a": 1}}'),
                       ('truncated', b'{"provider":"custom","baseUrl":"http://127.0.0.1:1'), ('null', b'null'), ('huge', b'{"x":"' + b'a' * 20_000_000 + b'"}')]:
    jl = setup('corrupt-' + label)
    sp = os.path.join(jl.home, 'ai', 'state.json')
    open(sp, 'wb').write(content)
    rc, out, dt = jl.run('status', timeout=60)
    rc2, out2, dt2 = jl.run('chat', 'hello', timeout=60)
    ok_plain, bad = C.plain_message(out + out2)
    said = any(w in (out + out2).replace(jl.home, '<home>').lower() for w in ['could not read', 'cannot read', 'damaged', 'corrupt', 'unreadable', 'reset', 'not valid', 'broken', 'start over', 'set up again'])
    H.check('corrupt-settings-plain[%s]' % label, ok_plain and rc != 'TIMEOUT' and rc2 != 'TIMEOUT', 'bad=%s status=%s chat=%s' % (bad, H.short(out, 200), H.short(out2, 200)), 'O1', 'medium')
    H.check('corrupt-settings-says-so[%s]' % label, said, 'status=%s | chat=%s' % (H.short(out, 250), H.short(out2, 150)), 'O1', 'low')
    jl.cleanup()

# 2. concurrent writers: 24 processes switch provider and save keys at the same time
jl = setup('concurrent')
procs = []
for i in range(24):
    if i % 3 == 0:
        procs.append(jl.popen('use', 'custom', '--url', (A if i % 2 else B).url, '--model', 'hostile-7b'))
    elif i % 3 == 1:
        p = jl.popen('key', 'set')
        p.stdin.write('sk-concurrent-%02d-key' % i)
        p.stdin.close()
        procs.append(p)
    else:
        procs.append(jl.popen('status'))
for p in procs:
    try:
        p.wait(60)
    except Exception:
        p.kill()
sp = os.path.join(jl.home, 'ai', 'state.json')
try:
    json.load(open(sp))
    parsed = True
except Exception as e:
    parsed = 'ERR %s' % e
rc, out, dt = jl.run('status')
ok_plain, bad = C.plain_message(out)
H.check('concurrent-writes-leave-valid-settings', parsed is True and ok_plain and 'Provider:' in out, 'parsed=%s status=%s' % (parsed, H.short(out, 200)), 'O1', 'high')
rc, out, dt = jl.run('chat', 'Reply with the word ready')
H.check('concurrent-writes-then-chat-works', rc == 0 and (A.nonce in out or B.nonce in out), H.short(out, 200), 'O1', 'high')
jl.cleanup()

# 3. kill -9 while saving, 25 times at random moments: the settings file must always stay readable
jl = setup('kill9')
broken = 0
for i in range(25):
    p = jl.popen('use', 'custom', '--url', (A if i % 2 else B).url, '--model', 'hostile-7b')
    time.sleep(random.uniform(0.05, 0.35))
    p.send_signal(signal.SIGKILL)
    p.wait()
    try:
        json.load(open(os.path.join(jl.home, 'ai', 'state.json')))
    except FileNotFoundError:
        pass
    except Exception:
        broken += 1
rc, out, dt = jl.run('status')
H.check('kill-9-mid-save-never-corrupts', broken == 0 and 'Provider:' in out, 'corrupt after kill: %d of 25; status=%s' % (broken, H.short(out, 150)), 'O1', 'high')
# the same while saving a key (secrets file)
bk = 0
for i in range(15):
    p = jl.popen('key', 'set')
    p.stdin.write('sk-kill-%02d' % i)
    p.stdin.close()
    time.sleep(random.uniform(0.05, 0.3))
    p.send_signal(signal.SIGKILL)
    p.wait()
    rc, out, dt = jl.run('status')
    if not C.plain_message(out)[0] or rc not in (0, 1):
        bk += 1
H.check('kill-9-mid-key-save-never-breaks', bk == 0, 'broken after kill: %d of 15; last status=%s' % (bk, H.short(out, 200)), 'O8', 'high')
jl.cleanup()

# 4. no permission to read the data folder
jl = setup('perm')
os.chmod(os.path.join(jl.home, 'ai'), 0)
rc, out, dt = jl.run('status', timeout=30)
rc2, out2, dt2 = jl.run('chat', 'hello', timeout=30)
os.chmod(os.path.join(jl.home, 'ai'), 0o700)
ok_plain, bad = C.plain_message(out + out2)
said = any(w in (out + out2).replace(jl.home, '<home>').lower() for w in ['permission', 'cannot read', 'could not read', 'not allowed'])
H.check('unreadable-data-folder-says-so', said, 'status=%s chat=%s' % (H.short(out.replace(jl.home, '<home>'), 200), H.short(out2, 200)), 'O1', 'low')
H.check('unreadable-data-folder-plain', ok_plain and rc != 'TIMEOUT', 'bad=%s status=%s chat=%s' % (bad, H.short(out, 200), H.short(out2, 200)), 'O1', 'medium')
jl.cleanup()

# 5. a data folder with spaces, accents and emoji in its path
jl = H.JL('unicode')
weird = os.path.join(jl.home, 'Jördan Tëstwell 📁 données')
os.makedirs(weird)
jl.env['JOBLEFT_HOME'] = weird
jl.run('use', 'custom', '--url', A.url, '--model', 'hostile-7b')
jl.run('key', 'set', stdin='sk-unicode-path-1234')
rc, out, dt = jl.run('chat', 'Reply with the word ready')
H.check('unicode-data-folder-works', rc == 0 and A.nonce in out, H.short(out, 200), 'O1', 'medium')
jl.env['JOBLEFT_HOME'] = jl.home
jl.cleanup()

# 6. the encryption key file is lost while the encrypted secrets remain
jl = setup('lostkey')
jl.run('key', 'set', stdin='sk-lost-master-key-5678')
for f in jl.files():
    if f.endswith('master.key'):
        os.remove(f)
rc, out, dt = jl.run('chat', 'hello')
rc2, out2, dt2 = jl.run('status')
ok_plain, bad = C.plain_message(out + out2)
H.check('lost-master-key-plain', ok_plain, 'bad=%s chat=%s status=%s' % (bad, H.short(out, 200), H.short(out2, 200)), 'O8', 'medium')
sent_key = [r for r in A.ai_requests() if 'sk-lost' in json.dumps(r['headers'])]
claims_saved = 'ends in "5678"' in out2
H.check('lost-master-key-not-silently-dropped', sent_key or (not claims_saved and rc != 0),
        'key sent=%d status claims saved=%s chat=%s' % (len(sent_key), claims_saved, H.short(out, 150)), 'O8', 'low')
jl.cleanup()

# 7. a huge chat message (600 kB): plain handling, the app does not hang
jl = setup('hugemsg')
big = 'Jordan Testwell 🙂 ' * 32000
rc, out, dt = jl.run('chat', big, timeout=120)
ok_plain, bad = C.plain_message(out)
H.check('huge-message-plain-no-hang', rc != 'TIMEOUT' and ok_plain, 'rc=%s %.1fs %s' % (rc, dt, H.short(out, 200)), 'O4', 'medium')
jl.cleanup()

# 8. an unknown vendor name saved by mistake: nothing is sent anywhere, plain words
jl = H.JL('vendor')
jl.run('use', 'own-key', '--vendor', 'bogus-vendor', '--model', 'x')
jl.run('key', 'set', stdin='sk-bogus-vendor-9999')
rc, out, dt = jl.run('chat', 'hello')
ok_plain, bad = C.plain_message(out)
H.check('unknown-vendor-plain-and-sends-nothing', ok_plain and not jl.non_loopback(), 'bad=%s out=%s attempts=%s' % (bad, H.short(out, 200), jl.non_loopback()[:3]), 'O1', 'low')
jl.cleanup()

H.finish()
