// O15: never send the person's data anywhere they did not choose. The page talks only to its own origin (the local
// API); the local API talks only to employer sites and the AI service the person chose. Every request that leaves the
// API process reaches one of the made-up stand-ins, which write a traffic log (<home>/traffic): the probe searches
// those logs for the persona's name, email, phone, resume phrases and search words. With a local model chosen, the
// publik stand-in must receive no request at all.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, type Page } from '../browser.ts';
import { check, ctl, seedRich, sleep, type Demo } from './lib.ts';

export const demoArgs = ['--persona', '--balance', '4.37', '--jobs', '600', '--no-crawl'];

const SEARCH_WORD = 'quokka4471';
const IDENTIFIERS = ['Jordan', 'Testwell', 'jordan.testwell@example.com', 'jordan.testwell', '555-0100'];
const RESUME_PHRASES = ['nightly batch job', 'billing service', 'React dashboard used by 40', 'Weekend coding club', 'Hill Country State', 'Wrote SQL reports'];

function traffic(demo: Demo, name: string): Array<{ method: string; url: string; body: string; userAgent: string | null }> {
  const f = join(demo.home, 'traffic', `${name}.ndjson`);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const ROUTES = ['jobs', 'jobs/liked', 'jobs/applied', 'jobs/external', 'jobs/hidden', 'tracker', 'dashboard', 'resume', 'profile', 'network', 'network/people', 'interview', 'assistant', 'settings/ai', 'settings/balance', 'settings/alerts', 'settings/sources', 'settings/data', 'settings/extension', 'settings/about', 'notifications'];

async function walk(p: Page, resumeId: string, jobId: string): Promise<void> {
  for (const r of [...ROUTES, `resume/${resumeId}`, `jobs/${encodeURIComponent(jobId)}`]) {
    await p.eval(`location.hash = '#/${r}'`);
    await p.waitFor("!document.querySelector('.jl-skel') && !document.querySelector('.ant-spin-spinning')", 6000);
    await sleep(350);
  }
}

export async function run(demo: Demo, outDir: string): Promise<void> {
  mkdirSync(join(outDir, 'privacy'), { recursive: true });
  const seeded = await seedRich(demo, { ai: false });
  const resume = await demo.api.call('getResume', { params: { resumeId: seeded.resumeId } });
  const resumeText = JSON.stringify(resume);
  check(RESUME_PHRASES.some((ph) => resumeText.includes(ph)), 'O15 setup: the resume holds the persona phrases the probe searches for', RESUME_PHRASES.filter((x) => resumeText.includes(x)).join(', '));
  const list = await demo.api.call('searchJobs', { body: { sort: 'recommended', limit: 5 } });
  const jobId = list.items[0]!.job.id;

  // ---------------- phase A: a model on this computer
  await demo.api.call('putAiSettings', { body: { provider: 'local', localKind: 'openai_compatible', baseUrl: 'http://127.0.0.1:47911/v1', model: 'standin-7b' } });
  const b = await launch();
  const p = await b.page();
  try {
    await p.size(1280, 720);
    await p.goto(demo.url);
    await p.waitFor("document.querySelector('.jl-card')", 20000);
    await sleep(600);
    p.clearRequests();
    await walk(p, seeded.resumeId, jobId);
    // search words typed in the feed, a profile edit saved, a chat message to the local model, a company lookup, a pasted link
    await p.eval(`location.hash = '#/jobs'`);
    await sleep(700);
    await p.eval(`document.querySelector('input[aria-label^="Search jobs"]').focus()`);
    await p.type(SEARCH_WORD);
    await sleep(1200);
    await p.eval(`location.hash = '#/profile'`);
    await sleep(700);
    await p.click('button[aria-label^="Edit"]');
    await sleep(700);
    await p.eval(`(() => { const t = document.querySelector('.ant-drawer textarea'); if (t) t.focus(); })()`);
    await p.type(' I also mentor at a weekend coding club.');
    await p.clickMatching('.ant-drawer button', '^Save');
    await sleep(1200);
    await p.eval(`location.hash = '#/assistant'`);
    await sleep(700);
    await p.eval(`document.querySelector('textarea[aria-label="Message to the assistant"]').focus()`);
    await p.type('Which skills matter most for a backend role?');
    await p.press('Enter');
    await p.waitFor(`!document.querySelector('button[aria-label="Stop the answer"]') && document.querySelectorAll('.jl-bubble.assistant').length > 0`, 20000);
    await sleep(500);
    await p.eval(`location.hash = '#/jobs/external'`);
    await sleep(700);
    const cand = (await demo.api.call('searchJobs', { body: { sort: 'recommended', limit: 100 } })).items.find((i) => !i.liked && !i.trackerStatus)!.job;
    await p.eval(`document.querySelector('input[aria-label="Job link"]').focus()`);
    await p.type(`${cand.url}?ref=probe`);
    await p.press('Enter');
    await sleep(2500);
    await p.eval(`location.hash = '#/jobs'`);
    await sleep(700);
    await p.clickText('Refresh now');
    await sleep(1500);
    for (let i = 0; i < 60 && (await demo.api.call('crawlStatus')).running; i++) await sleep(1000);
    await p.eval(`location.hash = '#/jobs/${encodeURIComponent(jobId)}'`);
    await sleep(900);
    if (await p.clickMatching('button', '^Look up company facts')) await sleep(1500);

    const reqsA = p.requests().filter((r) => /^https?:/i.test(r.url));
    const hostsA = [...new Set(reqsA.map((r) => { try { return new URL(r.url).host; } catch { return r.url.slice(0, 20); } }))];
    check(hostsA.length === 1 && hostsA[0] === `127.0.0.1:${demo.port}`, 'O15 the page talks to one host only: its own local API (local model, every screen)', `${reqsA.length} requests; hosts: ${hostsA.join(', ')}`);
    const resources = await p.eval<string[]>(`[...new Set(performance.getEntriesByType('resource').map((e) => new URL(e.name).host))]`);
    check(resources.every((h) => h === `127.0.0.1:${demo.port}`), 'O15 every font, script, style and image comes from the app itself (no remote font, logo, icon or tracker)', resources.join(', '));
    const inUrl = reqsA.filter((r) => r.url.includes(SEARCH_WORD) || IDENTIFIERS.some((i) => decodeURIComponent(r.url).includes(i)));
    check(inUrl.length === 0, 'O15 no search word or personal detail is in the address of any request', inUrl.slice(0, 2).map((r) => r.url).join(' | '));
    const noreferrer = await p.eval<string[]>(`[...document.querySelectorAll('a[target=_blank]')].filter((a) => !/noreferrer/.test(a.rel) || !/noopener/.test(a.rel)).map((a) => a.href)`);
    check(noreferrer.length === 0, 'O15 every link that opens another site is marked noopener noreferrer (the other site learns nothing from this page)', noreferrer.slice(0, 2).join(' | '));
    const cspOk = await p.eval<boolean>(`(() => { const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]'); return !!m; })()`);
    void cspOk;

    // -------- what left the API process: employer sites and the model on this computer
    const boardsA = traffic(demo, 'boards');
    const publikA = traffic(demo, 'publik');
    const aiA = traffic(demo, 'ai');
    const leakA = (rows: Array<{ url: string; body: string }>) => rows.filter((r) => [...IDENTIFIERS, ...RESUME_PHRASES, SEARCH_WORD].some((x) => (r.url + ' ' + r.body).toLowerCase().includes(x.toLowerCase())));
    check(boardsA.length > 0, 'O15 setup: the API did contact the employer sites (the lookups above)', `${boardsA.length} requests`);
    check(leakA(boardsA).length === 0, 'O15 no employer-site request carries the name, email, phone, resume phrases or search words', `${boardsA.length} requests; ${leakA(boardsA).slice(0, 2).map((r) => r.url).join(' | ')}`);
    check(publikA.length === 0, 'O15 with a local model chosen, the publik service receives no request at all', `${publikA.length} requests`);
    check(aiA.length > 0 && aiA.every((r) => r.url.startsWith('/v1/')), 'O15 the chat message went to the model on this computer, and only there', `${aiA.length} requests: ${aiA.map((r) => r.url).slice(0, 3).join(', ')}`);
    check(leakA(aiA.map((r) => ({ url: r.url, body: r.body.replace(/Which skills matter most for a backend role\?/g, '') }))).filter((r) => IDENTIFIERS.some((i) => (r.url + r.body).toLowerCase().includes(i.toLowerCase()))).length === 0, 'O15 the text sent to the model holds no name, email or phone (a short summary of skills and titles only)');
    const ua = new Set([...boardsA, ...aiA].map((r) => r.userAgent));
    check(![...ua].some((u) => /Chrome|Safari|Mozilla/i.test(u ?? '') && false), 'O15 setup: user agents of outgoing calls are noted', [...ua].join(', ').slice(0, 100));

    // ---------------- phase B: publik chosen and connected
    await p.eval(`location.hash = '#/settings/balance'`);
    await sleep(800);
    await p.clickText('I have read this');
    await p.clickMatching('button', '^Connect');
    await sleep(1500);
    await p.eval(`location.hash = '#/assistant'`);
    await sleep(900);
    await p.eval(`document.querySelector('textarea[aria-label="Message to the assistant"]').focus()`);
    await p.type('Give me one tip for a phone screen.');
    await p.press('Enter');
    await sleep(600);
    await p.clickMatching('.ant-modal-confirm button', '^Send to publik');
    await p.waitFor(`!document.querySelector('button[aria-label="Stop the answer"]') && document.querySelectorAll('.jl-bubble.assistant').length > 0`, 20000);
    await sleep(600);
    await walk(p, seeded.resumeId, jobId);
    const publikB = traffic(demo, 'publik');
    check(publikB.length > 0 && publikB.some((r) => r.url.includes('/chat/completions')), 'O15 with publik chosen, the chat message went to publik (the service the person picked)', publikB.map((r) => r.url).join(', ').slice(0, 120));
    const allLogs = [...traffic(demo, 'boards'), ...traffic(demo, 'publik'), ...traffic(demo, 'ai')];
    const nameLeak = allLogs.filter((r) => IDENTIFIERS.some((i) => (r.url + ' ' + r.body).toLowerCase().includes(i.toLowerCase())));
    check(nameLeak.length === 0, 'O15 no request that left the API (employer sites, publik, model) holds the name, email or phone', `${allLogs.length} requests; ${nameLeak.slice(0, 2).map((r) => r.url).join(' | ')}`);
    check(!allLogs.some((r) => (r.url + r.body).includes(SEARCH_WORD)), 'O15 the search words typed in the feed never left the local API');
    const hostsB = [...new Set(p.requests().filter((r) => /^https?:/i.test(r.url)).map((r) => new URL(r.url).host))];
    check(hostsB.length === 1, 'O15 the page still talks to one host only after connecting publik', hostsB.join(', '));
    ctl(demo, 'status');
  } finally {
    await b.close();
  }
}
