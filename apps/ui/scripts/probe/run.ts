// Runs the lane's own probes. Examples:
//   node apps/ui/scripts/probe/run.ts --only nav,facts              (starts its own demo in /private/tmp)
//   node apps/ui/scripts/probe/run.ts --only nav --url "http://127.0.0.1:47821/#token=..."   (uses a running demo)
//   node apps/ui/scripts/probe/run.ts --all                          (every probe)
// A probe module exports run(demo, outDir). It may also export demoArgs: then it gets its own fresh demo with those
// start-up options (the stand-in services use fixed ports, so demos run one after the other).

import { attachDemo, startDemo, summary, type Demo } from './lib.ts';

const ALL = ['nav', 'facts', 'filters', 'signals', 'detail', 'tracker', 'persist', 'states', 'money', 'privacy', 'keyboard', 'layout', 'perf'];
const argv = process.argv.slice(2);
const get = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const only = argv.includes('--all') ? ALL : (get('only') ?? 'nav').split(',');
const out = get('out') ?? '/private/tmp/jlui-probe';

interface Probe { run: (d: Demo, out: string) => Promise<void>; demoArgs?: string[] }
const attached = get('url') ? attachDemo(get('url')!) : null;
let shared: Demo | null = null;
const startShared = () => startDemo({ home: '/private/tmp/jlui-probe-home', args: ['--persona', '--balance', '4.37', '--jobs', '1500'] });

try {
  for (const name of only) {
    console.log(`\n== ${name}`);
    const mod = await import(`./${name}.ts`) as Probe;
    if (attached) { await mod.run(attached, out); continue; }
    if (mod.demoArgs) {
      if (shared) { await shared.stop(); shared = null; }
      const d = await startDemo({ home: `/private/tmp/jlui-probe-${name}`, args: mod.demoArgs });
      try { await mod.run(d, out); } finally { await d.stop(); }
    } else {
      shared ??= await startShared();
      await mod.run(shared, out);
    }
  }
} finally {
  await shared?.stop();
}
process.exit(summary());
