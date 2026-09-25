// Runs the lane's own probes. Examples:
//   node apps/ui/scripts/probe/run.ts --only nav,facts              (starts its own demo in /private/tmp)
//   node apps/ui/scripts/probe/run.ts --only nav --url "http://127.0.0.1:47821/#token=..."   (uses a running demo)

import { attachDemo, startDemo, summary } from './lib.ts';

const argv = process.argv.slice(2);
const get = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const only = (get('only') ?? 'nav').split(',');
const out = get('out') ?? '/private/tmp/jlui-probe';

const demo = get('url') ? attachDemo(get('url')!) : await startDemo({ home: '/private/tmp/jlui-probe-home', args: ['--persona', '--balance', '4.37', '--no-crawl'] });
try {
  for (const name of only) {
    console.log(`\n== ${name}`);
    const mod = await import(`./${name}.ts`) as { run: (d: typeof demo, out: string) => Promise<void> };
    await mod.run(demo, out);
  }
} finally {
  await demo.stop();
}
process.exit(summary());
