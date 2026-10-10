import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Tx } from '../../db.js';
import { audit, nextNumber, notify, requirePerm } from '../../lib/context.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { idempotent } from '../../lib/idempotency.js';
import { can } from '../../lib/rbac.js';
import { approvalHandler, createApprovalRequest, decide, effectiveLevel, loadCurrentPolicy, supersedeOpenRequests } from '../approvals/engine.js';
import { requireFreshApprovalMfa } from '../../lib/approval-mfa.js';
import type { PricingPolicy } from '../pricing/policy-defaults.js';
import type { PriceResult } from '../pricing/engine.js';
import { renderQuotationHtml } from './render.js';
import { onBidDecision } from '../tenders/service.js';

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const r2 = (n: number) => Math.round(n * 100) / 100;

const Line = z.object({
  catalogItemId: z.string().uuid().optional(),
  description: z.string().trim().min(2).max(500),
  qty: z.number().positive(),
  unit: z.string().min(1).max(40),
  unitPrice: z.number().min(0),
});
const Terms = z.object({
  title: z.string().trim().min(3).max(200),
  discountPct: z.number().min(0).max(99.999).default(0),
  validityDays: z.number().int().min(7).max(180).default(30),
  paymentTerms: z.string().min(3).max(500).default('30% DP, 50% progress, 20% BAST'),
  deliveryTerms: z.string().max(1000).optional(),
  exclusions: z.string().max(2000).optional(),
  lines: z.array(Line).min(1).max(200).optional(),
});

/** Field internal yang tidak boleh terlihat oleh role tanpa pricing.view_cost / customer. */
const INTERNAL_FIELDS = ['internalCost', 'floorPrice', 'grossMarginPct', 'scenarioId'] as const;
export function redactQuotation<T extends Record<string, unknown>>(q: T): Omit<T, (typeof INTERNAL_FIELDS)[number]> {
  const out: Record<string, unknown> = { ...q };
  for (const f of INTERNAL_FIELDS) delete out[f];
  return out as Omit<T, (typeof INTERNAL_FIELDS)[number]>;
}

async function recompute(tx: Tx, quotationId: string, taxRatePct: number) {
  const lines = await tx`SELECT amount FROM quotation_lines WHERE quotation_id = ${quotationId}`;
  const [q] = await tx`SELECT discount_pct, internal_cost FROM quotations WHERE id = ${quotationId}`;
  const subtotal = r2(lines.reduce((s, l) => s + Number(l.amount), 0));
  const discountAmount = r2(subtotal * Number(q.discountPct) / 100);
  const totalBeforeTax = r2(subtotal - discountAmount);
  const taxAmount = r2(totalBeforeTax * taxRatePct / 100);
  const cost = Number(q.internalCost);
  const margin = totalBeforeTax > 0 && cost > 0 ? r2(((totalBeforeTax - cost) / totalBeforeTax) * 100) : null;
  await tx`UPDATE quotations SET subtotal = ${subtotal}, discount_amount = ${discountAmount}, total_before_tax = ${totalBeforeTax},
           tax_rate = ${taxRatePct}, tax_amount = ${taxAmount}, grand_total = ${r2(totalBeforeTax + taxAmount)}, gross_margin_pct = ${margin}
           WHERE id = ${quotationId}`;
}

async function replaceLines(tx: Tx, tenantId: string, quotationId: string, lines: z.infer<typeof Line>[]) {
  await tx`DELETE FROM quotation_lines WHERE quotation_id = ${quotationId}`;
  let i = 1;
  for (const l of lines) {
    if (l.catalogItemId) {
      const [ci] = await tx`SELECT id FROM catalog_items WHERE id = ${l.catalogItemId} AND tenant_id = ${tenantId}`;
      if (!ci) throw notFound('Catalog item');
    }
    await tx`INSERT INTO quotation_lines (tenant_id, quotation_id, line_no, catalog_item_id, description, qty, unit, unit_price, amount)
             VALUES (${tenantId}, ${quotationId}, ${i++}, ${l.catalogItemId ?? null}, ${l.description}, ${l.qty}, ${l.unit}, ${l.unitPrice}, ${r2(l.qty * l.unitPrice)})`;
  }
}

