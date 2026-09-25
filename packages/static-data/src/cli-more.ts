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
    default:
      process.stderr.write(`jobleft-data: unknown command "${cmd}". Run with --help.\n`);
      return 2;
  }
}
