import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, nextNumber, requirePerm } from '../../lib/context.js';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { can } from '../../lib/rbac.js';

const INDUSTRIES = ['banking', 'bpd', 'bpr_bprs', 'insurance', 'capital_market', 'multifinance', 'fintech', 'government',
  'bumn', 'manufacturing', 'telecommunication', 'logistics', 'energy', 'healthcare', 'education', 'other'] as const;

const CustomerBody = z.object({
  legalName: z.string().trim().min(2).max(200),
  brandName: z.string().trim().max(200).optional(),
  parentId: z.string().uuid().optional(),
  industry: z.enum(INDUSTRIES),
  subsector: z.string().max(100).optional(),
  classification: z.enum(['B2B', 'B2G', 'B2B2B']).default('B2B'),
  clientTier: z.enum(['S', 'A', 'B', 'C', 'D', 'E']).default('A'),
  npwp: z.string().regex(/^[0-9.\-]{15,20}$/, 'format NPWP tidak valid').optional(),
  address: z.string().max(500).optional(),
  city: z.string().max(100).optional(),
  onboardingStatus: z.enum(['PROSPECT', 'ONBOARDING', 'ACTIVE', 'INACTIVE']).default('PROSPECT'),
  segmentation: z.string().max(100).optional(),
  accountOwnerId: z.string().uuid().optional(),
  existingTechnologies: z.array(z.string().max(80)).max(50).default([]),
  notes: z.string().max(4000).optional(),
});

const ContactBody = z.object({
  fullName: z.string().trim().min(2).max(150),
  title: z.string().max(150).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  contactRole: z.enum(['primary', 'technical', 'procurement', 'finance', 'management', 'other']).default('primary'),
  isDecisionMaker: z.boolean().default(false),
});

const STAGES = ['LEAD', 'QUALIFIED', 'SCOPING', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'] as const;
const DEFAULT_PROB: Record<string, number> = { LEAD: 10, QUALIFIED: 25, SCOPING: 40, PROPOSAL: 60, NEGOTIATION: 80, WON: 100, LOST: 0 };
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  LEAD: ['QUALIFIED', 'LOST'],
  QUALIFIED: ['SCOPING', 'LEAD', 'LOST'],
  SCOPING: ['PROPOSAL', 'QUALIFIED', 'LOST'],
  PROPOSAL: ['NEGOTIATION', 'SCOPING', 'WON', 'LOST'],
  NEGOTIATION: ['WON', 'PROPOSAL', 'LOST'],
  WON: [],
  LOST: ['LEAD'],
};

const OpportunityBody = z.object({
  customerId: z.string().uuid(),
  name: z.string().trim().min(3).max(200),
  serviceCategory: z.enum(['SOC_MDR', 'VAPT', 'RED_TEAM', 'DFIR', 'CTI', 'GRC', 'ISO', 'IT_AUDIT', 'PDP', 'BCM', 'AWARENESS', 'SECURITY_ENGINEERING', 'IT_INFRA', 'MANAGED_IT', 'OTHER']),
  amountEstimate: z.number().min(0).default(0),
  expectedClose: z.string().date().optional(),
  source: z.enum(['direct', 'referral', 'partner', 'tender', 'inbound', 'import']).default('direct'),
  isTender: z.boolean().default(false),
  ownerId: z.string().uuid().optional(),
  competitors: z.array(z.string().max(100)).max(20).default([]),
  nextAction: z.string().max(500).optional(),
});

const ActivityBody = z.object({
  opportunityId: z.string().uuid().optional(),
  kind: z.enum(['call', 'meeting', 'visit', 'email', 'task', 'note']),
  subject: z.string().trim().min(2).max(200),
  notes: z.string().max(8000).optional(),
  dueAt: z.string().datetime({ offset: true }).optional(),
  done: z.boolean().default(false),
});

