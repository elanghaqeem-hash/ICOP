import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, nextNumber, notify, requirePerm } from '../../lib/context.js';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { requireFreshApprovalMfa } from '../../lib/approval-mfa.js';
import { idempotent } from '../../lib/idempotency.js';

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const r2 = (n: number) => Math.round(n * 100) / 100;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 864e5);


export async function billingRoutes(app: FastifyInstance) {
  const sql = app.sql;
  const auth = { onRequest: [app.authenticate] };
  const R = requirePerm('billing.read');
  const W = requirePerm('billing.write');
  /** Status efektif: OVERDUE bila belum lunas dan lewat jatuh tempo (tanggal Asia/Jakarta). */
  const eff = () => sql`CASE WHEN i.status IN ('ISSUED','PARTIAL') AND i.due_date < (now() AT TIME ZONE 'Asia/Jakarta')::date THEN 'OVERDUE' ELSE i.status END`;

  /** BAST: milestone diterima customer (bukti = nomor BAST yang sudah ditandatangani). */
  app.post('/api/v1/projects/:id/milestones/:mid/accept', { ...auth, preValidation: requirePerm('project.manage') }, async (req) => {
    const { id, mid } = z.object({ id: z.string().uuid(), mid: z.string().uuid() }).parse(req.params);
    const b = z.object({ bastRef: z.string().min(3).max(120) }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const [m] = await tx`SELECT m.*, p.tenant_id AS t FROM project_milestones m JOIN projects p ON p.id = m.project_id WHERE m.id = ${mid} AND m.project_id = ${id} AND p.tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!m) throw notFound('Milestone');
      if (m.status === 'ACCEPTED') throw conflict('Milestone sudah diterima (BAST ' + m.bastRef + ')');
      const [dup] = await tx`SELECT 1 FROM project_milestones WHERE bast_ref = ${b.bastRef} AND tenant_id = ${u.tenantId}`;
      if (dup) throw conflict('Nomor BAST sudah dipakai milestone lain');
      await tx`UPDATE project_milestones SET status = 'ACCEPTED', bast_ref = ${b.bastRef}, accepted_at = now() WHERE id = ${mid}`;
      await audit(tx, u, 'milestone.accept', 'project_milestone', mid, { status: m.status }, { status: 'ACCEPTED', bastRef: b.bastRef }, req.ip);
      return { id: mid, status: 'ACCEPTED', bastRef: b.bastRef };
    });
  });

  /** Invoice dari milestone ACCEPTED: nominal termin + PPN sesuai kontrak. Satu milestone = satu invoice aktif. */
  app.post('/api/v1/projects/:id/milestones/:mid/invoice', { ...auth, preValidation: W }, async (req, reply) => {
    const { id, mid } = z.object({ id: z.string().uuid(), mid: z.string().uuid() }).parse(req.params);
    const b = z.object({ dueDays: z.number().int().min(0).max(180).default(30) }).parse(req.body ?? {});
    const u = req.authUser;
    return idempotent(req, reply, 201, () => sql.begin(async (tx) => {
      const [p] = await tx`SELECT p.*, c.tax_rate, c.number AS contract_number FROM projects p JOIN contracts c ON c.id = p.contract_id WHERE p.id = ${id} AND p.tenant_id = ${u.tenantId}`;
      if (!p) throw notFound('Proyek');
      const [m] = await tx`SELECT * FROM project_milestones WHERE id = ${mid} AND project_id = ${id}`;
      if (!m) throw notFound('Milestone');
      if (m.status !== 'ACCEPTED') throw unprocessable('Invoice hanya dapat dibuat dari milestone yang sudah diterima (BAST)');
      if (!m.billingAmount || Number(m.billingAmount) <= 0) throw unprocessable('Milestone tidak memiliki nilai tagihan');
      const [dup] = await tx`SELECT number FROM invoices WHERE milestone_id = ${mid} AND status <> 'VOID'`;
      if (dup) throw conflict(`Milestone sudah ditagihkan dengan invoice ${dup.number}`);
      const now = new Date(); const year = now.getFullYear();
      const n = await nextNumber(tx, u.tenantId, 'INVOICE', String(year));
      const number = `${String(n).padStart(3, '0')}/DEIT-INV/${ROMAN[now.getMonth()]}/${year}`;
      const amount = r2(Number(m.billingAmount)); const rate = Number(p.taxRate ?? 11);
      const tax = r2((amount * rate) / 100);
      const [inv] = await tx`INSERT INTO invoices (tenant_id, number, project_id, contract_id, customer_id, milestone_id, description, amount, tax_rate, tax, total, issue_date, due_date, created_by)
        VALUES (${u.tenantId}, ${number}, ${id}, ${p.contractId}, ${p.customerId}, ${mid}, ${`${m.name} (BAST ${m.bastRef})`}, ${amount}, ${rate}, ${tax}, ${r2(amount + tax)},
                ${iso(now)}, ${iso(addDays(now, b.dueDays))}, ${u.id}) RETURNING *`;
      await audit(tx, u, 'invoice.create', 'invoice', inv.id as string, null, { number, total: inv.total, milestone: mid }, req.ip);
      await notify(tx, u.tenantId, [u.id], 'INVOICE_ISSUED', `Invoice ${number}`, `Total ${inv.total}`, `/billing/${inv.id}`);
      reply.code(201);
      return inv;
    }));
  });

  app.get('/api/v1/invoices', { ...auth, preValidation: R }, async (req) => {
    const q = z.object({ status: z.enum(['ISSUED', 'PARTIAL', 'PAID', 'CREDITED', 'VOID', 'OVERDUE']).optional() }).parse(req.query);
    const rows = await sql`SELECT * FROM (SELECT i.id, i.number, i.description, i.total, i.paid_total, i.credited_total, i.due_date, i.issue_date, i.status AS raw_status, ${eff()} AS status,
        cu.legal_name AS customer_name, p.code AS project_code, c.number AS contract_number
      FROM invoices i JOIN customers cu ON cu.id = i.customer_id JOIN projects p ON p.id = i.project_id JOIN contracts c ON c.id = i.contract_id
      WHERE i.tenant_id = ${req.authUser.tenantId}) x ${q.status ? sql`WHERE x.status = ${q.status}` : sql``} ORDER BY x.issue_date DESC, x.number DESC LIMIT 300`;
    return { items: rows.map((r) => ({ ...r, outstanding: Math.max(0, r2(Number(r.total) - Number(r.paidTotal) - Number(r.creditedTotal ?? 0))) })) };
  });

  app.get('/api/v1/invoices/:id', { ...auth, preValidation: R }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [inv] = await sql`SELECT i.*, ${eff()} AS effective_status, cu.legal_name AS customer_name, p.code AS project_code, c.number AS contract_number, cr.full_name AS created_by_name
      FROM invoices i JOIN customers cu ON cu.id = i.customer_id JOIN projects p ON p.id = i.project_id JOIN contracts c ON c.id = i.contract_id
      LEFT JOIN users cr ON cr.id = i.created_by WHERE i.id = ${id} AND i.tenant_id = ${req.authUser.tenantId}`;
    if (!inv) throw notFound('Invoice');
    const payments = await sql`SELECT pa.id, pa.amount, pa.paid_on, pa.reference, pa.created_at, u.full_name AS recorded_by_name FROM invoice_payments pa LEFT JOIN users u ON u.id = pa.recorded_by WHERE pa.invoice_id = ${id} ORDER BY pa.id`;
    const creditNotes = await sql`SELECT cn.*, cu.full_name AS created_by_name, au.full_name AS approved_by_name
      FROM credit_notes cn LEFT JOIN users cu ON cu.id = cn.created_by
      LEFT JOIN users au ON au.id = cn.approved_by
      WHERE cn.invoice_id = ${id} AND cn.tenant_id = ${req.authUser.tenantId} ORDER BY cn.created_at`;
    return { invoice: { ...inv, outstanding: Math.max(0, r2(Number(inv.total) - Number(inv.paidTotal) - Number(inv.creditedTotal))) }, payments, creditNotes };
  });

  /** Pembayaran (append-only). Tidak boleh melebihi sisa tagihan. */
  app.post('/api/v1/invoices/:id/payments', { ...auth, preValidation: W }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ amount: z.number().positive(), paidOn: z.string().date(), reference: z.string().min(3).max(200) }).parse(req.body);
    const u = req.authUser;
    return idempotent(req, reply, 201, () => sql.begin(async (tx) => {
      const [inv] = await tx`SELECT * FROM invoices WHERE id = ${id} AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!inv) throw notFound('Invoice');
      if (!['ISSUED', 'PARTIAL'].includes(inv.status as string)) throw unprocessable(`Invoice berstatus ${inv.status}; tidak menerima pembayaran`);
      const outstanding = r2(Number(inv.total) - Number(inv.paidTotal) - Number(inv.creditedTotal));
      if (r2(b.amount) > outstanding) throw unprocessable(`Jumlah melebihi sisa tagihan (${outstanding})`, { outstanding });
      await tx`INSERT INTO invoice_payments (tenant_id, invoice_id, amount, paid_on, reference, recorded_by) VALUES (${u.tenantId}, ${id}, ${r2(b.amount)}, ${b.paidOn}, ${b.reference}, ${u.id})`;
      const paid = r2(Number(inv.paidTotal) + b.amount);
      const status = paid + Number(inv.creditedTotal) >= Number(inv.total) - 0.005 ? 'PAID' : 'PARTIAL';
      await tx`UPDATE invoices SET paid_total = ${paid}, status = ${status}, updated_at = now() WHERE id = ${id}`;
      await audit(tx, u, 'invoice.payment', 'invoice', id, { paid: inv.paidTotal }, { paid, status, reference: b.reference }, req.ip);
      reply.code(201);
      return { id, paidTotal: paid, outstanding: Math.max(0, r2(Number(inv.total) - paid - Number(inv.creditedTotal))), status };
    }));
  });

  /** Batalkan invoice (hanya bila belum ada pembayaran). Milestone tetap ACCEPTED dan dapat ditagihkan ulang. */
  app.post('/api/v1/invoices/:id/void', { ...auth, preValidation: W }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ reason: z.string().min(10).max(500) }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const [inv] = await tx`SELECT * FROM invoices WHERE id = ${id} AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!inv) throw notFound('Invoice');
      if (inv.status === 'VOID') throw conflict('Invoice sudah dibatalkan');
      if (Number(inv.paidTotal) > 0) throw unprocessable('Invoice sudah memiliki pembayaran; buat nota koreksi, bukan pembatalan');
      const [existingCn] = await tx`SELECT 1 FROM credit_notes WHERE invoice_id = ${id} AND tenant_id = ${u.tenantId} AND status IN ('DRAFT','ISSUED') LIMIT 1`;
      if (existingCn) throw unprocessable('Invoice memiliki nota kredit; pembatalan tidak diizinkan');
      await tx`UPDATE invoices SET status = 'VOID', void_reason = ${b.reason}, updated_at = now() WHERE id = ${id}`;
      await audit(tx, u, 'invoice.void', 'invoice', id, { status: inv.status }, { status: 'VOID', reason: b.reason }, req.ip);
      return { id, status: 'VOID' };
    });
  });

  /** Credit note Phase 6 — per-tenant DPP correction + VAT and SoD approval. */
  app.post('/api/v1/invoices/:id/credit-notes', { ...auth, preValidation: W }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ amount: z.number().positive(), reason: z.string().trim().min(10).max(1000) }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const [inv] = await tx`SELECT * FROM invoices WHERE id = ${id} AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!inv) throw notFound('Invoice');
      if (inv.status === 'VOID') throw unprocessable('Invoice sudah dibatalkan');
      const [used] = await tx`SELECT coalesce(sum(amount), 0)::float AS used FROM credit_notes
          WHERE invoice_id = ${id} AND tenant_id = ${u.tenantId} AND status IN ('DRAFT','ISSUED')`;
      const available = r2(Number(inv.amount) - Number(used.used));
      if (r2(b.amount) > available) throw unprocessable(`DPP nota kredit melebihi sisa DPP invoice (${available})`, { available });
      const amount = r2(b.amount), tax = r2(amount * Number(inv.taxRate) / 100);
      const [cn] = await tx`INSERT INTO credit_notes
        (tenant_id, invoice_id, amount, tax, total, reason, created_by)
        VALUES (${u.tenantId}, ${id}, ${amount}, ${tax}, ${r2(amount + tax)}, ${b.reason}, ${u.id}) RETURNING *`;
      const approvers = await tx`SELECT id FROM users WHERE tenant_id = ${u.tenantId}
        AND is_active AND role IN ('pricing_finance','director','vp_head','company_admin','super_admin') AND id <> ${u.id}`;
      await notify(tx, u.tenantId, approvers.map((a) => String(a.id)), 'CREDIT_NOTE_DRAFT',
        `Nota kredit invoice ${inv.number} perlu persetujuan`, b.reason, `/billing/${id}`);
      await audit(tx, u, 'credit_note.create', 'invoice', id, null,
        { creditNoteId: cn.id, amount, tax }, req.ip);
      reply.code(201);
      return cn;
    });
  });

  app.post('/api/v1/credit-notes/:cid/decide', {
    ...auth, preValidation: requirePerm('billing.approve'),
  }, async (req) => {
    const { cid } = z.object({ cid: z.string().uuid() }).parse(req.params);
    const b = z.object({ decision: z.enum(['APPROVE','REJECT']) }).parse(req.body);
    const u = req.authUser;
    requireFreshApprovalMfa(u);
    return sql.begin(async (tx) => {
      const [cn] = await tx`SELECT * FROM credit_notes WHERE id = ${cid}
        AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!cn) throw notFound('Nota kredit');
      if (cn.status !== 'DRAFT') throw conflict('Nota kredit sudah diputuskan');
      if (cn.createdBy === u.id) throw forbidden('Maker-checker: pembuat nota kredit tidak boleh memutuskan');
      if (b.decision === 'REJECT') {
        await tx`UPDATE credit_notes SET status = 'REJECTED',
          approved_by = ${u.id}, approved_at = now() WHERE id = ${cid}`;
        await audit(tx, u, 'credit_note.reject', 'invoice', String(cn.invoiceId),
          null, { creditNoteId: cid }, req.ip);
        return { id: cid, status: 'REJECTED' };
      }
      const [inv] = await tx`SELECT * FROM invoices WHERE id = ${cn.invoiceId}
        AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!inv || inv.status === 'VOID') throw unprocessable('Invoice tidak lagi dapat dikoreksi');
      const now = new Date(), year = now.getFullYear();
      const seq = await nextNumber(tx, u.tenantId, 'CREDIT_NOTE', String(year));
      const number = `${String(seq).padStart(3, '0')}/DEIT-CN/${ROMAN[now.getMonth()]}/${year}`;
      const dueBefore = r2(Number(inv.total) - Number(inv.paidTotal) - Number(inv.creditedTotal));
      const refundDue = Math.max(0, r2(Number(cn.total) - Math.max(0, dueBefore)));
      const totalCredited = r2(Number(inv.creditedTotal) + Number(cn.total));
      const settled = Number(inv.paidTotal) + totalCredited >= Number(inv.total) - 0.005;
      const invoiceStatus = settled ? (Number(inv.paidTotal) > 0 ? 'PAID' : 'CREDITED')
        : Number(inv.paidTotal) > 0 ? 'PARTIAL' : 'ISSUED';
      await tx`UPDATE credit_notes SET status = 'ISSUED', number = ${number},
        refund_due = ${refundDue}, approved_by = ${u.id}, approved_at = now() WHERE id = ${cid}`;
      await tx`UPDATE invoices SET credited_total = ${totalCredited}, status = ${invoiceStatus},
        updated_at = now() WHERE id = ${inv.id} AND tenant_id = ${u.tenantId}`;
      await audit(tx, u, 'credit_note.issue', 'invoice', String(inv.id),
        { credited: inv.creditedTotal, status: inv.status },
        { creditNoteId: cid, number, totalCredited, refundDue, invoiceStatus }, req.ip);
      return { id: cid, number, status: 'ISSUED', invoiceStatus, refundDue };
    });
  });

  /** Aging piutang: buckets berdasarkan hari lewat jatuh tempo. */
  app.get('/api/v1/billing/aging', { ...auth, preValidation: R }, async (req) => {
    const rows = await sql`SELECT
        CASE WHEN due_date >= today THEN 'CURRENT' WHEN today - due_date <= 30 THEN 'D1_30' WHEN today - due_date <= 60 THEN 'D31_60'
             WHEN today - due_date <= 90 THEN 'D61_90' ELSE 'D90_PLUS' END AS bucket,
        count(*)::int AS count, coalesce(sum(greatest(total - paid_total - credited_total, 0)), 0)::float AS outstanding
      FROM (SELECT i.*, (now() AT TIME ZONE 'Asia/Jakarta')::date AS today FROM invoices i WHERE i.tenant_id = ${req.authUser.tenantId} AND i.status IN ('ISSUED','PARTIAL')) x
      GROUP BY 1`;
    const order = ['CURRENT', 'D1_30', 'D31_60', 'D61_90', 'D90_PLUS'];
    const buckets = order.map((k) => { const r = rows.find((x) => x.bucket === k); return { bucket: k, count: r?.count ?? 0, outstanding: r2(Number(r?.outstanding ?? 0)) }; });
    return { buckets, totalOutstanding: r2(buckets.reduce((s, b) => s + b.outstanding, 0)), asOf: iso(new Date()) };
  });

  /** Portal customer: tagihan milik customer (tanpa nilai internal). */
  app.get('/api/v1/portal/invoices', { onRequest: [app.authenticate], preValidation: requirePerm('portal.access') }, async (req) => {
    const u = req.authUser;
    const rows = await sql`SELECT i.id, i.number, i.description, i.total, i.paid_total, i.credited_total, i.due_date, i.issue_date, ${eff()} AS status
      FROM invoices i WHERE i.tenant_id = ${u.tenantId} AND i.customer_id = ${u.customerId} AND i.status <> 'VOID' ORDER BY i.issue_date DESC`;
    return { items: rows.map((r) => ({ ...r, outstanding: Math.max(0, r2(Number(r.total) - Number(r.paidTotal) - Number(r.creditedTotal ?? 0))) })) };
  });
}
