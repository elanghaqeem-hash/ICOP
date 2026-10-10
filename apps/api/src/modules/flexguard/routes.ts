import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Tx } from '../../db.js';
import { audit, nextNumber, notify, requirePerm } from '../../lib/context.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { idempotent } from '../../lib/idempotency.js';
import { can } from '../../lib/rbac.js';
import { createApprovalRequest, loadCurrentPolicy, registerApprovalHandler } from '../approvals/engine.js';
import type { FlexguardPolicy } from '../pricing/policy-defaults.js';
import { CalculatorInput, calculate, estimateTokens, floorCheck } from './engine.js';
import { post, reconcile, reverse } from './ledger.js';

const r2 = (n: number) => Math.round(n * 100) / 100;
const EstimateLines = z.array(z.object({ role: z.string(), md: z.number().min(0).max(500), tdc: z.number().positive().optional() })).min(1).max(20);

/* ───── Approval handlers ───── */
registerApprovalHandler('flexguard_wallet', async (tx, u, ar, finalStatus) => {
  if (finalStatus !== 'APPROVED') return;
  const a = (ar.summary as any).action as { type: 'TOPUP' | 'ROLLOVER' | 'ADJUSTMENT' | 'REVERSAL'; tokens?: number; months?: number; reason: string; txId?: number; pricePerToken?: number };
  const walletId = ar.entityId as string;
  if (a.type === 'TOPUP') await post(tx, { tenantId: u.tenantId, walletId, type: 'TOPUP', delta: { available: a.tokens!, credited: a.tokens! }, reason: a.reason, userId: u.id,
    approvalRequestId: ar.id as string, idempotencyKey: `approval:${ar.id}`, valueIdr: r2(a.tokens! * (a.pricePerToken ?? 0)) });
  if (a.type === 'ADJUSTMENT') await post(tx, { tenantId: u.tenantId, walletId, type: 'ADJUSTMENT', delta: { available: a.tokens!, credited: a.tokens! }, reason: a.reason, userId: u.id,
    approvalRequestId: ar.id as string, idempotencyKey: `approval:${ar.id}`, valueIdr: 0 });
  if (a.type === 'REVERSAL') await reverse(tx, { tenantId: u.tenantId, txId: a.txId!, reason: a.reason, userId: u.id, approvalRequestId: ar.id as string });
  if (a.type === 'ROLLOVER') {
    await tx`UPDATE flexguard_wallets SET valid_until = valid_until + make_interval(months => ${a.months!}), status = 'ACTIVE' WHERE id = ${walletId}`;
    await post(tx, { tenantId: u.tenantId, walletId, type: 'ROLLOVER', delta: {}, reason: `${a.reason} (+${a.months} bulan)`, userId: u.id, approvalRequestId: ar.id as string,
      idempotencyKey: `approval:${ar.id}`, valueIdr: 0 });
  }
});

/** Debit di bawah floor membutuhkan approval Direktur sebelum estimasi dikirim ke customer. */
registerApprovalHandler('service_request', async (tx, u, ar, finalStatus) => {
  const status = finalStatus === 'APPROVED' ? 'PENDING_CUSTOMER_APPROVAL' : 'SCOPED';
  await tx`UPDATE service_requests SET status = ${status}, updated_at = now() WHERE id = ${ar.entityId as string} AND tenant_id = ${u.tenantId}`;
  if (status === 'PENDING_CUSTOMER_APPROVAL') {
    const [sr] = await tx`SELECT code, customer_id, estimated_tokens FROM service_requests WHERE id = ${ar.entityId as string}`;
    const cust = await tx`SELECT id FROM users WHERE tenant_id = ${u.tenantId} AND customer_id = ${sr.customerId} AND is_active`;
    await notify(tx, u.tenantId, cust.map((x) => x.id as string), 'SR_ESTIMATE', `Estimasi ${sr.code}: ${sr.estimatedTokens} token`, 'Mohon persetujuan', `/portal/flexguard`);
  }
});

