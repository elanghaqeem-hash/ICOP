import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, requirePerm } from '../../lib/context.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { can } from '../../lib/rbac.js';
import { loadCurrentPolicy } from '../approvals/engine.js';
import type { PricingPolicy } from './policy-defaults.js';
import { CtiInput, GrcInput, PriceInput, SimulateInput, SocInput, VaptInput, calculatePrice, redactPrice, simulate, sizeCti, sizeGrc, sizeSoc, sizeVapt } from './engine.js';

const CatalogBody = z.object({
  sku: z.string().trim().min(2).max(40),
  itemType: z.enum(['service', 'product', 'license', 'bundle']),
  pillar: z.string().min(2).max(80),
  category: z.string().min(2).max(80),
  name: z.string().min(2).max(200),
  description: z.string().max(4000).optional(),
  vendor: z.string().max(120).optional(),
  pricingStructure: z.enum(['one_time', 'man_day', 'fixed_fee', 'time_material', 'monthly', 'annual', 'per_asset', 'per_endpoint',
    'per_user', 'per_device', 'per_eps', 'per_gb', 'license', 'usage', 'milestone', 'retainer', 'bundle', 'managed_package', 'token_wallet']),
  unit: z.string().min(1).max(40),
  listPrice: z.number().min(0).optional(),
  costPrice: z.number().min(0).optional(),
  currency: z.string().length(3).default('IDR'),
  vendorAuthorized: z.boolean().default(false),
});

