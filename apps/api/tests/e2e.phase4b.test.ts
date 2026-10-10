/**
 * Phase 4 acceptance — delivery (WBS, timesheet proyek, change request via DoA, penutupan), helpdesk & SLA (portal, komentar,
 * eskalasi), ingest SOC/VAPT via API key layanan, renewal H-180/90/60/30, dunning invoice jatuh tempo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { slaBreachCheck } from '../src/modules/helpdesk/routes.js';
import { dunningRun, renewalReminders } from '../src/modules/renewal/jobs.js';
import { SEED_PW, api, freshDb, login } from './helpers.js';

let sql: Sql;
let app: FastifyInstance;
const T: Record<string, string> = {};
const U: Record<string, string> = {};
const ctx: Record<string, any> = {};
const sentMail: any[] = [];
const transport = nodemailer.createTransport({ jsonTransport: true });
const origSend = transport.sendMail.bind(transport);
(transport as any).sendMail = async (m: any) => { sentMail.push(m); return origSend(m); };
const ingest = (path: string, key: string | null, body: unknown) =>
  app.inject({ method: 'POST', url: path, payload: body as never, headers: key ? { 'x-api-key': key } : {} });

beforeAll(async () => {
  sql = await freshDb();
  app = await buildApp({ sql, logger: false, mailTransport: transport });
  const users = { admin: 'companyadmin@defendit360.com', sales: 'sales@defendit360.com', pm: 'pm@defendit360.com', presales: 'presales@defendit360.com',
    arch: 'architect@defendit360.com', mgr: 'salesmanager@defendit360.com', vp: 'vp@defendit360.com', dir: 'direktur@defendit360.com', fin: 'finance@defendit360.com' };
  for (const [k, e] of Object.entries(users)) { T[k] = await login(app, e); U[k] = (await api(app, T[k]).get('/api/v1/auth/me')).body.id; }
  const [tn] = await sql`SELECT id FROM tenants WHERE code = 'DEIT'`;
  ctx.tenantId = tn.id;
  const c = await api(app, T.sales).post('/api/v1/customers', { legalName: 'PT Delivery Demo', industry: 'banking', clientTier: 'A' });
  ctx.customerId = c.body.id;
  await sql`INSERT INTO contacts (tenant_id, customer_id, full_name, email, contact_role) VALUES (${tn.id}, ${c.body.id}, 'Ibu Finance', 'finance@delivery.co.id', 'finance')`;
  await sql`INSERT INTO users (tenant_id, email, full_name, password_hash, role, customer_id, force_password_change)
            VALUES (${tn.id}, 'pic@delivery.co.id', 'PIC Delivery', ${await bcrypt.hash(SEED_PW, 4)}, 'customer_user', ${c.body.id}, false)`;
  T.cust = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'pic@delivery.co.id', password: SEED_PW } })).json().token;
  const [con] = await sql`INSERT INTO contracts (tenant_id, number, customer_id, contract_type, title, value, tax_rate, start_date, end_date, payment_terms, status, legal_checklist, created_by)
    VALUES (${tn.id}, '800/DEIT-PKS/X/2026', ${c.body.id}, 'MANAGED_SERVICE', 'Managed SOC 12 bulan', 600000000, 11, (current_date - 30), (current_date + 100), 'Bulanan', 'ACTIVE', ${sql.json({})}, ${U.sales}) RETURNING id`;
  ctx.contractId = con.id;
  const [pr] = await sql`INSERT INTO projects (tenant_id, code, name, contract_id, customer_id, status, start_date, end_date, contract_value, budget_md, handover, pm_id)
    VALUES (${tn.id}, 'PRJ-DLV-0001', 'Managed SOC 12 bulan', ${con.id}, ${c.body.id}, 'IN_PROGRESS', (current_date - 30), (current_date + 100), 600000000, 40, ${sql.json({ items: [] })}, ${U.pm}) RETURNING id`;
  ctx.projectId = pr.id;
  await sql`INSERT INTO project_milestones (tenant_id, project_id, seq, name, billing_amount, status) VALUES (${tn.id}, ${pr.id}, 1, 'Onboarding SOC', 50000000, 'PLANNED')`;
});
afterAll(async () => { await app.close(); await sql.end(); });

describe('Delivery: WBS, timesheet, change request, penutupan', () => {
  it('PM menyusun WBS (kode otomatis bertingkat); non-PM ditolak', async () => {
    const pm = api(app, T.pm);
    const t1 = await pm.post(`/api/v1/projects/${ctx.projectId}/tasks`, { name: 'Onboarding & integrasi log', plannedMd: 6, assigneeId: U.presales });
    expect(t1.status).toBe(201);
    expect(t1.body.wbsCode).toBe('1');
    const t11 = await pm.post(`/api/v1/projects/${ctx.projectId}/tasks`, { name: 'Integrasi firewall', parentId: t1.body.id, plannedMd: 2, assigneeId: U.presales });
    expect(t11.body.wbsCode).toBe('1.1');
    const t2 = await pm.post(`/api/v1/projects/${ctx.projectId}/tasks`, { name: 'Tuning use case', plannedMd: 4, assigneeId: U.arch, startDate: '2026-10-01', dueDate: '2026-11-30' });
    expect(t2.body.wbsCode).toBe('2');
    Object.assign(ctx, { t1: t1.body.id, t11: t11.body.id, t2: t2.body.id });
    expect((await api(app, T.sales).post(`/api/v1/projects/${ctx.projectId}/tasks`, { name: 'Tidak boleh' })).status).toBe(403);
    expect((await pm.post(`/api/v1/projects/${ctx.projectId}/tasks`, { name: 'Tanggal salah', startDate: '2026-12-01', dueDate: '2026-11-01' })).status).toBe(400);
  });

  it('penanggung jawab hanya mengubah progres/status; DONE = 100%', async () => {
    expect((await api(app, T.presales).patch(`/api/v1/projects/${ctx.projectId}/tasks/${ctx.t11}`, { name: 'Ganti nama' })).status).toBe(403);
    expect((await api(app, T.arch).patch(`/api/v1/projects/${ctx.projectId}/tasks/${ctx.t11}`, { progressPct: 50 })).status).toBe(403);
    const p = await api(app, T.presales).patch(`/api/v1/projects/${ctx.projectId}/tasks/${ctx.t11}`, { progressPct: 50, status: 'IN_PROGRESS' });
    expect(p.status).toBe(200);
    const d = await api(app, T.presales).patch(`/api/v1/projects/${ctx.projectId}/tasks/${ctx.t11}`, { status: 'DONE' });
    expect(d.body.progressPct).toBe(100);
  });

  it('timesheet: maks 1,5 MD/hari, unik per tanggal & task, tidak boleh masa depan, maker-checker', async () => {
    const ps = api(app, T.presales);
    const a = await ps.post(`/api/v1/projects/${ctx.projectId}/timesheets`, { workDate: '2026-10-05', md: 1, taskId: ctx.t11, note: 'Integrasi FortiGate' });
    expect(a.status).toBe(201);
    expect((await ps.post(`/api/v1/projects/${ctx.projectId}/timesheets`, { workDate: '2026-10-05', md: 0.5, taskId: ctx.t11 })).status).toBe(409);
    expect((await ps.post(`/api/v1/projects/${ctx.projectId}/timesheets`, { workDate: '2026-10-05', md: 1, taskId: ctx.t1 })).status).toBe(422);
    expect((await ps.post(`/api/v1/projects/${ctx.projectId}/timesheets`, { workDate: '2030-01-01', md: 1 })).status).toBe(400);
    expect((await api(app, T.sales).post(`/api/v1/projects/${ctx.projectId}/timesheets`, { workDate: '2026-10-05', md: 1 })).status).toBe(403);
    const own = await api(app, T.pm).post(`/api/v1/projects/${ctx.projectId}/timesheets`, { workDate: '2026-10-06', md: 0.5, note: 'Koordinasi' });
    expect((await api(app, T.pm).post(`/api/v1/projects/${ctx.projectId}/timesheets/${own.body.id}/decide`, { decision: 'APPROVE' })).status).toBe(403);
    expect((await api(app, T.pm).post(`/api/v1/projects/${ctx.projectId}/timesheets/${a.body.id}/decide`, { decision: 'APPROVE' })).status).toBe(200);
    const dlv = await api(app, T.pm).get(`/api/v1/projects/${ctx.projectId}/delivery`);
    expect(dlv.body.metrics.actualMd).toBe(1);
    expect(dlv.body.metrics.pendingMd).toBe(0.5);
    expect(dlv.body.metrics.burnPct).toBe(2.5); // 1 / 40 MD
    // progres tertimbang daun: 1.1 (2 MD, 100%) + 2 (4 MD, 0%) → 33,33%
    expect(dlv.body.metrics.progressPct).toBeCloseTo(33.33, 1);
    expect(dlv.body.tasks.find((t: any) => t.id === ctx.t11).actualMd).toBe(1);
  });

  it('change request: tanpa dampak ditolak; disetujui DoA → nilai/effort/jadwal proyek & milestone addendum', async () => {
    const pm = api(app, T.pm);
    expect((await pm.post(`/api/v1/projects/${ctx.projectId}/change-requests`, { title: 'Kosong', description: 'Tidak ada perubahan apa pun', reason: 'Uji' })).status).toBe(400);
    const cr = await pm.post(`/api/v1/projects/${ctx.projectId}/change-requests`, { title: 'Tambah 2 sumber log OT', description: 'Integrasi log SCADA dan historian ke SIEM',
      reason: 'Permintaan customer pasca kickoff', valueDelta: 75_000_000, mdDelta: 10, scheduleDeltaDays: 14 });
    expect(cr.status).toBe(201);
    expect(cr.body.number).toMatch(/^CR-\d{4}-0001$/);
    const [before] = await sql`SELECT end_date FROM projects WHERE id = ${ctx.projectId}`;
    const sub = await pm.post(`/api/v1/projects/${ctx.projectId}/change-requests/${cr.body.id}/submit`);
    expect(sub.status).toBe(200);
    expect(sub.body.requiredLevel).toBe(2); // > Rp50 jt ≤ Rp250 jt → VP (DOA-MP-2026 v3 CONTRACT_VALUE)
    for (const st of sub.body.steps) {
      const who = st.level === 1 ? T.mgr : st.level === 2 ? T.vp : T.dir;
      const dr = await api(app, who).post(`/api/v1/approvals/${sub.body.approvalRequestId}/decide`, { decision: 'APPROVE' });
      expect(dr.status, JSON.stringify(dr.body)).toBe(200);
    }
    const [p] = await sql`SELECT contract_value, budget_md, end_date FROM projects WHERE id = ${ctx.projectId}`;
    expect(Number(p.contractValue)).toBe(675_000_000);
    expect(Number(p.budgetMd)).toBe(50);
    expect((new Date(p.endDate).getTime() - new Date(before.endDate).getTime()) / 864e5).toBe(14);
    const ms = await sql`SELECT name, billing_amount FROM project_milestones WHERE project_id = ${ctx.projectId} AND name LIKE 'Addendum%'`;
    expect(Number(ms[0].billingAmount)).toBe(75_000_000);
    const dlv = await pm.get(`/api/v1/projects/${ctx.projectId}/delivery`);
    expect(dlv.body.changeRequests[0].status).toBe('APPROVED');
  });

  it('penutupan proyek: transisi divalidasi; CLOSED butuh semua milestone BAST & timesheet diputuskan', async () => {
    const pm = api(app, T.pm);
    expect((await pm.post(`/api/v1/projects/${ctx.projectId}/status`, { status: 'CLOSED' })).status).toBe(422);
    expect((await pm.post(`/api/v1/projects/${ctx.projectId}/status`, { status: 'ON_HOLD' })).status).toBe(400);
    expect((await pm.post(`/api/v1/projects/${ctx.projectId}/status`, { status: 'CLOSING' })).status).toBe(200);
    const r = await pm.post(`/api/v1/projects/${ctx.projectId}/status`, { status: 'CLOSED' });
    expect(r.status).toBe(422);
    expect(r.body.details.open.length).toBe(2);
    expect((await pm.post(`/api/v1/projects/${ctx.projectId}/status`, { status: 'IN_PROGRESS' })).status).toBe(200);
  });
});

describe('Helpdesk & SLA', () => {
  it('customer membuat tiket di portal; target SLA P2 = respons 60 menit', async () => {
    const r = await api(app, T.cust).post('/api/v1/portal/tickets', { category: 'INCIDENT', priority: 'P2', title: 'Alert phishing di email direksi', description: 'Email mencurigakan diterima 3 direksi pagi ini' });
    expect(r.status).toBe(201);
    expect(r.body.number).toMatch(/^TCK-\d{4}-\d{5}$/);
    const mins = (new Date(r.body.responseDueAt).getTime() - Date.now()) / 60000;
    expect(mins).toBeGreaterThan(55);
    expect(mins).toBeLessThanOrEqual(60);
    ctx.ticket = r.body.id;
    expect((await api(app, T.cust).post('/api/v1/portal/tickets', { category: 'VULNERABILITY', title: 'xxxxx', description: 'tidak boleh dari portal' })).status).toBe(400);
  });

  it('komentar internal tidak dihitung respons & tidak terlihat customer; balasan publik = respons pertama', async () => {
    const pm = api(app, T.pm);
    expect((await pm.post(`/api/v1/tickets/${ctx.ticket}/comments`, { body: 'Cek header email di SIEM', internal: true })).status).toBe(201);
    let t = await pm.get(`/api/v1/tickets/${ctx.ticket}`);
    expect(t.body.ticket.firstResponseAt).toBeNull();
    await pm.post(`/api/v1/tickets/${ctx.ticket}/comments`, { body: 'Kami sedang menganalisis, mohon jangan klik tautan.' });
    t = await pm.get(`/api/v1/tickets/${ctx.ticket}`);
    expect(t.body.ticket.firstResponseAt).not.toBeNull();
    expect(t.body.ticket.status).toBe('IN_PROGRESS');
    const portal = await api(app, T.cust).get(`/api/v1/portal/tickets/${ctx.ticket}`);
    expect(portal.body.comments.map((c: any) => c.body)).toEqual(['Kami sedang menganalisis, mohon jangan klik tautan.']);
    await expect(sql`UPDATE ticket_comments SET body = 'x'`).rejects.toThrow(/append-only/);
  });

  it('perubahan prioritas menghitung ulang target; RESOLVED wajib ringkasan; customer konfirmasi → CLOSED', async () => {
    const pm = api(app, T.pm);
    const p1 = await pm.patch(`/api/v1/tickets/${ctx.ticket}`, { priority: 'P1' });
    expect((new Date(p1.body.resolutionDueAt).getTime() - new Date(p1.body.createdAt).getTime()) / 60000).toBe(240);
    expect((await pm.patch(`/api/v1/tickets/${ctx.ticket}`, { status: 'RESOLVED' })).status).toBe(400);
    expect((await pm.patch(`/api/v1/tickets/${ctx.ticket}`, { status: 'RESOLVED', resolution: 'Domain pengirim diblokir, 3 email dikarantina, tidak ada klik.' })).status).toBe(200);
    expect((await pm.patch(`/api/v1/tickets/${ctx.ticket}`, { status: 'WAITING_CUSTOMER' })).status).toBe(422);
    expect((await api(app, T.cust).post(`/api/v1/portal/tickets/${ctx.ticket}/confirm`)).body.status).toBe('CLOSED');
    expect((await api(app, T.cust).post(`/api/v1/portal/tickets/${ctx.ticket}/comments`, { body: 'terima kasih' })).status).toBe(422);
  });

  it('pelanggaran SLA ditandai sekali dan dieskalasi; target SLA dapat diubah admin', async () => {
    const t = await api(app, T.pm).post('/api/v1/tickets', { customerId: ctx.customerId, category: 'INCIDENT', priority: 'P1', title: 'Ransomware terdeteksi di file server', description: 'EDR memblokir enkripsi massal' });
    await sql`UPDATE tickets SET response_due_at = now() - interval '5 minutes' WHERE id = ${t.body.id}`;
    const r1 = await slaBreachCheck(sql);
    expect(r1.slaResponseBreached).toBe(1);
    expect((await slaBreachCheck(sql)).slaResponseBreached).toBe(0);
    const [n] = await sql`SELECT count(*)::int AS n FROM notifications WHERE kind = 'SLA_BREACH' AND link = ${'/helpdesk/' + t.body.id}`;
    expect(n.n).toBeGreaterThan(0);
    const list = await api(app, T.pm).get('/api/v1/tickets?open=true');
    expect(list.body.summary.breached).toBeGreaterThanOrEqual(1);
    expect((await api(app, T.admin).put('/api/v1/helpdesk/sla', { items: [{ priority: 'P3', response: 600, resolution: 300 }] })).status).toBe(400);
    expect((await api(app, T.admin).put('/api/v1/helpdesk/sla', { items: [{ priority: 'P3', response: 120, resolution: 2880 }] })).status).toBe(200);
    expect((await api(app, T.pm).get('/api/v1/helpdesk/sla')).body.items.find((x: any) => x.priority === 'P3')).toMatchObject({ response: 120, resolution: 2880 });
  });
});

describe('Ingest SOC / VAPT via API key layanan', () => {
  it('alert SOC critical → tiket P1 (idempoten per externalId); kunci salah/scope salah/dicabut ditolak', async () => {
    const soc = await api(app, T.admin).post('/api/v1/integrations/api-keys', { name: 'Rapid7 InsightIDR', scope: 'INGEST_SOC', customerId: ctx.customerId });
    const vapt = await api(app, T.admin).post('/api/v1/integrations/api-keys', { name: 'Scanner VAPT', scope: 'INGEST_VAPT' });
    const alert = { externalId: 'R7-INV-1001', severity: 'critical', title: 'Lateral movement via PsExec', description: 'Deteksi dari host FIN-PC-07', asset: 'FIN-PC-07', detectedAt: '2026-10-10T01:00:00+07:00' };
    expect((await ingest('/api/v1/ingest/soc-alerts', null, alert)).statusCode).toBe(401);
    expect((await ingest('/api/v1/ingest/soc-alerts', 'icop_deadbeef_wrong', alert)).statusCode).toBe(401);
    expect((await ingest('/api/v1/ingest/soc-alerts', vapt.body.apiKey, alert)).statusCode).toBe(403);
    const r = await ingest('/api/v1/ingest/soc-alerts', soc.body.apiKey, alert);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ priority: 'P1', duplicate: false });
    const again = await ingest('/api/v1/ingest/soc-alerts', soc.body.apiKey, alert);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ ticketId: r.json().ticketId, duplicate: true });
    const other = await api(app, T.sales).post('/api/v1/customers', { legalName: 'PT Lain Sejahtera', industry: 'banking', clientTier: 'B' });
    const cross = await ingest('/api/v1/ingest/soc-alerts', soc.body.apiKey, { ...alert, externalId: 'R7-2', customerId: other.body.id });
    expect(cross.statusCode, cross.body + ' key-customer=' + soc.body.customerId + ' other=' + other.body.id).toBe(403);
    // VAPT key tidak terikat → wajib customerId
    expect((await ingest('/api/v1/ingest/vapt-findings', vapt.body.apiKey, { ...alert, externalId: 'V-1', severity: 'high' })).statusCode).toBe(400);
    const v = await ingest('/api/v1/ingest/vapt-findings', vapt.body.apiKey, { externalId: 'V-1', severity: 'high', title: 'SQL injection pada /api/login', description: 'Parameter username', customerId: ctx.customerId, cvss: 9.1, cve: 'CWE-89' });
    expect(v.statusCode).toBe(201);
    expect(v.json().priority).toBe('P2');
    const [tk] = await sql`SELECT category, source, meta FROM tickets WHERE id = ${v.json().ticketId}`;
    expect(tk).toMatchObject({ category: 'VULNERABILITY', source: 'VAPT_INGEST' });
    expect(tk.meta.cvss).toBe(9.1);
    await api(app, T.admin).post(`/api/v1/integrations/api-keys/${soc.body.id}/revoke`);
    expect((await ingest('/api/v1/ingest/soc-alerts', soc.body.apiKey, { ...alert, externalId: 'R7-3' })).statusCode).toBe(401);
  });
});

describe('Renewal & dunning', () => {
  it('renewal: H-100 → pengingat ambang 180 + opportunity renewal; tidak berulang; H-25 → ambang 30 tanpa opportunity baru', async () => {
    const r1 = await renewalReminders(sql);
    expect(r1).toMatchObject({ renewalReminders: 1, renewalOpportunities: 1 });
    const [c] = await sql`SELECT renewal_opportunity_id FROM contracts WHERE id = ${ctx.contractId}`;
    const [o] = await sql`SELECT name, stage, amount_estimate FROM opportunities WHERE id = ${c.renewalOpportunityId}`;
    expect(o.name).toBe('Renewal — Managed SOC 12 bulan');
    expect(o.stage).toBe('LEAD');
    expect((await renewalReminders(sql)).renewalReminders).toBe(0);
    await sql`UPDATE contracts SET end_date = current_date + 25 WHERE id = ${ctx.contractId}`;
    expect(await renewalReminders(sql)).toMatchObject({ renewalReminders: 1, renewalOpportunities: 0 });
    const rows = await sql`SELECT days_before FROM renewal_reminders WHERE contract_id = ${ctx.contractId} ORDER BY days_before`;
    expect(rows.map((r) => r.daysBefore)).toEqual([30, 180]);
  });

  it('dunning: L2 di hari ke-20 (email ke kontak finance + PIC), tidak berulang; L3 di hari ke-35', async () => {
    await api(app, T.admin).put('/api/v1/integrations/smtp', { enabled: true, host: 'smtp.test', port: 587, secure: false, fromName: 'DEIT Finance', fromEmail: 'finance@defendit360.com' });
    const [inv] = await sql`INSERT INTO invoices (tenant_id, number, project_id, contract_id, customer_id, description, amount, tax_rate, tax, total, issue_date, due_date, created_by)
      VALUES (${ctx.tenantId}, '777/DEIT-INV/X/2026', ${ctx.projectId}, ${ctx.contractId}, ${ctx.customerId}, 'Tagihan bulan 1', 50000000, 11, 5500000, 55500000,
              current_date - 50, current_date - 20, ${U.fin}) RETURNING id`;
    sentMail.length = 0;
    const r = await dunningRun(sql);
    expect(r).toMatchObject({ dunningSent: 1, dunningEmailed: 1 });
    const to = (sentMail[0].to as string[]).map(String).sort();
    expect(to).toEqual(['finance@delivery.co.id', 'pic@delivery.co.id']);
    expect(sentMail[0].subject).toContain('777/DEIT-INV/X/2026');
    expect((await dunningRun(sql)).dunningSent).toBe(0);
    await sql`UPDATE invoices SET due_date = current_date - 35 WHERE id = ${inv.id}`;
    expect((await dunningRun(sql)).dunningSent).toBe(1);
    const log = await sql`SELECT level, channel FROM dunning_log WHERE invoice_id = ${inv.id} ORDER BY level`;
    expect(log.map((l) => `${l.level}:${l.channel}`)).toEqual(['2:email', '3:email']);
  });

  it('admin menjalankan semua job terjadwal sekaligus', async () => {
    const r = await api(app, T.admin).post('/api/v1/admin/jobs/run', {});
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(expect.arrayContaining(['escalation', 'esign', 'tenderFeeds', 'sla', 'renewal', 'dunning']));
  });
});
