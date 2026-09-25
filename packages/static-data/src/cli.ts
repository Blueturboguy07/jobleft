#!/usr/bin/env node
// jobleft-data: the documented lookups and the dataset build commands of @jobleft/static-data.
// Run with Node 24 or newer:  node packages/static-data/src/cli.ts <command> ...
// Every command prints plain text; add --json for the full machine-readable answer.

import { mkdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DIST_DIR } from './paths.ts';
import { writeBundledRecord, type DatasetRecord, type StaticDataOptions } from './datasets/store.ts';

const HELP = `jobleft-data: sponsor data, places, company facts and dataset releases (works offline except where noted)

Lookups
  h1b <company> [--title <job title>]      H-1B filing summary for a company name: found or unknown, never "no"
  place <text>                              Resolve a place text ("San Francisco, CA", "NYC", "Remote - US")
  within "<center> | <place> | ..." [--miles 25]   Which places are within the radius of the center
  company <name> [--refresh] [--expire]     Company facts, kept in a local cache (network only on --refresh)
  datasets                                  Every shipped dataset with its date, licence and attribution

Updates
  update [--manifest <url>]                 Install newer dataset releases (signed); a bad release changes nothing
  mock-release [--port 4777] [--mode m]     Serve a local test release: valid | truncated | tampered | older | badsig

Checks
  count-lca --lca <file.xlsx> --contains <text>   Count certified H-1B rows in a public DOL file, per filer

Builds (write to packages/static-data/dist)
  fetch-lca --out <dir>                     Download the official DOL LCA files this build uses (about 670 MB)
  build-h1b --lca <file.xlsx> [--lca ...]   Build the sponsor table from DOL LCA disclosure files
  build-places [--src <dir>] [--geonames <dir>]  Build the place table (downloads USGS GNIS and Natural Earth,
                                            about 14 MB, unless --src holds them; GeoNames only from --geonames)

Options
  --json                 Print the full JSON answer
  --data-dir <dir>       Where updated releases live (default: $JOBLEFT_HOME/datasets)
  --bundled-dir <dir>    The shipped datasets (default: packages/static-data/dist)
`;

function defaultHome(): string {
  if (process.env.JOBLEFT_HOME) return process.env.JOBLEFT_HOME;
  const p = platform();
  if (p === 'darwin') return join(homedir(), 'Library', 'Application Support', 'jobleft');
  if (p === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'jobleft');
  return join(homedir(), '.local', 'share', 'jobleft');
}

