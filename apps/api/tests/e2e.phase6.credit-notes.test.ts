import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../src/db.js';
import { api, freshDb, login, makeApp } from './helpers.js';

let sql: Sql;
let app: FastifyInstance;
const ctx: Record<string, string> = {};
let finance: ReturnType<typeof api>;
let director: ReturnType<typeof api>;
let sales: ReturnType<typeof api>;
const prior = process.env.MFA_POLICY;

beforeAll(async () => {
  process.env.MFA_POLICY = 'off';
  sql = await freshDb();
  app = await makeApp(sql);
  finance = api(app, await login(app, 'finance@defendit360.com'));
  director = api(app, await login(app, 'direktur@defendit360.com'));
  sales = api(app, await login(app, 'sales@defendit360.com'));
  const [{ id: tenantId }] = await sql`SELECT id FROM tenants WHERE code='DEIT'`;
  const [{ id: uid }] = await sql`SELECT id FROM users WHERE tenant_id=${tenantId} AND email='finance@defendit360.com'`;
  const [{ id: customer }] = await sql`INSERT INTO customers (tenant_id,code,legal_name,industry,created_by)
    VALUES (${tenantId}, 'C-P6-1','PT Source Phase6 Customer','banking',${uid}) RETURNING id`;
  const [{ id: opp }] = await sql`INSERT INTO opportunities
    (tenant_id,code,customer_id,name,service_category,created_by)
    VALUES(${tenantId},'O-P6-1',${customer},'SLA & Credit Note','SOC_MDR',${uid}) RETURNING id`;
  const [{ id: contract }] = await sql`INSERT INTO contracts
    (tenant_id,number,customer_id,opportunity_id,contract_type,title,value,start_date,end_date,payment_terms,created_by)
    VALUES (${tenantId},'K-P6-1',${customer},${opp},'PROJECT','Managed SOC',100000000,
      '2026-10-01','2027-10-01','100% BAST',${uid}) RETURNING id`;
  const [{ id: project }] = await sql`INSERT INTO projects
    (tenant_id,code,name,contract_id,customer_id,contract_value,handover,created_by)
    VALUES (${tenantId},'P-P6-1','SOC delivery',${contract},${customer},100000000,
      ${sql.json({ status: 'pending' })},${uid}) RETURNING id`;
  for (const [key,amount] of [['a',100000000],['b',10000000]] as const) {
    const [i] = await sql`INSERT INTO invoices
      (tenant_id,number,project_id,contract_id,customer_id,description,amount,tax_rate,tax,total,due_date,created_by)
      VALUES(${tenantId},${'INV-P6-'+key},${project},${contract},${customer},
        'Phase 6 source verified invoice',${amount},11,${amount*0.11},${amount*1.11},
        '2026-12-31',${uid}) RETURNING id`;
    ctx[key]=String(i.id);
  }
  ctx.tenantId=String(tenantId);
},60000);

afterAll(async () => {
  if(app) await app.close();
  if(sql) await sql.end();
  if(prior===undefined)delete process.env.MFA_POLICY;
  else process.env.MFA_POLICY=prior;
});

