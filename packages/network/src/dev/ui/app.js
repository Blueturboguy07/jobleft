// jobleft Network screens. Plain browser JavaScript, no framework, nothing loaded from the internet.
// Every value from the file is written with textContent (never as markup). Profile links open only when the person
// clicks "Open profile", one link per click. The app never sends a message: drafts are copied by the person.
'use strict';

(() => {
  // ------------------------------------------------------------ token (from the URL fragment, then removed)
  let token = null;
  try {
    const m = /(?:^#|&)token=([^&]+)/.exec(location.hash);
    if (m) { token = decodeURIComponent(m[1]); sessionStorage.setItem('jl-network-token', token); }
    else token = sessionStorage.getItem('jl-network-token');
  } catch { /* storage off: the token lives in memory only */ }
  if (location.hash) history.replaceState(null, '', location.pathname);

  const STAGES = { to_contact: 'To contact', messaged: 'Messaged', replied: 'Replied', met: 'Met', follow_up_due: 'Follow-up due' };
  const main = document.getElementById('main');
  const dialog = document.getElementById('dialog');

  // ------------------------------------------------------------ helpers
  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
  }
  const clear = (n) => { while (n.firstChild) n.firstChild.remove(); };
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
  }
  const fullName = (c) => [c.firstName, c.lastName].filter(Boolean).join(' ') || '(no name in the file)';
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  function dollars(micros) {
    if (micros === null || micros === undefined) return '';
    const abs = Math.abs(Math.trunc(micros));
    if (abs > 0 && abs < 10000) return '<$0.01';
    const cents = Math.floor(abs / 10000);
    return `${micros < 0 ? '-' : ''}$${Math.floor(cents / 100).toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`;
  }
  function dateText(iso) {
    if (!iso) return 'unknown';
    const [y, m, d] = iso.split('-').map(Number);
    return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
  }

  class ApiError extends Error {
    constructor(status, body) { super((body && body.error && body.error.message) || `Error ${status}`); this.status = status; this.body = body; }
  }
  async function api(method, path, body, rawType) {
    if (!token) throw new ApiError(401, { error: { message: 'Open this page from the address that `serve` printed (it holds the launch token).' } });
    const headers = { 'x-jobleft-token': token };
    let payload;
    if (rawType) { headers['content-type'] = rawType; payload = body; }
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(path, { method, headers, body: payload, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }
  const q = (params) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) s.set(k, String(v));
    const t = s.toString();
    return t ? `?${t}` : '';
  };
  function errorBox(e) {
    return el('div', { class: 'box bad', role: 'alert' }, e instanceof ApiError ? e.message : 'Something went wrong.');
  }
  function openProfile(url) {
    // One link, only on this click, in the person's own browser. Nothing is fetched before the click.
    if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
  }

  // ------------------------------------------------------------ tabs
  const tabs = { import: renderImport, people: renderPeople, companies: renderCompanies, jobs: renderJobs, targets: renderTargets, plan: renderPlan, due: renderDue, settings: renderSettings, privacy: renderPrivacy };
  let current = 'import';
  function go(tab, arg) {
    current = tab;
    const shown = tab === 'companies:view' ? (arg && arg.job ? 'jobs' : 'companies') : tab;
    for (const b of document.querySelectorAll('#tabs button')) b.setAttribute('aria-current', b.dataset.tab === shown ? 'page' : 'false');
    clear(main);
    Promise.resolve(tabs[tab](arg)).catch((e) => main.append(errorBox(e)));
    main.focus({ preventScroll: true });
  }
  for (const b of document.querySelectorAll('#tabs button')) b.addEventListener('click', () => go(b.dataset.tab));

  // ------------------------------------------------------------ import
  async function renderImport() {
    const status = await api('GET', '/api/v1/network-dev/status');
    const result = el('div');
    const footer = el('p', { class: 'muted small' });
    const showStatus = (st) => { footer.textContent = st.lastImport ? `Last import: ${new Date(st.lastImport.at).toLocaleString()}, ${plural(st.lastImport.inFile, 'person', 'people')} in that file. People in your network now: ${st.contacts}.` : 'No connections imported yet.'; };
    showStatus(status);
    const file = el('input', { type: 'file', accept: '.csv,text/csv', id: 'file', 'aria-label': 'Connections.csv' });
    const btn = el('button', { class: 'primary', onclick: async () => {
      const f = file.files && file.files[0];
      if (!f) { toast('Pick your Connections.csv first.'); return; }
      btn.disabled = true; clear(result); result.append(el('p', { class: 'muted' }, 'Reading the file on this computer...'));
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const t0 = performance.now();
        const s = await api('POST', '/api/v1/network/import', bytes, 'text/csv');
        clear(result); result.append(importSummary(s, Math.round(performance.now() - t0)));
        showStatus(await api('GET', '/api/v1/network-dev/status'));
      } catch (e) { clear(result); result.append(errorBox(e)); }
      finally { btn.disabled = false; }
    } }, 'Import');
    main.append(
      el('h1', {}, 'Import your connections'),
      el('div', { class: 'panel stack' },
        el('h3', {}, 'How to get the file'),
        el('ol', { class: 'steps' },
          el('li', {}, 'On LinkedIn, open Me, then Settings & Privacy.'),
          el('li', {}, 'Open Data privacy, then Get a copy of your data.'),
          el('li', {}, 'Choose the larger archive (or only Connections), then Request archive.'),
          el('li', {}, 'Open the link in the email you get, download the archive and unzip it.'),
          el('li', {}, 'Pick Connections.csv below.')),
        el('h3', {}, 'What the file holds, and what it does not'),
        el('ul', {},
          el('li', {}, 'Only your first-degree connections: people you are connected with directly. No second-degree connections.'),
          el('li', {}, 'Many email addresses are blank: each person decides whether connections can see it. jobleft never guesses an email.'),
          el('li', {}, 'Some names in Chinese, Japanese, Hebrew and other non-Latin scripts come out garbled in the export. jobleft shows them exactly as in the file, marked "may be garbled", and never changes them.'),
          el('li', {}, 'No phone numbers, schools or messages. A blank company or title stays blank.')),
        el('p', { class: 'muted small' }, 'Nothing uploads. The file is read on this computer, its rows go into the local jobleft database, and the file itself is not copied or changed.')),
      el('div', { class: 'panel row' }, file, btn),
      result,
      footer,
    );
  }

  function importSummary(s, ms) {
    if (s.notAConnectionsFile) {
      return el('div', { class: 'box bad', role: 'alert' }, el('strong', {}, 'Not imported. '), s.warnings.join(' '));
    }
    return el('div', { class: 'panel stack' },
      el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('div', { class: 'big' }, String(s.inFile)), el('div', { class: 'muted' }, 'people imported from this file')),
        el('div', { class: 'stat' }, el('div', { class: 'big' }, String(s.skipped.length)), el('div', { class: 'muted' }, 'rows skipped')),
        el('div', { class: 'stat' }, el('div', { class: 'big' }, String(s.imported)), el('div', { class: 'muted' }, 'new')),
        el('div', { class: 'stat' }, el('div', { class: 'big' }, String(s.updated)), el('div', { class: 'muted' }, 'updated')),
        el('div', { class: 'stat' }, el('div', { class: 'big' }, String(s.unchanged)), el('div', { class: 'muted' }, 'unchanged')),
        el('div', { class: 'stat' }, el('div', { class: 'big' }, String(s.missingFromFile)), el('div', { class: 'muted' }, 'kept from an earlier import, not in this file'))),
      s.skipped.length ? el('div', { class: 'box warn' }, el('strong', {}, 'Skipped rows'), el('ul', {}, s.skipped.map((k) => el('li', {}, `Line ${k.line}: ${k.reason}`)))) : el('div', { class: 'box ok' }, 'No row was skipped.'),
      s.warnings.length ? el('div', { class: 'box warn' }, el('strong', {}, 'Notes'), el('ul', {}, s.warnings.map((w) => el('li', {}, w)))) : null,
      el('p', { class: 'muted small' }, `People in your network now: ${s.total}. Import took ${ms} ms.`),
      el('div', { class: 'row' }, el('button', { onclick: () => go('people') }, 'See the people'), el('button', { onclick: () => go('companies') }, 'See the companies')));
  }

  // ------------------------------------------------------------ people
  function personCard(c, opts = {}) {
    const stage = el('select', { 'aria-label': `Stage for ${fullName(c)}`, onchange: async () => {
      try { await api('PATCH', `/api/v1/network/contacts/${encodeURIComponent(c.id)}`, { stage: stage.value }); toast(`${fullName(c)}: ${STAGES[stage.value]}`); } catch (e) { toast(e.message); }
    } }, Object.entries(STAGES).map(([k, v]) => el('option', { value: k, selected: c.stage === k }, v)));
    const follow = el('input', { type: 'date', value: c.followUpOn || '', 'aria-label': `Follow-up date for ${fullName(c)}`, onchange: async () => {
      try { await api('PATCH', `/api/v1/network/contacts/${encodeURIComponent(c.id)}`, { followUpOn: follow.value || null }); toast(follow.value ? `Follow-up on ${follow.value}` : 'Follow-up cleared'); } catch (e) { toast(e.message); }
    } });
    const note = el('textarea', { rows: 2, placeholder: 'A note (stays on this computer)', 'aria-label': `Note for ${fullName(c)}` });
    note.value = c.note || '';
    const saveNote = el('button', { onclick: async () => {
      try { await api('PATCH', `/api/v1/network/contacts/${encodeURIComponent(c.id)}`, { note: note.value.trim() ? note.value : null }); toast('Note saved'); } catch (e) { toast(e.message); }
    } }, 'Save note');
    const plan = el('button', { onclick: async () => {
      try { const u = await api('PATCH', `/api/v1/network/contacts/${encodeURIComponent(c.id)}`, { inPlan: !c.inPlan }); c.inPlan = u.inPlan; plan.textContent = c.inPlan ? 'Remove from plan' : 'Add to plan'; toast(c.inPlan ? 'In the coffee-chat plan' : 'Out of the plan'); } catch (e) { toast(e.message); }
    } }, c.inPlan ? 'Remove from plan' : 'Add to plan');
    const card = el('div', { class: 'panel person', 'data-contact': c.id },
      el('div', {},
        el('div', { class: 'row' },
          el('h3', {}, (opts.rank ? `${opts.rank}. ` : '') + fullName(c)),
          c.maybeGarbled ? el('span', { class: 'chip warn', title: 'The export may have garbled this name. It is shown exactly as in the file.' }, 'name may be garbled') : null,
          c.inLatestFile === false ? el('span', { class: 'chip warn' }, 'not in your latest file') : null,
          c.followUpDue ? el('span', { class: 'chip bad' }, 'follow-up due') : null,
          c.inPlan ? el('span', { class: 'chip ok' }, 'in plan') : null),
        el('div', {}, c.position || el('span', { class: 'muted' }, 'No title in your file')),
        el('div', {}, c.company || el('span', { class: 'muted' }, 'Unknown company (blank in your file)')),
        el('div', { class: 'small muted' }, c.email ? `Email: ${c.email}` : 'No email in your file', ' · ', `Connected: ${dateText(c.connectedOn)}`),
        opts.reasons ? el('ul', { class: 'reasons' }, opts.reasons.map((r) => el('li', {}, r.text))) : null,
        el('div', { class: 'row note-row', style: 'margin-top:6px' }, note, saveNote)),
      el('div', { class: 'controls' },
        stage, follow, plan,
        el('button', { class: 'primary', onclick: () => draftDialog(c, opts.job || null) }, 'Draft a message'),
        c.profileUrl ? el('button', { onclick: () => openProfile(c.profileUrl), title: 'Opens this one profile in your browser' }, 'Open profile') : null,
        el('button', { class: 'danger', onclick: async () => {
          if (!confirm(`Delete ${fullName(c)} and everything about them (stage, note, dates, plan)? Your own file is not touched.`)) return;
          try { await api('DELETE', `/api/v1/network/contacts/${encodeURIComponent(c.id)}`); card.remove(); toast(`Deleted ${fullName(c)}`); } catch (e) { toast(e.message); }
        } }, 'Delete')));
    return card;
  }

  async function renderPeople(preset) {
    const state = Object.assign({ q: '', stage: '', due: false, inPlan: false, noCompany: false, offset: 0 }, preset || {});
    const list = el('div');
    const search = el('input', { type: 'search', placeholder: 'Search names, titles, companies', value: state.q, 'aria-label': 'Search', class: 'grow' });
    const stage = el('select', { 'aria-label': 'Stage filter' }, el('option', { value: '' }, 'Any stage'), Object.entries(STAGES).map(([k, v]) => el('option', { value: k, selected: state.stage === k }, v)));
    const due = el('input', { type: 'checkbox', checked: state.due });
    const inPlan = el('input', { type: 'checkbox', checked: state.inPlan });
    const noCompany = el('input', { type: 'checkbox', checked: state.noCompany });
    async function load() {
      clear(list);
      const params = { q: search.value.trim(), stage: stage.value, due: due.checked ? 'true' : '', inPlan: inPlan.checked ? 'true' : '', noCompany: noCompany.checked ? 'true' : '' };
      try {
        const all = await api('GET', `/api/v1/network/contacts${q(params)}`);
        const page = all.slice(state.offset, state.offset + 100);
        list.append(el('p', { class: 'muted' }, `${plural(all.length, 'person', 'people')}${all.length > 100 ? ` (showing ${state.offset + 1} to ${state.offset + page.length})` : ''}.`));
        for (const c of page) list.append(personCard(c));
        if (all.length > 100) list.append(el('div', { class: 'row' },
          el('button', { disabled: state.offset === 0, onclick: () => { state.offset = Math.max(0, state.offset - 100); load(); } }, 'Previous 100'),
          el('button', { disabled: state.offset + 100 >= all.length, onclick: () => { state.offset += 100; load(); } }, 'Next 100')));
      } catch (e) { list.append(errorBox(e)); }
    }
    let timer;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.offset = 0; load(); }, 200); });
    for (const x of [stage, due, inPlan, noCompany]) x.addEventListener('change', () => { state.offset = 0; load(); });
    main.append(el('h1', {}, 'People'),
      el('div', { class: 'panel row' }, search, stage, el('label', {}, due, 'Follow-up due'), el('label', {}, inPlan, 'In plan'), el('label', {}, noCompany, 'No company')),
      list);
    await load();
  }

  // ------------------------------------------------------------ companies
  async function renderCompanies() {
    const groups = await api('GET', '/api/v1/network/companies');
    main.append(el('h1', {}, 'Companies in your network'));
    if (!groups.length) { main.append(el('p', { class: 'muted' }, 'No connections imported yet.')); return; }
    const box = el('div', { class: 'panel' });
    for (const g of groups) {
      const label = g.kind === 'unknown' ? 'Unknown company (blank in your file)' : g.kind === 'placeholder' ? 'No specific company (Self-employed, Stealth and the like)' : g.names[0].name;
      box.append(el('div', { class: 'row', style: 'padding:4px 0; border-bottom:1px solid var(--line)' },
        el('strong', { style: 'min-width:3em' }, String(g.count)),
        el('span', { class: 'grow' }, label, g.kind !== 'unknown' && g.names.length > 1 ? el('span', { class: 'muted small' }, `  written as ${g.names.map((n) => `"${n.name}" (${n.count})`).join(', ')}`) : null),
        g.kind === 'company' ? el('button', { onclick: () => go('companies:view', { companyKey: g.companyKey, companyName: g.names[0].name }) }, 'Open') :
          el('button', { onclick: () => go('people', { noCompany: true }) }, 'List them')));
    }
    main.append(box);
  }

  async function renderCompanyView({ companyKey, companyName, job }) {
    const [explain, ranks, people] = await Promise.all([
      api('GET', `/api/v1/network/match${q({ companyKey, companyName })}`),
      api('GET', `/api/v1/network/rank${q({ companyKey, jobId: job ? job.id : '' })}`),
      api('GET', `/api/v1/network/contacts${q({ companyKey })}`),
    ]);
    const byId = new Map(people.map((c) => [c.id, c]));
    const n = explain.count;
    main.append(
      el('div', { class: 'row' }, el('button', { onclick: () => go(job ? 'jobs' : 'companies') }, job ? '← Jobs' : '← Companies')),
      el('h1', {}, job ? `${job.title} · ${job.company}` : companyName),
      n ? el('p', { class: 'count-line' }, `You know ${plural(n, 'person', 'people')} at ${companyName}`) : el('p', { class: 'muted' }, `You know no one at ${companyName} in your connections file.`));
    if (explain.matched.length || explain.notCounted.length) {
      main.append(el('div', { class: 'panel small' }, el('h3', {}, 'How this count was made'),
        el('ul', {}, explain.matched.map((m) => el('li', {}, `Counted "${m.name}" (${m.count}): ${m.how}`)),
          explain.notCounted.map((m) => el('li', { class: 'muted' }, `${m.why} (${m.count} ${m.count === 1 ? 'person' : 'people'})`)))));
    }
    if (!n) return;
    const count = el('input', { type: 'number', min: 1, max: 50, value: 2, style: 'width:4.5em', 'aria-label': 'How many people' });
    main.append(el('div', { class: 'panel row' }, el('span', { class: 'grow' }, 'Who to message first, in order, with the reasons from your file.'),
      el('label', {}, 'Top', count), el('button', { class: 'primary', onclick: async () => {
        try {
          const added = await api('POST', '/api/v1/network/plan', { companyKey, count: Number(count.value) || 2, ...(job ? { jobId: job.id } : {}) });
          toast(`In the plan: ${added.map(fullName).join(', ')}`);
          go('plan');
        } catch (e) { toast(e.message); }
      } }, 'Add to coffee-chat plan')));
    ranks.forEach((r, i) => { const c = byId.get(r.contactId); if (c) main.append(personCard(c, { rank: i + 1, reasons: r.reasons, job })); });
  }
  tabs['companies:view'] = renderCompanyView;

  // ------------------------------------------------------------ jobs (stand-in)
  async function renderJobs() {
    const title = el('input', { placeholder: 'Job title', 'aria-label': 'Job title' });
    const company = el('input', { placeholder: 'Company', 'aria-label': 'Company' });
    const dept = el('input', { placeholder: 'Department (optional)', 'aria-label': 'Department' });
    const like = el('input', { type: 'checkbox', checked: true });
    const list = el('div');
    async function load() {
      clear(list);
      const feed = await api('GET', '/api/v1/network-dev/jobs?limit=500');
      list.append(el('p', { class: 'muted small' }, `${plural(feed.total, 'job', 'jobs')}. Page built in ${feed.ms} ms.`));
      for (const j of feed.items) {
        const job = { id: j.id, title: j.title, company: j.company };
        list.append(el('div', { class: 'panel', 'data-job': j.id },
          el('div', { class: 'row' },
            el('div', { class: 'grow' }, el('h3', {}, j.title), el('div', {}, j.company, j.department ? el('span', { class: 'muted' }, ` · ${j.department}`) : null),
              j.networkCount ? el('div', { class: 'count-line' }, el('button', { onclick: () => go('companies:view', { companyKey: j.companyKey, companyName: j.company, job }) }, `You know ${plural(j.networkCount, 'person', 'people')} at ${j.company}`)) : null),
            el('button', { onclick: async () => { await api('POST', `/api/v1/network-dev/jobs/${encodeURIComponent(j.id)}/like`, { liked: !j.liked }); load(); } }, j.liked ? '♥ Liked' : '♡ Like'),
            el('button', { onclick: () => go('companies:view', { companyKey: j.companyKey, companyName: j.company, job }) }, 'Details'),
            el('button', { class: 'danger', onclick: async () => { await api('DELETE', `/api/v1/network-dev/jobs/${encodeURIComponent(j.id)}`); load(); } }, 'Remove'))));
      }
    }
    main.append(el('h1', {}, 'Jobs'),
      el('p', { class: 'muted small' }, 'Stand-in jobs for this tool until it runs inside the app with the real job list. Liked jobs are your target companies.'),
      el('div', { class: 'panel row' }, title, company, dept, el('label', {}, like, 'Like'), el('button', { class: 'primary', onclick: async () => {
        if (!title.value.trim() || !company.value.trim()) { toast('Give a title and a company.'); return; }
        try { await api('POST', '/api/v1/network-dev/jobs', { title: title.value, company: company.value, department: dept.value || null, liked: like.checked }); title.value = ''; company.value = ''; dept.value = ''; load(); } catch (e) { toast(e.message); }
      } }, 'Add job')),
      list);
    await load();
  }

  // ------------------------------------------------------------ targets (coverage)
  async function renderTargets() {
    const [cov, status] = await Promise.all([api('GET', '/api/v1/network/coverage'), api('GET', '/api/v1/network-dev/status')]);
    main.append(el('h1', {}, 'Target companies'), el('p', { class: 'muted small' }, 'The companies of the jobs you liked. Where do you know someone, and where no one yet?'));
    if (!status.contacts) main.append(el('div', { class: 'box warn' }, 'No connections are imported, so every target shows "no one yet". Import your Connections.csv first.'));
    if (!cov.length) { main.append(el('p', { class: 'muted' }, 'No target companies yet. Like a job in Jobs.')); return; }
    const known = cov.filter((c) => c.count > 0);
    const none = cov.filter((c) => c.count === 0);
    main.append(el('h2', {}, `You know someone (${known.length})`));
    for (const c of known) {
      main.append(el('div', { class: 'panel row' },
        el('div', { class: 'grow' }, el('h3', {}, c.companyName), el('div', { class: 'count-line' }, `You know ${plural(c.count, 'person', 'people')}`)),
        el('button', { onclick: () => go('companies:view', { companyKey: c.companyKey, companyName: c.companyName }) }, 'Who to message first'),
        el('button', { class: 'primary', onclick: async () => {
          try { const added = await api('POST', '/api/v1/network/plan', { companyKey: c.companyKey, count: 2 }); toast(`In the plan: ${added.map(fullName).join(', ')}`); } catch (e) { toast(e.message); }
        } }, 'Add top 2 to plan')));
    }
    main.append(el('h2', {}, `No one yet (${none.length})`));
    for (const c of none) main.append(el('div', { class: 'panel row' }, el('h3', { class: 'grow' }, c.companyName), el('span', { class: 'chip' }, 'no one yet')));
  }

  // ------------------------------------------------------------ plan and due
  async function renderPlan() {
    const plan = await api('GET', '/api/v1/network/plan');
    main.append(el('h1', {}, 'Coffee-chat plan'));
    if (!plan.length) { main.append(el('p', { class: 'muted' }, 'The plan is empty. Open a company or a target and add the top people.')); return; }
    for (const p of plan) {
      main.append(el('div', { class: 'panel' }, el('h2', { style: 'margin-top:0' }, p.companyName),
        el('ol', {}, p.contacts.map((c) => el('li', {},
          el('strong', {}, fullName(c)), c.position ? ` · ${c.position}` : '', ' ', el('span', { class: 'chip' }, STAGES[c.stage] || c.stage),
          el('div', { class: 'small' }, `Next: ${c.nextStep}`),
          el('div', { class: 'row' },
            el('button', { onclick: async () => { const inPlan = await api('GET', '/api/v1/network/contacts?inPlan=true'); const hit = inPlan.find((x) => x.id === c.contactId); if (hit) draftDialog(hit, null); } }, 'Draft a message'),
            el('button', { onclick: async () => { await api('PATCH', `/api/v1/network/contacts/${encodeURIComponent(c.contactId)}`, { inPlan: false }); go('plan'); } }, 'Remove from plan')))))));
    }
  }

  async function renderDue() {
    const due = await api('GET', '/api/v1/network/contacts?due=true');
    main.append(el('h1', {}, 'Follow-ups due'),
      el('p', { class: 'muted small' }, 'Contacts whose follow-up date is today or earlier, in your time zone. A desktop notification shows once for each date (with a count, never a name).'),
      el('div', { class: 'row' }, el('button', { onclick: async () => { const r = await api('POST', '/api/v1/network-dev/reminders/check', {}); toast(r.shown ? `Reminder shown for ${plural(r.shown, 'follow-up', 'follow-ups')}` : 'No new reminders'); } }, 'Check reminders now')));
    if (!due.length) main.append(el('p', { class: 'muted' }, 'Nothing is due.'));
    for (const c of due) main.append(personCard(c));
  }

  // ------------------------------------------------------------ settings and privacy
  async function renderSettings() {
    const [ai, profile] = await Promise.all([api('GET', '/api/v1/network-dev/ai'), api('GET', '/api/v1/network-dev/profile')]);
    const provider = el('select', { 'aria-label': 'AI provider' },
      el('option', { value: '' }, 'None (the plain template still works)'),
      el('option', { value: 'local', selected: ai.config.provider === 'local' }, 'A model on this computer'),
      el('option', { value: 'custom', selected: ai.config.provider === 'custom' }, 'A custom address'),
      el('option', { value: 'publik', selected: ai.config.provider === 'publik' }, 'publik'));
    const url = el('input', { placeholder: 'http://127.0.0.1:11434', value: ai.config.baseUrl || '', 'aria-label': 'Address', class: 'grow' });
    const model = el('input', { placeholder: 'Model (optional)', value: ai.config.model || '', 'aria-label': 'Model' });
    const aiBox = el('div', { class: 'panel stack' },
      el('h3', {}, 'AI for drafts'),
      el('p', { class: 'small muted' }, ai.destination ? `Now: ${ai.destination.label} (${ai.destination.remote ? 'the text leaves this computer' : 'the text stays on this computer'}).` : 'Now: none.'),
      ai.wallet ? el('p', {}, `publik balance: ${ai.wallet.balance === null ? 'read after the first draft' : ai.wallet.balance}`) : null,
      el('div', { class: 'row' }, provider, url, model, el('button', { class: 'primary', onclick: async () => {
        try { await api('PUT', '/api/v1/network-dev/ai', { provider: provider.value || null, baseUrl: url.value || null, model: model.value || null }); toast('Saved'); go('settings'); } catch (e) { toast(e.message); }
      } }, 'Save')),
      el('p', { class: 'small muted' }, `${ai.source}. In this build every AI address must be on this computer (127.0.0.1 or localhost).`));
    const f = {};
    const field = (k, label) => { f[k] = el('input', { value: Array.isArray(profile[k]) ? profile[k].join(', ') : (profile[k] || ''), 'aria-label': label }); return el('label', {}, label, f[k]); };
    const profBox = el('div', { class: 'panel stack' }, el('h3', {}, 'You (the summary a draft may use)'),
      el('div', { class: 'row' }, field('firstName', 'First name'), field('lastName', 'Last name'), field('currentTitle', 'Title'), field('currentCompany', 'Company')),
      el('div', { class: 'row' }, field('school', 'School'), field('degree', 'Degree'), field('targetTitles', 'Target titles'), field('skills', 'Skills')),
      el('p', { class: 'small muted' }, `A draft sends only this summary of you: "${profile.summary}". Never your email or phone.`),
      el('button', { class: 'primary', onclick: async () => {
        const body = { firstName: f.firstName.value, lastName: f.lastName.value, currentTitle: f.currentTitle.value || null, currentCompany: f.currentCompany.value || null, school: f.school.value || null, degree: f.degree.value || null,
          targetTitles: f.targetTitles.value.split(',').map((x) => x.trim()).filter(Boolean), skills: f.skills.value.split(',').map((x) => x.trim()).filter(Boolean) };
        try { await api('PUT', '/api/v1/network-dev/profile', body); toast('Saved'); go('settings'); } catch (e) { toast(e.message); }
      } }, 'Save'));
    main.append(el('h1', {}, 'Settings'), aiBox, profBox);
  }

  async function renderPrivacy() {
    const status = await api('GET', '/api/v1/network-dev/status');
    const confirmBox = el('input', { placeholder: 'Type DELETE', 'aria-label': 'Type DELETE to confirm' });
    main.append(el('h1', {}, 'Privacy and delete'),
      el('div', { class: 'panel stack' },
        el('h3', {}, 'Where your network data lives'),
        el('ul', {},
          el('li', {}, 'Only in the jobleft database on this computer. Nothing uploads, and there is no copy of your file.'),
          el('li', {}, 'jobleft never contacts LinkedIn or any people-lookup service, never guesses emails, and never sends a message.'),
          el('li', {}, 'A draft sends one contact\'s name, title and company, the job, and a short summary of you, and only to the AI provider you chose. With a model on this computer, nothing leaves it.'))),
      el('div', { class: 'panel stack' },
        el('h3', {}, 'Delete one person'),
        el('p', {}, 'Use Delete on the person in People. It removes them with their stage, note, dates and plan entry.')),
      el('div', { class: 'panel stack' },
        el('h3', {}, 'Delete all network data'),
        el('p', {}, `This deletes all ${plural(status.contacts, 'person', 'people')} with every note, stage, date and plan entry. Your own Connections.csv is not touched. Job cards stop showing "You know N people".`),
        el('div', { class: 'row' }, confirmBox, el('button', { class: 'danger', onclick: async () => {
          if (confirmBox.value !== 'DELETE') { toast('Type DELETE to confirm.'); return; }
          try {
            const r = await api('DELETE', '/api/v1/network');
            toast(`Deleted ${plural(r.deleted, 'person', 'people')}.`);
            await go('privacy');
            main.prepend(r.logCleared === false
              ? el('div', { class: 'box warn', role: 'status' }, `Deleted ${plural(r.deleted, 'person', 'people')}. Another task was writing to the database, so one internal file is emptied at the next start of jobleft.`)
              : el('div', { class: 'box ok', role: 'status' }, `The delete is complete: ${plural(r.deleted, 'person', 'people')} and everything about them are gone from jobleft.`));
          } catch (e) { toast(e.message); }
        } }, 'Delete all network data'))));
  }

  // ------------------------------------------------------------ the draft dialog
  async function draftDialog(contact, job) {
    clear(dialog);
    const body = el('div', { class: 'dialog-body stack' });
    dialog.append(body);
    const variant = el('select', { 'aria-label': 'Length' }, el('option', { value: 'short' }, 'Short connection note (300 characters)'), el('option', { value: 'long' }, 'Longer message'));
    const template = el('input', { type: 'checkbox' });
    const jobs = await api('GET', '/api/v1/network-dev/jobs?limit=500').catch(() => ({ items: [] }));
    const jobSel = el('select', { 'aria-label': 'Job' }, el('option', { value: '' }, 'No job'),
      jobs.items.map((j) => el('option', { value: j.id, selected: job && job.id === j.id }, `${j.title} · ${j.company}`)));
    const dest = el('p', { class: 'small muted' });
    const out = el('div');
    const refreshDest = async () => {
      try {
        const p = await api('POST', `/api/v1/network/contacts/${encodeURIComponent(contact.id)}/draft/preview`, { variant: variant.value, ...(jobSel.value ? { jobId: jobSel.value } : {}) });
        dest.textContent = template.checked ? 'The plain template uses no AI and sends nothing anywhere.'
          : p.destination ? `AI: ${p.destination.label}. ${p.destination.remote ? 'The draft request leaves this computer.' : 'Nothing leaves this computer.'}` : 'No AI provider is set up (Settings). The plain template still works.';
        return p;
      } catch (e) { dest.textContent = e.message; return null; }
    };
    for (const x of [variant, jobSel, template]) x.addEventListener('change', refreshDest);
    const go1 = el('button', { class: 'primary', onclick: () => run(false) }, 'Draft');
    async function run(confirmRemote) {
      clear(out); go1.disabled = true;
      out.append(el('p', { class: 'muted' }, 'Drafting...'));
      const req = { variant: variant.value, ...(jobSel.value ? { jobId: jobSel.value } : {}), ...(template.checked ? { template: true } : {}), ...(confirmRemote ? { confirmRemote: true } : {}) };
      try {
        const d = await api('POST', `/api/v1/network/contacts/${encodeURIComponent(contact.id)}/draft`, req);
        clear(out); out.append(await draftResult(d));
      } catch (e) {
        clear(out);
        const det = e.body && e.body.error && e.body.error.details;
        if (e.status === 409 && det && det.needsConfirmation) {
          out.append(el('div', { class: 'box warn stack' },
            el('strong', {}, `Before the first draft with ${det.destination.label}`),
            el('p', {}, 'The AI provider receives exactly this, and nothing else (no other connection, no email address, no profile link):'),
            el('pre', { class: 'sends' }, JSON.stringify(det.sends, null, 2)),
            el('div', { class: 'row' }, el('button', { class: 'primary', onclick: () => run(true) }, `Send to ${det.destination.label} and draft`), el('button', { onclick: () => clear(out) }, 'Cancel'))));
        } else {
          out.append(errorBox(e));
          if (e.body && e.body.error && e.body.error.link) out.append(el('p', {}, el('button', { onclick: () => openProfile(e.body.error.link.url) }, e.body.error.link.label || 'Add money')));
          if (e.body && e.body.error && e.body.error.code === 'needs_provider') out.append(el('p', {}, el('button', { onclick: () => { template.checked = true; run(false); } }, 'Use the plain template')));
        }
      } finally { go1.disabled = false; }
    }
    body.append(
      el('div', { class: 'row' }, el('h2', { class: 'grow', style: 'margin:0' }, `Draft for ${fullName(contact)}`), el('button', { onclick: () => dialog.close(), 'aria-label': 'Close' }, 'Close')),
      el('p', { class: 'small' }, [contact.position, contact.company].filter(Boolean).join(' · ') || 'No title or company in your file'),
      el('div', { class: 'row' }, variant, jobSel, el('label', {}, template, 'Plain template (no AI)'), go1),
      dest,
      el('p', { class: 'small muted' }, 'jobleft never sends messages. Read the draft, change it, copy it, and send it yourself.'),
      out);
    dialog.showModal();
    refreshDest();

    async function draftResult(d) {
      const text = el('textarea', { rows: 7, 'aria-label': 'Draft text' });
      text.value = d.text;
      const counter = el('span', { class: 'counter small' });
      const upd = () => { const n = [...text.value].length; counter.textContent = d.charLimit ? `${n} / ${d.charLimit} characters` : `${n} characters`; counter.classList.toggle('over', !!d.charLimit && n > d.charLimit); };
      text.addEventListener('input', upd); upd();
      let wallet = null;
      if (d.costMicros !== null && d.costMicros !== undefined) { try { wallet = (await api('GET', '/api/v1/network-dev/ai')).wallet; } catch { wallet = null; } }
      const copy = el('button', { class: 'primary', onclick: async () => {
        const exact = text.value;
        try { await navigator.clipboard.writeText(exact); }
        catch { text.focus(); text.select(); document.execCommand('copy'); }
        toast('Copied the text exactly as shown');
      } }, 'Copy');
      return el('div', { class: 'stack' },
        d.ready ? el('div', { class: 'box ok' }, 'Ready: no unsupported claim was found. Read it before you send it.')
          : el('div', { class: 'box bad', role: 'alert' }, el('strong', {}, 'Not ready. Check these before you send anything:'), el('ul', {}, d.warnings.map((w) => el('li', {}, w)))),
        text,
        el('div', { class: 'row' }, counter, el('span', { class: 'grow' }), el('span', { class: 'small muted' }, `By ${d.provider}`)),
        d.costMicros !== null && d.costMicros !== undefined ? el('p', { class: 'small' }, `Cost: ${dollars(d.costMicros)} from your publik balance.${wallet && wallet.balance ? ` Balance left: ${wallet.balance}.` : ''}`) : null,
        el('div', { class: 'row' }, copy, el('button', { onclick: async () => {
          try { await api('PATCH', `/api/v1/network/contacts/${encodeURIComponent(contact.id)}`, { stage: 'messaged' }); toast(`${fullName(contact)}: Messaged`); } catch (e) { toast(e.message); }
        } }, 'I sent it: mark as Messaged')));
    }
  }

  // ------------------------------------------------------------ start
  if (!token) {
    main.append(el('div', { class: 'box bad', role: 'alert' }, 'This page needs its launch token. Open the address that `serve` printed (it ends with #token=...).'));
  } else {
    go('import');
  }
})();
