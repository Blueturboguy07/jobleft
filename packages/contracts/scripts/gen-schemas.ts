// Writes every contract schema to schemas/<Name>.schema.json. Run after any contract change:
//   pnpm --filter @jobleft/contracts run gen
// test/schemas.test.ts fails when the files on disk differ from the TypeScript definitions.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMAS, schemaDocument } from '../src/registry.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) if (f.endsWith('.schema.json')) rmSync(join(dir, f));
for (const name of Object.keys(SCHEMAS)) {
  writeFileSync(join(dir, `${name}.schema.json`), JSON.stringify(schemaDocument(name), null, 2) + '\n');
}
console.log(`wrote ${Object.keys(SCHEMAS).length} schemas to ${dir}`);