describe('Phase 6 source integration: credit-note financial controls', () => {
  it('enforces billing permission, reason validation and DPP ceiling including open drafts',async()=>{
    expect((await sales.post(`/api/v1/invoices/${ctx.a}/credit-notes`,
      {amount:1000000,reason:'Koreksi nilai layanan SOC'})).status).toBe(403);
    expect((await finance.post(`/api/v1/invoices/${ctx.a}/credit-notes`,
      {amount:1000000,reason:'pendek'})).status).toBe(400);
    expect((await finance.post(`/api/v1/invoices/${ctx.a}/credit-notes`,
      {amount:100000001,reason:'Melebihi total nilai invoice'})).status).toBe(422);
    const r=await finance.post(`/api/v1/invoices/${ctx.a}/credit-notes`,
      {amount:20000000,reason:'Pengurangan scope dua site berdasarkan BA'});
    expect(r.status).toBe(201);
    expect(Number(r.body.tax)).toBe(2200000);
    expect(Number(r.body.total)).toBe(22200000);
    expect(r.body.status).toBe('DRAFT');
    ctx.creditA=String(r.body.id);
    const over=await finance.post(`/api/v1/invoices/${ctx.a}/credit-notes`,
      {amount:80000001,reason:'Melebihi saldo DPP setelah draft'});
    expect(over.status).toBe(422);
  });

  it('requires independent approver, single decision, tenant-filter and correct outstanding', async()=>{
    expect((await finance.post(`/api/v1/credit-notes/${ctx.creditA}/decide`,
      {decision:'APPROVE'})).status).toBe(403);
    const r=await director.post(`/api/v1/credit-notes/${ctx.creditA}/decide`,
      {decision:'APPROVE'});
    expect(r.status).toBe(200);
    expect(r.body.number).toMatch(/^\d{3}\/DEIT-CN\/[IVX]+\/\d{4}$/);
    expect(r.body.refundDue).toBe(0);
    expect((await director.post(`/api/v1/credit-notes/${ctx.creditA}/decide`,
      {decision:'REJECT'})).status).toBe(409);
    const details=await finance.get(`/api/v1/invoices/${ctx.a}`);
    expect(details.status).toBe(200);
    expect(Number(details.body.invoice.creditedTotal)).toBe(22200000);
    expect(Number(details.body.invoice.outstanding)).toBe(88800000);
  });

  it('reduces allowed payment by credit note and accounts for settlement',async()=>{
    expect((await finance.post(`/api/v1/invoices/${ctx.a}/payments`,
      {amount:88800001,paidOn:'2026-10-10',reference:'TRF-P6-001'})).status).toBe(422);
    const r=await finance.post(`/api/v1/invoices/${ctx.a}/payments`,
      {amount:88800000,paidOn:'2026-10-10',reference:'TRF-P6-002'});
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('PAID');
    expect(r.body.outstanding).toBe(0);
  });

  it('credits unpaid invoice fully; over-credit on already paid invoice is a refund',async()=>{
    const draft=await finance.post(`/api/v1/invoices/${ctx.b}/credit-notes`,
      {amount:10000000,reason:'Layanan dibatalkan sebelum pelaksanaan'});
    expect(draft.status).toBe(201);
    const approved=await director.post(`/api/v1/credit-notes/${draft.body.id}/decide`,{decision:'APPROVE'});
    expect(approved.status).toBe(200);
    expect(approved.body.invoiceStatus).toBe('CREDITED');
    expect((await finance.post(`/api/v1/invoices/${ctx.b}/void`,
      {reason:'Tidak boleh batalkan invoice yang sudah dikredit'})).status).toBe(422);
    const credit=await finance.post(`/api/v1/invoices/${ctx.a}/credit-notes`,
      {amount:5000000,reason:'Kompensasi pelanggaran SLA Oktober'});
    const result=await director.post(`/api/v1/credit-notes/${credit.body.id}/decide`,{decision:'APPROVE'});
    expect(result.status).toBe(200);
    expect(result.body.refundDue).toBe(5550000);
    expect(result.body.invoiceStatus).toBe('PAID');
    const aging=await finance.get('/api/v1/billing/aging');
    expect(aging.status).toBe(200);
    expect(aging.body.totalOutstanding).toBe(0);
  });

  it('isolates credit note decision by tenant and preserves append-only audit',async()=>{
    const id='00000000-0000-4000-8000-000000000002';
    expect((await director.post(`/api/v1/credit-notes/${id}/decide`,
      {decision:'APPROVE'})).status).toBe(404);
    const [n]=await sql`SELECT count(*)::int AS count FROM audit_events WHERE tenant_id=${ctx.tenantId}
      AND action='credit_note.issue'`;
    expect(Number(n.count)).toBe(3);
  });
});
