/**
 * Phase6B2 gate: PostgreSQL migration upgrade from a populated 012 schema.
 * Runs only in the isolated CI TEST_DATABASE_URL; NEVER against staging/prod.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSql, type Sql } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { inspectMigrationGate } from '../src/migration-preflight.js';
import { seed } from '../src/seed.js';
import { TEST_DB, SEED_PW } from './helpers.js';

let sql: Sql;
let originalTenant = '', originalTender = '', originalRequirement = '';
const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL || !TEST_DB.includes('icop_test')) {
    throw new Error('Refusing upgrade fixture outside explicitly isolated CI TEST_DATABASE_URL icop_test');
  }
  sql = createSql(TEST_DB);
  await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await sql`CREATE TABLE schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
  )`;
  const files = (await readdir(path)).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort();
  for (const f of files) {
    if (f.startsWith('013_')) break;
    const body = await readFile(join(path, f), 'utf8');
    await sql.begin(async tx => {
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (name) VALUES (${f})`;
    });
  }
  await seed(sql, { password: SEED_PW });
  const [t] = await sql`SELECT id FROM tenants WHERE code='DEIT'`;
  const [creator] = await sql`SELECT id FROM users WHERE tenant_id=${t.id} LIMIT 1`;
  originalTenant = t.id;
  const [tender] = await sql`INSERT INTO tenders
    (tenant_id,code,title,procuring_entity,source,created_by)
    VALUES(${t.id},'GATE-OLD-12','Existing customer tender kept across schema upgrade',
      'Staging Gate Business Entity','manual',${creator.id}) RETURNING id`;
  originalTender = tender.id;
  const [req] = await sql`INSERT INTO tender_requirements
    (tenant_id,tender_id,ref_code,category,requirement,origin)
    VALUES(${t.id},${tender.id},'LEGACY-001','QUALIFICATION',
      'Existing ISO 27001 requirement retained by migration', 'MANUAL') RETURNING id`;
  originalRequirement = req.id;
}, 60000);

afterAll(async () => { if (sql) await sql.end(); });

describe('Phase6B2 migration staging rehearsal — populated 012 -> 013', () => {
  it('preflight is truly read-only and confirms migration 013 is pending', async () => {
    const [before] = await sql`SELECT COUNT(*)::int AS n FROM schema_migrations`;
    const p = await inspectMigrationGate(sql, 'pre');
    const [after] = await sql`SELECT COUNT(*)::int AS n FROM schema_migrations`;
    expect(p).toMatchObject({ok:true,target:'pre',foundSqlMigrations:12,
      phase6b2MigrationApplied:false,suggestionTableExists:false});
    expect(after.n).toBe(before.n);
  });
  it('applies versioned migration 013, preserves existing rows and is idempotent', async () => {
    await migrate(sql, () => {});
    const p = await inspectMigrationGate(sql, 'post');
    expect(p).toMatchObject({ok:true,target:'post',phase6b2MigrationApplied:true,
      suggestionTableExists:true,pendingUniqueIndexExists:true});
    const [tender] = await sql`SELECT tenant_id FROM tenders WHERE id=${originalTender}`;
    expect(tender.tenantId).toBe(originalTenant);
    const [req] = await sql`SELECT id,compliance_status FROM tender_requirements WHERE id=${originalRequirement}`;
    expect(req.id).toBe(originalRequirement);
    expect(req.complianceStatus).toBe('UNREVIEWED');
    const [cnt] = await sql`SELECT COUNT(*)::int AS n FROM schema_migrations
      WHERE name='013_phase6_tender_suggestions.sql'`;
    expect(cnt.n).toBe(1);
    await migrate(sql, () => {});
    const [unchanged] = await sql`SELECT COUNT(*)::int AS n FROM schema_migrations
      WHERE name='013_phase6_tender_suggestions.sql'`;
    expect(unchanged.n).toBe(1);
  });
  it('fails closed when expected constraint disappears, without writing any schema fixes', async () => {
    await sql`DROP INDEX tender_ai_suggestions_pending_uq`;
    const failed = await inspectMigrationGate(sql, 'post');
    expect(failed.ok).toBe(false);
    expect(failed.issues).toEqual(expect.arrayContaining([
      'Unique partial index for one PENDING suggestion per requirement is missing.',
    ]));
    const [count] = await sql`SELECT COUNT(*)::int AS n FROM schema_migrations
      WHERE name='013_phase6_tender_suggestions.sql'`;
    expect(count.n).toBe(1); // diagnostic must not auto-repair the missing index
  });
});
