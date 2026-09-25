// O12 (and the zoom part of O13): every screen at the smallest supported window, at 1280 x 720, at full screen on a
// large display and at 150% zoom: nothing scrolls sideways, no control is covered by another element, text that is
// cut off can be read some other way, and the close control of every modal and drawer is on screen.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, type Page } from '../browser.ts';
import { check, seedRich, sleep, type Demo } from './lib.ts';

export const demoArgs = ['--persona', '--balance', '4.37', '--jobs', '1500', '--no-crawl'];

/** [css width, css height, device scale factor, name]. 150% zoom of a 1024 x 640 window is 683 x 427 css pixels. */
const VIEWPORTS: Array<[number, number, number, string]> = [
  [1024, 640, 1, '1024x640'], [1280, 720, 1, '1280x720'], [1920, 1080, 1, '1920x1080'], [2560, 1440, 1, '2560x1440'],
  [683, 427, 1.5, '1024x640@150pct'], [853, 480, 1.5, '1280x720@150pct'],
];

const PROBLEMS = `(() => {
  const out = { sideways: [], covered: [], clipped: [], tiny: [], badText: [] };
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && !e.closest('[aria-hidden="true"],[inert],.jl-sr'); };
  const scrollsX = (e) => { for (let x = e.parentElement; x; x = x.parentElement) { const o = getComputedStyle(x).overflowX; if ((o === 'auto' || o === 'scroll') && x.scrollWidth > x.clientWidth) return x; } return null; };
  const W = innerWidth, H = innerHeight;
  // 1. sideways scrolling: the page, or a pane that scrolls sideways where the person did not ask for a wide table
  if (document.documentElement.scrollWidth > W + 1) out.sideways.push('page ' + document.documentElement.scrollWidth + ' > ' + W);
  for (const e of document.querySelectorAll('main *, .jl-main *, .jl-rail')) {
    if (!vis(e)) continue;
    const st = getComputedStyle(e);
    if ((st.overflowX === 'auto' || st.overflowX === 'scroll') && e.scrollWidth > e.clientWidth + 2 && !e.closest('.ant-table-content, .ant-table-body, .ant-table-wrapper, .ant-tabs-nav-wrap, .ant-tabs-nav-list, .ant-segmented, .ant-select-selector, .ant-modal-body pre, pre, textarea, .ant-input')) out.sideways.push((e.className && String(e.className).slice(0, 50)) + ' ' + e.scrollWidth + ' > ' + e.clientWidth);
    const r = e.getBoundingClientRect();
    if (r.right > W + 2 && !scrollsX(e) && !e.closest('.ant-tooltip, .ant-message, .ant-popover, .ant-dropdown, .ant-select-dropdown, .ant-tabs-nav-wrap, .ant-table-wrapper, svg')) out.sideways.push('off the right edge: ' + e.tagName + '.' + String(e.className).slice(0, 40) + ' right=' + Math.round(r.right));
  }
  // 2. a control that another element covers (something that lies on top of a button, link or field)
  const seen = new Set();
  for (const e of document.querySelectorAll('main button, main a[href], main input, main textarea, main [role=tab], .jl-rail a, .jl-topbar button, .jl-topbar input, .jl-topbar a, .ant-drawer button, .ant-modal button, .ant-drawer input, .ant-modal input')) {
    if (!vis(e) || e.disabled) continue;
    const nw = e.closest('.ant-tabs-nav-wrap'); // tabs that the tab bar has folded into its "..." menu are not on screen
    if (nw) { const wr = nw.getBoundingClientRect(), er = e.getBoundingClientRect(); if (er.right > wr.right + 1 || er.left < wr.left - 1) continue; }
    if (e.tagName === 'INPUT' && e.closest('.ant-select')) continue; // the search box inside a select sits under the chosen value on purpose
    const r = e.getBoundingClientRect();
    if (r.bottom < 0 || r.top > H || r.right < 0 || r.left > W) continue;
    if (e.closest('[style*="position: absolute"][style*="left: -"]')) continue;
    const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 3, r.top + r.height / 2], [r.right - 3, r.top + r.height / 2]];
    for (const [x, y] of pts) {
      if (x < 0 || y < 0 || x > W || y > H) continue;
      const top = document.elementFromPoint(x, y);
      if (!top || top === e || e.contains(top) || top.contains(e)) continue;
      if (top.closest('.ant-tooltip, .ant-message, .ant-select-dropdown')) continue;
      // a scrolled-out part of a pane (behind the sticky top area) is not "covered": the sticky bars are part of the pane
      if (top.closest('.jl-filterbar, .jl-actionbar, .jl-detail-tabs, .jl-topbar') && !e.closest('.jl-filterbar, .jl-actionbar, .jl-detail-tabs, .jl-topbar')) break;
      const label = (e.getAttribute('aria-label') || e.textContent || e.placeholder || '').trim().slice(0, 30);
      const by = (top.getAttribute('aria-label') || top.className || top.tagName).toString().slice(0, 40);
      const k = label + '|' + by;
      if (!seen.has(k)) { seen.add(k); out.covered.push(label + ' <- ' + by); }
      break;
    }
  }
  // 3. text that is cut off (an ellipsis or a clipped box) and has no title or label to read it in full
  for (const e of document.querySelectorAll('main *, .jl-topbar *, .jl-rail *')) {
    if (!vis(e) || e.children.length > 3) continue;
    const st = getComputedStyle(e);
    const cut = (st.textOverflow === 'ellipsis' && e.scrollWidth > e.clientWidth + 1) || (st.webkitLineClamp && st.webkitLineClamp !== 'none' && e.scrollHeight > e.clientHeight + 2);
    if (!cut) continue;
    const hasWay = e.getAttribute('title') || e.closest('[title]') || e.getAttribute('aria-label') || e.querySelector('a[href]') || e.closest('a[href]') || e.closest('.jl-card-title, .jl-card-company, .jl-fact, .ant-tooltip-open') || e.closest('h1, h2, h3');
    out.clipped.push({ text: (e.textContent || '').trim().slice(0, 60), cls: String(e.className).slice(0, 40), way: !!hasWay });
  }
  // 4. text that is too small to read
  for (const e of document.querySelectorAll('main *')) {
    if (!vis(e) || e.children.length) continue;
    if (!(e.textContent || '').trim()) continue;
    const fs = parseFloat(getComputedStyle(e).fontSize);
    if (fs < 10.5) out.tiny.push((e.textContent || '').trim().slice(0, 30) + ' ' + fs + 'px');
  }
  const t = document.body.innerText;
  if (/undefined|\\bnull\\b|NaN|\\[object/.test(t)) out.badText.push(t.match(/.{0,20}(undefined|\\bnull\\b|NaN|\\[object).{0,20}/)[0]);
  return out;
})()`;

