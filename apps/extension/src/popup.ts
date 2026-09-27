// The popup: pairing, the page's support level, the job and the resume, and the one Fill button.
// It holds no token and no profile data; it asks the service worker for everything.

import type { ConnState, PopupState, ToWorker } from './messages.ts';

const content = document.getElementById('content') as HTMLDivElement;
let tabId: number | null = null;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Array<Node | string | null>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else e.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

async function ask<T>(m: ToWorker): Promise<T> {
  return (await chrome.runtime.sendMessage(m)) as T;
}

/** The plain statement of what jobleft reads (shown before pairing, and on request). */
function readsNode(open: boolean): HTMLElement {
  const d = h('details', open ? { open: '' } : {}, h('summary', {}, 'What jobleft reads, and where it sends it'),
    h('ul', {},
      h('li', {}, 'When you press Fill: the fields of the application form on this tab (their labels and choices). It sends them only to the jobleft app on this computer, which answers with your values. The values go into that form, and you check them.'),
      h('li', {}, 'When you click the jobleft button: the address of this tab, and a few markers that name the job system (not the page text). The address goes to your jobleft app to find the job.'),
      h('li', {}, 'Never: other tabs, your browsing history, page text, passwords. Nothing at all on the three large job boards it blocks (the README names them).'),
      h('li', {}, 'It talks only to the jobleft app at 127.0.0.1 (this computer), on the one port you type when you pair it. Chrome lists this as access to 127.0.0.1.'),
      h('li', {}, 'It never presses submit, next or save, and never solves a human check.'),
    ));
  return d;
}

function connNode(c: ConnState, onChange: () => void): HTMLElement {
  if (c.state === 'paired') {
    const unpair = h('button', { class: 'link' }, 'Unpair');
    unpair.addEventListener('click', async () => { await ask({ type: 'popup:unpair' }); onChange(); });
    const box = h('div', { class: 'card' }, h('div', { class: 'row' }, h('span', { class: 'ok' }, `Paired with jobleft ${c.appVersion} on this computer (port ${c.port}).`), unpair));
    if (!c.profileComplete && c.missingProfileFields.length) {
      box.append(h('div', { class: 'small warn' }, `Your profile has no ${c.missingProfileFields.join(', ')}. Fields that need them stay empty.`));
    }
    return box;
  }
  if (c.state === 'app_not_running') {
    const retry = h('button', {}, 'Try again');
    retry.addEventListener('click', onChange);
    const unpair = h('button', {}, 'Unpair');
    unpair.addEventListener('click', async () => { await ask({ type: 'popup:unpair' }); onChange(); });
    return h('div', { class: 'card' }, h('div', { class: 'err' }, `The jobleft app is not running on this computer (nothing answers on port ${c.port}).`),
      h('div', { class: 'small muted' }, c.message), h('div', { class: 'small muted' }, 'jobleft fills nothing without it.'), h('div', { class: 'msg row' }, retry, unpair));
  }
  if (c.state === 'refused') return h('div', { class: 'card err' }, c.message);
  // Not paired. The code goes only to the port the person types: the one the app shows next to the code.
  const input = h('input', { type: 'text', inputmode: 'numeric', maxlength: '6', autocomplete: 'off', 'aria-label': 'Pairing code', placeholder: '000000' });
  const portInput = h('input', { type: 'text', class: 'port', inputmode: 'numeric', maxlength: '5', autocomplete: 'off', 'aria-label': 'App port', placeholder: '47821' });
  const btn = h('button', {}, 'Pair');
  const msg = h('div', { class: 'msg small' });
  btn.addEventListener('click', async () => {
    btn.setAttribute('disabled', 'true');
    msg.textContent = 'Pairing…';
    const r = await ask<{ ok: boolean; message: string }>({ type: 'popup:pair', code: input.value.trim(), port: portInput.value.trim() });
    msg.textContent = r.message;
    msg.className = `msg small ${r.ok ? 'ok' : 'err'}`;
    btn.removeAttribute('disabled');
    if (r.ok) setTimeout(onChange, 400);
  });
  return h('div', { class: 'card' },
    h('div', { class: 'warn' }, 'This browser is not paired with your jobleft app. jobleft does nothing until you pair it.'),
    c.note ? h('div', { class: 'small err' }, c.note) : null,
    h('ol', {}, h('li', {}, 'In the jobleft app, open Settings, then Browser extension, and click "Show a pairing code". The app shows a 6-digit code and its port.'),
      h('li', {}, 'Type the code and the port here and press Pair. jobleft sends the code to that port only.')),
    h('div', { class: 'row pairrow' }, h('label', { class: 'small muted' }, 'Code', input), h('label', { class: 'small muted' }, 'Port', portInput), btn), msg, readsNode(true));
}

