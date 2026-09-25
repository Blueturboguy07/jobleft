// The JSON Schema files in schemas/ must equal the TypeScript definitions. If this fails, run:
//   pnpm --filter @jobleft/contracts run gen
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMAS, schemaDocument } from '../src/index.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

test('schemas/*.schema.json are up to date with the TypeScript contracts', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.schema.json')).sort();
  assert.deepEqual(files, Object.keys(SCHEMAS).map((n) => `${n}.schema.json`).sort(), 'one file per registered schema');
  for (const name of Object.keys(SCHEMAS)) {
    const onDisk = JSON.parse(readFileSync(join(dir, `${name}.schema.json`), 'utf8'));
    assert.deepEqual(onDisk, JSON.parse(JSON.stringify(schemaDocument(name))), `${name}.schema.json is stale`);
  }
});