function completeness(serviceType: string, answers: Record<string, unknown>): number {
  if (serviceType === 'VAPT') {
    const a = answers as Partial<VaptInput>;
    const checks = [
      (a.web?.length ?? 0) + (a.mobile?.length ?? 0) + (a.api?.length ?? 0) > 0 || Object.values(a.network ?? {}).some(Boolean),
      !!a.webMethod, !!a.webAuth, !!a.compliance,
      (answers.workLocation as string | undefined) !== undefined,
      (answers.assessmentWindow as string | undefined) !== undefined,
      (answers.reportingStandard as string | undefined) !== undefined,
    ];
    return Math.round((checks.filter(Boolean).length / checks.length) * 100);
  }
  if (serviceType === 'CTI') {
    const c = answers as Partial<CtiInput>;
    const checks = [c.domains !== undefined, c.subsidiaries !== undefined, c.darkWebMonitoring !== undefined, c.rfiPerMonth !== undefined, c.contractMonths !== undefined];
    return Math.round((checks.filter(Boolean).length / checks.length) * 100);
  }
  if (serviceType === 'GRC') {
    const g = answers as any;
    const checks = [!!(g.iso || g.pdp), !!g.iso?.frameworks?.length || !!g.pdp, !!g.iso?.employees || !!g.pdp, !!g.iso?.maturity || !!g.pdp, !!g.iso?.serviceType || !!g.pdp?.dpoHours];
    return Math.round((checks.filter(Boolean).length / checks.length) * 100);
  }
  const a = answers as Partial<SocInput>;
  const checks = [
    Object.values(a.assets ?? {}).some((v) => Number(v) > 0), !!a.coverage, !!a.serviceTier,
    a.logSources !== undefined, a.contractMonths !== undefined,
    (answers.siemPlatform as string | undefined) !== undefined, (answers.retentionDays as number | undefined) !== undefined,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

export async function pricingRoutes(app: FastifyInstance) {
  const sql = app.sql;
  const auth = { onRequest: [app.authenticate] };

  /* ───── Catalogue ───── */
  app.get('/api/v1/catalog', { ...auth, preValidation: requirePerm('catalog.read') }, async (req) => {
    const q = z.object({ q: z.string().max(100).optional(), pillar: z.string().optional() }).parse(req.query);
    const showCost = can(req.authUser.role, 'pricing.view_cost');
    const rows = await sql`
      SELECT id, sku, item_type, pillar, category, name, description, vendor, pricing_structure, unit, list_price, currency, vendor_authorized, is_active
             ${showCost ? sql`, cost_price` : sql``}
      FROM catalog_items WHERE tenant_id = ${req.authUser.tenantId} AND is_active
        ${q.q ? sql`AND (name ILIKE ${'%' + q.q + '%'} OR sku ILIKE ${'%' + q.q + '%'})` : sql``}
        ${q.pillar ? sql`AND pillar = ${q.pillar}` : sql``}
      ORDER BY pillar, category, name`;
    return { items: rows };
  });

  app.post('/api/v1/catalog', { ...auth, preValidation: requirePerm('catalog.write') }, async (req, reply) => {
    const b = CatalogBody.parse(req.body);
    const u = req.authUser;
    const [dup] = await sql`SELECT id FROM catalog_items WHERE tenant_id = ${u.tenantId} AND sku = ${b.sku}`;
    if (dup) throw conflict(`SKU ${b.sku} sudah ada`);
    const [row] = await sql`INSERT INTO catalog_items ${sql({ ...b, tenantId: u.tenantId } as Record<string, unknown>)} RETURNING *`;
    await audit(sql, u, 'catalog.create', 'catalog_item', row.id as string, null, row, req.ip);
    reply.code(201);
    return row;
  });

  /* ───── Policies ───── */
  app.get('/api/v1/policies', { ...auth, preValidation: requirePerm('policy.read') }, async (req) => {
    const rows = await sql`SELECT p.*, cu.full_name AS created_by_name, au.full_name AS approved_by_name
      FROM policies p LEFT JOIN users cu ON cu.id = p.created_by LEFT JOIN users au ON au.id = p.approved_by
      WHERE p.tenant_id = ${req.authUser.tenantId} ORDER BY p.kind, p.code, p.version DESC`;
    return { items: rows };
  });

  app.post('/api/v1/policies', { ...auth, preValidation: requirePerm('policy.manage') }, async (req, reply) => {
    const b = z.object({ kind: z.enum(['PRICING', 'DOA', 'FLEXGUARD']), code: z.string().min(3).max(40), title: z.string().min(3).max(200),
      params: z.record(z.string(), z.unknown()), effectiveFrom: z.string().date(), sourceNote: z.string().max(1000).optional() }).parse(req.body);
    const u = req.authUser;
    const [{ v }] = await sql`SELECT coalesce(max(version), 0) + 1 AS v FROM policies WHERE tenant_id = ${u.tenantId} AND code = ${b.code}`;
    const [row] = await sql`INSERT INTO policies (tenant_id, kind, code, version, title, params, status, effective_from, source_note, created_by)
      VALUES (${u.tenantId}, ${b.kind}, ${b.code}, ${v}, ${b.title}, ${sql.json(b.params as never)}, 'DRAFT', ${b.effectiveFrom}, ${b.sourceNote ?? null}, ${u.id}) RETURNING *`;
    await audit(sql, u, 'policy.create', 'policy', row.id as string, null, row, req.ip);
    reply.code(201);
    return row;
  });

  /** Maker-checker: hanya Direktur, dan bukan pembuat kebijakan, yang bisa mengaktifkan. */
  app.post('/api/v1/policies/:id/activate', { ...auth, preValidation: requirePerm('policy.activate') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const [p] = await tx`SELECT * FROM policies WHERE id = ${id} AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!p) throw notFound('Policy');
      if (p.createdBy === u.id) throw forbidden('Maker-checker: pembuat kebijakan tidak boleh mengaktifkan sendiri');
      if (p.status === 'RETIRED') throw unprocessable('Kebijakan RETIRED tidak dapat diaktifkan kembali; buat versi baru');
      const prev = await tx`UPDATE policies SET is_current = false, status = CASE WHEN status = 'ACTIVE' THEN 'RETIRED' ELSE status END
                            WHERE tenant_id = ${u.tenantId} AND kind = ${p.kind} AND is_current RETURNING id, code, version`;
      const [after] = await tx`UPDATE policies SET status = 'ACTIVE', is_current = true, approved_by = ${u.id}, approved_at = now() WHERE id = ${id} RETURNING *`;
      await audit(tx, u, 'policy.activate', 'policy', id, { previous: prev }, after, req.ip);
      return after;
    });
  });

  /* ───── Assessments (Smart Scoping) ───── */
  app.post('/api/v1/assessments', { ...auth, preValidation: requirePerm('assessment.write') }, async (req, reply) => {
    const b = z.object({ customerId: z.string().uuid(), opportunityId: z.string().uuid().optional(), serviceType: z.enum(['VAPT', 'SOC', 'CTI', 'GRC']),
      answers: z.record(z.string(), z.unknown()).default({}) }).parse(req.body);
    const u = req.authUser;
    if (JSON.stringify(b.answers).match(/"(password|passwd|pwd|secret|credential)"\s*:/i)) {
      throw badRequest('Jangan menyimpan password/kredensial pelanggan di form scoping');
    }
    const [c] = await sql`SELECT id FROM customers WHERE id = ${b.customerId} AND tenant_id = ${u.tenantId}`;
    if (!c) throw notFound('Customer');
    if (b.opportunityId) {
      const [o] = await sql`SELECT id FROM opportunities WHERE id = ${b.opportunityId} AND customer_id = ${b.customerId} AND tenant_id = ${u.tenantId}`;
      if (!o) throw notFound('Opportunity');
    }
    const [row] = await sql`INSERT INTO assessments (tenant_id, customer_id, opportunity_id, service_type, answers, completeness, created_by)
      VALUES (${u.tenantId}, ${b.customerId}, ${b.opportunityId ?? null}, ${b.serviceType}, ${sql.json(b.answers as never)},
              ${completeness(b.serviceType, b.answers)}, ${u.id}) RETURNING *`;
    reply.code(201);
    return row;
  });

  /** Auto-save draft. Mengubah jawaban me-reset status review. */
  app.patch('/api/v1/assessments/:id', { ...auth, preValidation: requirePerm('assessment.write') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ answers: z.record(z.string(), z.unknown()) }).parse(req.body);
    if (JSON.stringify(b.answers).match(/"(password|passwd|pwd|secret|credential)"\s*:/i)) throw badRequest('Jangan menyimpan password/kredensial pelanggan di form scoping');
    const u = req.authUser;
    const [a] = await sql`SELECT * FROM assessments WHERE id = ${id} AND tenant_id = ${u.tenantId}`;
    if (!a) throw notFound('Assessment');
    const [row] = await sql`UPDATE assessments SET answers = ${sql.json(b.answers as never)}, completeness = ${completeness(a.serviceType as string, b.answers)},
      status = 'DRAFT', result = NULL, reviewed_by = NULL, reviewed_at = NULL, updated_at = now() WHERE id = ${id} RETURNING *`;
    return row;
  });

  app.post('/api/v1/assessments/:id/calculate', { ...auth, preValidation: requirePerm('assessment.write') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    const [a] = await sql`SELECT a.*, c.client_tier, c.industry FROM assessments a JOIN customers c ON c.id = a.customer_id WHERE a.id = ${id} AND a.tenant_id = ${u.tenantId}`;
    if (!a) throw notFound('Assessment');
    const policy = await loadCurrentPolicy<PricingPolicy>(sql, u.tenantId, 'PRICING');
    let result: unknown;
    try {
      const tier = a.clientTier as string;
      if (a.serviceType === 'VAPT') result = sizeVapt(VaptInput.parse(a.answers), policy.params.vapt);
      else if (a.serviceType === 'CTI') result = sizeCti(CtiInput.parse(a.answers), policy.params.cti, a.industry as string, policy.params.tierMultipliers[tier]);
      else if (a.serviceType === 'GRC') result = sizeGrc(GrcInput.parse(a.answers), policy.params.iso, policy.params.pdp);
      else {
        const tier = a.clientTier as string;
        result = sizeSoc(SocInput.parse(a.answers), policy.params.soc, tier, policy.params.tierMultipliers[tier]);
      }
    } catch (e) {
      if (e instanceof z.ZodError) throw badRequest('Jawaban assessment belum valid', e.flatten());
      throw unprocessable((e as Error).message);
    }
    const withPolicy = { ...(result as object), policy: { id: policy.id, code: policy.code, version: policy.version } };
    const [row] = await sql`UPDATE assessments SET result = ${sql.json(withPolicy as never)}, status = 'ENGINEER_REVIEW_REQUIRED', updated_at = now()
                            WHERE id = ${id} RETURNING *`;
    await audit(sql, u, 'assessment.calculate', 'assessment', id, null, { status: row.status }, req.ip);
    return row;
  });

  app.post('/api/v1/assessments/:id/review', { ...auth, preValidation: requirePerm('assessment.review') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ adjustedTeam: z.object({ pm: z.number().min(0), lead: z.number().min(0), senior: z.number().min(0), junior: z.number().min(0) }).optional(),
      note: z.string().max(2000).optional() }).parse(req.body ?? {});
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const [a] = await tx`SELECT * FROM assessments WHERE id = ${id} AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!a) throw notFound('Assessment');
      if (a.status !== 'ENGINEER_REVIEW_REQUIRED') throw unprocessable('Assessment belum dihitung atau sudah direview');
      const result = { ...(a.result as Record<string, unknown>) };
      if (b.adjustedTeam) {
        result.engineerAdjustment = { from: result.team, to: b.adjustedTeam, by: u.fullName, note: b.note };
        result.team = b.adjustedTeam;
        result.totalMd = b.adjustedTeam.pm + b.adjustedTeam.lead + b.adjustedTeam.senior + b.adjustedTeam.junior;
      }
      result.reviewNote = b.note ?? null;
      const [row] = await tx`UPDATE assessments SET result = ${tx.json(result as never)}, status = 'REVIEWED', reviewed_by = ${u.id}, reviewed_at = now(), updated_at = now()
                             WHERE id = ${id} RETURNING *`;
      await audit(tx, u, 'assessment.review', 'assessment', id, { team: (a.result as Record<string, unknown>)?.team }, { team: result.team, note: b.note }, req.ip);
      return row;
    });
  });

  app.get('/api/v1/assessments/:id', { ...auth, preValidation: requirePerm('assessment.read') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [a] = await sql`SELECT a.*, c.legal_name AS customer_name, c.client_tier FROM assessments a JOIN customers c ON c.id = a.customer_id
                          WHERE a.id = ${id} AND a.tenant_id = ${req.authUser.tenantId}`;
    if (!a) throw notFound('Assessment');
    return a;
  });

  /* ───── Pricing calculation & scenarios ───── */
  app.post('/api/v1/pricing/calculate', { ...auth, preValidation: requirePerm('pricing.calculate') }, async (req) => {
    const input = PriceInput.parse(req.body);
    const policy = await loadCurrentPolicy<PricingPolicy>(sql, req.authUser.tenantId, 'PRICING');
    let r;
    try { r = calculatePrice(input, policy.params); } catch (e) { throw unprocessable((e as Error).message); }
    const out = can(req.authUser.role, 'pricing.view_cost') ? r : redactPrice(r);
    return { ...out, policy: { code: policy.code, version: policy.version, status: policy.status } };
  });

  app.post('/api/v1/pricing/scenarios', { ...auth, preValidation: requirePerm('pricing.calculate') }, async (req, reply) => {
    const b = z.object({ opportunityId: z.string().uuid(), assessmentId: z.string().uuid().optional(), label: z.string().min(2).max(120),
      input: z.unknown() }).parse(req.body);
    const u = req.authUser;
    const [o] = await sql`SELECT o.id, c.client_tier FROM opportunities o JOIN customers c ON c.id = o.customer_id WHERE o.id = ${b.opportunityId} AND o.tenant_id = ${u.tenantId}`;
    if (!o) throw notFound('Opportunity');
    let input = PriceInput.parse(b.input);
    if (b.assessmentId) {
      const [a] = await sql`SELECT * FROM assessments WHERE id = ${b.assessmentId} AND tenant_id = ${u.tenantId} AND opportunity_id = ${b.opportunityId}`;
      if (!a) throw notFound('Assessment');
      if (a.status !== 'REVIEWED') throw unprocessable('Assessment harus direview Pre-Sales Engineer sebelum dipakai untuk pricing');
      const res = a.result as Record<string, unknown>;
      if (['VAPT', 'GRC'].includes(a.serviceType as string) && input.hr.length === 0 && (res.team as any)?.lead !== undefined && Number(res.totalMd) > 0) {
        const t = res.team as Record<string, number>;
        input = { ...input, hr: [{ role: 'pm', md: t.pm }, { role: 'lead', md: t.lead }, { role: 'senior', md: t.senior }, { role: 'junior', md: t.junior }] };
      }
      if (['SOC', 'CTI'].includes(a.serviceType as string) && input.referencePrice === undefined) input = { ...input, referencePrice: Number(res.contractValue) };
      if (a.serviceType === 'GRC' && Number(res.pdpValue) > 0 && !input.addOnPrice) input = { ...input, addOnPrice: Number(res.pdpValue) };
    }
    if (input.clientTier !== o.clientTier) {
      (input as PriceInput & { tierNote?: string }).tierNote = `Tier dipilih ${input.clientTier} berbeda dari tier customer ${o.clientTier}`;
    }
    const policy = await loadCurrentPolicy<PricingPolicy>(sql, u.tenantId, 'PRICING');
    let result;
    try { result = calculatePrice(input, policy.params); } catch (e) { throw unprocessable((e as Error).message); }
    const [row] = await sql`INSERT INTO pricing_scenarios (tenant_id, opportunity_id, assessment_id, policy_id, label, input, result, created_by)
      VALUES (${u.tenantId}, ${b.opportunityId}, ${b.assessmentId ?? null}, ${policy.id}, ${b.label}, ${sql.json(input as never)}, ${sql.json(result as never)}, ${u.id})
      RETURNING *`;
    await audit(sql, u, 'pricing.scenario_saved', 'pricing_scenario', row.id as string, null, { label: b.label, sellingPrice: result.sellingPrice, margin: result.grossMarginPct }, req.ip);
    reply.code(201);
    return can(u.role, 'pricing.view_cost') ? row : { ...row, result: redactPrice(result), input: undefined };
  });

  /** Simulasi sensitivitas: diskon, effort, FX, tier, staffing mix, posisi vs kompetitor (G4). */
  app.post('/api/v1/pricing/simulate', { ...auth, preValidation: requirePerm('pricing.view_cost') }, async (req) => {
    const b = SimulateInput.parse(req.body);
    const policy = await loadCurrentPolicy<PricingPolicy>(sql, req.authUser.tenantId, 'PRICING');
    try { return { ...simulate(b, policy.params), policy: { code: policy.code, version: policy.version } }; } catch (e) { throw unprocessable((e as Error).message); }
  });

  app.get('/api/v1/pricing/scenarios/compare', { ...auth, preValidation: requirePerm('pricing.view_cost') }, async (req) => {
    const q = z.object({ ids: z.string() }).parse(req.query);
    const ids = q.ids.split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 6);
    if (ids.length < 2) throw badRequest('Minimal 2 scenario untuk dibandingkan');
    const rows = await sql`SELECT id, label, result, created_at FROM pricing_scenarios WHERE tenant_id = ${req.authUser.tenantId} AND id IN ${sql(ids)}`;
    return {
      items: rows.map((r) => {
        const x = r.result as ReturnType<typeof calculatePrice>;
        return { id: r.id, label: r.label, totalCost: x.boq.totalCost, floor: x.prices.floor, standard: x.prices.standard, premium: x.prices.premium,
          sellingPrice: x.sellingPrice, discountPct: x.discountPct, grossMarginPct: x.grossMarginPct, markupPct: x.markupPct, grandTotal: x.grandTotal };
      }),
    };
  });
}