const ROUTES = [
  'jobs', 'jobs/liked', 'jobs/applied', 'jobs/external', 'jobs/hidden', 'DETAIL', 'tracker', 'dashboard', 'resume', 'RESUME', 'profile', 'network', 'network/people',
  'interview', 'assistant', 'settings/ai', 'settings/balance', 'settings/alerts', 'settings/sources', 'settings/data', 'settings/extension', 'settings/about', 'notifications', 'onboarding',
];

async function problems(p: Page) {
  return p.eval<{ sideways: string[]; covered: string[]; clipped: Array<{ text: string; cls: string; way: boolean }>; tiny: string[]; badText: string[] }>(PROBLEMS);
}

export async function run(demo: Demo, outDir: string): Promise<void> {
  const dir = join(outDir, 'layout');
  mkdirSync(dir, { recursive: true });
  const seeded = await seedRich(demo);
  const b = await launch();
  const p = await b.page();
  const report: Record<string, unknown> = {};
  try {
    await p.size(1280, 720);
    await p.goto(demo.url);
    await p.waitFor("document.querySelector('.jl-shell, .jl-onboard')", 15000);
    await sleep(800);
    const detailId = seeded.applied[0]!;
    const longTitleJob = (await demo.api.call('searchJobs', { body: { sort: 'recommended', limit: 100 } })).items.map((i) => i.job).sort((a, b2) => b2.title.length - a.title.length)[0]!;
    for (const [w, h, dpr, name] of VIEWPORTS) {
      const bad: string[] = [];
      const sub = { sideways: 0, covered: 0, clippedNoWay: 0 };
      for (const r of ROUTES) {
        const route = r === 'DETAIL' ? `jobs/${encodeURIComponent(detailId)}` : r === 'RESUME' ? `resume/${seeded.resumeId}` : r;
        await p.sizeScaled(w, h, dpr);
        await p.eval(`location.hash = ${JSON.stringify(`#/${route}`)}`);
        await p.waitFor("!document.querySelector('.ant-spin-spinning') && !document.querySelector('.jl-skel')", 8000);
        await sleep(500);
        const x = await problems(p);
        report[`${r}@${name}`] = x;
        const noWay = x.clipped.filter((c) => !c.way);
        if (x.sideways.length) { bad.push(`${r}: sideways ${x.sideways.slice(0, 2).join('; ')}`); sub.sideways++; }
        if (x.covered.length) { bad.push(`${r}: covered ${x.covered.slice(0, 2).join('; ')}`); sub.covered++; }
        if (noWay.length) { bad.push(`${r}: cut off with no way to read it: ${noWay.slice(0, 2).map((c) => `"${c.text}"`).join(', ')}`); sub.clippedNoWay++; }
        if (x.badText.length) bad.push(`${r}: bad text ${x.badText[0]}`);
        if (r === 'jobs' || r === 'DETAIL' || r === 'tracker' || r === 'settings/ai' || r === 'resume') await p.shot(join(dir, `${r.replace(/\//g, '_')}@${name}.png`));
      }
      check(bad.length === 0, `O12 all ${ROUTES.length} screens at ${name}: no sideways scroll, no covered control, no unreadable cut-off text`, bad.slice(0, 4).join(' | ') + (bad.length > 4 ? ` (+${bad.length - 4} more)` : ''));
    }

    // -------- a very long job title and company name stay readable
    for (const [w, h, dpr, name] of [VIEWPORTS[0]!, VIEWPORTS[4]!]) {
      await p.sizeScaled(w, h, dpr);
      await p.eval(`location.hash = '#/jobs/${encodeURIComponent(longTitleJob.id)}'`);
      await p.waitFor("document.querySelector('.jl-overlay .jl-detail-card')", 8000);
      await sleep(500);
      const full = await p.eval<{ h1: string; cut: boolean }>(`(() => { const h = document.querySelector('.jl-detail-main h1'); return { h1: h.textContent, cut: h.scrollWidth > h.clientWidth + 1 || h.scrollHeight > h.clientHeight + 2 }; })()`);
      check(full.h1 === longTitleJob.title && !full.cut, `O12 the longest job title (${longTitleJob.title.length} characters) is shown in full in the detail at ${name}`, full.h1.slice(0, 60));
      await p.shot(join(dir, `long-title@${name}.png`));
    }
    await p.eval(`location.hash = '#/jobs'`);

    // -------- modals and drawers: the close control is on screen at the smallest sizes
    const anyOf = async (pg: Page, ...names: string[]) => { for (const n of names) if (await pg.clickMatching('button, a, [role=menuitem], .ant-dropdown-menu-item', `^${n}`)) return true; return false; };
    const OPENERS: Array<{ name: string; route: string; open: (p: Page) => Promise<boolean> }> = [
      { name: 'All filters drawer', route: 'jobs', open: (pg) => pg.clickMatching('button', '^All filters') },
      { name: 'Save filter modal', route: 'jobs', open: async (pg) => { if (await pg.clickMatching('aside button', '^$', 'button[aria-label="Save the current filters"]')) return true; await pg.clickMatching('button', '^Saved filters'); await sleep(300); return pg.clickMatching('.ant-dropdown-menu-item', '^Save the current filters'); } },
      { name: 'Add resume modal', route: 'resume', open: (pg) => pg.clickMatching('button', 'Add resume') },
      { name: 'Tailor drawer', route: `jobs/${encodeURIComponent(detailId)}`, open: (pg) => anyOf(pg, 'Tailor your resume', 'Tailor resume') },
      { name: 'Cover letter drawer', route: `jobs/${encodeURIComponent(detailId)}`, open: (pg) => anyOf(pg, 'Write a cover letter', 'Cover letter') },
      { name: 'Keyword gaps drawer', route: `jobs/${encodeURIComponent(detailId)}`, open: (pg) => anyOf(pg, 'Check keyword gaps', 'Keyword gaps') },
      { name: 'Profile editor', route: 'profile', open: (pg) => pg.click('button[aria-label^="Edit"]') },
      { name: 'Assistant panel', route: 'jobs', open: (pg) => pg.click('button[aria-label="Open the assistant panel"]') },
    ];
    for (const [w, h, dpr, name] of [VIEWPORTS[0]!, VIEWPORTS[4]!]) {
      for (const o of OPENERS) {
        await p.sizeScaled(w, h, dpr);
        await p.eval(`location.hash = '#/${o.route}'`);
        await p.waitFor("!document.querySelector('.jl-skel')", 6000);
        await sleep(700);
        const opened = await o.open(p);
        await sleep(900);
        const info = await p.eval<{ open: boolean; closeOn: boolean; closeRect: string; overflowY: boolean }>(`(() => {
          const layer = [...document.querySelectorAll('.ant-modal:not([style*="display: none"]), .ant-drawer-content-wrapper, .jl-chatpanel')].filter((e) => e.getBoundingClientRect().width > 0).pop();
          if (!layer) return { open: false, closeOn: false, closeRect: '', overflowY: false };
          const c = layer.querySelector('.ant-modal-close, .ant-drawer-close, [aria-label^="Close"]');
          const r = c ? c.getBoundingClientRect() : null;
          const on = !!r && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && r.width > 0;
          return { open: true, closeOn: on, closeRect: r ? [r.left, r.top, r.right, r.bottom].map(Math.round).join(',') : 'none', overflowY: layer.getBoundingClientRect().bottom > innerHeight + 1 };
        })()`);
        if (!info.open) { check(false, `O12 ${o.name} at ${name} opens`, `clicked=${opened}`); continue; }
        check(info.closeOn, `O12 the close control of the ${o.name} is on screen at ${name}`, `close box ${info.closeRect}`);
        if (o.name === 'All filters drawer' || o.name === 'Add resume modal') await p.shot(join(dir, `${o.name.replace(/ /g, '_')}@${name}.png`));
        await p.press('Escape');
        await sleep(500);
        const still = await p.eval<boolean>(`[...document.querySelectorAll('.ant-modal:not([style*="display: none"]), .ant-drawer-open, .jl-chatpanel')].some((e) => e.getBoundingClientRect().width > 0)`);
        check(!still, `O12 Esc closes the ${o.name} at ${name}`);
      }
    }
  } finally {
    await b.close();
    writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 1));
  }
}
