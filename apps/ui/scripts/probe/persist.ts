// O9: never lose the person's work silently.
// Part 1: each kind of work is done through the screens, the local service is killed (kill -9, like a force-quit) within
//   about a second, restarted, and every change must be there, on screen and through the API.
// Part 2: with the data folder read-only, saving fails: the screen says so in words, shows no "saved", and keeps the text.
// Part 3: closing an editor or a drawer with unsaved changes asks first.
// Part 4: two windows on the same record: the older one must not overwrite the newer edit.

import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, type Page } from '../browser.ts';
import { check, seedRich, sleep, type Demo } from './lib.ts';

export const demoArgs = ['--persona', '--balance', '4.37', '--jobs', '600', '--no-crawl'];

async function restart(demo: Demo, p: Page, hash = '#/jobs'): Promise<void> {
  demo.kill9();
  await sleep(400);
  await demo.relaunchApi(['--no-crawl']);
  await p.goto(`${demo.origin}/${hash}`);
  await p.waitFor("document.querySelector('.jl-shell')", 15000);
  await sleep(800);
}

const setInput = (sel: string, value: string) => `(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.focus(); const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set; set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`;

async function openDetail(p: Page, id: string): Promise<void> {
  await p.eval(`location.hash = '#/jobs/${encodeURIComponent(id)}'`);
  await p.waitFor("document.querySelector('.jl-overlay .jl-detail-card')", 8000);
  await sleep(500);
}

