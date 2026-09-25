// The server's own page. It takes the launch token from the address fragment (#token=...), keeps it in this tab's
// sessionStorage only, and removes it from the address bar. It never stores personal data in the browser.

const KEY = 'jobleft.launchToken';
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.get('token')) {
  try { sessionStorage.setItem(KEY, hash.get('token')); } catch { /* private mode: keep it in memory */ }
  window.__token = hash.get('token');
  history.replaceState(null, '', location.pathname);
}
const token = window.__token || (() => { try { return sessionStorage.getItem(KEY); } catch { return null; } })();

const $ = (id) => document.getElementById(id);
function notice(text, ok = false) {
  const n = $('notice');
  n.textContent = text;
  n.className = ok ? 'notice ok' : 'notice';
  n.hidden = !text;
}

async function api(method, path, body, raw) {
  const headers = { 'x-jobleft-token': token || '' };
  let payload;
  if (raw) { headers['content-type'] = raw; payload = body; }
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(path, { method, headers, body: payload, cache: 'no-store' });
  if (!res.ok) {
    let msg = `The server answered ${res.status}.`;
    try { msg = (await res.json()).error.message; } catch { /* keep */ }
    throw new Error(msg);
  }
  return res;
}
const json = async (m, p, b) => (await api(m, p, b)).json();

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
function when(iso) { return iso ? new Date(iso).toLocaleString() : 'never'; }

async function download(res, fallback) {
  const cd = res.headers.get('content-disposition') || '';
  const m = /filename="([^"]+)"/.exec(cd);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = m ? m[1] : fallback;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function loadFolder() {
  const s = await json('GET', '/api/v1/storage');
  $('dataDir').textContent = s.dataDir;
  $('dbBytes').textContent = bytes(s.dbBytes);
  $('jobs').textContent = `${s.jobs.toLocaleString()} (${s.openJobs.toLocaleString()} open)`;
}

async function loadCounts() {
  const [profile, tracker, filters, resumes, contacts, chats] = await Promise.all([
    json('GET', '/api/v1/profile'), json('GET', '/api/v1/tracker?view=liked'), json('GET', '/api/v1/filters'),
    json('GET', '/api/v1/resumes'), json('GET', '/api/v1/network/contacts'), json('GET', '/api/v1/ai/chats'),
  ]);
  const c = tracker.counts;
  const rows = [
    ['Profile', profile.personal.firstName || profile.personal.lastName ? 'saved' : 'not filled in yet'],
    ['Liked jobs', c.liked], ['Applied (any stage)', c.applied], ['Added by you', c.external], ['Hidden', c.hidden],
    ['Closed but tracked', c.closed], ['Saved filters', filters.length], ['Resumes', resumes.length],
    ['Contacts', contacts.length], ['Conversations', chats.length],
  ];
  const dl = $('counts');
  dl.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = String(v);
    dl.append(dt, dd);
  }
}

async function loadPairings() {
  const list = await json('GET', '/api/v1/extension/pairings');
  const body = $('pairings').querySelector('tbody');
  body.replaceChildren();
  if (!list.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td'); td.colSpan = 5; td.className = 'muted'; td.textContent = 'None yet.';
    tr.append(td); body.append(tr);
    return;
  }
  for (const p of list) {
    const tr = document.createElement('tr');
    const id = document.createElement('td'); const code = document.createElement('code'); code.textContent = p.extensionId; id.append(code);
    const br = document.createElement('td'); br.textContent = `${p.browser} (${p.extensionVersion})`;
    const pa = document.createElement('td'); pa.textContent = when(p.pairedAt);
    const ls = document.createElement('td'); ls.textContent = when(p.lastSeenAt);
    const act = document.createElement('td');
    const b = document.createElement('button'); b.type = 'button'; b.className = 'secondary'; b.textContent = 'Unpair';
    b.addEventListener('click', async () => {
      try { await api('DELETE', `/api/v1/extension/pairings/${encodeURIComponent(p.extensionId)}`); notice('Unpaired. That extension has no access now.', true); await loadPairings(); }
      catch (e) { notice(e.message); }
    });
    act.append(b);
    tr.append(id, br, pa, ls, act);
    body.append(tr);
  }
}

let codeTimer = null;
$('pairBtn').addEventListener('click', async () => {
  try {
    const c = await json('POST', '/api/v1/extension/pairing-code');
    $('code').textContent = c.code;
    $('codeBox').hidden = false;
    clearInterval(codeTimer);
    const tick = () => {
      const left = Math.max(0, Math.round((Date.parse(c.expiresAt) - Date.now()) / 1000));
      $('codeExpiry').textContent = left > 0 ? `Works once, for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} more.` : 'This code expired. Get a new one.';
      if (left <= 0) clearInterval(codeTimer);
    };
    tick();
    codeTimer = setInterval(tick, 1000);
  } catch (e) { notice(e.message); }
});

$('backupBtn').addEventListener('click', async () => {
  try { notice('Making the backup…', true); await download(await api('POST', '/api/v1/backup'), 'jobleft-backup.zip'); notice('The backup file was downloaded.', true); }
  catch (e) { notice(e.message); }
});
$('exportBtn').addEventListener('click', async () => {
  try { await download(await api('GET', '/api/v1/export'), 'jobleft-export.zip'); notice('The export was downloaded.', true); }
  catch (e) { notice(e.message); }
});
$('restoreFile').addEventListener('change', async (ev) => {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  if (!confirm('Restore this backup? It replaces all jobleft data on this computer with the data in the backup.')) return;
  try {
    notice('Checking and restoring the backup…', true);
    const r = await (await api('POST', '/api/v1/restore', await f.arrayBuffer(), 'application/zip')).json();
    const parts = Object.entries(r.restored).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`);
    notice(`Restored: ${parts.join(', ') || 'an empty backup'}.`, true);
    await refresh();
  } catch (e) { notice(e.message); }
});

$('confirmText').addEventListener('input', () => { $('deleteBtn').disabled = $('confirmText').value !== 'delete everything'; });
$('deleteBtn').addEventListener('click', async () => {
  try {
    await api('POST', '/api/v1/data/delete', { confirm: 'delete everything' });
    $('confirmText').value = ''; $('deleteBtn').disabled = true;
    notice('Everything was deleted.', true);
    await refresh();
  } catch (e) { notice(e.message); }
});

async function refresh() {
  try { await Promise.all([loadFolder(), loadCounts(), loadPairings()]); }
  catch (e) { notice(e.message); }
}

if (!token) {
  notice('This page needs the address the server printed at start (it ends with #token=…). Open that address.');
} else {
  void refresh();
  setInterval(() => { void loadPairings().catch(() => {}); }, 4000);
}
