// O13: the keyboard alone goes from the feed to a job, likes it, opens the detail and the apply control and comes back;
// the focus is always visible; Esc closes the top-most layer and puts the focus back; icon-only buttons have names;
// hover content (the three part-scores) can be reached with the keyboard; a wcag-style contrast check per screen.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIT, launch, type Page } from '../browser.ts';
import { check, sleep, type Demo } from './lib.ts';

export const demoArgs = ['--persona', '--balance', '4.37', '--jobs', '1500', '--no-crawl'];

const ACTIVE = `(() => { const a = document.activeElement; if (!a || a === document.body) return null; const cs = getComputedStyle(a);
  const card = a.closest('.jl-card');
  return { tag: a.tagName, label: (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 70), card: card ? card.getAttribute('data-job-id') : null,
    outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0, shadow: cs.boxShadow !== 'none', cardRing: !!card && getComputedStyle(card).boxShadow !== 'none',
    inDialog: !!a.closest('[role=dialog], .ant-drawer, .ant-modal, .jl-detail-main'), href: a.getAttribute('href') }; })()`;

interface Active { tag: string; label: string; card: string | null; outline: boolean; shadow: boolean; cardRing: boolean; inDialog: boolean; href: string | null }

async function tabUntil(p: Page, test: (a: Active) => boolean, max = 80): Promise<Active | null> {
  for (let i = 0; i < max; i++) {
    await p.press('Tab');
    const a = await p.eval<Active | null>(ACTIVE);
    if (a && test(a)) return a;
  }
  return null;
}