export async function run(demo: Demo, outDir: string): Promise<void> {
  const dir = join(outDir, 'persist');
  mkdirSync(dir, { recursive: true });
  const seeded = await seedRich(demo, { ai: false });
  const items = (await demo.api.call('searchJobs', { body: { sort: 'recommended', limit: 60 } })).items.map((i) => i.job).filter((j) => !seeded.liked.includes(j.id) && !seeded.applied.includes(j.id));
  const [jLike, jHide, jApply, jNote, jRem] = items;
  const b = await launch();
  const p = await b.page();
  const stateDir = join(demo.home, 'state');
  try {
    await p.size(1280, 720);
    await p.goto(demo.url);
    await p.waitFor("document.querySelector('.jl-card')", 20000);
    await sleep(700);

    // ================= part 1: force-quit within a second of each action
    // like
    await p.eval(`location.hash = '#/jobs'`);
    await sleep(600);
    await p.eval(`document.querySelector('#jl-feed-scroll').scrollTo(0, 0)`);
    const likeSel = `[data-job-id="${jLike!.id}"] button[aria-label^="Like "]`;
    if (!(await p.eval<boolean>(`!!document.querySelector(${JSON.stringify(likeSel)})`))) await p.clickMatching('button', '^Clear all');
    await sleep(600);
    // the card may be far down the list: use the detail's like button (same person action)
    await openDetail(p, jLike!.id);
    await p.click('.jl-actionbar button[aria-label="Like this job"]');
    await sleep(500);
    await restart(demo, p);
    let e = (await demo.api.call('getJob', { params: { jobId: jLike!.id } })).tracker;
    check(!!e?.liked, 'O9 a like survives a force-quit half a second later');
    await openDetail(p, jLike!.id);
    check(await p.eval<boolean>(`!!document.querySelector('.jl-actionbar button[aria-label="Unlike this job"]')`), 'O9 the like is shown on screen after the restart');

    // hide
    await openDetail(p, jHide!.id);
    await p.click('.jl-actionbar button[aria-label="Not interested in this job"]');
    await sleep(500);
    await restart(demo, p);
    e = (await demo.api.call('getJob', { params: { jobId: jHide!.id } })).tracker;
    check(!!e?.hidden, 'O9 a hidden job stays hidden after a force-quit');

    // tracker status
    await openDetail(p, jApply!.id);
    await p.clickText('Mark as applied', '.jl-actionbar');
    await sleep(500);
    await restart(demo, p);
    e = (await demo.api.call('getJob', { params: { jobId: jApply!.id } })).tracker;
    check(e?.status === 'applied', 'O9 a tracker status survives a force-quit', String(e?.status));

    // note + reminder
    await openDetail(p, jNote!.id);
    await p.eval(`(() => { const t = document.querySelector('textarea[aria-label="New note"]'); t.scrollIntoView({ block: 'center' }); t.focus(); })()`);
    await p.type('Ask about the on-call rota');
    await p.clickMatching('button', '^Save note');
    await sleep(600);
    await restart(demo, p);
    e = (await demo.api.call('getJob', { params: { jobId: jNote!.id } })).tracker;
    check(e?.notes.some((n) => n.text === 'Ask about the on-call rota') ?? false, 'O9 a note survives a force-quit');
    await openDetail(p, jNote!.id);
    check((await p.eval<string>(`document.querySelector('.jl-detail-main').innerText`)).includes('Ask about the on-call rota'), 'O9 the note is on screen after the restart');

    // reminder: due 9 seconds from now; the local service is killed at once; after the restart the reminder still fires
    await openDetail(p, jRem!.id);
    const soon = new Date(Date.now() + 9000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}T${pad(soon.getHours())}:${pad(soon.getMinutes())}`;
    // datetime-local has minute precision, so set the reminder with the person's controls and then check it fires after the minute
    await p.eval(`(() => { const i = document.querySelector('input[aria-label="Reminder date and time"]'); i.scrollIntoView({ block: 'center' }); })()`);
    await p.eval(setInput('input[aria-label="Reminder date and time"]', local));
    await p.eval(setInput('input[aria-label="Reminder text"]', 'Send the thank-you note'));
    await p.clickMatching('button', '^Add reminder');
    await sleep(500);
    await restart(demo, p);
    e = (await demo.api.call('getJob', { params: { jobId: jRem!.id } })).tracker;
    check(e?.reminders.some((r) => r.text === 'Send the thank-you note') ?? false, 'O9 a reminder survives a force-quit', JSON.stringify(e?.reminders.map((r) => r.at)));
    const dueAt = Date.parse(e!.reminders.find((r) => r.text === 'Send the thank-you note')!.at);
    const waitMs = Math.max(0, dueAt - Date.now()) + 14_000;
    let fired = false;
    for (let t = 0; t < waitMs && !fired; t += 2000) { await sleep(2000); fired = (await demo.api.call('listNotifications')).some((n) => n.kind === 'reminder' && /thank-you/.test(n.body)); }
    check(fired, 'O9 a reminder set before the force-quit still fires after the relaunch', `due ${new Date(dueAt).toISOString()}`);
    await p.eval(`location.hash = '#/notifications'`);
    await sleep(1200);
    check(/thank-you/.test(await p.eval<string>(`document.querySelector('main').innerText`)), 'O9 the fired reminder shows in the notifications screen');
    await p.shot(join(dir, '01-reminder-fired.png'));

    // resume edit
    await p.eval(`location.hash = '#/resume/${seeded.resumeId}'`);
    await p.waitFor("document.querySelector('.jl-paper')", 8000);
    await sleep(500);
    await p.eval(`(() => { const t = [...document.querySelectorAll('.jl-paper textarea')][0]; t.scrollIntoView({ block: 'center' }); t.focus(); })()`);
    await p.type(' Mentors a weekend coding club.');
    await sleep(300);
    await p.clickMatching('button', '^Save$');
    await sleep(600);
    await restart(demo, p, `#/resume/${seeded.resumeId}`);
    const res = await demo.api.call('getResume', { params: { resumeId: seeded.resumeId } });
    check(JSON.stringify(res.document).includes('Mentors a weekend coding club.'), 'O9 a saved resume edit survives a force-quit');

    // profile edit
    await p.eval(`location.hash = '#/profile'`);
    await sleep(900);
    await p.click('button[aria-label^="Edit"]');
    await sleep(700);
    await p.eval(`(() => { const t = document.querySelector('.ant-drawer textarea'); t.focus(); })()`);
    await p.type(' Enjoys mentoring.');
    await p.clickMatching('.ant-drawer button', '^Save');
    await sleep(600);
    await restart(demo, p, '#/profile');
    check(((await demo.api.call('getProfile')).summary ?? '').includes('Enjoys mentoring.'), 'O9 a saved profile edit survives a force-quit');

    // saved filter
    await p.eval(`location.hash = '#/jobs'`);
    await sleep(900);
    await p.clickMatching('button', '^Job type');
    await sleep(300);
    await p.clickText('Contract', '.ant-popover');
    await p.clickText('Apply', '.ant-popover');
    await sleep(700);
    await p.click('button[aria-label="Save the current filters"]');
    await sleep(600);
    await p.eval(setInput('input[aria-label="Filter name"]', 'Contract roles'));
    await p.clickMatching('.ant-modal button', '^Save filter');
    await sleep(600);
    await restart(demo, p);
    const filters = await demo.api.call('listFilters');
    check(filters.some((f) => f.name === 'Contract roles' && f.filter.employmentTypes?.includes('contract')), 'O9 a saved filter survives a force-quit', filters.map((f) => f.name).join(', '));

    // pasted job (a link that is not stored yet)
    const known = items[10]!;
    await p.eval(`location.hash = '#/jobs/external'`);
    await sleep(800);
    await p.eval(`document.querySelector('input[aria-label="Job link"]').focus()`);
    await p.type(`${known.url}?from=paste`);
    await p.press('Enter');
    await sleep(2200);
    await restart(demo, p, '#/jobs/external');
    const ext = await demo.api.call('listTracker', { query: { view: 'external' } });
    check(ext.items.some((x) => x.job.title === known.title), 'O9 a pasted job survives a force-quit', `${ext.items.length} external jobs`);

    // ================= part 2: the data folder cannot be written
    await openDetail(p, jNote!.id);
    await p.eval(`(() => { const t = document.querySelector('textarea[aria-label="New note"]'); t.scrollIntoView({ block: 'center' }); t.focus(); })()`);
    chmodSync(stateDir, 0o555);
    await p.type('This note must not be lost');
    await p.clickMatching('button', '^Save note');
    await sleep(1200);
    const ro = await p.eval<{ alert: string; field: string; toasts: string }>(`({ alert: [...document.querySelectorAll('[role=alert]')].map((e) => e.innerText).join(' | '), field: document.querySelector('textarea[aria-label="New note"]').value, toasts: [...document.querySelectorAll('.ant-message-notice')].map((e) => e.innerText).join(' | ') })`);
    await p.shot(join(dir, '02-read-only-note.png'));
    check(/could not save|cannot be written|not saved|nothing was changed/i.test(ro.alert) && !/HTTP|\b500\b|EACCES|\{/.test(ro.alert), 'O9 with the data folder read-only, the screen says in words that the note was not saved', ro.alert.replace(/\s+/g, ' ').slice(0, 170));
    check(ro.field === 'This note must not be lost', 'O9 the typed note text stays in the field', JSON.stringify(ro.field));
    check(!/saved\./i.test(ro.toasts), 'O9 no "saved" message shows for a save that failed', ro.toasts);
    // a like fails the same way, in words
    await p.click('.jl-actionbar button[aria-label="Like this job"], .jl-actionbar button[aria-label="Unlike this job"]');
    await sleep(900);
    const likeToast = await p.eval<string>(`[...document.querySelectorAll('.ant-message-notice')].map((e) => e.innerText).join(' | ')`);
    check(/could not save|cannot be written|nothing was changed/i.test(likeToast), 'O9 a like that cannot be saved says so instead of showing a heart that is not saved', likeToast.replace(/\s+/g, ' ').slice(0, 140));
    // the profile drawer keeps the typed text too
    await p.eval(`location.hash = '#/profile'`);
    await sleep(800);
    await p.click('button[aria-label^="Edit"]');
    await sleep(600);
    await p.eval(`document.querySelector('.ant-drawer textarea').focus()`);
    await p.type(' Kept while the folder was read-only.');
    await p.clickMatching('.ant-drawer button', '^Save');
    await sleep(1000);
    const prof = await p.eval<{ open: boolean; text: string; err: string }>(`({ open: !!document.querySelector('.ant-drawer-open'), text: (document.querySelector('.ant-drawer textarea') || {}).value || '', err: [...document.querySelectorAll('.ant-drawer [role=alert]')].map((e) => e.innerText).join(' ') })`);
    await p.shot(join(dir, '03-read-only-profile.png'));
    check(prof.open && /Kept while the folder was read-only\./.test(prof.text) && /could not save|cannot be written|not saved/i.test(prof.err), 'O9 the profile editor stays open with its text and says the save failed', prof.err.replace(/\s+/g, ' ').slice(0, 130));
    chmodSync(stateDir, 0o755);
    await p.clickMatching('.ant-drawer button', '^Save');
    await sleep(1200);
    check(((await demo.api.call('getProfile')).summary ?? '').includes('Kept while the folder was read-only.'), 'O9 after the folder is writable again, Save keeps the text that stayed in the editor');
    await openDetail(p, jNote!.id);
    await p.eval(`(() => { const t = document.querySelector('textarea[aria-label="New note"]'); t.scrollIntoView({ block: 'center' }); t.focus(); })()`);
    await p.type('Second note after the folder is writable');
    await p.clickMatching('button', '^Save note');
    await sleep(900);
    e = (await demo.api.call('getJob', { params: { jobId: jNote!.id } })).tracker;
    check(e?.notes.some((n) => n.text === 'Second note after the folder is writable') ?? false, 'O9 saving works again once the folder is writable');

    // ================= part 3: unsaved changes ask first
    await p.eval(`location.hash = '#/profile'`);
    await sleep(700);
    await p.click('button[aria-label^="Edit"]');
    await sleep(600);
    await p.eval(`document.querySelector('.ant-drawer textarea').focus()`);
    await p.type(' unsaved words');
    await p.press('Escape');
    await sleep(600);
    const ask1 = await p.eval<string>(`(document.querySelector('.ant-modal-confirm') || {}).innerText || ''`);
    check(/discard|unsaved/i.test(ask1), 'O9 Esc in the profile editor with typed text asks before closing', ask1.replace(/\s+/g, ' ').slice(0, 80));
    await p.shot(join(dir, '04-profile-esc-asks.png'));
    await p.clickMatching('.ant-modal-confirm button', '^Keep editing');
    await sleep(400);
    check(/unsaved words/.test(await p.eval<string>(`document.querySelector('.ant-drawer textarea').value`)), 'O9 "Keep editing" keeps the text');
    await p.press('Escape');
    await sleep(400);
    await p.clickMatching('.ant-modal-confirm button', 'Discard');
    await sleep(500);
    check(!(await p.eval<boolean>(`!!document.querySelector('.ant-drawer-open')`)), 'O9 "Discard changes" closes the editor');
    // a link in the navigation while an editor is dirty
    await p.click('button[aria-label^="Edit"]');
    await sleep(500);
    await p.eval(`document.querySelector('.ant-drawer textarea').focus()`);
    await p.type(' more');
    await p.eval(`document.querySelector('.jl-rail a[href="#/tracker"]').click()`);
    await sleep(600);
    check(/discard|unsaved/i.test(await p.eval<string>(`(document.querySelector('.ant-modal-confirm') || {}).innerText || ''`)), 'O9 leaving the screen with an unsaved editor asks first');
    await p.clickMatching('.ant-modal-confirm button', 'Discard');
    await sleep(600);
    await p.eval(`location.hash = '#/resume/${seeded.resumeId}'`);
    await p.waitFor("document.querySelector('.jl-paper')", 8000);
    await p.eval(`document.querySelector('.jl-paper textarea').focus()`);
    await p.type(' scratch');
    await p.press('Escape');
    await sleep(600);
    check(/discard|unsaved/i.test(await p.eval<string>(`(document.querySelector('.ant-modal-confirm') || {}).innerText || ''`)), 'O9 Esc in the resume editor with unsaved changes asks first');
    await p.clickMatching('.ant-modal-confirm button', 'Discard');
    await sleep(600);
    await p.eval(`location.hash = '#/jobs'`);
    await sleep(700);
    await p.clickMatching('button', '^All filters');
    await sleep(700);
    await p.clickText('Internship', '.ant-drawer');
    await sleep(300);
    await p.press('Escape');
    await sleep(600);
    check(/discard|unsaved/i.test(await p.eval<string>(`(document.querySelector('.ant-modal-confirm') || {}).innerText || ''`)), 'O9 Esc in the All filters drawer with changes asks first');
    await p.clickMatching('.ant-modal-confirm button', 'Discard');
    await sleep(500);

    // ================= part 4: two windows, the same record
    const p2 = await b.page();
    await p2.size(1280, 720);
    await p2.goto(demo.url);
    await p2.waitFor("document.querySelector('.jl-shell')", 15000);
    // notes
    const jTwo = items[12]!;
    await openDetail(p, jTwo.id);
    await openDetail(p2, jTwo.id);
    for (const [pg, text] of [[p, 'note from window one'], [p2, 'note from window two']] as const) {
      await pg.eval(`(() => { const t = document.querySelector('textarea[aria-label="New note"]'); t.scrollIntoView({ block: 'center' }); t.focus(); })()`);
      await pg.type(text);
      await pg.clickMatching('button', '^Save note');
      await sleep(900);
    }
    e = (await demo.api.call('getJob', { params: { jobId: jTwo.id } })).tracker;
    check(!!e && e.notes.length === 2 && e.notes.some((n) => n.text === 'note from window one') && e.notes.some((n) => n.text === 'note from window two'), 'O9 two windows add a note each: both notes are kept', e?.notes.map((n) => n.text).join(' | '));
    // profile
    await p.eval(`location.hash = '#/profile'`);
    await p2.eval(`location.hash = '#/profile'`);
    await sleep(900);
    await p.click('button[aria-label^="Edit"]');
    await p2.click('button[aria-label^="Edit"]');
    await sleep(700);
    await p2.eval(`document.querySelector('.ant-drawer textarea').focus()`);
    await p2.type(' [written in window two]');
    await p2.clickMatching('.ant-drawer button', '^Save');
    await sleep(900);
    await p.eval(`document.querySelector('.ant-drawer textarea').focus()`);
    await p.type(' [written in window one]');
    await p.clickMatching('.ant-drawer button', '^Save');
    await sleep(1000);
    const conflict = await p.eval<{ open: boolean; text: string; notice: string }>(`({ open: !!document.querySelector('.ant-drawer-open'), text: document.querySelector('.ant-drawer textarea').value, notice: [...document.querySelectorAll('.ant-drawer [role=alert]')].map((e) => e.innerText).join(' ') })`);
    await p.shot(join(dir, '05-profile-conflict.png'));
    check(/changed in another window/i.test(conflict.notice) && conflict.open && /written in window one/.test(conflict.text), 'O9 the older profile editor is told about the newer edit and keeps its own text', conflict.notice.replace(/\s+/g, ' ').slice(0, 130));
    const mid = (await demo.api.call('getProfile')).summary ?? '';
    check(/written in window two/.test(mid) && !/written in window one/.test(mid), 'O9 nothing was overwritten while the older editor waits for a choice');
    await p.clickMatching('.ant-drawer button', 'Save my version');
    await sleep(1000);
    check(/written in window one/.test((await demo.api.call('getProfile')).summary ?? ''), 'O9 the person can choose to keep their own version');
    // resume
    await p.eval(`location.hash = '#/resume/${seeded.resumeId}'`);
    await p2.eval(`location.hash = '#/resume/${seeded.resumeId}'`);
    await p.waitFor("document.querySelector('.jl-paper')", 8000);
    await p2.waitFor("document.querySelector('.jl-paper')", 8000);
    await sleep(600);
    await p2.eval(`document.querySelector('.jl-paper textarea').focus()`);
    await p2.type(' (resume window two)');
    await p2.clickMatching('button', '^Save$');
    await sleep(900);
    await p.eval(`document.querySelector('.jl-paper textarea').focus()`);
    await p.type(' (resume window one)');
    await p.clickMatching('button', '^Save$');
    await sleep(1000);
    const rc = await p.eval<string>(`[...document.querySelectorAll('[role=alert]')].map((e) => e.innerText).join(' ')`);
    await p.shot(join(dir, '06-resume-conflict.png'));
    check(/changed in another window/i.test(rc), 'O9 the older resume editor is told about the newer edit', rc.replace(/\s+/g, ' ').slice(0, 120));
    check(JSON.stringify((await demo.api.call('getResume', { params: { resumeId: seeded.resumeId } })).document).includes('(resume window two)'), 'O9 the newer resume edit was not overwritten');
    await p2.eval('void 0');
  } finally {
    try { chmodSync(stateDir, 0o755); } catch { /* ignore */ }
    await b.close();
  }
}