export async function crmRoutes(app: FastifyInstance) {
  const sql = app.sql;
  const auth = { onRequest: [app.authenticate] };

  /* ───── Customers ───── */
  app.get('/api/v1/customers', { ...auth, preValidation: requirePerm('customer.read') }, async (req) => {
    const q = z.object({ q: z.string().max(100).optional(), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }).parse(req.query);
    const t = req.authUser.tenantId;
    const like = q.q ? `%${q.q}%` : null;
    const rows = await sql`
      SELECT c.id, c.code, c.legal_name, c.brand_name, c.industry, c.client_tier, c.classification, c.onboarding_status, c.city,
             u.full_name AS account_owner,
             (SELECT count(*)::int FROM opportunities o WHERE o.customer_id = c.id AND o.stage NOT IN ('WON','LOST')) AS open_opportunities
      FROM customers c LEFT JOIN users u ON u.id = c.account_owner_id
      WHERE c.tenant_id = ${t}
        ${like ? sql`AND (c.legal_name ILIKE ${like} OR c.brand_name ILIKE ${like} OR c.code ILIKE ${like})` : sql``}
        ${q.cursor ? sql`AND c.legal_name > ${q.cursor}` : sql``}
      ORDER BY c.legal_name LIMIT ${q.limit + 1}`;
    const hasMore = rows.length > q.limit;
    const items = rows.slice(0, q.limit);
    return { items, nextCursor: hasMore ? items[items.length - 1].legalName : null };
  });

  app.post('/api/v1/customers', { ...auth, preValidation: requirePerm('customer.write') }, async (req, reply) => {
    const b = CustomerBody.parse(req.body);
    const u = req.authUser;
    // Deduplication check yang ramah (index unik tetap menjadi pengaman terakhir)
    const norm = b.legalName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const dup = await sql`SELECT id, code, legal_name FROM customers WHERE tenant_id = ${u.tenantId}
      AND (regexp_replace(lower(legal_name), '[^a-z0-9]', '', 'g') = ${norm} ${b.npwp ? sql`OR npwp = ${b.npwp}` : sql``}) LIMIT 1`;
    if (dup.length) throw conflict('Customer duplikat terdeteksi (nama legal / NPWP sama)', { existing: dup[0] });
    const created = await sql.begin(async (tx) => {
      const n = await nextNumber(tx, u.tenantId, 'CUSTOMER', 'ALL');
      const code = `CUS-${String(n).padStart(5, '0')}`;
      const [c] = await tx`
        INSERT INTO customers (tenant_id, code, legal_name, brand_name, parent_id, industry, subsector, classification, client_tier, npwp,
          address, city, onboarding_status, segmentation, account_owner_id, existing_technologies, notes, created_by)
        VALUES (${u.tenantId}, ${code}, ${b.legalName}, ${b.brandName ?? null}, ${b.parentId ?? null}, ${b.industry}, ${b.subsector ?? null},
          ${b.classification}, ${b.clientTier}, ${b.npwp ?? null}, ${b.address ?? null}, ${b.city ?? null}, ${b.onboardingStatus},
          ${b.segmentation ?? null}, ${b.accountOwnerId ?? u.id}, ${b.existingTechnologies}, ${b.notes ?? null}, ${u.id})
        RETURNING *`;
      await audit(tx, u, 'customer.create', 'customer', c.id as string, null, c, req.ip);
      return c;
    });
    reply.code(201);
    return created;
  });

  app.get('/api/v1/customers/:id', { ...auth, preValidation: requirePerm('customer.read') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const t = req.authUser.tenantId;
    const [c] = await sql`SELECT c.*, u.full_name AS account_owner FROM customers c LEFT JOIN users u ON u.id = c.account_owner_id
                          WHERE c.id = ${id} AND c.tenant_id = ${t}`;
    if (!c) throw notFound('Customer');
    const showCost = can(req.authUser.role, 'pricing.view_cost');
    const [contacts, opportunities, quotations, activities] = await Promise.all([
      sql`SELECT * FROM contacts WHERE tenant_id = ${t} AND customer_id = ${id} ORDER BY is_decision_maker DESC, full_name`,
      sql`SELECT id, code, name, service_category, stage, amount_estimate, probability, expected_close, updated_at
          FROM opportunities WHERE tenant_id = ${t} AND customer_id = ${id} ORDER BY updated_at DESC`,
      sql`SELECT id, number, revision, title, status, grand_total, total_before_tax, created_at
              ${showCost ? sql`, gross_margin_pct` : sql``}
          FROM quotations WHERE tenant_id = ${t} AND customer_id = ${id} ORDER BY created_at DESC`,
      sql`SELECT a.*, u.full_name AS owner_name FROM activities a LEFT JOIN users u ON u.id = a.owner_id
          WHERE a.tenant_id = ${t} AND a.customer_id = ${id} ORDER BY a.created_at DESC LIMIT 50`,
    ]);
    const open = opportunities.filter((o) => !['WON', 'LOST'].includes(o.stage as string));
    const won = quotations.filter((q) => q.status === 'ACCEPTED');
    return {
      customer: c, contacts, opportunities, quotations, activities,
      summary: {
        openPipeline: open.reduce((s, o) => s + Number(o.amountEstimate), 0),
        weightedPipeline: open.reduce((s, o) => s + Number(o.amountEstimate) * Number(o.probability) / 100, 0),
        acceptedValue: won.reduce((s, q) => s + Number(q.totalBeforeTax), 0),
        decisionMakers: contacts.filter((x) => x.isDecisionMaker).length,
        lastActivityAt: activities[0]?.createdAt ?? null,
      },
      notYetAvailable: ['contracts', 'projects', 'tickets', 'invoices', 'healthScore'], // Phase 3–4
    };
  });

  app.patch('/api/v1/customers/:id', { ...auth, preValidation: requirePerm('customer.write') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = CustomerBody.partial().parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const [before] = await tx`SELECT * FROM customers WHERE id = ${id} AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!before) throw notFound('Customer');
      const cols = Object.keys(b) as (keyof typeof b)[];
      if (!cols.length) throw badRequest('Tidak ada field yang diubah');
      const [after] = await tx`UPDATE customers SET ${tx(b as Record<string, unknown>, cols as string[])}, updated_at = now()
                               WHERE id = ${id} AND tenant_id = ${u.tenantId} RETURNING *`;
      await audit(tx, u, 'customer.update', 'customer', id, before, after, req.ip);
      return after;
    });
  });

  app.post('/api/v1/customers/:id/contacts', { ...auth, preValidation: requirePerm('customer.write') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = ContactBody.parse(req.body);
    const u = req.authUser;
    const [c] = await sql`SELECT id FROM customers WHERE id = ${id} AND tenant_id = ${u.tenantId}`;
    if (!c) throw notFound('Customer');
    const [row] = await sql`INSERT INTO contacts (tenant_id, customer_id, full_name, title, email, phone, contact_role, is_decision_maker)
      VALUES (${u.tenantId}, ${id}, ${b.fullName}, ${b.title ?? null}, ${b.email ?? null}, ${b.phone ?? null}, ${b.contactRole}, ${b.isDecisionMaker}) RETURNING *`;
    await audit(sql, u, 'contact.create', 'contact', row.id as string, null, row, req.ip);
    reply.code(201);
    return row;
  });

  app.post('/api/v1/customers/:id/activities', { ...auth, preValidation: requirePerm('opportunity.write') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = ActivityBody.parse(req.body);
    const u = req.authUser;
    const [c] = await sql`SELECT id FROM customers WHERE id = ${id} AND tenant_id = ${u.tenantId}`;
    if (!c) throw notFound('Customer');
    if (b.opportunityId) {
      const [o] = await sql`SELECT id FROM opportunities WHERE id = ${b.opportunityId} AND customer_id = ${id} AND tenant_id = ${u.tenantId}`;
      if (!o) throw notFound('Opportunity');
    }
    const [row] = await sql`INSERT INTO activities (tenant_id, customer_id, opportunity_id, kind, subject, notes, due_at, done_at, owner_id)
      VALUES (${u.tenantId}, ${id}, ${b.opportunityId ?? null}, ${b.kind}, ${b.subject}, ${b.notes ?? null}, ${b.dueAt ?? null},
              ${b.done ? sql`now()` : null}, ${u.id}) RETURNING *`;
    reply.code(201);
    return row;
  });

  /* ───── Opportunities ───── */
  app.get('/api/v1/opportunities', { ...auth, preValidation: requirePerm('opportunity.read') }, async (req) => {
    const q = z.object({ stage: z.enum(STAGES).optional(), customerId: z.string().uuid().optional(), mine: z.coerce.boolean().optional() }).parse(req.query);
    const u = req.authUser;
    const rows = await sql`
      SELECT o.*, c.legal_name AS customer_name, c.client_tier, u.full_name AS owner_name,
             extract(day FROM now() - o.stage_changed_at)::int AS days_in_stage,
             extract(day FROM now() - o.created_at)::int AS deal_age_days
      FROM opportunities o JOIN customers c ON c.id = o.customer_id LEFT JOIN users u ON u.id = o.owner_id
      WHERE o.tenant_id = ${u.tenantId}
        ${q.stage ? sql`AND o.stage = ${q.stage}` : sql``}
        ${q.customerId ? sql`AND o.customer_id = ${q.customerId}` : sql``}
        ${q.mine ? sql`AND o.owner_id = ${u.id}` : sql``}
      ORDER BY o.updated_at DESC LIMIT 500`;
    const board = Object.fromEntries(STAGES.map((s) => [s, rows.filter((r) => r.stage === s)]));
    return { items: rows, board, stages: STAGES };
  });

  app.post('/api/v1/opportunities', { ...auth, preValidation: requirePerm('opportunity.write') }, async (req, reply) => {
    const b = OpportunityBody.parse(req.body);
    const u = req.authUser;
    const out = await sql.begin(async (tx) => {
      const [c] = await tx`SELECT id FROM customers WHERE id = ${b.customerId} AND tenant_id = ${u.tenantId}`;
      if (!c) throw notFound('Customer');
      const year = new Date().getFullYear();
      const n = await nextNumber(tx, u.tenantId, 'OPPORTUNITY', String(year));
      const code = `OPP-${year}-${String(n).padStart(4, '0')}`;
      const [o] = await tx`
        INSERT INTO opportunities (tenant_id, code, customer_id, name, service_category, amount_estimate, probability, expected_close,
          source, is_tender, owner_id, competitors, next_action, created_by)
        VALUES (${u.tenantId}, ${code}, ${b.customerId}, ${b.name}, ${b.serviceCategory}, ${b.amountEstimate}, ${DEFAULT_PROB.LEAD},
          ${b.expectedClose ?? null}, ${b.source}, ${b.isTender || b.source === 'tender'}, ${b.ownerId ?? u.id}, ${b.competitors}, ${b.nextAction ?? null}, ${u.id})
        RETURNING *`;
      await tx`INSERT INTO opportunity_stage_history (tenant_id, opportunity_id, from_stage, to_stage, changed_by) VALUES (${u.tenantId}, ${o.id}, NULL, 'LEAD', ${u.id})`;
      await audit(tx, u, 'opportunity.create', 'opportunity', o.id as string, null, o, req.ip);
      return o;
    });
    reply.code(201);
    return out;
  });

  app.get('/api/v1/opportunities/:id', { ...auth, preValidation: requirePerm('opportunity.read') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const t = req.authUser.tenantId;
    const showCost = can(req.authUser.role, 'pricing.view_cost');
    const [o] = await sql`SELECT o.*, c.legal_name AS customer_name, c.client_tier, u.full_name AS owner_name
                          FROM opportunities o JOIN customers c ON c.id = o.customer_id LEFT JOIN users u ON u.id = o.owner_id
                          WHERE o.id = ${id} AND o.tenant_id = ${t}`;
    if (!o) throw notFound('Opportunity');
    const [history, assessments, scenarios, quotations, activities, approvals] = await Promise.all([
      sql`SELECT h.*, u.full_name AS changed_by_name FROM opportunity_stage_history h LEFT JOIN users u ON u.id = h.changed_by
          WHERE h.opportunity_id = ${id} ORDER BY h.changed_at`,
      sql`SELECT id, service_type, status, completeness, result, updated_at FROM assessments WHERE tenant_id = ${t} AND opportunity_id = ${id} ORDER BY created_at DESC`,
      showCost ? sql`SELECT id, label, result, created_at FROM pricing_scenarios WHERE tenant_id = ${t} AND opportunity_id = ${id} ORDER BY created_at DESC` : Promise.resolve([]),
      sql`SELECT id, number, revision, title, status, grand_total, total_before_tax, created_at ${showCost ? sql`, gross_margin_pct` : sql``}
          FROM quotations WHERE tenant_id = ${t} AND opportunity_id = ${id} ORDER BY created_at DESC`,
      sql`SELECT * FROM activities WHERE tenant_id = ${t} AND opportunity_id = ${id} ORDER BY created_at DESC`,
      sql`SELECT ar.id, ar.status, ar.required_level, ar.created_at, ar.entity_id FROM approval_requests ar
          JOIN quotations q ON q.id = ar.entity_id WHERE ar.tenant_id = ${t} AND q.opportunity_id = ${id} ORDER BY ar.created_at DESC`,
    ]);
    return { opportunity: o, stageHistory: history, assessments, scenarios, quotations, activities, approvals };
  });

  app.post('/api/v1/opportunities/:id/stage', { ...auth, preValidation: requirePerm('opportunity.write') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ stage: z.enum(STAGES), lostReason: z.string().min(3).max(500).optional(), probability: z.number().int().min(0).max(100).optional() }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const [o] = await tx`SELECT * FROM opportunities WHERE id = ${id} AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!o) throw notFound('Opportunity');
      if (o.stage === b.stage) return o;
      if (!ALLOWED_TRANSITIONS[o.stage as string].includes(b.stage)) {
        throw unprocessable(`Transisi ${o.stage} → ${b.stage} tidak diizinkan`, { allowed: ALLOWED_TRANSITIONS[o.stage as string] });
      }
      if (b.stage === 'LOST' && !b.lostReason) throw badRequest('Lost reason wajib diisi');
      if (b.stage === 'WON') {
        const [acc] = await tx`SELECT 1 FROM quotations WHERE opportunity_id = ${id} AND tenant_id = ${u.tenantId} AND status = 'ACCEPTED' LIMIT 1`;
        if (!acc) throw unprocessable('Opportunity hanya bisa WON jika ada quotation berstatus ACCEPTED');
      }
      if (b.stage === 'PROPOSAL') {
        const [sc] = await tx`SELECT 1 FROM pricing_scenarios WHERE opportunity_id = ${id} AND tenant_id = ${u.tenantId} LIMIT 1`;
        if (!sc) throw unprocessable('Exit criteria SCOPING: minimal satu pricing scenario harus tersimpan');
      }
      const [after] = await tx`UPDATE opportunities SET stage = ${b.stage}, probability = ${b.probability ?? DEFAULT_PROB[b.stage]},
        lost_reason = ${b.stage === 'LOST' ? b.lostReason! : null}, stage_changed_at = now(), updated_at = now()
        WHERE id = ${id} RETURNING *`;
      await tx`INSERT INTO opportunity_stage_history (tenant_id, opportunity_id, from_stage, to_stage, changed_by) VALUES (${u.tenantId}, ${id}, ${o.stage}, ${b.stage}, ${u.id})`;
      await audit(tx, u, 'opportunity.stage', 'opportunity', id, { stage: o.stage }, { stage: b.stage, lostReason: b.lostReason }, req.ip);
      return after;
    });
  });

  app.patch('/api/v1/opportunities/:id', { ...auth, preValidation: requirePerm('opportunity.write') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = OpportunityBody.omit({ customerId: true }).partial().parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const [before] = await tx`SELECT * FROM opportunities WHERE id = ${id} AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!before) throw notFound('Opportunity');
      const cols = Object.keys(b);
      if (!cols.length) throw badRequest('Tidak ada field yang diubah');
      const [after] = await tx`UPDATE opportunities SET ${tx(b as Record<string, unknown>, cols)}, updated_at = now() WHERE id = ${id} RETURNING *`;
      await audit(tx, u, 'opportunity.update', 'opportunity', id, before, after, req.ip);
      return after;
    });
  });
}
