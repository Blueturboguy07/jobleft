// Applies prisma/migrations/*/migration.sql to a SQLite file. Replaces the
// boot-time `npx -y prisma@6.19.0 migrate deploy` in docker-entrypoint.sh:
// no Prisma CLI, no schema engine, no network. Uses node:sqlite (Node >= 22.13,
// no flag needed on 24), so there is no native module to ship either.
//
// Each applied migration is recorded in Prisma's own _prisma_migrations table
// with Prisma's checksum (sha256 of migration.sql), so a later
// `prisma migrate deploy` in dev tooling sees the same history.
//
// Like Prisma, the script is run as-is and not wrapped in a transaction: the
// table-redefinition migrations rely on `PRAGMA foreign_keys=OFF`, which SQLite
// ignores inside a transaction.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HISTORY_DDL = `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id"                  TEXT PRIMARY KEY NOT NULL,
  "checksum"            TEXT NOT NULL,
  "finished_at"         DATETIME,
  "migration_name"      TEXT NOT NULL,
  "logs"                TEXT,
  "rolled_back_at"      DATETIME,
  "started_at"          DATETIME NOT NULL DEFAULT current_timestamp,
  "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
)`;

export function migrate({ dbPath, migrationsDir, log = () => {} }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const hasHistory = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'")
      .get();
    if (!hasHistory) {
      const foreign = db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .get();
      if (foreign.n > 0) {
        throw new Error(
          `${dbPath} has tables but no _prisma_migrations history. Refusing to guess.`,
        );
      }
    }
    db.exec(HISTORY_DDL);

    const applied = new Map(
      db
        .prepare(
          "SELECT migration_name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
        )
        .all()
        .map((r) => [r.migration_name, r.checksum]),
    );

    const names = fs
      .readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(migrationsDir, d.name, "migration.sql")))
      .map((d) => d.name)
      .sort();

    let ran = 0;
    for (const name of names) {
      const sql = fs.readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      if (applied.has(name)) {
        if (applied.get(name) !== checksum) log(`warning: ${name} changed after it was applied`);
        continue;
      }
      const id = randomUUID();
      db.prepare("INSERT INTO _prisma_migrations (id, checksum, migration_name) VALUES (?, ?, ?)").run(id, checksum, name);
      try {
        db.exec(sql);
      } catch (error) {
        db.prepare("UPDATE _prisma_migrations SET logs = ? WHERE id = ?").run(String(error), id);
        throw new Error(`migration ${name} failed: ${error.message}`);
      }
      db.prepare(
        "UPDATE _prisma_migrations SET finished_at = current_timestamp, applied_steps_count = 1 WHERE id = ?",
      ).run(id);
      ran += 1;
      log(`applied ${name}`);
    }
    return { total: names.length, applied: ran };
  } finally {
    db.close();
  }
}

// CLI: node jobleft-migrate.mjs <db-file> <migrations-dir>
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [dbPath, migrationsDir] = process.argv.slice(2);
  const r = migrate({ dbPath, migrationsDir, log: console.log });
  console.log(`migrations: ${r.total} total, ${r.applied} applied now`);
}