function fail(msg: string, code = 2): never {
  process.stderr.write(`jobleft-data: ${msg}\n`);
  process.exit(code);
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      title: { type: 'string' },
      'data-dir': { type: 'string' },
      'bundled-dir': { type: 'string' },
      lca: { type: 'string', multiple: true },
      out: { type: 'string' },
      contains: { type: 'string' },
      geonames: { type: 'string' },
      manifest: { type: 'string' },
      port: { type: 'string' },
      mode: { type: 'string' },
      refresh: { type: 'boolean' },
      expire: { type: 'boolean' },
      db: { type: 'string' },
      'allow-paid': { type: 'boolean' },
      'keep-downloads': { type: 'boolean' },
      host: { type: 'string' },
      src: { type: 'string' },
      miles: { type: 'string' },
      near: { type: 'string' },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd) { process.stdout.write(HELP); return cmd ? 0 : 1; }
  const opts: StaticDataOptions = {
    dataDir: resolve(values['data-dir'] ?? join(defaultHome(), 'datasets')),
    bundledDir: values['bundled-dir'] ? resolve(values['bundled-dir']) : undefined,
  };
  const out = (text: string, json: unknown) => { process.stdout.write(values.json ? JSON.stringify(json, null, 2) + '\n' : text.endsWith('\n') ? text : text + '\n'); };

  switch (cmd) {
    case 'h1b': {
      const company = rest.join(' ').trim();
      if (!company) fail('give a company name: jobleft-data h1b "Stripe, Inc."');
      const { loadH1bIndex } = await import('./h1b/index.ts');
      const { formatH1b } = await import('./format.ts');
      const idx = loadH1bIndex(opts);
      const r = idx.lookup(company, { jobTitle: values.title });
      out(formatH1b(r, idx.dataset()), r);
      return 0;
    }
    case 'datasets': {
      const { listDatasets } = await import('./datasets/list.ts');
      const { formatDatasets } = await import('./format.ts');
      const list = listDatasets(opts);
      out(formatDatasets(list), list);
      return 0;
    }
    case 'count-lca': {
      const files = values.lca ?? [];
      if (files.length === 0 || !values.contains) fail('usage: count-lca --lca <file.xlsx> --contains <text>');
      const { countLcaRows } = await import('./h1b/count.ts');
      const results = [];
      for (const f of files) results.push(await countLcaRows(resolve(f), values.contains!));
      const lines: string[] = [];
      for (const r of results) {
        lines.push(`${r.file}: ${r.scanned.toLocaleString('en-US')} rows scanned`);
        for (const row of r.rows) lines.push(`  ${String(row.certifiedH1b).padStart(7)} certified H-1B  (${row.otherRows} other rows)  ${row.employerName}  [FEIN ${row.fein || 'none'}]`);
        lines.push(`  ${String(r.rows.reduce((s, x) => s + x.certifiedH1b, 0)).padStart(7)} total for EMPLOYER_NAME containing "${values.contains}"`);
      }
      out(lines.join('\n'), results);
      return 0;
    }
    case 'build-h1b': {
      const files = (values.lca ?? []).map((f) => resolve(f));
      if (files.length === 0) fail('usage: build-h1b --lca <file.xlsx> [--lca <file.xlsx> ...]  (or run fetch-lca first)');
      for (const f of files) { try { statSync(f); } catch { fail(`no such file: ${f}`); } }
      const { buildH1bTable } = await import('./h1b/build.ts');
      const outDir = resolve(values.out ?? DIST_DIR);
      const r = await buildH1bTable({ files, outDir, log: (l) => process.stderr.write(l + '\n') });
      const rec: DatasetRecord = {
        id: r.meta.id, name: r.meta.name, file: basename(r.path), sha256: r.sha256, bytes: r.bytes, version: r.meta.version,
        sequence: r.meta.sequence, dataThrough: r.meta.dataThrough, licence: r.meta.licence, attribution: r.meta.attribution,
        sourceUrl: r.meta.sourceUrl, builtAt: r.meta.builtAt,
      };
      writeBundledRecord(outDir, rec);
      const { writeFileSync } = await import('node:fs');
      mkdirSync(join(outDir, 'reports'), { recursive: true });
      writeFileSync(join(outDir, 'reports', 'h1b-build-report.json'), JSON.stringify(r.report, null, 2) + '\n');
      out(`built ${r.path}\n  ${r.bytes.toLocaleString('en-US')} bytes, sha256 ${r.sha256}\n  ${r.meta.version}, data through ${r.meta.dataThrough}, window ${r.meta.window.from} to ${r.meta.window.to}\n  report: ${join(outDir, 'reports', 'h1b-build-report.json')}`, { record: rec, report: r.report });
      return 0;
    }
    case 'fetch-lca': {
      if (!values.out) fail('usage: fetch-lca --out <dir>  (about 670 MB; needs that much free disk)');
      const { fetchOfficialLcaFiles } = await import('./h1b/fetch.ts');
      const dir = resolve(values.out);
      const paths = await fetchOfficialLcaFiles(dir, (l) => process.stderr.write(l + '\n'));
      out(`downloaded and verified:\n${paths.map((p) => '  ' + p).join('\n')}\nnext: node packages/static-data/src/cli.ts build-h1b ${paths.map((p) => `--lca "${p}"`).join(' ')}`, paths);
      return 0;
    }
    default: {
      const more = await import('./cli-more.ts');
      return more.run(cmd, rest, values as Record<string, unknown>, opts, out);
    }
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err: Error) => {
  process.stderr.write(`jobleft-data: ${err.message}\n`);
  process.exitCode = 1;
});