async function snapshot(tx: Tx, tenantId: string, quotationId: string, userId: string, reason: string) {
  const [q] = await tx`SELECT * FROM quotations WHERE id = ${quotationId}`;
  const lines = await tx`SELECT line_no, description, qty, unit, unit_price, amount FROM quotation_lines WHERE quotation_id = ${quotationId} ORDER BY line_no`;
  await tx`INSERT INTO quotation_revisions (tenant_id, quotation_id, revision, row_version, snapshot, reason, created_by)
           VALUES (${tenantId}, ${quotationId}, ${q.revision}, ${q.rowVersion}, ${tx.json({ ...q, lines } as never)}, ${reason}, ${userId})`;
}

export async function loadQuotation(sql: FastifyInstance['sql'] | Tx, tenantId: string, id: string) {
  const [q] = await sql`SELECT q.*, c.legal_name AS customer_name, c.address AS customer_address, c.city AS customer_city, o.code AS opportunity_code,
      o.name AS opportunity_name, cu.full_name AS created_by_name, iu.full_name AS issued_by_name, iu.role AS issued_by_role
    FROM quotations q JOIN customers c ON c.id = q.customer_id JOIN opportunities o ON o.id = q.opportunity_id
    LEFT JOIN users cu ON cu.id = q.created_by LEFT JOIN users iu ON iu.id = q.issued_by
    WHERE q.id = ${id} AND q.tenant_id = ${tenantId}`;
  if (!q) throw notFound('Quotation');
  const lines = await sql`SELECT * FROM quotation_lines WHERE quotation_id = ${id} ORDER BY line_no`;
  return { ...q, lines } as Record<string, any> & { lines: Record<string, unknown>[] };
}

