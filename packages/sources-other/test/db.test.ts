import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { NewerSchemaError, SCHEMA_VERSION, migrateSourcesOther } from '../src/db.ts';
import { cleanup, tempDir } from './helpers.ts';

test('migrations run forward once, are recorded per owner, and a newer file is refused untouched', () => {
  const dir = tempDir();
  try {
    const db = new DatabaseSync(join(dir, 'm.db'));
    assert.deepEqual(migrateSourcesOther(db), { from: 0, to: SCHEMA_VERSION });
    assert.deepEqual(migrateSourcesOther(db), { from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    const rows = db.prepare("SELECT version FROM schema_migrations WHERE owner = 'sources-other' ORDER BY version").all() as Array<{ version: number }>;
    assert.deepEqual(rows.map((r) => r.version), Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1));
    db.prepare("INSERT INTO schema_migrations (owner, version, applied_at) VALUES ('sources-other', ?, 'x')").run(SCHEMA_VERSION + 1);
    assert.throws(() => migrateSourcesOther(db), NewerSchemaError);
    db.close();
  } finally { cleanup(dir); }
});
