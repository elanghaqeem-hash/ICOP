import type { Sql } from './db.js';
import { ensurePolicies } from './seed.js';

/** Migrasi data berurutan (idempoten), dijalankan setelah migrasi SQL. */
export const DATA_MIGRATIONS: { name: string; run: (sql: Sql) => Promise<void> }[] = [
  {
    name: 'data:2026-10-09_activate_owner_approved_policies',
    run: async (sql) => {
      const tenants = await sql`SELECT t.id, (SELECT u.id FROM users u WHERE u.tenant_id = t.id AND u.role = 'super_admin' LIMIT 1) AS admin FROM tenants t`;
      for (const t of tenants) await ensurePolicies(sql, t.id as string, (t.admin as string) ?? null);
    },
  },
  {
    name: 'data:2026-10-10_phase3_policies',
    run: async (sql) => {
      const tenants = await sql`SELECT t.id, (SELECT u.id FROM users u WHERE u.tenant_id = t.id AND u.role = 'super_admin' LIMIT 1) AS admin FROM tenants t`;
      for (const t of tenants) await ensurePolicies(sql, t.id as string, (t.admin as string) ?? null);
    },
  },
];