export async function run(demo: Demo, outDir: string): Promise<void> {
  const dir = join(outDir, 'keyboard');
  mkdirSync(dir, { recursive: true });
  const b = await launch();
  const p = await b.page();
  try {
    await p.size(1280, 720);
    await p.goto(demo.url);
    await p.waitFor("document.querySelectorAll('.jl-card').length > 3", 20000);
    await sleep(600);

    // 1. the focus is visible on every stop for the first 45 Tab presses
    const missing: string[] = [];
    let stops = 0;
    await p.eval('document.activeElement && document.activeElement.blur()');
    for (let i = 0; i < 45; i++) {
      await p.press('Tab');
      const a = await p.eval<Active | null>(ACTIVE);
      if (!a) continue;
      stops++;
      if (!(a.outline || a.shadow || a.cardRing)) missing.push(`${a.tag} ${a.label}`);
    }
    check(stops >= 20 && missing.length === 0, 'O13 the focus is visible on every stop of the first 45 Tab presses', missing.length ? `no ring: ${missing.slice(0, 4).join(' | ')}` : `${stops} stops`);

    // 2. keyboard only: feed -> like -> open the detail -> apply control -> Esc -> back on the same card
    await p.eval("location.hash = '#/jobs'");
    await sleep(500);
    await p.eval('document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0)');
    const like = await tabUntil(p, (a) => a.card !== null && /^Like /.test(a.label));
    check(!!like, 'O13 the Tab key reaches the Like button of a card', like ? like.label : 'not reached in 80 presses');
    if (like) {
      const before = await p.eval<number>("document.querySelectorAll('.jl-card [aria-pressed=true][aria-label^=Unlike]').length");
      await p.press('Enter');
      await sleep(700);
      const after = await p.eval<number>("document.querySelectorAll('.jl-card [aria-pressed=true][aria-label^=Unlike]').length");
      check(after === before + 1, 'O13 Enter on the focused Like button likes the job', `${before} -> ${after}`);
    }
    const title = await tabUntil(p, (a) => a.card !== null && !!a.href && /#\/jobs\//.test(a.href) && !/^Like|^Apply/.test(a.label), 20).catch(() => null)
      ?? await (async () => { // the title link comes before the buttons in the card: shift-Tab back to it
        for (let i = 0; i < 10; i++) { await p.press('Tab', true); const a = await p.eval<Active | null>(ACTIVE); if (a?.href && /#\/jobs\//.test(a.href)) return a; }
        return null;
      })();
    check(!!title, 'O13 the title link of a card is a keyboard stop', title?.label);
    if (title?.card) {
      const cardId = title.card;
      await p.press('Enter');
      const opened = await p.waitFor("/#\\/jobs\\//.test(location.hash) && document.querySelector('.jl-detail-main')", 5000);
      await sleep(500);
      const inside = await p.eval<Active | null>(ACTIVE);
      check(opened && !!inside?.inDialog, 'O13 opening a job with Enter moves the focus into the detail', `focus: ${inside?.tag} ${inside?.label}`);
      const apply = await tabUntil(p, (a) => /^Apply/.test(a.label) && !!a.href, 60);
      check(!!apply && /^https?:/.test(apply.href ?? ''), 'O13 the apply control is reachable with Tab and is a real link to the employer page', apply ? `${apply.label} -> ${apply.href}` : 'not reached');
      await p.press('Escape');
      await sleep(700);
      const closed = await p.eval<boolean>("!document.querySelector('.jl-detail-main')");
      const back = await p.eval<Active | null>(ACTIVE);
      check(closed, 'O13 Esc closes the detail', `hash=${await p.eval<string>('location.hash')}`);
      check(back?.card === cardId, 'O13 after Esc the focus is back on the card that was open', `focus card=${back?.card} (wanted ${cardId}) ${back?.label ?? ''}`);
    }

    // 3. the match tile: the three part-scores are reachable without a mouse
    await p.eval("location.hash = '#/jobs'");
    await sleep(500);
    const tileFocus = await p.eval<boolean>(`(() => { const t = document.querySelector('.jl-card button.jl-tile'); if (!t) return false; t.focus(); return document.activeElement === t; })()`);
    check(tileFocus, 'O13 the match tile is a button that the keyboard can focus');
    if (tileFocus) {
      await p.press('Enter');
      await sleep(600);
      const txt = await p.eval<string>("document.activeElement.closest('.jl-card').innerText");
      check(/skills/i.test(txt) && /industry/i.test(txt) && /(experience|level)/i.test(txt), 'O13 Enter on the match tile shows the three part-scores', txt.replace(/\s+/g, ' ').slice(0, 140));
    }

    // 4. Esc closes the top-most popover or drawer and the focus comes back to the control that opened it
    await p.eval("location.hash = '#/jobs'");
    await sleep(500);
    const openers = await p.eval<string[]>(`[...document.querySelectorAll('.jl-filterbar button')].map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim()).filter(Boolean).slice(0, 12)`);
    let popoverOk = 0, popoverTried = 0;
    for (const name of openers.slice(0, 6)) {
      const focused = await p.eval<boolean>(`(() => { const b = [...document.querySelectorAll('.jl-filterbar button')].find((x) => ((x.getAttribute('aria-label') || x.textContent || '').trim()) === ${JSON.stringify(name)}); if (!b) return false; b.focus(); return true; })()`);
      if (!focused) continue;
      popoverTried++;
      await p.press('Enter');
      await sleep(400);
      const open = await p.eval<boolean>("!!document.querySelector('.ant-popover:not(.ant-popover-hidden), .ant-drawer-open, .ant-dropdown:not(.ant-dropdown-hidden), .ant-modal-wrap')");
      await p.press('Escape');
      await sleep(400);
      const gone = await p.eval<boolean>("!document.querySelector('.ant-popover:not(.ant-popover-hidden), .ant-drawer-open, .ant-dropdown:not(.ant-dropdown-hidden), .ant-modal-wrap:not([style*=\"display: none\"])')");
      const ret = await p.eval<string>("(document.activeElement.getAttribute('aria-label') || document.activeElement.textContent || '').trim()");
      if (open && gone && ret === name) popoverOk++;
      else console.log(`   filter "${name}": opened=${open} closedByEsc=${gone} focus back on "${ret}"`);
    }
    check(popoverTried >= 4 && popoverOk === popoverTried, 'O13 each filter opens with Enter, closes with Esc and gives the focus back', `${popoverOk} of ${popoverTried} (${openers.slice(0, 6).join(', ')})`);

    // 5. every screen: named controls and contrast
    const screens = ['jobs', 'jobs/liked', 'tracker', 'dashboard', 'resume', 'profile', 'network', 'interview', 'assistant', 'notifications', 'settings/ai', 'settings/balance', 'settings/sources', 'settings/data'];
    for (const s of screens) {
      await p.eval(`location.hash = '#/${s}'`);
      await sleep(700);
      const a = await p.eval<{ noName: string[]; lowContrast: Array<{ text: string; ratio: number }> }>(AUDIT);
      check(a.noName.length === 0 && a.lowContrast.length === 0, `O13 ${s}: every control has a name and text passes 4.5:1 (3:1 large)`,
        [...a.noName.slice(0, 2), ...a.lowContrast.slice(0, 3).map((c) => `${c.text} ${c.ratio}`)].join(' | '));
    }
  } finally {
    await b.close();
  }
}
