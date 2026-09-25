// Every route answer matches its contract schema (the server validates bodies and may validate answers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate, arr, CompanySchema, DatasetInfoSchema, H1bLookupSchema, PlaceLookupSchema } from '@jobleft/contracts';
import { createStaticDataRoutes } from '../src/index.ts';
import { FIXTURE_DIR } from '../src/facts/mock-facts.ts';
import { DIST_DIR } from '../src/paths.ts';
import { tempDir } from './helpers.ts';

const have = existsSync(join(DIST_DIR, 'h1b-lca.json.gz')) && existsSync(join(DIST_DIR, 'places.json.gz'));

test('route answers match the contracts', { skip: !have }, async () => {
  const t = tempDir('jl-sd-contract-');
  try {
    const r = createStaticDataRoutes({
      dataDir: join(t.dir, 'datasets'), db: new DatabaseSync(':memory:'), manifestUrl: null,
      fetchText: async (u) => {
        const m = /EntityData\/(Q\d+)\.json$|CIK(\d{10})\.json$|lei-records\/([A-Z0-9]{20})$/.exec(u);
        const f = m ? (m[1] ? `wikidata-${m[1]}.json` : m[2] ? `sec-CIK${m[2]}.json` : `gleif-${m[3]}.json`) : '';
        return f && existsSync(join(FIXTURE_DIR, f)) ? readFileSync(join(FIXTURE_DIR, f), 'utf8') : '{"data":[]}';
      },
    });
    const ok = (schema: Parameters<typeof validate>[0], v: unknown, what: string) => {
      const res = validate(schema, v);
      assert.ok(res.ok, `${what}: ${JSON.stringify((res as { issues?: unknown }).issues)}`);
    };
    for (const c of ['Stripe', 'Baltimore Orioles', 'AWS', 'Inc.']) ok(H1bLookupSchema, r.h1bLookup({ company: c }), c);
    for (const p of ['San Francisco, CA', 'Portland', 'Remote (Canada)', 'Georgia', 'Building 7, Campus West']) ok(PlaceLookupSchema, r.placeLookup({ text: p }), p);
    ok(CompanySchema, await r.refreshCompany({ companyKey: 'nvidia' }, { allowPaid: false }), 'NVIDIA');
    ok(CompanySchema, r.getCompany({ companyKey: 'qxlorvanewidgets' }, { name: 'Qxlorvane Widgets LLC' }), 'fictional');
    ok(arr(DatasetInfoSchema), r.listDatasets(), 'datasets');
    const after = await r.updateDatasets();
    ok(arr(DatasetInfoSchema), after, 'update');
    assert.match(after.find((d) => d.id === 'h1b-lca')!.lastUpdateError ?? '', /No release location/);
  } finally { t.done(); }
});