export async function flexguardRoutes(app: FastifyInstance) {
  const sql = app.sql;
  const auth = { onRequest: [app.authenticate] };
  const R = requirePerm('flexguard.read');
  const W = requirePerm('flexguard.write');
  const policy = (tenantId: string, db: any = sql) => loadCurrentPolicy<FlexguardPolicy>(db, tenantId, 'FLEXGUARD');

  const loadWallet = async (u: { tenantId: string; role: string; customerId: string | null }, id: string, db: any = sql) => {
    const [w] = await db`SELECT w.*, cu.legal_name AS customer_name, c.number AS contract_number FROM flexguard_wallets w JOIN customers cu ON cu.id = w.customer_id
                         LEFT JOIN contracts c ON c.id = w.contract_id WHERE w.id = ${id} AND w.tenant_id = ${u.tenantId}`;
    if (!w || (u.role === 'customer_user' && w.customerId !== u.customerId)) throw notFound('Wallet');
    return w as Record<string, any>;
  };
  const loadSr = async (u: { tenantId: string; role: string; customerId: string | null }, id: string, db: any = sql, lock = false) => {
    const [s] = lock ? await db`SELECT * FROM service_requests WHERE id = ${id} AND tenant_id = ${u.tenantId} FOR UPDATE`
      : await db`SELECT s.*, w.code AS wallet_code, w.price_per_token, cu.legal_name AS customer_name, pm.full_name AS pm_name FROM service_requests s
                 JOIN flexguard_wallets w ON w.id = s.wallet_id JOIN customers cu ON cu.id = s.customer_id LEFT JOIN users pm ON pm.id = s.assigned_pm_id
                 WHERE s.id = ${id} AND s.tenant_id = ${u.tenantId}`;
    if (!s || (u.role === 'customer_user' && s.customerId !== u.customerId)) throw notFound('Service request');
    return s as Record<string, any>;
  };

  /* ───── Kalkulator ───── */
  app.post('/api/v1/flexguard/calculate', { ...auth, preValidation: requirePerm('pricing.calculate') }, async (req) => {
    const b = CalculatorInput.parse(req.body);
    const pol = await policy(req.authUser.tenantId);
    try { return { ...calculate(pol.params, b), policy: { code: pol.code, version: pol.version, status: pol.status } }; } catch (e) { throw unprocessable((e as Error).message); }
  });

  app.get('/api/v1/flexguard/policy', { ...auth, preValidation: R }, async (req) => {
    const pol = await policy(req.authUser.tenantId);
    const p = pol.params;
    const showCost = can(req.authUser.role, 'pricing.view_cost');
    return { id: pol.id, code: pol.code, version: pol.version, status: pol.status, canApprove: pol.status !== 'ACTIVE' && can(req.authUser.role, 'policy.activate'), trv: p.trv, ladder: p.ladder, tdc: p.tdc, multipliers: p.multipliers, serviceLines: p.serviceLines,
      complimentary: p.complimentary, membership: p.membership, ...(showCost ? { internalRate: p.internalRate, overheadRatio: p.overheadRatio } : {}) };
  });

  /** Pengesahan kebijakan FlexGuard oleh Direktur atau Company Admin (maker-checker, catatan wajib). */
  app.post('/api/v1/flexguard/policy/approve', { ...auth, preValidation: requirePerm('policy.activate') }, async (req) => {
    const b = z.object({ note: z.string().min(10).max(1000) }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const [p] = await tx`SELECT * FROM policies WHERE tenant_id = ${u.tenantId} AND kind = 'FLEXGUARD' AND is_current FOR UPDATE`;
      if (!p) throw notFound('Kebijakan FlexGuard');
      if (p.status === 'ACTIVE') throw conflict(`${p.code} v${p.version} sudah disahkan`);
      if (p.createdBy === u.id) throw forbidden('Maker-checker: pembuat kebijakan tidak boleh mengesahkan sendiri');
      const note = `Disahkan ${u.fullName} (${u.role}) ${new Date().toISOString().slice(0, 10)}: ${b.note}`;
      const [after] = await tx`UPDATE policies SET status = 'ACTIVE', approved_by = ${u.id}, approved_at = now(),
        source_note = coalesce(source_note || ' | ', '') || ${note} WHERE id = ${p.id} RETURNING id, code, version, status, approved_at`;
      await audit(tx, u, 'policy.activate', 'policy', p.id as string, { status: p.status }, { status: 'ACTIVE', note: b.note }, req.ip);
      return after;
    });
  });

  /* ───── Wallet ───── */
  app.get('/api/v1/flexguard/wallets', { ...auth, preValidation: R }, async (req) => {
    const rows = await sql`SELECT w.id, w.code, w.package, w.status, w.valid_from, w.valid_until, w.price_per_token, w.credited_tokens, w.available_tokens, w.reserved_tokens,
        w.consumed_tokens, w.expired_tokens, cu.legal_name AS customer_name, c.number AS contract_number
      FROM flexguard_wallets w JOIN customers cu ON cu.id = w.customer_id LEFT JOIN contracts c ON c.id = w.contract_id
      WHERE w.tenant_id = ${req.authUser.tenantId} ORDER BY w.created_at DESC`;
    return { items: rows };
  });

  const walletView = async (w: Record<string, any>) => {
    const [burn] = await sql`SELECT coalesce(sum(d_consumed),0) AS consumed90 FROM wallet_transactions WHERE wallet_id = ${w.id} AND created_at > now() - interval '90 days'`;
    const monthly = Number(burn.consumed90) / 3;
    const credited = Number(w.creditedTokens);
    const daysLeft = Math.max(0, Math.ceil((new Date(w.validUntil).getTime() - Date.now()) / 864e5));
    return {
      wallet: w,
      metrics: {
        utilizationPct: credited ? r2(((Number(w.consumedTokens) + Number(w.reservedTokens)) / credited) * 100) : 0,
        availablePct: credited ? r2((Number(w.availableTokens) / credited) * 100) : 0,
        monthlyBurn: r2(monthly), daysUntilDepletion: monthly > 0 ? Math.round((Number(w.availableTokens) / monthly) * 30) : null, daysUntilExpiry: daysLeft,
        atRiskOfExpiry: monthly > 0 ? Math.max(0, r2(Number(w.availableTokens) - monthly * (daysLeft / 30))) : Number(w.availableTokens),
        valueAvailable: Math.round(Number(w.availableTokens) * Number(w.pricePerToken)),
      },
    };
  };

  app.get('/api/v1/flexguard/wallets/:id', { ...auth, preValidation: R }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const w = await loadWallet(req.authUser, id);
    const ledger = await sql`SELECT t.*, u.full_name AS created_by_name, s.code AS sr_code FROM wallet_transactions t LEFT JOIN users u ON u.id = t.created_by
                             LEFT JOIN service_requests s ON s.id = t.service_request_id WHERE t.wallet_id = ${id} ORDER BY t.id DESC LIMIT 500`;
    const requests = await sql`SELECT id, code, title, service_line, status, estimated_tokens, reserved_tokens, actual_tokens, updated_at FROM service_requests WHERE wallet_id = ${id} ORDER BY created_at DESC`;
    const approvals = await sql`SELECT id, status, summary, created_at FROM approval_requests WHERE entity_type = 'flexguard_wallet' AND entity_id = ${id} ORDER BY created_at DESC`;
    return { ...(await walletView(w)), ledger, requests, approvals, reconciliation: await reconcile(sql, id) };
  });

  /** Statement bulanan (customer usage report). */
  app.get('/api/v1/flexguard/wallets/:id/statement', { ...auth, preValidation: R }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.query);
    const w = await loadWallet(req.authUser, id);
    const from = `${q.month}-01`;
    const [open] = await sql`SELECT coalesce(sum(d_available),0) AS available, coalesce(sum(d_consumed),0) AS consumed, coalesce(sum(d_reserved),0) AS reserved
                             FROM wallet_transactions WHERE wallet_id = ${id} AND created_at < ${from}::date`;
    const rows = await sql`SELECT t.id, t.type, t.d_available, t.d_reserved, t.d_consumed, t.d_expired, t.d_credited, t.reason, t.created_at, s.code AS sr_code, s.service_line
                           FROM wallet_transactions t LEFT JOIN service_requests s ON s.id = t.service_request_id
                           WHERE t.wallet_id = ${id} AND t.created_at >= ${from}::date AND t.created_at < (${from}::date + interval '1 month') ORDER BY t.id`;
    const sum = (k: string) => r2(rows.reduce((s, r) => s + Number(r[k]), 0));
    const byService: Record<string, number> = {};
    for (const r of rows) if (Number(r.dConsumed) && r.serviceLine) byService[r.serviceLine as string] = r2((byService[r.serviceLine as string] ?? 0) + Number(r.dConsumed));
    return { wallet: { code: w.code, customerName: w.customerName, package: w.package, validUntil: w.validUntil }, month: q.month,
      opening: { available: Number(open.available), reserved: Number(open.reserved), consumed: Number(open.consumed) },
      movements: { credited: sum('dCredited'), consumed: sum('dConsumed'), reservedNet: sum('dReserved'), expired: sum('dExpired') },
      closing: { available: r2(Number(open.available) + sum('dAvailable')), reserved: r2(Number(open.reserved) + sum('dReserved')) },
      consumedByService: byService, transactions: rows };
  });

  /** Permintaan top-up / rollover / adjustment / reversal → approval DoA (FLEXGUARD_VALUE, BELOW_FLOOR). */
  app.post('/api/v1/flexguard/wallets/:id/requests', { ...auth, preValidation: W }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.discriminatedUnion('type', [
      z.object({ type: z.literal('TOPUP'), tokens: z.number().positive().max(100_000), pricePerToken: z.number().positive().optional(), reason: z.string().min(5).max(500) }),
      z.object({ type: z.literal('ROLLOVER'), months: z.number().int().min(1).max(12), reason: z.string().min(5).max(500) }),
      z.object({ type: z.literal('ADJUSTMENT'), tokens: z.number().refine((n) => n !== 0).refine((n) => Math.abs(n) <= 1000), reason: z.string().min(10).max(500) }),
      z.object({ type: z.literal('REVERSAL'), txId: z.number().int().positive(), reason: z.string().min(10).max(500) }),
    ]).parse(req.body);
    const u = req.authUser;
    return idempotent(req, reply, 201, () => sql.begin(async (tx) => {
      const w = await loadWallet(u, id, tx);
      const pol = await policy(u.tenantId, tx);
      const floorPerToken = Math.round((pol.params.internalRate.senior * (1 + pol.params.overheadRatio)) / pol.params.floorMarginDivisor);
      const price = b.type === 'TOPUP' ? (b.pricePerToken ?? Number(w.pricePerToken)) : Number(w.pricePerToken);
      if (b.type === 'ROLLOVER' && !w.rolloverAllowed) throw unprocessable('Paket wallet ini tidak memiliki hak rollover');
      if (b.type === 'REVERSAL') {
        const [t] = await tx`SELECT id, type FROM wallet_transactions WHERE id = ${b.txId} AND wallet_id = ${id}`;
        if (!t) throw notFound('Transaksi');
      }
      const value = b.type === 'TOPUP' ? Math.round(b.tokens * price) : b.type === 'ADJUSTMENT' ? Math.round(Math.abs(b.tokens) * price) : 0;
      const metrics = { flexguardValue: value, belowFloor: b.type === 'TOPUP' && price < floorPerToken ? 1 : 0, marginHold: b.type === 'ADJUSTMENT' ? 1 : 0 };
      const { request, evaluation } = await createApprovalRequest(tx, { tenantId: u.tenantId, entityType: 'flexguard_wallet', entityId: id, entityVersion: 1, requestedBy: u.id,
        metrics: metrics as never, summary: { title: `${w.code} ${b.type}${'tokens' in b ? ` ${b.tokens} token` : ''}${'months' in b ? ` +${b.months} bln` : ''}`, action: { ...b, pricePerToken: price },
          totalBeforeTax: value, discountPct: 0, warnings: metrics.belowFloor ? [`Harga top-up di bawah floor Rp${floorPerToken.toLocaleString('id-ID')}/token`] : [] } });
      await audit(tx, u, 'flexguard.request', 'flexguard_wallet', id, null, { ...b, approvalRequestId: request.id }, req.ip);
      return { approvalRequestId: request.id, requiredLevel: evaluation.requiredLevel, steps: evaluation.steps };
    }));
  });

  app.post('/api/v1/flexguard/wallets/:id/complimentary/:index/redeem', { ...auth, preValidation: W }, async (req) => {
    const { id, index } = z.object({ id: z.string().uuid(), index: z.coerce.number().int().min(0) }).parse(req.params);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const [w] = await tx`SELECT * FROM flexguard_wallets WHERE id = ${id} AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!w) throw notFound('Wallet');
      const items = w.complimentary as { item: string; status: string; redeemBy: string; redeemedAt?: string }[];
      const it = items[index];
      if (!it) throw notFound('Complimentary');
      if (it.status !== 'AVAILABLE') throw conflict('Complimentary sudah ditukar/hangus');
      if (new Date(it.redeemBy) < new Date()) throw unprocessable('Masa penukaran complimentary telah lewat');
      it.status = 'REDEEMED'; it.redeemedAt = new Date().toISOString();
      await tx`UPDATE flexguard_wallets SET complimentary = ${tx.json(items as never)} WHERE id = ${id}`;
      await audit(tx, u, 'flexguard.complimentary_redeem', 'flexguard_wallet', id, null, it, req.ip);
      return it;
    });
  });

  /** Job harian: token kedaluwarsa (tanpa rollover) → EXPIRE; reservasi tetap dihormati. */
  app.post('/api/v1/flexguard/jobs/expire', { ...auth, preValidation: requirePerm('jobs.run') }, async (req) => {
    return expireWallets(sql, req.authUser.tenantId, req.authUser.id);
  });

  /* ───── Service request (alur H2) ───── */
  const createSr = async (tx: Tx, u: { id: string; tenantId: string }, b: { walletId: string; serviceLine: string; title: string; description?: string }, customerId: string) => {
    const pol = await policy(u.tenantId, tx);
    if (!pol.params.serviceLines.includes(b.serviceLine)) throw badRequest('Layanan tidak termasuk token-eligible (SOC/MRC/procurement tidak dapat didebit token)');
    const [w] = await tx`SELECT * FROM flexguard_wallets WHERE id = ${b.walletId} AND tenant_id = ${u.tenantId}`;
    if (!w || w.customerId !== customerId) throw notFound('Wallet');
    if (w.status !== 'ACTIVE') throw unprocessable(`Wallet berstatus ${w.status}`);
    const year = new Date().getFullYear();
    const n = await nextNumber(tx, u.tenantId, 'SERVICE_REQUEST', String(year));
    const [s] = await tx`INSERT INTO service_requests (tenant_id, code, wallet_id, customer_id, service_line, title, description, requested_by)
      VALUES (${u.tenantId}, ${`SR-${year}-${String(n).padStart(4, '0')}`}, ${b.walletId}, ${customerId}, ${b.serviceLine}, ${b.title}, ${b.description ?? null}, ${u.id}) RETURNING *`;
    const team = await tx`SELECT id FROM users WHERE tenant_id = ${u.tenantId} AND is_active AND role IN ('presales_engineer','account_manager')`;
    await notify(tx, u.tenantId, team.map((x) => x.id as string), 'SR_NEW', `Service request ${s.code}`, b.title, `/flexguard/requests/${s.id}`);
    await audit(tx, u, 'flexguard.sr_create', 'service_request', s.id as string, null, { code: s.code, serviceLine: b.serviceLine });
    return s;
  };
  const SrBody = z.object({ walletId: z.string().uuid(), serviceLine: z.string(), title: z.string().min(3).max(200), description: z.string().max(4000).optional() });

  app.post('/api/v1/flexguard/requests', { ...auth, preValidation: W }, async (req, reply) => {
    const b = SrBody.parse(req.body);
    const u = req.authUser;
    const [w] = await sql`SELECT customer_id FROM flexguard_wallets WHERE id = ${b.walletId} AND tenant_id = ${u.tenantId}`;
    if (!w) throw notFound('Wallet');
    reply.code(201);
    return sql.begin((tx) => createSr(tx, u, b, w.customerId as string));
  });

  app.get('/api/v1/flexguard/requests', { ...auth, preValidation: R }, async (req) => {
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    const rows = await sql`SELECT s.id, s.code, s.title, s.service_line, s.status, s.estimated_tokens, s.reserved_tokens, s.actual_tokens, s.updated_at, cu.legal_name AS customer_name, w.code AS wallet_code
      FROM service_requests s JOIN customers cu ON cu.id = s.customer_id JOIN flexguard_wallets w ON w.id = s.wallet_id
      WHERE s.tenant_id = ${req.authUser.tenantId} ${q.status ? sql`AND s.status = ${q.status}` : sql``} ORDER BY s.updated_at DESC LIMIT 200`;
    return { items: rows };
  });

  app.get('/api/v1/flexguard/requests/:id', { ...auth, preValidation: R }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    const s = await loadSr(u, id);
    const timesheets = await sql`SELECT t.*, u.full_name AS user_name, a.full_name AS approved_by_name FROM service_timesheets t JOIN users u ON u.id = t.user_id
                                 LEFT JOIN users a ON a.id = t.approved_by WHERE t.service_request_id = ${id} ORDER BY t.work_date, t.created_at`;
    const ledger = await sql`SELECT id, type, d_available, d_reserved, d_consumed, reason, created_at FROM wallet_transactions WHERE service_request_id = ${id} ORDER BY id`;
    const showCost = can(u.role, 'pricing.view_cost');
    return { request: showCost ? s : { ...s, floorCheck: undefined, estimate: s.estimate ? { ...s.estimate, sdmCost: undefined, totalCost: undefined, floorValue: undefined } : null }, timesheets, ledger };
  });

  /** Estimasi MD → token (TDC) + floor guard. Di bawah floor → approval Direktur sebelum dikirim ke customer. */
  app.post('/api/v1/flexguard/requests/:id/estimate', { ...auth, preValidation: requirePerm('flexguard.estimate') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ lines: EstimateLines, overseas: z.boolean().default(false), overseasMultiplier: z.number().min(2).max(2.5).optional(), rush: z.boolean().default(false),
      note: z.string().max(2000).optional() }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const s = await loadSr(u, id, tx, true);
      if (!['SUBMITTED', 'SCOPED'].includes(s.status)) throw unprocessable(`Service request berstatus ${s.status}`);
      const pol = await policy(u.tenantId, tx);
      let e;
      try { e = estimateTokens(pol.params, b.lines, b); } catch (err) { throw unprocessable((err as Error).message); }
      const [w] = await tx`SELECT price_per_token, available_tokens FROM flexguard_wallets WHERE id = ${s.walletId}`;
      const fc = floorCheck(e.tokens, Number(w.pricePerToken), e.floorValue);
      const warnings = [...e.warnings];
      if (e.tokens > Number(w.availableTokens)) warnings.push(`Estimasi ${e.tokens} token melebihi saldo tersedia ${w.availableTokens} — perlu top-up sebelum disetujui customer`);
      await tx`UPDATE service_requests SET estimate = ${tx.json({ ...e, note: b.note, by: u.fullName, at: new Date().toISOString() } as never)}, estimated_tokens = ${e.tokens},
               floor_check = ${tx.json(fc as never)}, status = 'SCOPED', row_version = row_version + 1, updated_at = now() WHERE id = ${id}`;
      await audit(tx, u, 'flexguard.sr_estimate', 'service_request', id, null, { tokens: e.tokens, belowFloor: fc.belowFloor }, req.ip);
      return { tokens: e.tokens, rawTokens: e.rawTokens, lines: e.lines.map(({ internalCost: _c, ...l }) => l), multipliers: e.multipliers, floor: fc, warnings };
    });
  });

  app.post('/api/v1/flexguard/requests/:id/send-to-customer', { ...auth, preValidation: W }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const s = await loadSr(u, id, tx, true);
      if (s.status !== 'SCOPED') throw unprocessable('Estimasi belum dibuat');
      if (s.floorCheck?.belowFloor) {
        const { request } = await createApprovalRequest(tx, { tenantId: u.tenantId, entityType: 'service_request', entityId: id, entityVersion: s.rowVersion, requestedBy: u.id,
          metrics: { belowFloor: 1 } as never, summary: { title: `${s.code} debit di bawah floor`, totalBeforeTax: s.floorCheck.debitValue, discountPct: 0,
            floorPrice: s.floorCheck.floorValue, warnings: [`Nilai debit ${s.floorCheck.debitValue} < floor ${s.floorCheck.floorValue}`] } });
        await tx`UPDATE service_requests SET approval_request_id = ${request.id}, updated_at = now() WHERE id = ${id}`;
        return { id, status: 'SCOPED', approvalRequired: true, approvalRequestId: request.id };
      }
      await tx`UPDATE service_requests SET status = 'PENDING_CUSTOMER_APPROVAL', updated_at = now() WHERE id = ${id}`;
      const cust = await tx`SELECT id FROM users WHERE tenant_id = ${u.tenantId} AND customer_id = ${s.customerId} AND is_active`;
      await notify(tx, u.tenantId, cust.map((x) => x.id as string), 'SR_ESTIMATE', `Estimasi ${s.code}: ${s.estimatedTokens} token`, 'Mohon persetujuan', '/portal/flexguard');
      await audit(tx, u, 'flexguard.sr_sent', 'service_request', id, null, null, req.ip);
      return { id, status: 'PENDING_CUSTOMER_APPROVAL', approvalRequired: false };
    });
  });

  /** Persetujuan customer → RESERVE token (H2: Reserve Man-Days). */
  const customerApprove = async (req: FastifyRequest, id: string) => {
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const s = await loadSr(u, id, tx, true);
      if (u.role === 'customer_user' && s.customerId !== u.customerId) throw notFound('Service request');
      if (s.status !== 'PENDING_CUSTOMER_APPROVAL') throw unprocessable(`Service request berstatus ${s.status}`);
      const tokens = Number(s.estimatedTokens);
      const r = await post(tx, { tenantId: u.tenantId, walletId: s.walletId, type: 'RESERVE', delta: { available: -tokens, reserved: tokens }, reason: `Reservasi ${s.code}`,
        userId: u.id, serviceRequestId: id, idempotencyKey: `sr:${id}:reserve` });
      await tx`UPDATE service_requests SET status = 'APPROVED', reserved_tokens = ${tokens}, customer_approved_by = ${u.id}, customer_approved_at = now(), updated_at = now() WHERE id = ${id}`;
      await audit(tx, u, 'flexguard.sr_customer_approved', 'service_request', id, null, { reserved: tokens, txId: r.tx.id }, req.ip);
      return { id, status: 'APPROVED', reserved: tokens, wallet: { available: r.wallet.available, reserved: r.wallet.reserved } };
    });
  };

  app.post('/api/v1/flexguard/requests/:id/start', { ...auth, preValidation: requirePerm('flexguard.deliver') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ pmId: z.string().uuid() }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const s = await loadSr(u, id, tx, true);
      if (s.status !== 'APPROVED') throw unprocessable('Service request belum disetujui customer');
      const [pm] = await tx`SELECT role FROM users WHERE id = ${b.pmId} AND tenant_id = ${u.tenantId} AND is_active`;
      if (!pm || pm.role !== 'project_manager') throw badRequest('PM harus role project_manager');
      await tx`UPDATE service_requests SET status = 'IN_PROGRESS', assigned_pm_id = ${b.pmId}, updated_at = now() WHERE id = ${id}`;
      await audit(tx, u, 'flexguard.sr_start', 'service_request', id, null, { pmId: b.pmId }, req.ip);
      return { id, status: 'IN_PROGRESS' };
    });
  });

  app.post('/api/v1/flexguard/requests/:id/timesheets', { ...auth, preValidation: requirePerm('flexguard.timesheet') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ workDate: z.string().date(), role: z.string(), md: z.number().positive().max(1.5), note: z.string().max(1000).optional(), evidence: z.string().max(500).optional() }).parse(req.body);
    const u = req.authUser;
    const s = await loadSr(u, id);
    if (s.status !== 'IN_PROGRESS') throw unprocessable('Timesheet hanya untuk service request IN_PROGRESS');
    const pol = await policy(u.tenantId);
    if (pol.params.tdc[b.role] === undefined) throw badRequest('Peran tidak dikenal');
    if (new Date(b.workDate) > new Date()) throw badRequest('Tanggal kerja tidak boleh di masa depan');
    const [row] = await sql`INSERT INTO service_timesheets (tenant_id, service_request_id, user_id, work_date, role, md, note, evidence)
      VALUES (${u.tenantId}, ${id}, ${u.id}, ${b.workDate}, ${b.role}, ${b.md}, ${b.note ?? null}, ${b.evidence ?? null}) RETURNING *`;
    reply.code(201);
    return row;
  });

  app.post('/api/v1/flexguard/requests/:id/timesheets/:tid/decide', { ...auth, preValidation: requirePerm('flexguard.deliver') }, async (req) => {
    const { id, tid } = z.object({ id: z.string().uuid(), tid: z.string().uuid() }).parse(req.params);
    const b = z.object({ decision: z.enum(['APPROVE', 'REJECT']) }).parse(req.body);
    const u = req.authUser;
    const [t] = await sql`SELECT * FROM service_timesheets WHERE id = ${tid} AND service_request_id = ${id} AND tenant_id = ${u.tenantId}`;
    if (!t) throw notFound('Timesheet');
    if (t.userId === u.id) throw forbidden('Maker-checker: timesheet tidak boleh disetujui pembuatnya');
    if (t.status !== 'SUBMITTED') throw conflict('Timesheet sudah diputuskan');
    const [row] = await sql`UPDATE service_timesheets SET status = ${b.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED'}, approved_by = ${u.id}, approved_at = now() WHERE id = ${tid} RETURNING *`;
    await audit(sql, u, 'flexguard.timesheet_decide', 'service_request', id, null, { tid, decision: b.decision }, req.ip);
    return row;
  });

  /** Validasi realisasi: token aktual = Σ MD timesheet disetujui × TDC × pengali estimasi. */
  app.post('/api/v1/flexguard/requests/:id/deliver', { ...auth, preValidation: requirePerm('flexguard.deliver') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ deliverableRef: z.string().min(3).max(500) }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const s = await loadSr(u, id, tx, true);
      if (s.status !== 'IN_PROGRESS') throw unprocessable(`Service request berstatus ${s.status}`);
      const pending = await tx`SELECT 1 FROM service_timesheets WHERE service_request_id = ${id} AND status = 'SUBMITTED' LIMIT 1`;
      if (pending.length) throw unprocessable('Masih ada timesheet yang belum diputuskan');
      const ts = await tx`SELECT role, sum(md)::float AS md FROM service_timesheets WHERE service_request_id = ${id} AND status = 'APPROVED' GROUP BY role`;
      if (!ts.length) throw unprocessable('Tidak ada timesheet disetujui');
      const pol = await policy(u.tenantId, tx);
      const est = s.estimate as { multipliers: { location: number; urgency: number } };
      const e = estimateTokens(pol.params, ts.map((t) => ({ role: t.role as string, md: Number(t.md) })), { overseas: est.multipliers.location > 1, overseasMultiplier: est.multipliers.location, rush: est.multipliers.urgency > 1 });
      const variancePct = r2(((e.tokens - Number(s.reservedTokens)) / Number(s.reservedTokens)) * 100);
      await tx`UPDATE service_requests SET status = 'DELIVERED', actual_tokens = ${e.tokens},
        estimate = estimate || ${tx.json({ actual: { lines: e.lines.map(({ internalCost: _c, ...l }) => l), tokens: e.tokens, variancePct, deliverableRef: b.deliverableRef } } as never)},
        updated_at = now() WHERE id = ${id}`;
      const cust = await tx`SELECT id FROM users WHERE tenant_id = ${u.tenantId} AND customer_id = ${s.customerId} AND is_active`;
      await notify(tx, u.tenantId, cust.map((x) => x.id as string), 'SR_DELIVERED', `${s.code} selesai — konfirmasi BAST`, `Realisasi ${e.tokens} token (estimasi ${s.reservedTokens})`, '/portal/flexguard');
      await audit(tx, u, 'flexguard.sr_delivered', 'service_request', id, null, { actual: e.tokens, reserved: s.reservedTokens, variancePct }, req.ip);
      return { id, status: 'DELIVERED', actualTokens: e.tokens, reservedTokens: Number(s.reservedTokens), variancePct };
    });
  });

  /** BAST/acceptance customer → CONSUME (selisih dikembalikan / diambil dari saldo tersedia). */
  const customerAccept = async (req: FastifyRequest, id: string) => {
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const s = await loadSr(u, id, tx, true);
      if (s.status !== 'DELIVERED') throw unprocessable(`Service request berstatus ${s.status}`);
      const reserved = Number(s.reservedTokens); const actual = Number(s.actualTokens);
      const r = await post(tx, { tenantId: u.tenantId, walletId: s.walletId, type: 'CONSUME', delta: { reserved: -reserved, consumed: actual, available: r2(reserved - actual) },
        reason: `Debit final ${s.code} (BAST)`, userId: u.id, serviceRequestId: id, idempotencyKey: `sr:${id}:consume`, allowInactive: true });
      await tx`UPDATE service_requests SET status = 'COMPLETED', delivery_accepted_by = ${u.id}, delivery_accepted_at = now(), updated_at = now() WHERE id = ${id}`;
      await audit(tx, u, 'flexguard.sr_accepted', 'service_request', id, null, { consumed: actual, released: r2(reserved - actual), txId: r.tx.id }, req.ip);
      return { id, status: 'COMPLETED', consumed: actual, wallet: { available: r.wallet.available, reserved: r.wallet.reserved, consumed: r.wallet.consumed } };
    });
  };

  const customerDispute = async (req: FastifyRequest, id: string, note: string) => {
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const s = await loadSr(u, id, tx, true);
      if (s.status !== 'DELIVERED') throw unprocessable('Sengketa hanya untuk hasil yang sudah diserahkan');
      await tx`UPDATE service_requests SET status = 'DISPUTED', dispute_note = ${note}, updated_at = now() WHERE id = ${id}`;
      const am = await tx`SELECT id FROM users WHERE tenant_id = ${u.tenantId} AND is_active AND role IN ('sales_manager','account_manager')`;
      await notify(tx, u.tenantId, am.map((x) => x.id as string), 'SR_DISPUTE', `Sengketa ${s.code}`, note, `/flexguard/requests/${id}`);
      await audit(tx, u, 'flexguard.sr_dispute', 'service_request', id, null, { note }, req.ip);
      return { id, status: 'DISPUTED' };
    });
  };

  /** Penyelesaian sengketa (Sales Manager): koreksi realisasi lalu kembali ke DELIVERED untuk konfirmasi customer. */
  app.post('/api/v1/flexguard/requests/:id/resolve-dispute', { ...auth, preValidation: requirePerm('approval.decide') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ actualTokens: z.number().min(0), resolution: z.string().min(10).max(2000) }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const s = await loadSr(u, id, tx, true);
      if (s.status !== 'DISPUTED') throw unprocessable('Service request tidak dalam sengketa');
      if (b.actualTokens > Number(s.actualTokens)) throw unprocessable('Penyelesaian sengketa tidak boleh menaikkan realisasi');
      await tx`UPDATE service_requests SET status = 'DELIVERED', actual_tokens = ${b.actualTokens},
        estimate = estimate || ${tx.json({ disputeResolution: { from: s.actualTokens, to: b.actualTokens, by: u.fullName, resolution: b.resolution } } as never)}, updated_at = now() WHERE id = ${id}`;
      await audit(tx, u, 'flexguard.sr_dispute_resolved', 'service_request', id, { actual: s.actualTokens }, { actual: b.actualTokens, resolution: b.resolution }, req.ip);
      return { id, status: 'DELIVERED', actualTokens: b.actualTokens };
    });
  });

  /** Pembatalan sebelum delivery → RELEASE; biaya scoping maks 1 token bila scoping sudah dikerjakan. */
  app.post('/api/v1/flexguard/requests/:id/cancel', { ...auth, preValidation: W }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ reason: z.string().min(5).max(500), scopingFeeTokens: z.number().min(0).max(1).default(0) }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const s = await loadSr(u, id, tx, true);
      if (!['SUBMITTED', 'SCOPED', 'PENDING_CUSTOMER_APPROVAL', 'APPROVED'].includes(s.status)) throw unprocessable(`Tidak dapat dibatalkan pada status ${s.status}`);
      const reserved = Number(s.reservedTokens);
      if (reserved > 0) {
        const fee = Math.min(b.scopingFeeTokens, reserved);
        await post(tx, { tenantId: u.tenantId, walletId: s.walletId, type: fee > 0 ? 'CONSUME' : 'RELEASE', delta: { reserved: -reserved, consumed: fee, available: r2(reserved - fee) },
          reason: `Pembatalan ${s.code}${fee ? ` (biaya scoping ${fee} token)` : ''}: ${b.reason}`, userId: u.id, serviceRequestId: id, idempotencyKey: `sr:${id}:cancel`, allowInactive: true });
      }
      await tx`UPDATE service_requests SET status = 'CANCELLED', reserved_tokens = 0, updated_at = now() WHERE id = ${id}`;
      await audit(tx, u, 'flexguard.sr_cancel', 'service_request', id, null, b, req.ip);
      return { id, status: 'CANCELLED' };
    });
  });

  app.post('/api/v1/flexguard/requests/:id/customer-approve', { ...auth, preValidation: W }, async (req) => {
    // Persetujuan atas nama customer oleh staf internal hanya dengan bukti tertulis (mis. email/PO)
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    z.object({ evidenceRef: z.string().min(5).max(500) }).parse(req.body);
    return customerApprove(req, id);
  });

  /* ───── Portal customer ───── */
  const portal = { onRequest: [app.authenticate], preValidation: requirePerm('portal.access') };
  app.get('/api/v1/portal/flexguard', portal, async (req) => {
    const u = req.authUser;
    const wallets = await sql`SELECT id, code, package, status, valid_from, valid_until, price_per_token, credited_tokens, available_tokens, reserved_tokens, consumed_tokens, expired_tokens, complimentary
                              FROM flexguard_wallets WHERE tenant_id = ${u.tenantId} AND customer_id = ${u.customerId} ORDER BY created_at DESC`;
    const requests = await sql`SELECT id, code, title, service_line, status, estimated_tokens, reserved_tokens, actual_tokens, estimate->'actual'->>'deliverableRef' AS deliverable_ref, updated_at
                               FROM service_requests WHERE tenant_id = ${u.tenantId} AND customer_id = ${u.customerId} ORDER BY created_at DESC`;
    const pol = await policy(u.tenantId);
    return { wallets, requests, serviceLines: pol.params.serviceLines };
  });
  app.get('/api/v1/portal/flexguard/wallets/:id/ledger', portal, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const w = await loadWallet(req.authUser, id);
    const rows = await sql`SELECT t.id, t.type, t.d_available, t.d_reserved, t.d_consumed, t.d_credited, t.d_expired, t.reason, t.created_at, s.code AS sr_code
                           FROM wallet_transactions t LEFT JOIN service_requests s ON s.id = t.service_request_id WHERE t.wallet_id = ${id} ORDER BY t.id DESC LIMIT 500`;
    return { wallet: { code: w.code, available: w.availableTokens, reserved: w.reservedTokens, consumed: w.consumedTokens, validUntil: w.validUntil }, ledger: rows };
  });
  app.post('/api/v1/portal/flexguard/requests', portal, async (req, reply) => {
    const b = SrBody.parse(req.body);
    const u = req.authUser;
    reply.code(201);
    const s = await sql.begin((tx) => createSr(tx, u, b, u.customerId!));
    return { id: s.id, code: s.code, status: s.status };
  });
  app.post('/api/v1/portal/flexguard/requests/:id/approve', portal, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return idempotent(req, reply, 200, () => customerApprove(req, id));
  });
  app.post('/api/v1/portal/flexguard/requests/:id/accept', portal, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return idempotent(req, reply, 200, () => customerAccept(req, id));
  });
  app.post('/api/v1/portal/flexguard/requests/:id/dispute', portal, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ note: z.string().min(10).max(2000) }).parse(req.body);
    return customerDispute(req, id, b.note);
  });
}

export async function expireWallets(sql: any, tenantId: string | null, userId: string | null) {
  const due = await sql`SELECT id, tenant_id, code, available_tokens, rollover_allowed FROM flexguard_wallets WHERE status = 'ACTIVE' AND valid_until < current_date
                        ${tenantId ? sql`AND tenant_id = ${tenantId}` : sql``}`;
  let expired = 0;
  for (const w of due) {
    await sql.begin(async (tx: Tx) => {
      if (Number(w.availableTokens) > 0) {
        await post(tx, { tenantId: w.tenantId, walletId: w.id, type: 'EXPIRE', delta: { available: -Number(w.availableTokens), expired: Number(w.availableTokens) },
          reason: `Masa berlaku berakhir${w.rolloverAllowed ? ' (rollover tidak diajukan)' : ''}`, userId, idempotencyKey: `expire:${w.id}`, allowInactive: true });
      }
      await tx`UPDATE flexguard_wallets SET status = 'EXPIRED' WHERE id = ${w.id}`;
    });
    expired++;
  }
  return { expired };
}
