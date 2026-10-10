import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from './db.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Runner migrasi berurutan, tiap file dalam satu transaksi; tercatat di schema_migrations. */
export async function migrate(sql: Sql, log = console.log) {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const done = new Set((await sql`SELECT name FROM schema_migrations`).map((r) => r.name as string));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const body = await readFile(join(MIGRATIONS_DIR, f), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (name) VALUES (${f})`;
    });
    log(`✔ migrated ${f}`);
  }
  const { DATA_MIGRATIONS } = await import('./data-migrations.js');
  for (const m of DATA_MIGRATIONS) {
    if (done.has(m.name)) continue;
    await m.run(sql);
    await sql`INSERT INTO schema_migrations (name) VALUES (${m.name})`;
    log(`✔ ${m.name}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { createSql } = await import('./db.js');
  const sql = createSql();
  try {
    await migrate(sql);
    if (process.argv.includes('--seed')) {
      const { seed } = await import('./seed.js');
      await seed(sql);
    }
  } finally {
    await sql.end();
  }
}