async function render(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const q = new URLSearchParams(location.search).get('tab');
  tabId = q ? Number(q) : tab?.id ?? null;
  if (tabId === null) { content.replaceChildren(h('p', { class: 'err' }, 'No tab.')); return; }
  const s = await ask<PopupState>({ type: 'popup:state', tabId });
  const out: Node[] = [connNode(s.conn, () => void render())];
  const sup = s.support;
  const words = sup.level === 'supported' ? 'supported' : sup.level === 'partial' ? 'partial' : sup.level === 'never' ? 'does not work here' : sup.level === 'not_a_page' ? 'not a web page' : 'not supported';
  const page = h('div', { class: 'card' }, h('div', { class: 'row' }, h('span', {}, sup.name ? `This page: ${sup.name}` : 'This page'), h('span', { class: `badge ${sup.level}` }, words)),
    h('div', { class: 'small muted' }, sup.message));
  if (s.pageError) page.append(h('div', { class: 'small warn' }, s.pageError));
  out.push(page);
  if (s.conn.state === 'paired' && sup.level !== 'never' && sup.level !== 'not_a_page') {
    const pi = s.page;
    const job = h('div', { class: 'card' });
    if (pi?.jobId) {
      job.append(h('div', {}, h('strong', {}, [pi.title, pi.company].filter(Boolean).join(' · ') || 'A job in your jobleft app')));
      if (pi.applied) job.append(h('div', { class: 'small warn' }, `You already marked this job as applied on ${pi.applied.at.slice(0, 10)}.`));
    } else {
      job.append(h('div', { class: 'small warn' }, 'jobleft does not know this job. It is not in your jobleft app yet.'));
      const add = h('button', {}, 'Add this job to jobleft');
      const addMsg = h('div', { class: 'msg small' });
      add.addEventListener('click', async () => {
        add.setAttribute('disabled', 'true');
        addMsg.textContent = 'Adding…';
        const r = await ask<{ ok: boolean; message: string }>({ type: 'popup:addJob', tabId: tabId as number });
        addMsg.textContent = r.message;
        addMsg.className = `msg small ${r.ok ? 'ok' : 'err'}`;
        if (r.ok) setTimeout(() => void render(), 600); else add.removeAttribute('disabled');
      });
      job.append(h('div', { class: 'small muted' }, 'You can still fill this page. To see it in your tracker later, add it first.'), h('div', { class: 'msg' }, add), addMsg);
    }
    let select: HTMLSelectElement | null = null;
    if (pi && pi.resumes.length) {
      select = h('select', { 'aria-label': 'Resume to attach' });
      for (const r of pi.resumes) {
        const o = h('option', { value: r.id }, `${r.name}${r.tailoredForThisJob ? ' (made for this job)' : r.isDefault ? ' (default)' : ''} — ${r.fileName}`);
        if (r.id === pi.suggestedResumeId) o.selected = true;
        select.append(o);
      }
      job.append(h('div', { class: 'small muted', style: 'margin-top:6px' }, 'Resume to attach:'), select);
    } else if (pi) {
      job.append(h('div', { class: 'small muted' }, 'No resume is set up in the app, so none will be attached.'));
    }
    out.push(job);
    const fill = h('button', { class: 'primary' }, 'Fill this application');
    const msg = h('div', { class: 'msg small' });
    fill.addEventListener('click', async () => {
      fill.setAttribute('disabled', 'true');
      msg.textContent = 'Starting…';
      const r = await ask<{ ok: boolean; message: string }>({ type: 'popup:fill', tabId: tabId as number, resumeId: select?.value ?? null });
      msg.textContent = r.message;
      msg.className = `msg small ${r.ok ? 'ok' : 'err'}`;
      if (r.ok) setTimeout(() => window.close(), 700); else fill.removeAttribute('disabled');
    });
    out.push(fill, msg, h('div', { class: 'small muted', style: 'margin-top:8px' }, 'jobleft fills and shows a report. You check it and press submit yourself.'));
    out.push(readsNode(false));
  }
  content.replaceChildren(...out);
}

void render();
