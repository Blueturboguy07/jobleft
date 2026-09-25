// More jobleft-data commands (places, dataset releases, company facts). Loaded by cli.ts on demand.

import { basename, join, resolve } from 'node:path';
import { DIST_DIR } from './paths.ts';
import { writeBundledRecord, type DatasetRecord, type StaticDataOptions } from './datasets/store.ts';

type Out = (text: string, json: unknown) => void;

export async function run(cmd: string, rest: string[], values: Record<string, unknown>, opts: StaticDataOptions, out: Out): Promise<number> {
  switch (cmd) {
    case 'place': {
      const text = rest.join(' ').trim();
      if (!text) { process.stderr.write('jobleft-data: give a place text: jobleft-data place "Austin, TX"\n'); return 2; }
      const { loadPlaceIndex } = await import('./places/index.ts');
      const { formatPlace } = await import('./format.ts');
      const idx = loadPlaceIndex(opts);
      const r = idx.resolve(text);
      const notes: string[] = [];
      if (r.workModel) notes.push(`work model: ${r.workModel}${r.remoteScope ? `, remote from: ${r.remoteScope.regions.join(', ') || 'not stated'}` : ''}`);
      if (r.unresolved.length) notes.push(`shown as written (not resolved): ${r.unresolved.map((u) => `"${u}"`).join(', ')}`);
      const near = values.near as string | undefined;
      out(formatPlace({ ...r, notes }), r);
      void near;
      return 0;
    }
    case 'within': {
      // within <place text> --miles 25 <other place text> ...
      const { loadPlaceIndex } = await import('./places/index.ts');
      const idx = loadPlaceIndex(opts);
      const miles = Number(values.miles ?? 25);
      const [center, ...others] = rest.join(' ').split('|').map((s) => s.trim()).filter(Boolean);
      if (!center) { process.stderr.write('usage: within "Austin, TX | Round Rock, TX | Houston, TX" --miles 25\n'); return 2; }
      const c = idx.resolve(center);
      const cp = c.places.find((p) => p.city);
      if (!cp?.placeId) { out(`"${center}" does not resolve to one city, so there is no center.`, { center: c, results: [] }); return 1; }
      const set = idx.within(cp.placeId, miles);
      const lines = [`Within ${miles} miles of ${cp.city}, ${cp.region ?? ''} ${cp.country} [${cp.placeId}]:`];
      const results = [];
      for (const o of others) {
        const r = idx.resolve(o);
        const inside = r.places.some((p) => p.placeId !== null && set.has(p.placeId));
        const d = r.places[0] ? idx.distanceMiles(cp, r.places[0]) : null;
        lines.push(`  ${inside ? 'IN ' : 'OUT'}  ${o}${d !== null ? `  (${d.toFixed(1)} miles)` : '  (no coordinates: a state, a country or unresolved text)'}`);
        results.push({ text: o, inside, miles: d });
      }
      out(lines.join('\n'), { center: cp, miles, results });
      return 0;
    }
    case 'build-places': {
      const { buildPlacesTable } = await import('./places/build.ts');
      const srcDir = resolve((values.src as string | undefined) ?? join(process.env.TMPDIR ?? '/private/tmp', 'jobleft-place-sources'));
      if (!values.src) {
        const { fetchPlaceSourcesV2 } = await import('./places/fetch.ts');
        await fetchPlaceSourcesV2(srcDir, (l) => process.stderr.write(l + '\n'));
      }
      const outDir = resolve((values.out as string | undefined) ?? DIST_DIR);
      const r = await buildPlacesTable({ srcDir, outDir, geonamesDir: (values.geonames as string | undefined) ? resolve(values.geonames as string) : null, log: (l) => process.stderr.write(l + '\n') });
      const rec: DatasetRecord = {
        id: r.meta.id, name: r.meta.name, file: basename(r.path), sha256: r.sha256, bytes: r.bytes, version: r.meta.version,
        sequence: r.meta.sequence, dataThrough: r.meta.dataThrough, licence: r.meta.licence, attribution: r.meta.attribution,
        sourceUrl: r.meta.sourceUrl, builtAt: r.meta.builtAt,
      };
      writeBundledRecord(outDir, rec);
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(join(outDir, 'reports'), { recursive: true });
      writeFileSync(join(outDir, 'reports', 'places-build-report.json'), JSON.stringify({ ...r.report, sources: r.meta.sources }, null, 2) + '\n');
      out(`built ${r.path}\n  ${r.bytes.toLocaleString('en-US')} bytes, sha256 ${r.sha256}\n  ${JSON.stringify(r.report)}`, { record: rec, report: r.report });
      return 0;
    }
    case 'update': {
      const url = (values.manifest as string | undefined) ?? process.env.JOBLEFT_DATASET_MANIFEST_URL;
      if (!url) {
        process.stderr.write('jobleft-data: no release address. Pass --manifest <url> or set JOBLEFT_DATASET_MANIFEST_URL. The project has no public release location yet; use mock-release to test.\n');
        return 2;
      }
      const { installReleases } = await import('./datasets/release.ts');
      const { listDatasets } = await import('./datasets/list.ts');
      const { formatDatasets } = await import('./format.ts');
      const outcomes = await installReleases({ ...opts, releaseManifestUrl: url });
      const list = listDatasets(opts, { live: false });
      const lines = outcomes.map((o) => `${o.action.toUpperCase().padEnd(9)} ${o.message}`);
      lines.push('', 'Datasets in use now:', formatDatasets(list));
      out(lines.join('\n'), { outcomes, datasets: list });
      return outcomes.some((o) => o.action === 'refused' || o.action === 'failed') ? 1 : 0;
    }
    case 'mock-release': {
      const { startMockRelease, MOCK_MODES } = await import('./datasets/mock-release.ts');
      const mode = (values.mode as string | undefined) ?? 'valid';
      if (!(MOCK_MODES as readonly string[]).includes(mode)) { process.stderr.write(`jobleft-data: --mode must be one of ${MOCK_MODES.join(', ')}\n`); return 2; }
      const m = await startMockRelease({ ...opts, mode: mode as never, port: Number(values.port ?? 4777), log: (l) => process.stdout.write(l + '\n') });
      process.stdout.write(`mock release server (mode ${m.mode}) at ${m.url}\n`);
      process.stdout.write(`TEST RELEASE: synthetic data, signed with the test key that jobleft trusts only on 127.0.0.1.\n`);
      process.stdout.write(`In another terminal:  node packages/static-data/src/cli.ts update --manifest ${m.url}\n`);
      process.stdout.write('Press Ctrl+C to stop.\n');
      await new Promise<void>((resolveStop) => {
        const stop = () => { void m.close().then(resolveStop); };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
      return 0;
    }
    case 'company': {
      const name = rest.join(' ').trim();
      if (!name) { process.stderr.write('jobleft-data: give a company name: jobleft-data company "NVIDIA" --refresh\n'); return 2; }
      const { DatabaseSync } = await import('node:sqlite');
      const { mkdirSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      const { CompanyFacts } = await import('./facts/company-facts.ts');
      const { loadH1bIndex } = await import('./h1b/index.ts');
      const { loadAliasIndex } = await import('./aliases.ts');
      const { PoliteFetch } = await import('./net/polite-fetch.ts');
      const { formatCompany } = await import('./format.ts');
      const dbPath = resolve((values.db as string | undefined) ?? join(dirname(opts.dataDir), 'data', 'jobleft.db'));
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
      const pf = new PoliteFetch({ timeoutMs: 60_000, onRequest: (r) => { if (process.env.JOBLEFT_LOG_LEVEL === 'debug') process.stderr.write(`request: ${r.method} ${r.url}\n`); } });
      const searchUrl = values['search-url'] as string | undefined;
      const priceMicros = Number(values['search-price-micros'] ?? 5000);
      const paid = searchUrl ? {
        priceMicros: () => priceMicros,
        async search(q: string) {
          const res = await pf.request(`${searchUrl}${searchUrl.includes('?') ? '&' : '?'}q=${encodeURIComponent(q)}`, { accept: 'application/json' });
          const j = await res.json() as { results?: Array<{ title: string; url: string; snippet: string }> };
          return j.results ?? [];
        },
      } : null;
      const facts = new CompanyFacts({ db, h1b: loadH1bIndex(opts), aliases: loadAliasIndex(), fetchText: (u) => pf.text(u), paid });
      const key = facts.note(name);
      if (values.expire) { const n = facts.expireAll(); process.stderr.write(`expired the kept facts of ${n} companies\n`); }
      const c = values.refresh || values['allow-paid']
        ? await facts.refresh(key, { allowPaid: !!values['allow-paid'], maxPriceMicros: values['max-price-micros'] !== undefined ? Number(values['max-price-micros']) : undefined, force: !!values.force, name })
        : facts.get(key);
      db.close();
      out(formatCompany(c, pf.requestCount), { company: c, requestsSent: pf.requestCount, db: dbPath });
      return 0;
    }
    case 'mock-facts': {
      const { startMockFacts } = await import('./facts/mock-facts.ts');
      const scenario = (values.scenario as string | undefined) ?? 'empty';
      if (!['empty', 'other-company', 'match'].includes(scenario)) { process.stderr.write('jobleft-data: --scenario must be empty, other-company or match\n'); return 2; }
      const m = await startMockFacts({ port: Number(values.port ?? 4780), scenario: scenario as never, fail: !!values.fail, balanceMicros: Number(values['balance-micros'] ?? 1_000_000), logFile: values.log as string | undefined, log: (l) => process.stdout.write(l + '\n') });
      const map = JSON.stringify({ 'www.wikidata.org': m.origin, 'data.sec.gov': m.origin, 'api.gleif.org': m.origin });
      process.stdout.write(`mock company-fact sources at ${m.origin} (search scenario: ${scenario}${values.fail ? ', free sources FAIL' : ''})\n`);
      process.stdout.write(`Use in another terminal:\n  export JOBLEFT_HOST_MAP='${map}'\n  node packages/static-data/src/cli.ts company "NVIDIA" --refresh --allow-paid --search-url ${m.origin}/search\n  curl -s ${m.origin}/balance\n`);
      await new Promise<void>((resolveStop) => {
        const stop = () => { void m.close().then(resolveStop); };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
      return 0;
    }
    default:
      process.stderr.write(`jobleft-data: unknown command "${cmd}". Run with --help.\n`);
      return 2;
  }
}
