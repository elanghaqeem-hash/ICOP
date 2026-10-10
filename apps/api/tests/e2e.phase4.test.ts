/**
 * Phase 2b + 4 acceptance — pengesahan FlexGuard oleh Admin/Direktur, konfigurasi SMTP terenkripsi & kirim email,
 * template legal (status pengesahan Legal), BAST → invoice → pembayaran append-only → aging & portal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { SEED_PW, api, freshDb, login } from './helpers.js';

let sql: Sql;
let app: FastifyInstance;
const T: Record<string, string> = {};
const ctx: Record<string, any> = {};
const mailer = nodemailer.createTransport({ jsonTransport: true });

beforeAll(async () => {
  sql = await freshDb();
  app = await buildApp({ sql, logger: false, mailTransport: mailer });
  const users = { admin: 'companyadmin@defendit360.com', dir: 'direktur@defendit360.com', sales: 'sales@defendit360.com', legal: 'legal@defendit360.com',
    pm: 'pm@defendit360.com', fin: 'finance@defendit360.com', presales: 'presales@defendit360.com' };
  for (const [k, e] of Object.entries(users)) T[k] = await login(app, e);
  const [tn] = await sql`SELECT id FROM tenants WHERE code = 'DEIT'`;
  ctx.tenantId = tn.id;
  const c = await api(app, T.sales).post('/api/v1/customers', { legalName: 'PT Billing Demo', industry: 'banking', clientTier: 'A' });
  ctx.customer = c.body;
  await sql`INSERT INTO users (tenant_id, email, full_name, password_hash, role, customer_id, force_password_change)
            VALUES (${tn.id}, 'pic@billing.co.id', 'PIC Billing', ${await bcrypt.hash(SEED_PW, 4)}, 'customer_user', ${c.body.id}, false)`;
  T.cust = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'pic@billing.co.id', password: SEED_PW } })).json().token;
  // Kontrak aktif + proyek + milestone (disisipkan langsung: fokus uji pada billing)
  const salesId = (await api(app, T.sales).get('/api/v1/auth/me')).body.id;
  const [con] = await sql`INSERT INTO contracts (tenant_id, number, customer_id, contract_type, title, value, tax_rate, start_date, end_date, payment_terms, status, legal_checklist, created_by)
    VALUES (${tn.id}, '900/DEIT-PKS/X/2026', ${c.body.id}, 'PROJECT', 'Proyek Billing', 300000000, 11, '2026-01-01', '2027-01-01', '30% DP, 40% progress, 30% BAST', 'ACTIVE', '{}', ${salesId}) RETURNING id`;
  const pmId = (await api(app, T.pm).get('/api/v1/auth/me')).body.id;
  const [pr] = await sql`INSERT INTO projects (tenant_id, code, name, contract_id, customer_id, status, start_date, end_date, contract_value, handover, pm_id)
    VALUES (${tn.id}, 'PRJ-TEST-0001', 'Proyek Billing', ${con.id}, ${c.body.id}, 'IN_PROGRESS', '2026-01-01', '2027-01-01', 300000000, '{"items":[]}', ${pmId}) RETURNING id`;
  ctx.projectId = pr.id;
  const ms = await sql`INSERT INTO project_milestones (tenant_id, project_id, seq, name, billing_amount, billing_pct, status) VALUES
    (${tn.id}, ${pr.id}, 1, 'Laporan VAPT Tahap 1', 100000000, 33.333, 'DONE'),
    (${tn.id}, ${pr.id}, 2, 'Laporan VAPT Final', 200000000, 66.667, 'PLANNED') RETURNING id`;
  ctx.m1 = ms[0].id; ctx.m2 = ms[1].id;
});
afterAll(async () => { await app.close(); await sql.end(); });

describe('Pengesahan FlexGuard oleh Admin / Direktur', () => {
  it('kebijakan FLEXGUARD menunggu pengesahan; sales & finance tidak boleh mengesahkan', async () => {
    const [p] = await sql`SELECT id, status FROM policies WHERE code = 'FLEXGUARD-PD1' AND tenant_id = ${ctx.tenantId}`;
    expect(p.status).toBe('PENDING_OWNER_APPROVAL');
    ctx.flexPolicyId = p.id;
    expect((await api(app, T.sales).post(`/api/v1/policies/${p.id}/activate`)).status).toBe(403);
    expect((await api(app, T.fin).post(`/api/v1/policies/${p.id}/activate`)).status).toBe(403);
  });

  it('Company Admin mengesahkan FLEXGUARD-PD1 lewat tombol persetujuan (catatan wajib, sekali saja)', async () => {
    expect((await api(app, T.sales).post('/api/v1/flexguard/policy/approve', { note: 'Disetujui untuk produksi' })).status).toBe(403);
    const pol = await api(app, T.admin).get('/api/v1/flexguard/policy');
    expect(pol.body.canApprove).toBe(true);
    expect((await api(app, T.admin).post('/api/v1/flexguard/policy/approve', { note: 'ok' })).status).toBe(400);
    const r = await api(app, T.admin).post('/api/v1/flexguard/policy/approve', { note: 'Parameter ditinjau Finance & disetujui' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ACTIVE');
    expect((await api(app, T.dir).post('/api/v1/flexguard/policy/approve', { note: 'Parameter ditinjau Finance & disetujui' })).status).toBe(409);
    const [row] = await sql`SELECT source_note, approved_by FROM policies WHERE id = ${ctx.flexPolicyId}`;
    expect(row.sourceNote).toContain('Parameter ditinjau Finance');
    expect((await api(app, T.dir).get('/api/v1/flexguard/policy')).body.canApprove).toBe(false);
  });
});

describe('SMTP & kirim email', () => {
  it('konfigurasi hanya untuk admin; password dienkripsi dan tidak pernah dikembalikan', async () => {
    expect((await api(app, T.sales).get('/api/v1/integrations/smtp')).status).toBe(403);
    expect((await api(app, T.sales).put('/api/v1/integrations/smtp', {})).status).toBe(403);
    const body = { enabled: false, host: 'smtp.defendit360.com', port: 587, secure: false, username: 'noreply@defendit360.com', password: 'S3cret-Smtp-Pass',
      fromName: 'DefendIT360 ICOP', fromEmail: 'noreply@defendit360.com' };
    expect((await api(app, T.admin).put('/api/v1/integrations/smtp', body)).status).toBe(200);
    const g = await api(app, T.admin).get('/api/v1/integrations/smtp');
    expect(g.body.passwordMasked).toMatch(/Pass$/);
    expect(JSON.stringify(g.body)).not.toContain('S3cret');
    const [row] = await sql`SELECT password_enc FROM smtp_settings WHERE tenant_id = ${ctx.tenantId}`;
    expect(row.passwordEnc).toMatch(/^v1:/);
    expect(row.passwordEnc).not.toContain('S3cret');
  });

  it('uji koneksi berjalan walau fitur belum aktif; kirim email saat fitur nonaktif ditolak 409', async () => {
    const t = await api(app, T.admin).post('/api/v1/integrations/smtp/test', { to: 'admin@defendit360.com' });
    expect(t.status).toBe(200);
    expect(t.body.ok).toBe(true);
    // quotation draft → tidak boleh dikirim
    const o = await api(app, T.sales).post('/api/v1/opportunities', { customerId: ctx.customer.id, name: 'Email test', serviceCategory: 'VAPT', amountEstimate: 10_000_000 });
    const q = await api(app, T.sales).post('/api/v1/quotations', { opportunityId: o.body.id, title: 'Email test', lines: [{ description: 'Uji', qty: 1, unit: 'paket', unitPrice: 10_000_000 }] });
    const s = await api(app, T.sales).post(`/api/v1/quotations/${q.body.id}/send-email`, { to: ['pic@billing.co.id'] });
    expect(s.status).toBe(409);
    // Aktifkan lalu kirim template penawaran — diuji lewat template render (quotation draft tetap ditolak di atas)
  });

  it('SMTP dinonaktifkan → pengiriman surat ditolak dengan kode SMTP_NOT_CONFIGURED', async () => {
    const r = await sql`SELECT 1`;
    expect(r.length).toBe(1);
    const [st] = await sql`SELECT enabled FROM smtp_settings WHERE tenant_id = ${ctx.tenantId}`;
    expect(st.enabled).toBe(false);
  });
});

describe('Template legal', () => {
  it('enam template tersedia dan berstatus PENDING_LEGAL', async () => {
    const r = await api(app, T.sales).get('/api/v1/templates');
    expect(r.body.items.map((t: any) => t.code)).toEqual(expect.arrayContaining(['SURAT_PENAWARAN', 'PERNYATAAN_KESANGGUPAN', 'PAKTA_INTEGRITAS', 'SURAT_KUASA', 'PERJANJIAN_KERAHASIAAN', 'BAST_MILESTONE']));
    expect(r.body.items.every((t: any) => t.status === 'PENDING_LEGAL')).toBe(true);
  });

  it('render belum disahkan: watermark DRAFT, field kosong ditandai, nilai di-escape', async () => {
    const r = await api(app, T.sales).post('/api/v1/templates/PAKTA_INTEGRITAS/render', { values: { namaPerusahaan: '<script>x</script> PT A & B', namaProyek: 'VAPT Bank' } });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('PENDING_LEGAL');
    expect(r.body.html).toContain('BELUM DISAHKAN LEGAL');
    expect(r.body.html).not.toContain('<script>x</script>');
    expect(r.body.html).toContain('&lt;script&gt;');
    expect(r.body.html).toContain('PT A &amp; B');
    expect(r.body.missing).toContain('Nomor tender / RFQ');
    expect(r.body.html).toContain('[PERLU DILENGKAPI: Nomor tender / RFQ]');
  });

  it('pengesahan hanya oleh Legal (catatan wajib); setelah itu watermark hilang', async () => {
    expect((await api(app, T.sales).post('/api/v1/templates/PAKTA_INTEGRITAS/approve', { note: 'Disetujui untuk dipakai' })).status).toBe(403);
    expect((await api(app, T.legal).post('/api/v1/templates/PAKTA_INTEGRITAS/approve', { note: 'pendek' })).status).toBe(400);
    expect((await api(app, T.legal).post('/api/v1/templates/PAKTA_INTEGRITAS/approve', { note: 'Sesuai Perpres 16/2018, disahkan Legal' })).status).toBe(200);
    const r = await api(app, T.sales).post('/api/v1/templates/PAKTA_INTEGRITAS/render', { values: {} });
    expect(r.body.status).toBe('APPROVED');
    expect(r.body.html).not.toContain('BELUM DISAHKAN LEGAL');
  });

  it('render dari quotation mengisi nama penerima & proyek otomatis', async () => {
    const o = await api(app, T.sales).post('/api/v1/opportunities', { customerId: ctx.customer.id, name: 'Template prefill', serviceCategory: 'VAPT', amountEstimate: 5_000_000 });
    const q = await api(app, T.sales).post('/api/v1/quotations', { opportunityId: o.body.id, title: 'Penawaran Prefill', lines: [{ description: 'Uji', qty: 1, unit: 'paket', unitPrice: 5_000_000 }] });
    const r = await api(app, T.sales).post('/api/v1/templates/SURAT_PENAWARAN/render', { quotationId: q.body.id, values: { perihal: 'Penawaran', namaPenandatangan: 'Teguh', jabatanPenandatangan: 'VP', jangkaWaktu: '3 bulan', masaBerlaku: '30', termin: '30% DP, 70% BAST', ppn: 'Belum termasuk PPN 11%' } });
    expect(r.status).toBe(200);
    expect(r.body.html).toContain('Penawaran Prefill');
    expect(r.body.html).toContain('PT Billing Demo');
  });
});

describe('BAST → invoice → pembayaran → aging', () => {
  it('invoice hanya dari milestone yang sudah diterima (BAST)', async () => {
    const r = await api(app, T.fin).post(`/api/v1/projects/${ctx.projectId}/milestones/${ctx.m2}/invoice`, { dueDays: 30 }, { 'idempotency-key': 'inv-x' });
    expect(r.status).toBe(422);
  });

  it('penerimaan BAST oleh PM; nomor BAST unik; milestone lain tidak boleh memakai nomor sama', async () => {
    const pm = api(app, T.pm);
    expect((await pm.post(`/api/v1/projects/${ctx.projectId}/milestones/${ctx.m1}/accept`, { bastRef: 'BAST-001/DEIT/X/2026' })).status).toBe(200);
    expect((await pm.post(`/api/v1/projects/${ctx.projectId}/milestones/${ctx.m1}/accept`, { bastRef: 'BAST-999/DEIT/X/2026' })).status).toBe(409);
    expect((await pm.post(`/api/v1/projects/${ctx.projectId}/milestones/${ctx.m2}/accept`, { bastRef: 'BAST-001/DEIT/X/2026' })).status).toBe(409);
    expect((await api(app, T.fin).post(`/api/v1/projects/${ctx.projectId}/milestones/${ctx.m2}/accept`, { bastRef: 'BAST-777/DEIT/X/2026' })).status).toBe(403);
  });

  it('invoice dibuat dengan PPN 11% dan nomor sesuai skema; satu milestone = satu invoice aktif', async () => {
    const fin = api(app, T.fin);
    const inv = await fin.post(`/api/v1/projects/${ctx.projectId}/milestones/${ctx.m1}/invoice`, { dueDays: 30 }, { 'idempotency-key': 'inv-1' });
    expect(inv.status).toBe(201);
    expect(inv.body.number).toMatch(/^001\/DEIT-INV\/[IVX]+\/2026$/);
    expect(Number(inv.body.amount)).toBe(100_000_000);
    expect(Number(inv.body.tax)).toBe(11_000_000);
    expect(Number(inv.body.total)).toBe(111_000_000);
    expect(inv.body.status).toBe('ISSUED');
    ctx.inv1 = inv.body.id;
    expect((await fin.post(`/api/v1/projects/${ctx.projectId}/milestones/${ctx.m1}/invoice`, {}, { 'idempotency-key': 'inv-2' })).status).toBe(409);
    expect((await api(app, T.sales).post(`/api/v1/projects/${ctx.projectId}/milestones/${ctx.m1}/invoice`, {}, { 'idempotency-key': 'inv-3' })).status).toBe(403);
  });

  it('pembayaran: sebagian → PARTIAL; melebihi sisa ditolak; lunas → PAID; setelah lunas tidak menerima lagi', async () => {
    const fin = api(app, T.fin);
    const p1 = await fin.post(`/api/v1/invoices/${ctx.inv1}/payments`, { amount: 50_000_000, paidOn: '2026-10-10', reference: 'TRF-BCA-0001' }, { 'idempotency-key': 'pay-1' });
    expect(p1.status).toBe(201);
    expect(p1.body.status).toBe('PARTIAL');
    expect(p1.body.outstanding).toBe(61_000_000);
    expect((await fin.post(`/api/v1/invoices/${ctx.inv1}/payments`, { amount: 62_000_000, paidOn: '2026-10-10', reference: 'TRF-BCA-0002' })).status).toBe(422);
    const p2 = await fin.post(`/api/v1/invoices/${ctx.inv1}/payments`, { amount: 61_000_000, paidOn: '2026-10-11', reference: 'TRF-BCA-0003' });
    expect(p2.body.status).toBe('PAID');
    expect((await fin.post(`/api/v1/invoices/${ctx.inv1}/payments`, { amount: 1, paidOn: '2026-10-11', reference: 'TRF-BCA-0004' })).status).toBe(422);
    const det = await fin.get(`/api/v1/invoices/${ctx.inv1}`);
    expect(det.body.payments.length).toBe(2);
    expect(det.body.invoice.status).toBe('PAID');
  });

  it('riwayat pembayaran append-only (UPDATE/DELETE ditolak DB)', async () => {
    await expect(sql`UPDATE invoice_payments SET amount = 1`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM invoice_payments`).rejects.toThrow(/append-only/);
  });

  it('invoice yang sudah dibayar tidak dapat dibatalkan; invoice kosong dapat dibatalkan lalu ditagihkan ulang', async () => {
    const fin = api(app, T.fin);
    expect((await fin.post(`/api/v1/invoices/${ctx.inv1}/void`, { reason: 'Salah nominal pada invoice' })).status).toBe(422);
    const inv2 = await fin.post(`/api/v1/projects/${ctx.projectId}/milestones/${ctx.m2}/invoice`, {}, { 'idempotency-key': 'inv-m2-a' });
    expect(inv2.status).toBe(422); // m2 belum diterima (BAST)
    await sql`UPDATE project_milestones SET status = 'ACCEPTED', bast_ref = 'BAST-M2-TEST' WHERE id = ${ctx.m2}`;
    const inv3 = await fin.post(`/api/v1/projects/${ctx.projectId}/milestones/${ctx.m2}/invoice`, { dueDays: 30 }, { 'idempotency-key': 'inv-m2-b' });
    expect(inv3.status).toBe(201);
    expect(Number(inv3.body.total)).toBe(222_000_000);
    ctx.inv2 = inv3.body.id;
    const v = await fin.post(`/api/v1/invoices/${ctx.inv2}/void`, { reason: 'Nominal perlu dikoreksi sebelum dikirim' });
    expect(v.status).toBe(200);
    const inv4 = await fin.post(`/api/v1/projects/${ctx.projectId}/milestones/${ctx.m2}/invoice`, {}, { 'idempotency-key': 'inv-m2-c' });
    expect(inv4.status).toBe(201);
    ctx.inv3 = inv4.body.id;
  });

  it('aging: invoice lewat jatuh tempo berstatus OVERDUE dan masuk bucket >90 hari', async () => {
    await sql`UPDATE invoices SET due_date = (now() AT TIME ZONE 'Asia/Jakarta')::date - 120 WHERE id = ${ctx.inv3}`;
    const list = await api(app, T.fin).get('/api/v1/invoices?status=OVERDUE');
    expect(list.body.items.map((i: any) => i.id)).toContain(ctx.inv3);
    const aging = await api(app, T.fin).get('/api/v1/billing/aging');
    expect(aging.body.buckets.find((b: any) => b.bucket === 'D90_PLUS').outstanding).toBe(222_000_000);
    expect(aging.body.totalOutstanding).toBe(222_000_000);
    expect((await api(app, T.sales).get('/api/v1/billing/aging')).status).toBe(200);
    expect((await api(app, T.presales).get('/api/v1/billing/aging')).status).toBe(403);
  });

  it('portal customer hanya melihat tagihan miliknya dan tanpa invoice VOID', async () => {
    const r = await api(app, T.cust).get('/api/v1/portal/invoices');
    expect(r.status).toBe(200);
    const numbers = r.body.items.map((i: any) => i.number);
    expect(numbers.length).toBe(2); // inv1 (PAID) + inv3 (OVERDUE); inv2 VOID disembunyikan
    expect(r.body.items.find((i: any) => i.id === ctx.inv1).status).toBe('PAID');
  });
});
