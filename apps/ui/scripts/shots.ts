// Screenshots and audits of every screen at the smallest supported window and a large one.
// Run (with the demo running): node apps/ui/scripts/shots.ts --url "http://127.0.0.1:47821/#token=..." --out /private/tmp/jlui-shots
// Prints a JSON report: per screen and size, controls without a name, low-contrast text, sideways scroll,
// close buttons off screen, and banned words (another brand's names, "credits", applicant counts, "undefined"...).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIT, launch } from './browser.ts';

const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1] ?? '']] : a), []));
const url = args.url;
if (!url) { console.error('Pass --url with the token address the demo printed.'); process.exit(1); }
const out = args.out ?? '/private/tmp/jlui-shots';
mkdirSync(out, { recursive: true });
const sizes = (args.sizes ?? '1024x640,1440x900').split(',').map((s: string) => s.split('x').map(Number) as [number, number]);
const routes = (args.routes ?? 'jobs,jobs/liked,jobs/applied,jobs/external,jobs/hidden,DETAIL,tracker,dashboard,resume,profile,network,network/people,interview,assistant,settings/ai,settings/balance,settings/alerts,settings/sources,settings/data,settings/extension,settings/about,notifications,onboarding').split(',');

const b = await launch();
const p = await b.page();
const report: Record<string, unknown> = {};
try {
  await p.size(sizes[0]![0], sizes[0]![1]);
  await p.goto(url);
  await p.waitFor("document.querySelector('.jl-shell, .jl-onboard')", 15000);
  for (const [w, h] of sizes) {
    await p.size(w, h);
    for (const r of routes) {
      let route = r;
      if (r === 'DETAIL') {
        route = 'jobs';
        await p.eval(`location.hash = '#/jobs'`);
        await p.waitFor("document.querySelector('.jl-card')", 10000);
        const id = await p.eval<string | null>(`document.querySelector('.jl-card')?.getAttribute('data-job-id') ?? null`);
        if (!id) { report[`${r}@${w}x${h}`] = { error: 'no card to open' }; continue; }
        route = `jobs/${encodeURIComponent(id)}`;
      }
      await p.eval(`location.hash = ${JSON.stringify(`#/${route}`)}`);
      await p.waitFor("!document.querySelector('.ant-spin-spinning') && !document.querySelector('.jl-skel')", 8000);
      await new Promise((res) => setTimeout(res, 700));
      const name = `${r.replace(/\//g, '_')}@${w}x${h}`;
      await p.shot(join(out, `${name}.png`));
      report[name] = await p.eval(AUDIT);
    }
  }
} finally {
  await b.close();
}
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
const summary = Object.entries(report).map(([k, v]) => {
  const x = v as { noName?: unknown[]; lowContrast?: unknown[]; overflowX?: boolean; offscreen?: unknown[]; banned?: unknown[]; error?: string };
  return `${k.padEnd(34)} noName=${x.noName?.length ?? '-'} contrast=${x.lowContrast?.length ?? '-'} overflowX=${x.overflowX ?? '-'} offscreen=${x.offscreen?.length ?? '-'} banned=${x.banned?.length ?? '-'}${x.error ? ` ${x.error}` : ''}`;
});
console.log(summary.join('\n'));
console.log(`\nScreens and report: ${out}`);
