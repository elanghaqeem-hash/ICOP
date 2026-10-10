import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../src/db.js';
import { freshDb, makeApp, api, login, NEW_PW } from './helpers.js';

let sql: Sql;
let app: FastifyInstance;
let owner: ReturnType<typeof api>;
let outsider: ReturnType<typeof api>;
const targets: { route: string; name: string }[] = [];
const oldPolicy = process.env.MFA_POLICY;

beforeAll(async () => {
  process.env.MFA_POLICY = 'off';
  sql = await freshDb();
  app = await makeApp(sql);
  owner = api(app, await login(app, 'companyadmin@defendit360.com'));

  const [{ id: a }] = await sql`SELECT id FROM tenants WHERE code = 'DEIT'`;
  const [{ id: actor }] = await sql`SELECT id FROM users WHERE tenant_id = ${a}
    AND email = 'companyadmin@defendit360.com'`;
  const [{ id: customer }] = await sql`INSERT INTO customers
    (tenant_id, code, legal_name, industry, created_by) VALUES
    (${a}, 'CROSS-001', 'PT Hidden Cyber Tenant A', 'banking', ${actor}) RETURNING id`;
  const [{ id: opportunity }] = await sql`INSERT INTO opportunities
    (tenant_id, code, customer_id, name, service_category, created_by) VALUES
    (${a}, 'OPP-CROSS-001', ${customer}, 'Tenant-only SOC project', 'SOC_MDR', ${actor}) RETURNING id`;
  const [{ id: tender }] = await sql`INSERT INTO tenders
    (tenant_id, code, title, procuring_entity, source, customer_id, created_by) VALUES
    (${a}, 'T-CROSS-001', 'Confidential RKS', 'Company A', 'manual', ${customer}, ${actor}) RETURNING id`;
  const [{ id: quotation }] = await sql`INSERT INTO quotations
    (tenant_id, number, opportunity_id, customer_id, title, created_by) VALUES
    (${a}, 'Q-CROSS-001', ${opportunity}, ${customer}, 'Customer private quotation', ${actor}) RETURNING id`;
  const [{ id: document }] = await sql`INSERT INTO documents
    (tenant_id, title, filename, mime, kind, confidentiality, size_original, sha256, original_path, uploaded_by) VALUES
    (${a}, 'Private customer assessment', 'assessment.pdf', 'application/pdf', 'pdf',
    'RESTRICTED', 18, ${'a'.repeat(64)}, '/private/tenant-a.pdf', ${actor}) RETURNING id`;
  const [{ id: contract }] = await sql`INSERT INTO contracts
    (tenant_id, number, customer_id, opportunity_id, contract_type, title, value,
    start_date, end_date, payment_terms, created_by) VALUES
    (${a}, 'K-CROSS-001', ${customer}, ${opportunity}, 'PROJECT', 'Private Contract', 100000,
    '2026-10-01', '2027-10-01', '100% BAST', ${actor}) RETURNING id`;
  const [{ id: project }] = await sql`INSERT INTO projects
    (tenant_id, code, name, contract_id, customer_id, contract_value, handover, created_by) VALUES
    (${a}, 'P-CROSS-001', 'Private Delivery', ${contract}, ${customer}, 100000, ${sql.json({ status: 'pending' })}, ${actor}) RETURNING id`;
  const [{ id: invoice }] = await sql`INSERT INTO invoices
    (tenant_id, number, project_id, contract_id, customer_id, description,
    amount, tax, total, due_date, created_by) VALUES
    (${a}, 'INV-CROSS-001', ${project}, ${contract}, ${customer},
    'Private invoice', 100000, 11000, 111000, '2026-12-01', ${actor}) RETURNING id`;
  const [{ id: wallet }] = await sql`INSERT INTO flexguard_wallets
    (tenant_id, code, customer_id, package, price_per_token, valid_from, valid_until, created_by) VALUES
    (${a}, 'W-CROSS-001', ${customer}, 'FLEXGUARD', 1000, '2026-10-01', '2027-10-01', ${actor}) RETURNING id`;

  targets.push(
    { name: 'CRM customer', route: `/api/v1/customers/${customer}` },
    { name: 'tender & RKS', route: `/api/v1/tenders/${tender}` },
    { name: 'quotation', route: `/api/v1/quotations/${quotation}` },
    { name: 'restricted document', route: `/api/v1/documents/${document}` },
    { name: 'contract', route: `/api/v1/contracts/${contract}` },
    { name: 'project', route: `/api/v1/projects/${project}` },
    { name: 'invoice', route: `/api/v1/invoices/${invoice}` },
    { name: 'FlexGuard wallet', route: `/api/v1/flexguard/wallets/${wallet}` },
  );

  const [{ id: tenantB }] = await sql`INSERT INTO tenants (code, name)
    VALUES ('TNT-B', 'Isolated Client B') RETURNING id`;
  const hash = await bcrypt.hash(NEW_PW, 12);
  await sql`INSERT INTO users (tenant_id, email, full_name, role, password_hash, force_password_change)
    VALUES (${tenantB}, 'tenant-b-admin@example.invalid', 'Tenant B Admin', 'company_admin', ${hash}, false)`;
  const loginB = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
    payload: { tenant: 'TNT-B', email: 'tenant-b-admin@example.invalid', password: NEW_PW } });
  if (loginB.statusCode !== 200) throw new Error('Tenant B login setup failed: ' + loginB.body);
  outsider = api(app, loginB.json().token);
}, 60000);

afterAll(async () => {
  if (app) await app.close();
  if (sql) await sql.end();
  if (oldPolicy === undefined) delete process.env.MFA_POLICY;
  else process.env.MFA_POLICY = oldPolicy;
});

describe('Phase 5 Gate 4C: cross-tenant object-level isolation', () => {
  it('sanity: tenant A owner can read the fixture records', async () => {
    // Document and other fixtures are real rows; validate owner access before
    // treating 404 from the other tenant as a successful isolation result.
    for (const target of targets) {
      const response = await owner.get(target.route);
      expect(response.status, 'tenant A '+target.name).toBe(200);
    }
  });

  it('rejects tenant B access to actual tenant A objects across 8 modules', async () => {
    for (const target of targets) {
      const response = await outsider.get(target.route);
      expect(response.status, 'cross-tenant '+target.name).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('Private');
      expect(JSON.stringify(response.body)).not.toContain('Hidden');
      expect(JSON.stringify(response.body)).not.toContain('Confidential');
    }
  });

  it('does not leak tenant A objects in tenant B list views', async () => {
    for (const route of [
      '/api/v1/customers','/api/v1/tenders','/api/v1/quotations','/api/v1/documents',
      '/api/v1/contracts','/api/v1/projects','/api/v1/invoices','/api/v1/flexguard/wallets',
    ]) {
      const response = await outsider.get(route);
      expect(response.status, route).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain('Private');
      expect(JSON.stringify(response.body)).not.toContain('CROSS-001');
      expect(JSON.stringify(response.body)).not.toContain('Hidden Cyber');
    }
  });
});