export async function quotationRoutes(app: FastifyInstance) {
  const sql = app.sql;
  const auth = { onRequest: [app.authenticate] };

  app.get('/api/v1/quotations', { ...auth, preValidation: requirePerm('quotation.read') }, async (req) => {
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    const rows = await sql`SELECT q.id, q.number, q.revision, q.title, q.status, q.grand_total, q.total_before_tax, q.discount_pct, q.gross_margin_pct,
        q.created_at, q.updated_at, c.legal_name AS customer_name, o.code AS opportunity_code
      FROM quotations q JOIN customers c ON c.id = q.customer_id JOIN opportunities o ON o.id = q.opportunity_id
      WHERE q.tenant_id = ${req.authUser.tenantId} ${q.status ? sql`AND q.status = ${q.status}` : sql``}
      ORDER BY q.updated_at DESC LIMIT 200`;
    return { items: can(req.authUser.role, 'pricing.view_cost') ? rows : rows.map((r) => redactQuotation(r)) };
  });

  app.post('/api/v1/quotations', { ...auth, preValidation: requirePerm('quotation.write') }, async (req, reply) => {
    const b = Terms.extend({ opportunityId: z.string().uuid(), scenarioId: z.string().uuid().optional() }).parse(req.body);
    const u = req.authUser;
    return idempotent(req, reply, 201, () => sql.begin(async (tx) => {
      const [o] = await tx`SELECT * FROM opportunities WHERE id = ${b.opportunityId} AND tenant_id = ${u.tenantId}`;
      if (!o) throw notFound('Opportunity');
      if (['WON', 'LOST'].includes(o.stage as string)) throw unprocessable(`Opportunity berstatus ${o.stage}`);
      let lines = b.lines;
      let internalCost = 0;
      let floor = 0;
      if (b.scenarioId) {
        const [s] = await tx`SELECT * FROM pricing_scenarios WHERE id = ${b.scenarioId} AND tenant_id = ${u.tenantId} AND opportunity_id = ${b.opportunityId}`;
        if (!s) throw notFound('Pricing scenario');
        const r = s.result as PriceResult;
        internalCost = r.boq.totalCost;
        floor = r.prices.floor;
        if (!lines) {
          lines = [{ description: `${o.name} — sesuai lingkup pada proposal teknis`, qty: 1, unit: 'paket', unitPrice: r.listPrice }];
        }
        if (b.discountPct === 0 && r.discountPct > 0) b.discountPct = r.discountPct;
      }
      if (!lines?.length) throw badRequest('Isi baris quotation atau pilih pricing scenario');
      const now = new Date();
      const n = await nextNumber(tx, u.tenantId, 'QUOTATION', String(now.getFullYear()));
      const number = `${String(n).padStart(3, '0')}/DEIT-RCS/${ROMAN[now.getMonth()]}/${now.getFullYear()}`;
      const [q] = await tx`INSERT INTO quotations (tenant_id, number, opportunity_id, customer_id, scenario_id, title, discount_pct, internal_cost, floor_price,
          validity_days, payment_terms, delivery_terms, exclusions, created_by)
        VALUES (${u.tenantId}, ${number}, ${o.id}, ${o.customerId}, ${b.scenarioId ?? null}, ${b.title}, ${b.discountPct}, ${internalCost}, ${floor},
          ${b.validityDays}, ${b.paymentTerms}, ${b.deliveryTerms ?? null}, ${b.exclusions ?? null}, ${u.id}) RETURNING id`;
      await replaceLines(tx, u.tenantId, q.id as string, lines);
      const policy = await loadCurrentPolicy<PricingPolicy>(tx, u.tenantId, 'PRICING');
      await recompute(tx, q.id as string, policy.params.taxRatePct);
      await snapshot(tx, u.tenantId, q.id as string, u.id, 'created');
      if (o.stage === 'SCOPING') {
        await tx`UPDATE opportunities SET stage = 'PROPOSAL', probability = 60, stage_changed_at = now(), updated_at = now() WHERE id = ${o.id}`;
        await tx`INSERT INTO opportunity_stage_history (tenant_id, opportunity_id, from_stage, to_stage, changed_by) VALUES (${u.tenantId}, ${o.id}, 'SCOPING', 'PROPOSAL', ${u.id})`;
      }
      const full = await loadQuotation(tx, u.tenantId, q.id as string);
      await audit(tx, u, 'quotation.create', 'quotation', q.id as string, null, { number, grandTotal: full.grandTotal }, req.ip);
      return can(u.role, 'pricing.view_cost') ? full : redactQuotation(full);
    }));
  });

  app.get('/api/v1/quotations/:id', { ...auth, preValidation: requirePerm('quotation.read') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = await loadQuotation(sql, req.authUser.tenantId, id);
    const approvals = await sql`SELECT ar.*, (SELECT json_agg(s ORDER BY s.seq) FROM (SELECT st.seq, st.level_label, st.status, st.decided_at, u.full_name AS decided_by_name
        FROM approval_steps st LEFT JOIN users u ON u.id = st.decided_by WHERE st.request_id = ar.id) s) AS steps
      FROM approval_requests ar WHERE ar.tenant_id = ${req.authUser.tenantId} AND ar.entity_type = 'quotation' AND ar.entity_id = ${id} ORDER BY ar.created_at DESC`;
    const base = can(req.authUser.role, 'pricing.view_cost') ? q : redactQuotation(q);
    return { ...base, approvals };
  });

  /** Edit. Perubahan setelah APPROVED → kembali DRAFT, approval lama SUPERSEDED, revisi naik. */
  app.put('/api/v1/quotations/:id', { ...auth, preValidation: requirePerm('quotation.write') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = Terms.partial().extend({ rowVersion: z.number().int() }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const [q] = await tx`SELECT * FROM quotations WHERE id = ${id} AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!q) throw notFound('Quotation');
      if (q.rowVersion !== b.rowVersion) throw conflict('Quotation telah diubah pengguna lain — muat ulang', { currentRowVersion: q.rowVersion });
      if (!['DRAFT', 'REVISION_REQUESTED', 'APPROVED', 'REJECTED'].includes(q.status as string)) {
        throw unprocessable(`Quotation berstatus ${q.status} tidak dapat diedit${q.status === 'ISSUED' || q.status === 'SENT' ? ' — buat revisi' : ''}`);
      }
      const wasApproved = q.status === 'APPROVED';
      if (wasApproved) await supersedeOpenRequests(tx, u.tenantId, 'quotation', id);
      const { lines, rowVersion: _rv, ...terms } = b;
      const cols = Object.keys(terms).filter((k) => (terms as Record<string, unknown>)[k] !== undefined);
      if (cols.length) await tx`UPDATE quotations SET ${tx(terms as Record<string, unknown>, cols)} WHERE id = ${id}`;
      if (lines) await replaceLines(tx, u.tenantId, id, lines);
      const policy = await loadCurrentPolicy<PricingPolicy>(tx, u.tenantId, 'PRICING');
      await recompute(tx, id, policy.params.taxRatePct);
      const newRevision = wasApproved || q.status === 'REJECTED' || q.sentAt ? (q.revision as number) + 1 : (q.revision as number);
      await tx`UPDATE quotations SET status = 'DRAFT', revision = ${newRevision}, row_version = row_version + 1,
               sent_at = NULL, issued_at = NULL, issued_by = NULL, updated_at = now() WHERE id = ${id}`;
      await snapshot(tx, u.tenantId, id, u.id, wasApproved ? 'edited after approval — re-approval required' : 'edited');
      await audit(tx, u, 'quotation.update', 'quotation', id, { status: q.status, rowVersion: q.rowVersion }, { changed: [...cols, ...(lines ? ['lines'] : [])], reapprovalRequired: wasApproved }, req.ip);
      const full = await loadQuotation(tx, u.tenantId, id);
      return can(u.role, 'pricing.view_cost') ? full : redactQuotation(full);
    });
  });

  app.post('/api/v1/quotations/:id/submit', { ...auth, preValidation: requirePerm('quotation.submit') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    return idempotent(req, reply, 200, () => sql.begin(async (tx) => {
      const [q] = await tx`SELECT * FROM quotations WHERE id = ${id} AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!q) throw notFound('Quotation');
      if (!['DRAFT', 'REVISION_REQUESTED'].includes(q.status as string)) throw unprocessable(`Quotation berstatus ${q.status} tidak dapat diajukan`);
      const pol = await loadCurrentPolicy<PricingPolicy>(tx, u.tenantId, 'PRICING');
      const total = Number(q.totalBeforeTax);
      const cost = Number(q.internalCost);
      const margin = q.grossMarginPct === null ? null : Number(q.grossMarginPct);
      const metrics = {
        grandTotalExTax: total,
        discountPct: Number(q.discountPct),
        marginHold: cost > 0 && margin !== null && margin < pol.params.marginHold * 100 ? 1 : 0,
        belowFloor: Number(q.floorPrice) > 0 && total < Number(q.floorPrice) ? 1 : 0,
      };
      const warnings: string[] = [];
      if (cost === 0) warnings.push('Quotation tanpa pricing scenario/BoQ — margin tidak dapat diverifikasi');
      else if (margin !== null && margin < pol.params.marginWarning * 100) warnings.push(`Gross margin ${margin}% di bawah target ${pol.params.marginWarning * 100}%`);
      const { request, evaluation, policy } = await createApprovalRequest(tx, {
        tenantId: u.tenantId, entityType: 'quotation', entityId: id, entityVersion: q.rowVersion as number, requestedBy: u.id, metrics,
        summary: { title: `${q.number} — ${q.title}`, number: q.number, totalBeforeTax: total, discountPct: Number(q.discountPct),
          grossMarginPct: margin, internalCost: cost, floorPrice: Number(q.floorPrice), warnings },
      });
      await tx`UPDATE quotations SET status = 'IN_APPROVAL', updated_at = now() WHERE id = ${id}`;
      await audit(tx, u, 'quotation.submit', 'quotation', id, { status: q.status }, { status: 'IN_APPROVAL', requiredLevel: evaluation.requiredLevel, reasons: evaluation.reasons }, req.ip);
      return { quotationId: id, status: 'IN_APPROVAL', approvalRequestId: request.id, requiredLevel: evaluation.requiredLevel,
        steps: evaluation.steps, reasons: evaluation.reasons, policy: `${policy.code} v${policy.version}`, policyStatus: policy.status, warnings };
    }));
  });

  /** Terbitkan: hanya jika approval APPROVED untuk row_version yang sama (dicek server & DB lock). */
  app.post('/api/v1/quotations/:id/issue', { ...auth, preValidation: requirePerm('quotation.submit') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    return idempotent(req, reply, 200, () => sql.begin(async (tx) => {
      const [q] = await tx`SELECT * FROM quotations WHERE id = ${id} AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!q) throw notFound('Quotation');
      if (q.status !== 'APPROVED') throw unprocessable(`Quotation belum disetujui (status ${q.status}) — tidak dapat diterbitkan`);
      const [ar] = await tx`SELECT * FROM approval_requests WHERE tenant_id = ${u.tenantId} AND entity_type = 'quotation' AND entity_id = ${id}
                            AND status = 'APPROVED' AND entity_version = ${q.rowVersion} ORDER BY decided_at DESC LIMIT 1`;
      if (!ar) throw unprocessable('Approval lengkap untuk versi quotation ini tidak ditemukan');
      const [pending] = await tx`SELECT count(*)::int AS n FROM approval_steps WHERE request_id = ${ar.id} AND status <> 'APPROVED'`;
      if (pending.n > 0) throw unprocessable('Masih ada step approval yang belum selesai');
      await tx`UPDATE quotations SET status = 'ISSUED', issued_at = now(), issued_by = ${u.id}, updated_at = now() WHERE id = ${id}`;
      await snapshot(tx, u.tenantId, id, u.id, 'issued');
      await audit(tx, u, 'quotation.issue', 'quotation', id, { status: 'APPROVED' }, { status: 'ISSUED', approvalRequestId: ar.id }, req.ip);
      return { id, status: 'ISSUED', number: q.number };
    }));
  });

  app.post('/api/v1/quotations/:id/mark-sent', { ...auth, preValidation: requirePerm('quotation.submit') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ channel: z.enum(['portal', 'email', 'hand_delivery', 'procurement_portal']).default('portal') }).parse(req.body ?? {});
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const [q] = await tx`SELECT * FROM quotations WHERE id = ${id} AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!q) throw notFound('Quotation');
      if (q.status !== 'ISSUED') throw unprocessable('Hanya quotation ISSUED yang dapat dikirim');
      await tx`UPDATE quotations SET status = 'SENT', sent_at = now(), updated_at = now() WHERE id = ${id}`;
      await tx`UPDATE opportunities SET stage = 'NEGOTIATION', probability = 80, stage_changed_at = now(), updated_at = now()
               WHERE id = ${q.opportunityId} AND stage = 'PROPOSAL'`;
      const portalUsers = await tx`SELECT id FROM users WHERE tenant_id = ${u.tenantId} AND customer_id = ${q.customerId} AND is_active`;
      await notify(tx, u.tenantId, portalUsers.map((x) => x.id as string), 'QUOTATION_RECEIVED', `Penawaran ${q.number}`, q.title as string, `/portal/quotations/${id}`);
      await audit(tx, u, 'quotation.sent', 'quotation', id, { status: 'ISSUED' }, { status: 'SENT', channel: b.channel }, req.ip);
      return { id, status: 'SENT' };
    });
  });

  app.get('/api/v1/quotations/:id/revisions', { ...auth, preValidation: requirePerm('quotation.read') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const rows = await sql`SELECT r.id, r.revision, r.row_version, r.reason, r.created_at, u.full_name AS by_name, r.snapshot
      FROM quotation_revisions r LEFT JOIN users u ON u.id = r.created_by WHERE r.tenant_id = ${req.authUser.tenantId} AND r.quotation_id = ${id} ORDER BY r.id`;
    const showCost = can(req.authUser.role, 'pricing.view_cost');
    return { items: rows.map((r) => ({ ...r, snapshot: showCost ? r.snapshot : redactQuotation(r.snapshot as Record<string, unknown>) })) };
  });

  /** Dokumen surat penawaran eksternal (HTML print-ready; tanpa data internal). */
  app.get('/api/v1/quotations/:id/document', { ...auth, preValidation: requirePerm('quotation.read') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = await loadQuotation(sql, req.authUser.tenantId, id);
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    return renderQuotationHtml(redactQuotation(q) as never);
  });

  /* ───── Approval Decision Center ───── */
  /** approval.read ATAU penerima delegasi aktif */
  const approvalAccess = async (req: import('fastify').FastifyRequest) => {
    if (can(req.authUser.role, 'approval.read')) return;
    const { delegationId } = await effectiveLevel(sql, req.authUser);
    if (!delegationId) throw forbidden('Tidak memiliki akses approval');
  };
  const decideAccess = async (req: import('fastify').FastifyRequest) => {
    if (can(req.authUser.role, 'approval.decide')) return;
    const { delegationId } = await effectiveLevel(sql, req.authUser);
    if (!delegationId) throw forbidden('Tidak memiliki kewenangan approval');
  };

  app.get('/api/v1/approvals', { ...auth, preValidation: approvalAccess }, async (req) => {
    const q = z.object({ scope: z.enum(['mine', 'all']).default('mine'), status: z.string().default('PENDING') }).parse(req.query);
    const u = req.authUser;
    const { level: myLevel } = await effectiveLevel(sql, u);
    const rows = await sql`
      SELECT ar.id, ar.entity_type, ar.entity_id, ar.status, ar.required_level, ar.reasons, ar.summary, ar.created_at, ar.due_at,
             ru.full_name AS requested_by_name, ar.requested_by,
             st.seq AS current_seq, st.level AS current_level, st.level_label AS current_level_label,
             (ar.due_at < now()) AS overdue
      FROM approval_requests ar JOIN users ru ON ru.id = ar.requested_by
      LEFT JOIN LATERAL (SELECT * FROM approval_steps s WHERE s.request_id = ar.id AND s.status = 'PENDING' ORDER BY s.seq LIMIT 1) st ON true
      WHERE ar.tenant_id = ${u.tenantId} AND ar.status = ${q.status}
        ${q.scope === 'mine' && q.status === 'PENDING' ? sql`AND st.level <= ${myLevel} AND ar.requested_by <> ${u.id}` : sql``}
      ORDER BY overdue DESC, ar.due_at ASC LIMIT 200`;
    const showCost = can(u.role, 'pricing.view_cost');
    return {
      items: rows.map((r) => {
        if (showCost) return r;
        const s = { ...(r.summary as Record<string, unknown>) };
        delete s.internalCost; delete s.floorPrice; delete s.grossMarginPct;
        return { ...r, summary: s };
      }),
    };
  });

  app.get('/api/v1/approvals/:id', { ...auth, preValidation: approvalAccess }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    const [ar] = await sql`SELECT ar.*, ru.full_name AS requested_by_name, p.code AS policy_code, p.version AS policy_version, p.status AS policy_status
      FROM approval_requests ar JOIN users ru ON ru.id = ar.requested_by JOIN policies p ON p.id = ar.policy_id
      WHERE ar.id = ${id} AND ar.tenant_id = ${u.tenantId}`;
    if (!ar) throw notFound('Approval request');
    const steps = await sql`SELECT s.*, u.full_name AS decided_by_name FROM approval_steps s LEFT JOIN users u ON u.id = s.decided_by WHERE s.request_id = ${id} ORDER BY s.seq`;
    const decisions = await sql`SELECT d.*, u.full_name AS decided_by_name FROM approval_decisions d JOIN users u ON u.id = d.decided_by WHERE d.request_id = ${id} ORDER BY d.id`;
    let entity: unknown = null;
    if (ar.entityType === 'quotation') {
      const q = await loadQuotation(sql, u.tenantId, ar.entityId as string);
      entity = can(u.role, 'pricing.view_cost') ? q : redactQuotation(q);
    }
    if (ar.entityType === 'bid_assessment') {
      const [b] = await sql`SELECT b.*, t.id AS tender_id, t.code AS tender_code, t.title AS tender_title, t.procuring_entity, t.hps_value, t.submission_deadline
                            FROM bid_assessments b JOIN tenders t ON t.id = b.tender_id WHERE b.id = ${ar.entityId} AND b.tenant_id = ${u.tenantId}`;
      entity = { kind: 'bid_assessment', ...b };
    }
    if (ar.entityType === 'contract') {
      const [c] = await sql`SELECT c.*, cu.legal_name AS customer_name FROM contracts c JOIN customers cu ON cu.id = c.customer_id WHERE c.id = ${ar.entityId} AND c.tenant_id = ${u.tenantId}`;
      entity = c ? { kind: 'contract', ...c } : null;
    }
    if (ar.entityType === 'flexguard_wallet' || ar.entityType === 'service_request') {
      entity = { kind: ar.entityType, action: (ar.summary as Record<string, unknown>).action ?? null };
    }
    return { request: ar, steps, decisions, entity };
  });

  app.post('/api/v1/approvals/:id/decide', { ...auth, preValidation: decideAccess }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ decision: z.enum(['APPROVE', 'REJECT', 'REQUEST_REVISION']), comment: z.string().max(2000).optional() })
      .refine((x) => x.decision === 'APPROVE' || (x.comment && x.comment.trim().length >= 5), { message: 'Alasan wajib diisi untuk Reject / Request Revision' })
      .parse(req.body);
    const u = req.authUser;
    requireFreshApprovalMfa(u);
    return idempotent(req, reply, 200, () => decide(sql, u, id, b.decision, b.comment, req.ip, async (tx, ar, finalStatus) => {
      if (ar.entityType === 'bid_assessment') { await onBidDecision(tx, u, ar, finalStatus); return; }
      const h = approvalHandler(ar.entityType as string);
      if (h) { await h(tx, u, ar, finalStatus); return; }
      if (ar.entityType !== 'quotation') return;
      const qs = finalStatus === 'APPROVED' ? 'APPROVED' : finalStatus === 'REJECTED' ? 'REJECTED' : 'REVISION_REQUESTED';
      await tx`UPDATE quotations SET status = ${qs}, updated_at = now() WHERE id = ${ar.entityId as string} AND tenant_id = ${u.tenantId}`;
    }));
  });

  /* ───── Customer portal (customer_user) ───── */
  const portal = { onRequest: [app.authenticate], preValidation: requirePerm('portal.access') };
  const portalStatuses = ['SENT', 'ACCEPTED', 'REJECTED', 'REVISION_REQUESTED', 'EXPIRED'];

  app.get('/api/v1/portal/quotations', portal, async (req) => {
    const u = req.authUser;
    if (!u.customerId) throw forbidden('Akun portal belum terhubung ke customer');
    const rows = await sql`SELECT id, number, revision, title, status, grand_total, total_before_tax, tax_amount, sent_at, validity_days, customer_responded_at
      FROM quotations WHERE tenant_id = ${u.tenantId} AND customer_id = ${u.customerId}
        AND (status IN ${sql(portalStatuses)} OR (status = 'REVISION_REQUESTED' AND sent_at IS NOT NULL))
      ORDER BY sent_at DESC NULLS LAST`;
    return { items: rows };
  });

  app.get('/api/v1/portal/quotations/:id', portal, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    const q = await loadQuotation(sql, u.tenantId, id);
    if (q.customerId !== u.customerId || !q.sentAt) throw notFound('Quotation');
    const out = redactQuotation(q) as Record<string, unknown>;
    delete out.createdByName;
    await audit(sql, u, 'portal.quotation_viewed', 'quotation', id, null, null, req.ip);
    return out;
  });

  app.get('/api/v1/portal/quotations/:id/document', portal, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    const q = await loadQuotation(sql, u.tenantId, id);
    if (q.customerId !== u.customerId || !q.sentAt) throw notFound('Quotation');
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    return renderQuotationHtml(redactQuotation(q) as never);
  });

  /**
   * Respons customer. Catatan hukum: klik "Terima" di portal adalah acceptance komersial
   * yang tercatat (timestamp + audit), BUKAN tanda tangan elektronik tersertifikasi.
   * Penandatanganan kontrak memakai penyedia TTE tersertifikasi pada Phase 3.
   */
  app.post('/api/v1/portal/quotations/:id/respond', portal, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ response: z.enum(['ACCEPT', 'REJECT', 'REQUEST_REVISION']), note: z.string().max(2000).optional(),
      acknowledgement: z.literal(true).optional() }).parse(req.body);
    const u = req.authUser;
    if (b.response === 'ACCEPT' && !b.acknowledgement) throw badRequest('Konfirmasi pernyataan penerimaan wajib dicentang');
    return idempotent(req, reply, 200, () => sql.begin(async (tx) => {
      const [q] = await tx`SELECT * FROM quotations WHERE id = ${id} AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!q || q.customerId !== u.customerId || !q.sentAt) throw notFound('Quotation');
      if (q.status !== 'SENT') throw unprocessable(`Quotation berstatus ${q.status} — tidak dapat direspons`);
      const expires = new Date(q.sentAt as string);
      expires.setDate(expires.getDate() + (q.validityDays as number));
      if (new Date() > expires) {
        await tx`UPDATE quotations SET status = 'EXPIRED', updated_at = now() WHERE id = ${id}`;
        throw unprocessable('Masa berlaku penawaran telah habis');
      }
      const status = b.response === 'ACCEPT' ? 'ACCEPTED' : b.response === 'REJECT' ? 'REJECTED' : 'REVISION_REQUESTED';
      await tx`UPDATE quotations SET status = ${status}, customer_response = ${b.note ?? null}, customer_responded_at = now(), updated_at = now() WHERE id = ${id}`;
      const internal = await tx`SELECT id FROM users WHERE tenant_id = ${u.tenantId} AND is_active AND (id = ${q.createdBy} OR role IN ('legal','sales_manager'))`;
      await notify(tx, u.tenantId, internal.map((x) => x.id as string), 'CUSTOMER_RESPONSE',
        `${q.number}: ${status}${status === 'ACCEPTED' ? ' — siap proses contracting' : ''}`, b.note ?? '', `/quotations/${id}`);
      await audit(tx, u, `portal.quotation_${b.response.toLowerCase()}`, 'quotation', id, { status: 'SENT' },
        { status, note: b.note, acceptanceType: 'commercial_acceptance_not_certified_esignature' }, req.ip);
      return { id, status, contractingHandover: status === 'ACCEPTED' ? 'PENDING_CONTRACT' : null };
    }));
  });
}
