import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, nextNumber, requirePerm } from '../../lib/context.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { APPROVAL_LEVEL, LEVEL_LABEL } from '../../lib/rbac.js';
import { effectiveLevel, escalateOverdue } from '../approvals/engine.js';
import { tenderDeadlineReminders } from '../tenders/jobs.js';

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function vendorRoutes(app: FastifyInstance) {
  const sql = app.sql;
  const auth = { onRequest: [app.authenticate] };

  /* ───── Vendor & distributor ───── */
  app.get('/api/v1/vendors', { ...auth, preValidation: requirePerm('vendor.read') }, async (req) => {
    const rows = await sql`SELECT v.*, (SELECT count(*)::int FROM vendor_price_items p WHERE p.vendor_id = v.id AND (p.valid_until IS NULL OR p.valid_until >= current_date)) AS active_prices,
        CASE WHEN v.authorization_status = 'AUTHORIZED' AND v.authorized_until < current_date THEN 'EXPIRED' ELSE v.authorization_status END AS effective_authorization
      FROM vendors v WHERE v.tenant_id = ${req.authUser.tenantId} ORDER BY v.name`;
    return { items: rows };
  });

  app.post('/api/v1/vendors', { ...auth, preValidation: requirePerm('vendor.write') }, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(2).max(200), vendorType: z.enum(['vendor', 'distributor', 'vendor_distributor', 'subcontractor']),
      partnerLevel: z.string().max(60).optional(), authorizationStatus: z.enum(['NONE', 'REGISTERED', 'AUTHORIZED']).default('NONE'),
      authorizedUntil: z.string().date().optional(), contactName: z.string().max(150).optional(), contactEmail: z.string().email().optional(), notes: z.string().max(2000).optional() })
      .refine((x) => x.authorizationStatus !== 'AUTHORIZED' || x.authorizedUntil, { message: 'Tanggal berlaku otorisasi wajib untuk status AUTHORIZED' }).parse(req.body);
    const u = req.authUser;
    const [dup] = await sql`SELECT id FROM vendors WHERE tenant_id = ${u.tenantId} AND lower(name) = lower(${b.name})`;
    if (dup) throw conflict('Vendor sudah terdaftar');
    const row = await sql.begin(async (tx) => {
      const n = await nextNumber(tx, u.tenantId, 'VENDOR', 'ALL');
      const [v] = await tx`INSERT INTO vendors ${tx({ ...b, tenantId: u.tenantId, code: `VND-${String(n).padStart(4, '0')}`, createdBy: u.id } as Record<string, unknown>)} RETURNING *`;
      await audit(tx, u, 'vendor.create', 'vendor', v.id as string, null, v, req.ip);
      return v;
    });
    reply.code(201);
    return row;
  });

  app.get('/api/v1/vendors/:id/prices', { ...auth, preValidation: requirePerm('vendor.read') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const rows = await sql`SELECT p.*, (p.unit_cost * p.fx_rate_to_idr) AS unit_cost_idr, (p.valid_until IS NULL OR p.valid_until >= current_date) AS is_valid
                           FROM vendor_price_items p WHERE p.vendor_id = ${id} AND p.tenant_id = ${req.authUser.tenantId} ORDER BY p.sku, p.valid_from DESC`;
    return { items: rows };
  });

  /** Distributor quotation / price list (append; harga lama tetap tersimpan untuk histori). */
  app.post('/api/v1/vendors/:id/prices', { ...auth, preValidation: requirePerm('vendor.write') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ items: z.array(z.object({ sku: z.string().min(1).max(80), description: z.string().min(2).max(500), unit: z.string().min(1).max(40),
      currency: z.string().length(3).default('IDR'), unitCost: z.number().min(0), fxRateToIdr: z.number().positive().default(1), isSpecialBid: z.boolean().default(false),
      validFrom: z.string().date(), validUntil: z.string().date().optional(), catalogItemId: z.string().uuid().optional(), sourceRef: z.string().max(200).optional() })).min(1).max(500) }).parse(req.body);
    const u = req.authUser;
    const [v] = await sql`SELECT id FROM vendors WHERE id = ${id} AND tenant_id = ${u.tenantId}`;
    if (!v) throw notFound('Vendor');
    for (const it of b.items) if (it.currency !== 'IDR' && it.fxRateToIdr === 1) throw badRequest(`Kurs ke IDR wajib untuk ${it.sku} (${it.currency})`);
    const rows = await sql.begin(async (tx) => {
      const out = [];
      for (const it of b.items) {
        const [row] = await tx`INSERT INTO vendor_price_items ${tx({ ...it, tenantId: u.tenantId, vendorId: id, createdBy: u.id } as Record<string, unknown>)} RETURNING *`;
        out.push(row);
      }
      await audit(tx, u, 'vendor.price_upload', 'vendor', id, null, { count: out.length }, req.ip);
      return out;
    });
    reply.code(201);
    return { items: rows };
  });

  /** Solution/BOM builder: harga vendor terbaru yang berlaku × qty → biaya IDR, harga jual pada target margin. */
  app.post('/api/v1/pricing/bom', { ...auth, preValidation: requirePerm('pricing.view_cost') }, async (req) => {
    const b = z.object({ lines: z.array(z.object({ priceItemId: z.string().uuid(), qty: z.number().positive(), periods: z.number().int().min(1).max(60).default(1) })).min(1).max(100),
      targetMarginPct: z.number().min(0).max(90).default(20) }).parse(req.body);
    const u = req.authUser;
    const out = [];
    for (const l of b.lines) {
      const [p] = await sql`SELECT p.*, v.name AS vendor_name, v.authorization_status, v.authorized_until FROM vendor_price_items p JOIN vendors v ON v.id = p.vendor_id
                            WHERE p.id = ${l.priceItemId} AND p.tenant_id = ${u.tenantId}`;
      if (!p) throw notFound('Item harga vendor');
      const warnings: string[] = [];
      if (p.validUntil && new Date(p.validUntil as string) < new Date()) warnings.push('Harga vendor kedaluwarsa — minta quotation baru');
      if (p.authorizationStatus !== 'AUTHORIZED' || (p.authorizedUntil && new Date(p.authorizedUntil as string) < new Date())) warnings.push('Otorisasi vendor tidak aktif');
      if (p.isSpecialBid) warnings.push('Special bid price — hanya untuk deal terdaftar');
      const unitIdr = r2(Number(p.unitCost) * Number(p.fxRateToIdr));
      const cost = r2(unitIdr * l.qty * l.periods);
      const sell = r2(cost / (1 - b.targetMarginPct / 100));
      out.push({ priceItemId: p.id, sku: p.sku, description: p.description, vendor: p.vendorName, unit: p.unit, qty: l.qty, periods: l.periods,
        unitCostIdr: unitIdr, cost, sellingPrice: sell, unitSellingPrice: r2(sell / (l.qty * l.periods)), warnings });
    }
    const totalCost = r2(out.reduce((s, x) => s + x.cost, 0));
    const totalSell = r2(out.reduce((s, x) => s + x.sellingPrice, 0));
    return { lines: out, totalCost, totalSellingPrice: totalSell, grossMarginPct: totalSell ? r2(((totalSell - totalCost) / totalSell) * 100) : 0,
      note: 'Masukkan totalCost sebagai komponen D (third party) pada pricing scenario agar margin keseluruhan terhitung.' };
  });

  /* ───── Delegation of authority (berjangka) ───── */
  app.get('/api/v1/approvals/delegations', { ...auth }, async (req) => {
    const u = req.authUser;
    const rows = await sql`SELECT d.*, a.full_name AS delegator_name, b.full_name AS delegate_name,
        (d.revoked_at IS NULL AND now() BETWEEN d.valid_from AND d.valid_until) AS active
      FROM approval_delegations d JOIN users a ON a.id = d.delegator_id JOIN users b ON b.id = d.delegate_id
      WHERE d.tenant_id = ${u.tenantId} AND (d.delegator_id = ${u.id} OR d.delegate_id = ${u.id} OR ${['company_admin', 'auditor', 'director'].includes(u.role)})
      ORDER BY d.created_at DESC LIMIT 100`;
    return { items: rows };
  });

  app.post('/api/v1/approvals/delegations', { ...auth }, async (req, reply) => {
    const b = z.object({ delegateId: z.string().uuid(), level: z.number().int().min(1).max(3).optional(), validFrom: z.string().datetime({ offset: true }),
      validUntil: z.string().datetime({ offset: true }), reason: z.string().min(5).max(500) }).parse(req.body);
    const u = req.authUser;
    const own = APPROVAL_LEVEL[u.role] ?? 0;
    if (!own) throw forbidden('Hanya pemegang kewenangan approval yang dapat mendelegasikan');
    const level = b.level ?? own;
    if (level > own) throw forbidden(`Tidak dapat mendelegasikan melebihi level sendiri (${LEVEL_LABEL[own]})`);
    const from = new Date(b.validFrom); const until = new Date(b.validUntil);
    if (until <= from) throw badRequest('validUntil harus setelah validFrom');
    if ((until.getTime() - from.getTime()) / 864e5 > 30) throw unprocessable('Delegasi maksimal 30 hari');
    if (until < new Date()) throw badRequest('Periode delegasi sudah lewat');
    const [d] = await sql`SELECT id, role, is_active FROM users WHERE id = ${b.delegateId} AND tenant_id = ${u.tenantId}`;
    if (!d || !d.isActive) throw notFound('Penerima delegasi');
    if (['customer_user', 'partner_user'].includes(d.role as string)) throw forbidden('Delegasi hanya ke pengguna internal');
    if (d.id === u.id) throw badRequest('Tidak dapat mendelegasikan ke diri sendiri');
    const [row] = await sql`INSERT INTO approval_delegations (tenant_id, delegator_id, delegate_id, level, valid_from, valid_until, reason)
                            VALUES (${u.tenantId}, ${u.id}, ${b.delegateId}, ${level}, ${b.validFrom}, ${b.validUntil}, ${b.reason}) RETURNING *`;
    await audit(sql, u, 'approval.delegation_create', 'approval_delegation', row.id as string, null, row, req.ip);
    reply.code(201);
    return row;
  });

  app.post('/api/v1/approvals/delegations/:id/revoke', { ...auth }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    const [row] = await sql`UPDATE approval_delegations SET revoked_at = now() WHERE id = ${id} AND tenant_id = ${u.tenantId}
                            AND (delegator_id = ${u.id} OR ${u.role === 'company_admin'}) AND revoked_at IS NULL RETURNING *`;
    if (!row) throw notFound('Delegasi aktif');
    await audit(sql, u, 'approval.delegation_revoke', 'approval_delegation', id, null, { revokedAt: row.revokedAt }, req.ip);
    return row;
  });

  app.get('/api/v1/approvals/my-authority', { ...auth }, async (req) => effectiveLevel(sql, req.authUser));

  /* ───── Jobs (SLA escalation & tender deadline). Juga dijalankan scheduler internal. ───── */
  app.post('/api/v1/admin/jobs/run', { ...auth, preValidation: requirePerm('jobs.run') }, async (req) => {
    const { runScheduledJobs } = await import('../../scheduler.js');
    const res = await runScheduledJobs(sql) as Record<string, any>;
    await audit(sql, req.authUser, 'jobs.run', 'system', null, null, res, req.ip);
    return res;
  });
}
