import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../../lib/context.js';
import { can } from '../../lib/rbac.js';

/** Semua KPI dihitung dari transaksi riil; setiap KPI menyertakan definisi (data dictionary). */
export async function dashboardRoutes(app: FastifyInstance) {
  const sql = app.sql;
  const auth = { onRequest: [app.authenticate] };

  app.get('/api/v1/dashboard', { ...auth, preValidation: requirePerm('dashboard.read') }, async (req) => {
    const t = req.authUser.tenantId;
    const showCost = can(req.authUser.role, 'pricing.view_cost');
    const [pipe] = await sql`SELECT coalesce(sum(amount_estimate),0) AS total, coalesce(sum(amount_estimate*probability/100.0),0) AS weighted, count(*)::int AS n
                             FROM opportunities WHERE tenant_id = ${t} AND stage NOT IN ('WON','LOST')`;
    const [wl] = await sql`SELECT count(*) FILTER (WHERE stage='WON')::int AS won, count(*) FILTER (WHERE stage='LOST')::int AS lost FROM opportunities WHERE tenant_id = ${t}`;
    const byStage = await sql`SELECT stage, count(*)::int AS n, coalesce(sum(amount_estimate),0) AS value FROM opportunities WHERE tenant_id = ${t} GROUP BY stage`;
    const byService = await sql`SELECT service_category, count(*)::int AS n, coalesce(sum(amount_estimate),0) AS value FROM opportunities
                                WHERE tenant_id = ${t} AND stage NOT IN ('LOST') GROUP BY service_category ORDER BY value DESC`;
    const [q] = await sql`SELECT count(*) FILTER (WHERE status='ACCEPTED')::int AS accepted, coalesce(sum(total_before_tax) FILTER (WHERE status='ACCEPTED'),0) AS accepted_value,
                             count(*) FILTER (WHERE status IN ('ISSUED','SENT'))::int AS outstanding,
                             avg(gross_margin_pct) FILTER (WHERE status IN ('APPROVED','ISSUED','SENT','ACCEPTED') AND gross_margin_pct IS NOT NULL) AS avg_margin
                          FROM quotations WHERE tenant_id = ${t}`;
    const [turn] = await sql`SELECT avg(extract(epoch FROM decided_at - created_at)/3600)::numeric(10,1) AS approval_hours,
                                    count(*) FILTER (WHERE status='PENDING')::int AS pending, count(*) FILTER (WHERE status='PENDING' AND due_at < now())::int AS overdue
                             FROM approval_requests WHERE tenant_id = ${t}`;
    const [qt] = await sql`SELECT avg(extract(epoch FROM q.issued_at - o.created_at)/86400)::numeric(10,1) AS days
                           FROM quotations q JOIN opportunities o ON o.id = q.opportunity_id WHERE q.tenant_id = ${t} AND q.issued_at IS NOT NULL`;
    const closed = wl.won + wl.lost;
    return {
      kpis: [
        { key: 'total_pipeline', label: 'Total pipeline', value: Number(pipe.total), unit: 'IDR', definition: 'Σ amount_estimate opportunity dengan stage ≠ WON/LOST', drill: '/pipeline' },
        { key: 'weighted_pipeline', label: 'Weighted pipeline', value: Math.round(Number(pipe.weighted)), unit: 'IDR', definition: 'Σ amount_estimate × probability', drill: '/pipeline' },
        { key: 'win_rate', label: 'Win rate', value: closed ? Math.round((wl.won / closed) * 1000) / 10 : null, unit: '%', definition: 'WON / (WON + LOST)', drill: '/pipeline?stage=WON' },
        { key: 'accepted_value', label: 'Nilai quotation diterima', value: Number(q.acceptedValue), unit: 'IDR', definition: 'Σ total_before_tax quotation ACCEPTED', drill: '/quotations?status=ACCEPTED' },
        { key: 'outstanding_quotes', label: 'Quotation menunggu respons', value: q.outstanding, unit: 'count', definition: 'Quotation ISSUED/SENT', drill: '/quotations?status=SENT' },
        ...(showCost ? [{ key: 'avg_margin', label: 'Rata-rata gross margin', value: q.avgMargin === null ? null : Math.round(Number(q.avgMargin) * 10) / 10, unit: '%', definition: '(harga ex-PPN − biaya internal)/harga, quotation APPROVED+', drill: '/quotations' }] : []),
        { key: 'approval_turnaround', label: 'Approval turnaround', value: turn.approvalHours === null ? null : Number(turn.approvalHours), unit: 'jam', definition: 'Rata-rata decided_at − created_at', drill: '/approvals?scope=all' },
        { key: 'pending_approvals', label: 'Approval tertunda (overdue)', value: turn.pending, secondary: turn.overdue, unit: 'count', definition: 'approval_requests PENDING; overdue = melewati SLA', drill: '/approvals' },
        { key: 'quotation_turnaround', label: 'Quotation turnaround', value: qt.days === null ? null : Number(qt.days), unit: 'hari', definition: 'Rata-rata issued_at − opportunity.created_at', drill: '/quotations' },
      ],
      byStage, byService,
    };
  });

  app.get('/api/v1/audit', { ...auth, preValidation: requirePerm('audit.read') }, async (req) => {
    const q = z.object({ entityType: z.string().optional(), entityId: z.string().optional(), before: z.coerce.number().optional() }).parse(req.query);
    const rows = await sql`SELECT a.*, u.full_name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.tenant_id = ${req.authUser.tenantId}
        ${q.entityType ? sql`AND a.entity_type = ${q.entityType}` : sql``}
        ${q.entityId ? sql`AND a.entity_id = ${q.entityId}` : sql``}
        ${q.before ? sql`AND a.id < ${q.before}` : sql``}
      ORDER BY a.id DESC LIMIT 100`;
    return { items: rows, nextBefore: rows.length === 100 ? rows[99].id : null };
  });

  app.get('/api/v1/notifications', auth, async (req) => {
    const rows = await sql`SELECT * FROM notifications WHERE user_id = ${req.authUser.id} ORDER BY created_at DESC LIMIT 50`;
    return { items: rows, unread: rows.filter((r) => !r.readAt).length };
  });

  app.post('/api/v1/notifications/read', auth, async (req) => {
    await sql`UPDATE notifications SET read_at = now() WHERE user_id = ${req.authUser.id} AND read_at IS NULL`;
    return { ok: true };
  });

  app.get('/api/v1/users', { ...auth, preValidation: requirePerm('customer.read') }, async (req) => {
    const rows = await sql`SELECT id, full_name, role, email FROM users WHERE tenant_id = ${req.authUser.tenantId} AND is_active AND role <> 'customer_user' ORDER BY full_name`;
    return { items: rows };
  });
}
