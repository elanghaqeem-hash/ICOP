/**
 * Read-only, non-destructive Phase6B2 PostgreSQL staging gate.
 * Never migrates, seeds, logs credentials or changes database tables.
 * "pre" requires migrations 001..012 and no 013; "post" requires 001..013.
 */
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from './db.js';

export type GateTarget = 'pre' | 'post';
const PHASE6B2 = '013_phase6_tender_suggestions.sql';
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const MUST_HAVE_COLUMNS = [
  'id', 'tenant_id', 'tender_id', 'requirement_id', 'requirement_updated_at',
  'suggested_status', 'evidence_fact_ids', 'verified', 'downgraded',
  'status', 'created_by', 'decided_by', 'decided_at',
];

export async function inspectMigrationGate(sql: Sql, target: GateTarget) {
  const issues: string[] = [];
  const files = (await readdir(MIGRATIONS_DIR))
    .filter(name => /^\d{3}_.*\.sql$/.test(name)).sort();
  if (!files.includes(PHASE6B2)) issues.push('Source migration 013 is not present in this release.');
  const baseline = files.filter(f => f < PHASE6B2);
  if (baseline.length !== 12) issues.push('Expected exactly 12 versioned SQL migrations before 013.');
  const expected = target === 'post' ? [...baseline, PHASE6B2] : baseline;
  let found: string[] = [];
  let exists = false;
  let columns: string[] = [];
  let pendingUnique = false;
  try {
    await sql.begin(async tx => {
      // Even if passed a role with write grants, this transaction cannot mutate data.
      await tx`SET TRANSACTION READ ONLY`;
      const rows = await tx`SELECT name FROM schema_migrations ORDER BY name`;
      found = rows.map(x => String(x.name)).filter(x => x.endsWith('.sql'));
      const [table] = await tx`SELECT to_regclass('public.tender_ai_suggestions') IS NOT NULL AS exists`;
      exists = table?.exists === true;
      if (exists) {
        const cols = await tx`SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='tender_ai_suggestions'`;
        columns = cols.map(x => String(x.columnName));
        const idx = await tx`SELECT indexdef FROM pg_indexes WHERE schemaname='public'
          AND tablename='tender_ai_suggestions' AND indexname='tender_ai_suggestions_pending_uq'`;
        pendingUnique = idx.length === 1 && /CREATE UNIQUE INDEX/i.test(String(idx[0].indexdef))
          && /WHERE.*status.*PENDING/i.test(String(idx[0].indexdef));
      }
    });
  } catch (e) {
    issues.push('Unable to inspect schema_migrations or PostgreSQL metadata (verify read-only DB access).');
    // The caller can inspect operator-only logs; no credentials or raw DB error in output.
  }
  for (const name of expected) if (!found.includes(name)) issues.push(`Required migration is missing: ${name}`);
  const unexpected = found.filter(name => !files.includes(name));
  if (unexpected.length) issues.push('Database contains migrations not present in this source checkout.');
  const had13 = found.includes(PHASE6B2);
  if (target === 'pre' && (had13 || exists))
    issues.push('013 has already been applied or its target table exists; use --target=post to verify.');
  if (target === 'post') {
    if (!had13) issues.push('013 is not recorded as applied.');
    if (!exists) issues.push('tender_ai_suggestions table not found.');
    for (const col of MUST_HAVE_COLUMNS) {
      if (!columns.includes(col)) issues.push(`Missing required suggestion column: ${col}`);
    }
    if (!pendingUnique) issues.push('Unique partial index for one PENDING suggestion per requirement is missing.');
  }
  return {
    ok: issues.length === 0,
    target,
    foundSqlMigrations: found.length,
    phase6b2MigrationApplied: had13,
    suggestionTableExists: exists,
    pendingUniqueIndexExists: pendingUnique,
    issues,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = process.argv.includes('--target=pre') ? 'pre'
    : process.argv.includes('--target=post') ? 'post' : null;
  const explicitUrl = process.env.DATABASE_URL;
  if (!target || !explicitUrl) {
    console.error('Usage: DATABASE_URL=<secure staging Postgres URL> npm run migration:preflight -- --target=pre|post');
    process.exitCode = 2;
  } else {
    const { createSql } = await import('./db.js');
    const sql = createSql(explicitUrl);
    try {
      const result = await inspectMigrationGate(sql, target);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    } catch {
      console.error('Staging migration preflight could not complete; inspect database connectivity and grants.');
      process.exitCode = 1;
    } finally {
      await sql.end();
    }
  }
}
