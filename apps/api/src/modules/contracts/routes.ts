import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { Tx } from '../../db.js';
import { audit, nextNumber, notify, requirePerm } from '../../lib/context.js';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { idempotent } from '../../lib/idempotency.js';
import { enqueue } from '../../lib/jobs.js';
import { can } from '../../lib/rbac.js';
import { createApprovalRequest, effectiveLevel, loadCurrentPolicy, registerApprovalHandler, supersedeOpenRequests } from '../approvals/engine.js';
import { sniffDoc } from '../documents/routes.js';
import type { FlexguardPolicy } from '../pricing/policy-defaults.js';
import { complimentaryFor, packageFor } from '../flexguard/engine.js';
import { post } from '../flexguard/ledger.js';
import { PDFDocument } from 'pdf-lib';
import { readStoredFile, storeFile } from '../../lib/storage.js';
import { availableProviders, getProvider, resolveProvider } from './esign.js';

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const r2 = (n: number) => Math.round(n * 100) / 100;
const addMonths = (d: Date, m: number) => { const x = new Date(d); x.setMonth(x.getMonth() + m); return x; };
const iso = (d: Date) => d.toISOString().slice(0, 10);

export const LEGAL_CHECKLIST = ['identitas_para_pihak', 'ruang_lingkup_sesuai_penawaran', 'nilai_dan_pajak', 'termin_pembayaran', 'sla_dan_denda',
  'kerahasiaan_nda', 'pelindungan_data_pribadi', 'hak_kekayaan_intelektual', 'force_majeure', 'penyelesaian_sengketa'] as const;

const FlexguardTerms = z.object({ tokens: z.number().positive(), pricePerToken: z.number().positive(), validMonths: z.number().int().min(1).max(60).optional(), rollover: z.boolean().optional() });
const ContractBody = z.object({
  contractType: z.enum(['PROJECT', 'MANAGED_SERVICE', 'FLEXGUARD', 'LICENSE']).default('PROJECT'),
  title: z.string().min(3).max(300).optional(),
  value: z.number().min(0).optional(),
  startDate: z.string().date(),
  endDate: z.string().date(),
  paymentTerms: z.string().min(3).max(500).optional(),
  slaTerms: z.string().max(4000).optional(),
  penaltyTerms: z.string().max(1000).optional(),
  flexguard: FlexguardTerms.optional(),
});

/** Jadwal kewajiban pembayaran dari teks termin ("30% DP, 50% progress, 20% BAST") atau MRC bulanan. */
export function paymentSchedule(type: string, terms: string, value: number, start: string, end: string) {
  const out: { description: string; percent: number | null; amount: number; dueDate: string | null }[] = [];
  if (type === 'MANAGED_SERVICE') {
    const s = new Date(start); const e = new Date(end);
    const months = Math.max(1, (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()) + (e.getDate() >= s.getDate() ? 1 : 0));
    const per = r2(value / months);
    for (let i = 0; i < months; i++) out.push({ description: `Tagihan bulanan ke-${i + 1}`, percent: null, amount: i === months - 1 ? r2(value - per * (months - 1)) : per, dueDate: iso(addMonths(s, i + 1)) });
    return out;
  }
  if (type === 'FLEXGUARD') return [{ description: 'Pembayaran token di muka (100%)', percent: 100, amount: value, dueDate: start }];
  const parts = [...terms.matchAll(/(\d{1,3}(?:[.,]\d+)?)\s*%\s*([^,;]*)/g)].map((m) => ({ pct: Number(m[1].replace(',', '.')), label: m[2].trim() || 'Termin' }));
  const total = parts.reduce((s, p) => s + p.pct, 0);
  if (!parts.length || Math.abs(total - 100) > 0.01) return [{ description: `Pembayaran sesuai termin: ${terms}`, percent: 100, amount: value, dueDate: null }];
  let acc = 0;
  parts.forEach((p, i) => {
    const amount = i === parts.length - 1 ? r2(value - acc) : r2((value * p.pct) / 100);
    acc += amount;
    out.push({ description: `Termin ${i + 1}: ${p.pct}% ${p.label}`, percent: p.pct, amount, dueDate: i === 0 ? start : i === parts.length - 1 ? end : null });
  });
  return out;
}

async function contractHash(tx: Tx | any, id: string) {
  const [c] = await tx`SELECT c.number, c.customer_id, c.contract_type, c.title, c.value, c.tax_rate, c.start_date, c.end_date, c.payment_terms, c.sla_terms, c.penalty_terms, c.flexguard, c.row_version,
      d.sha256 AS final_document_sha256 FROM contracts c LEFT JOIN documents d ON d.id = c.final_document_id WHERE c.id = ${id}`;
  if (!c.finalDocumentSha256) delete c.finalDocumentSha256; // kompatibel dengan otorisasi yang dibuat sebelum dokumen final ada
  return createHash('sha256').update(JSON.stringify(c)).digest('hex');
}

/** Aktivasi: proyek (handover) + wallet FlexGuard + opportunity WON. */
async function activate(tx: Tx, u: { id: string; tenantId: string }, c: Record<string, any>) {
  await tx`UPDATE contracts SET status = 'ACTIVE', activated_at = now(), updated_at = now() WHERE id = ${c.id}`;
  if (c.opportunityId) {
    const [o] = await tx`SELECT stage FROM opportunities WHERE id = ${c.opportunityId}`;
    if (o && !['WON', 'LOST'].includes(o.stage as string)) {
      await tx`UPDATE opportunities SET stage = 'WON', probability = 100, stage_changed_at = now(), updated_at = now() WHERE id = ${c.opportunityId}`;
      await tx`INSERT INTO opportunity_stage_history (tenant_id, opportunity_id, from_stage, to_stage, changed_by) VALUES (${u.tenantId}, ${c.opportunityId}, ${o.stage}, 'WON', ${u.id})`;
    }
  }
  // Budget proyek dari pricing scenario quotation (bila ada)
  let budgetCost: number | null = null; let budgetMd: number | null = null;
  if (c.quotationId) {
    const [s] = await tx`SELECT ps.result FROM quotations q JOIN pricing_scenarios ps ON ps.id = q.scenario_id WHERE q.id = ${c.quotationId}`;
    if (s) {
      const r = s.result as any;
      budgetCost = r.boq?.totalCost ?? null;
      budgetMd = (r.boq?.A_humanResources?.lines ?? []).reduce((x: number, l: any) => x + Number(l.md), 0) || null;
    }
  }
  const year = new Date().getFullYear();
  const n = await nextNumber(tx, u.tenantId, 'PROJECT', String(year));
  const handover = {
    items: [
      { key: 'scope_baseline', label: 'Baseline scope (proposal/quotation/SOW) diterima PM', done: false },
      { key: 'boq_budget', label: 'BoQ internal & budget effort diterima PM', done: !!budgetCost },
      { key: 'customer_pic', label: 'PIC teknis & eskalasi customer terkonfirmasi', done: false },
      { key: 'access_requirements', label: 'Kebutuhan akses/izin (RoE, NDA, akun uji) diidentifikasi', done: false },
      { key: 'schedule', label: 'Jadwal & milestone awal disepakati', done: false },
      { key: 'risks', label: 'Risiko & asumsi dari pre-sales diserahkan', done: false },
    ],
  };
  const [p] = await tx`INSERT INTO projects (tenant_id, code, name, contract_id, customer_id, opportunity_id, status, start_date, end_date, contract_value, budget_cost, budget_md, handover, created_by)
    VALUES (${u.tenantId}, ${`PRJ-${year}-${String(n).padStart(4, '0')}`}, ${c.title}, ${c.id}, ${c.customerId}, ${c.opportunityId ?? null}, 'HANDOVER', ${c.startDate}, ${c.endDate},
            ${c.value}, ${budgetCost}, ${budgetMd}, ${tx.json(handover as never)}, ${u.id}) RETURNING id, code`;
  const obligations = await tx`SELECT * FROM contract_obligations WHERE contract_id = ${c.id} AND kind IN ('PAYMENT','DELIVERABLE') ORDER BY seq`;
  let seq = 0;
  for (const ob of obligations) {
    await tx`INSERT INTO project_milestones (tenant_id, project_id, seq, name, due_date, billing_pct, billing_amount, obligation_id)
             VALUES (${u.tenantId}, ${p.id}, ${++seq}, ${ob.description}, ${ob.dueDate}, ${ob.percent}, ${ob.amount}, ${ob.id})`;
  }
  let walletId: string | null = null;
  if (c.contractType === 'FLEXGUARD' && c.flexguard) {
    const fg = c.flexguard as { tokens: number; pricePerToken: number; validMonths?: number; rollover?: boolean };
    const pol = await loadCurrentPolicy<FlexguardPolicy>(tx, u.tenantId, 'FLEXGUARD');
    const pkg = packageFor(pol.params, fg.tokens);
    const listPrice = pkg?.price ?? pol.params.trv;
    const special = fg.pricePerToken !== listPrice;
    const bonus = special ? 0 : r2((fg.tokens * (pkg?.bonusPct ?? 0)) / 100);
    const validMonths = fg.validMonths ?? pkg?.validMonths ?? 12;
    const wn = await nextNumber(tx, u.tenantId, 'WALLET', 'ALL');
    const start = new Date(c.startDate);
    const [w] = await tx`INSERT INTO flexguard_wallets (tenant_id, code, customer_id, contract_id, package, price_per_token, valid_from, valid_until, rollover_allowed, low_balance_pct, complimentary, created_by)
      VALUES (${u.tenantId}, ${`FGW-${String(wn).padStart(5, '0')}`}, ${c.customerId}, ${c.id}, ${special ? `${pkg?.package ?? 'Custom'} (special)` : pkg?.package ?? 'Custom'},
              ${fg.pricePerToken}, ${c.startDate}, ${iso(addMonths(start, validMonths))}, ${fg.rollover ?? pkg?.rollover ?? false}, ${pol.params.lowBalancePct},
              ${tx.json(complimentaryFor(pol.params, fg.tokens).map((item) => ({ item, status: 'AVAILABLE', redeemBy: iso(addMonths(start, pol.params.complimentaryRedeemMonths)) })) as never)}, ${u.id})
      RETURNING id`;
    walletId = w.id as string;
    await post(tx, { tenantId: u.tenantId, walletId, type: 'FUND', delta: { available: fg.tokens, credited: fg.tokens }, reason: `Aktivasi kontrak ${c.number}`, userId: u.id,
      idempotencyKey: `contract:${c.id}:fund`, valueIdr: r2(fg.tokens * fg.pricePerToken) });
    if (bonus > 0) await post(tx, { tenantId: u.tenantId, walletId, type: 'BONUS', delta: { available: bonus, credited: bonus }, reason: `Token booster ${pkg?.bonusPct}% (${pkg?.package})`,
      userId: u.id, idempotencyKey: `contract:${c.id}:bonus`, valueIdr: 0 });
  }
  const notifyUsers = await tx`SELECT id FROM users WHERE tenant_id = ${u.tenantId} AND is_active AND role IN ('project_manager','legal','pricing_finance')`;
  await notify(tx, u.tenantId, notifyUsers.map((x) => x.id as string), 'CONTRACT_ACTIVE', `Kontrak ${c.number} aktif`, `Proyek ${p.code} dibuat — lakukan handover`, `/projects/${p.id}`);
  await audit(tx, u, 'contract.activate', 'contract', c.id, { status: 'PENDING_SIGNATURE' }, { status: 'ACTIVE', projectId: p.id, walletId });
  return { projectId: p.id as string, projectCode: p.code as string, walletId };
}

registerApprovalHandler('contract', async (tx, u, ar, finalStatus) => {
  const status = finalStatus === 'APPROVED' ? 'PENDING_SIGNATURE' : 'DRAFT';
  await tx`UPDATE contracts SET status = ${status}, updated_at = now() WHERE id = ${ar.entityId as string} AND tenant_id = ${u.tenantId}`;
  const [c] = await tx`SELECT number, created_by FROM contracts WHERE id = ${ar.entityId as string}`;
  await notify(tx, u.tenantId, [c.createdBy as string], 'CONTRACT_APPROVAL', `Kontrak ${c.number}: ${finalStatus}`, status === 'PENDING_SIGNATURE' ? 'Lanjutkan penandatanganan' : 'Perlu revisi', `/contracts/${ar.entityId}`);
});

const pollers = new Map<unknown, (s: Record<string, any>) => Promise<unknown>>();
/** Job terjadwal: tarik status envelope e-sign yang masih PENDING (VIDA tidak menyediakan webhook pada VSP OpenAPI). */
export async function pollEsignSignatures(sql: any) {
  const poll = pollers.get(sql);
  if (!poll) return { polled: 0, changed: 0 };
  const rows = await sql`SELECT * FROM contract_signatures WHERE status = 'PENDING' AND method = 'ESIGN_PROVIDER' AND provider <> 'sandbox' ORDER BY created_at LIMIT 50`;
  let changed = 0;
  for (const r of rows) { try { const out = await poll(r) as { changed?: boolean }; if (out.changed) changed++; } catch { /* dicoba lagi pada tick berikutnya */ } }
  return { polled: rows.length, changed };
}

export async function contractRoutes(app: FastifyInstance) {
  const sql = app.sql;
  const auth = { onRequest: [app.authenticate] };
  const R = requirePerm('contract.read');
  const W = requirePerm('contract.write');
  const DOC_DIR = () => resolve(process.env.DOCUMENT_DIR ?? process.env.UPLOAD_DIR ?? './storage/uploads', 'documents');

  const load = async (tenantId: string, id: string, db: any = sql, lock = false) => {
    const [c] = lock ? await db`SELECT * FROM contracts WHERE id = ${id} AND tenant_id = ${tenantId} FOR UPDATE`
      : await db`SELECT c.*, cu.legal_name AS customer_name, cr.full_name AS created_by_name, lr.full_name AS legal_reviewed_by_name
               FROM contracts c JOIN customers cu ON cu.id = c.customer_id LEFT JOIN users cr ON cr.id = c.created_by LEFT JOIN users lr ON lr.id = c.legal_reviewed_by
               WHERE c.id = ${id} AND c.tenant_id = ${tenantId}`;
    if (!c) throw notFound('Kontrak');
    return c as Record<string, any>;
  };

  const createContract = async (tx: Tx, u: { id: string; tenantId: string }, src: { customerId: string; opportunityId?: string | null; quotationId?: string | null; tenderId?: string | null;
    title: string; value: number; taxRate?: number; paymentTerms: string; deliverables?: string[] }, b: z.infer<typeof ContractBody>) => {
    if (b.contractType === 'FLEXGUARD') {
      if (!b.flexguard) throw badRequest('Parameter FlexGuard (tokens, pricePerToken) wajib untuk kontrak FLEXGUARD');
      const expected = r2(b.flexguard.tokens * b.flexguard.pricePerToken);
      if (Math.abs(expected - src.value) > 1) throw unprocessable(`Nilai kontrak (${src.value}) tidak sama dengan token × harga (${expected})`);
    }
    const now = new Date();
    const n = await nextNumber(tx, u.tenantId, 'CONTRACT', String(now.getFullYear()));
    const number = `${String(n).padStart(3, '0')}/DEIT-PKS/${ROMAN[now.getMonth()]}/${now.getFullYear()}`;
    const [c] = await tx`INSERT INTO contracts (tenant_id, number, customer_id, opportunity_id, quotation_id, tender_id, contract_type, title, value, tax_rate, start_date, end_date,
        payment_terms, sla_terms, penalty_terms, flexguard, legal_checklist, created_by)
      VALUES (${u.tenantId}, ${number}, ${src.customerId}, ${src.opportunityId ?? null}, ${src.quotationId ?? null}, ${src.tenderId ?? null}, ${b.contractType}, ${b.title ?? src.title},
        ${src.value}, ${src.taxRate ?? 11}, ${b.startDate}, ${b.endDate}, ${b.paymentTerms ?? src.paymentTerms}, ${b.slaTerms ?? null},
        ${b.penaltyTerms ?? 'Denda keterlambatan 1‰ per hari, maksimal 5% dari nilai termin terkait'}, ${b.flexguard ? tx.json(b.flexguard as never) : null},
        ${tx.json(Object.fromEntries(LEGAL_CHECKLIST.map((k) => [k, false])) as never)}, ${u.id}) RETURNING *`;
    const sched = paymentSchedule(b.contractType, c.paymentTerms as string, Number(c.value), b.startDate, b.endDate);
    let seq = 0;
    for (const s of sched) await tx`INSERT INTO contract_obligations (tenant_id, contract_id, kind, description, due_date, amount, percent, seq) VALUES (${u.tenantId}, ${c.id}, 'PAYMENT', ${s.description}, ${s.dueDate}, ${s.amount}, ${s.percent}, ${++seq})`;
    for (const d of src.deliverables ?? []) await tx`INSERT INTO contract_obligations (tenant_id, contract_id, kind, description, seq) VALUES (${u.tenantId}, ${c.id}, 'DELIVERABLE', ${d}, ${++seq})`;
    const renewal = addMonths(new Date(b.endDate), -3);
    await tx`INSERT INTO contract_obligations (tenant_id, contract_id, kind, description, due_date, seq) VALUES (${u.tenantId}, ${c.id}, 'RENEWAL', 'Review renewal H-90', ${iso(renewal)}, ${++seq})`;
    await audit(tx, u, 'contract.create', 'contract', c.id as string, null, { number, source: src.quotationId ? 'quotation' : src.tenderId ? 'tender' : 'manual', value: c.value });
    return c;
  };

  app.get('/api/v1/contracts', { ...auth, preValidation: R }, async (req) => {
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    const rows = await sql`SELECT c.id, c.number, c.title, c.contract_type, c.status, c.value, c.start_date, c.end_date, c.updated_at, cu.legal_name AS customer_name,
        (SELECT p.code FROM projects p WHERE p.contract_id = c.id) AS project_code
      FROM contracts c JOIN customers cu ON cu.id = c.customer_id WHERE c.tenant_id = ${req.authUser.tenantId} ${q.status ? sql`AND c.status = ${q.status}` : sql``}
      ORDER BY c.updated_at DESC LIMIT 200`;
    return { items: rows };
  });

  app.post('/api/v1/contracts/from-quotation/:quotationId', { ...auth, preValidation: W }, async (req, reply) => {
    const { quotationId } = z.object({ quotationId: z.string().uuid() }).parse(req.params);
    const b = ContractBody.parse(req.body);
    const u = req.authUser;
    return idempotent(req, reply, 201, () => sql.begin(async (tx) => {
      const [q] = await tx`SELECT * FROM quotations WHERE id = ${quotationId} AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!q) throw notFound('Quotation');
      if (q.status !== 'ACCEPTED') throw unprocessable('Kontrak hanya dapat dibuat dari quotation berstatus ACCEPTED');
      const [exists] = await tx`SELECT number FROM contracts WHERE quotation_id = ${quotationId} AND status <> 'CANCELLED'`;
      if (exists) throw conflict(`Quotation sudah memiliki kontrak ${exists.number}`);
      const lines = await tx`SELECT description FROM quotation_lines WHERE quotation_id = ${quotationId} ORDER BY line_no`;
      return createContract(tx, u, { customerId: q.customerId as string, opportunityId: q.opportunityId as string, quotationId, title: q.title as string,
        value: Number(q.totalBeforeTax), taxRate: Number(q.taxRate), paymentTerms: q.paymentTerms as string, deliverables: lines.map((l) => l.description as string) }, b);
    }));
  });

  app.post('/api/v1/contracts/from-tender/:tenderId', { ...auth, preValidation: W }, async (req, reply) => {
    const { tenderId } = z.object({ tenderId: z.string().uuid() }).parse(req.params);
    const b = ContractBody.extend({ value: z.number().positive(), paymentTerms: z.string().min(3).max(500) }).parse(req.body);
    const u = req.authUser;
    return idempotent(req, reply, 201, () => sql.begin(async (tx) => {
      const [t] = await tx`SELECT * FROM tenders WHERE id = ${tenderId} AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!t) throw notFound('Tender');
      if (!['AWARDED', 'CONTRACTING'].includes(t.status as string)) throw unprocessable('Kontrak tender hanya untuk status AWARDED/CONTRACTING');
      if (!t.customerId) throw unprocessable('Tender belum terhubung ke customer');
      const [exists] = await tx`SELECT number FROM contracts WHERE tender_id = ${tenderId} AND status <> 'CANCELLED'`;
      if (exists) throw conflict(`Tender sudah memiliki kontrak ${exists.number}`);
      if (t.hpsValue && b.value > Number(t.hpsValue)) throw unprocessable('Nilai kontrak melebihi HPS');
      return createContract(tx, u, { customerId: t.customerId as string, opportunityId: t.opportunityId as string, tenderId, title: t.title as string, value: b.value, paymentTerms: b.paymentTerms }, b);
    }));
  });

  app.get('/api/v1/contracts/:id', { ...auth, preValidation: R }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    const c = await load(u.tenantId, id);
    const [obligations, signatures, approvals, projects, wallets] = await Promise.all([
      sql`SELECT * FROM contract_obligations WHERE contract_id = ${id} ORDER BY seq`,
      sql`SELECT s.*, vu.full_name AS verified_by_name FROM contract_signatures s LEFT JOIN users vu ON vu.id = s.verified_by WHERE s.contract_id = ${id} ORDER BY s.created_at`,
      sql`SELECT id, status, required_level, created_at, decided_at FROM approval_requests WHERE tenant_id = ${u.tenantId} AND entity_type = 'contract' AND entity_id = ${id} ORDER BY created_at DESC`,
      sql`SELECT id, code, status FROM projects WHERE contract_id = ${id}`,
      sql`SELECT id, code, available_tokens, credited_tokens FROM flexguard_wallets WHERE contract_id = ${id}`,
    ]);
    const [finalDocument] = c.finalDocumentId ? await sql`SELECT id, filename, sha256, page_count, size_original, created_at FROM documents WHERE id = ${c.finalDocumentId}` : [];
    return { contract: c, obligations, signatures, approvals, project: projects[0] ?? null, wallet: wallets[0] ?? null, legalChecklistKeys: LEGAL_CHECKLIST,
      esignProviders: await availableProviders(sql, u.tenantId), finalDocument: finalDocument ?? null, contractHash: await contractHash(sql, id) };
  });

  app.put('/api/v1/contracts/:id', { ...auth, preValidation: W }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = ContractBody.partial().extend({ rowVersion: z.number().int() }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const c = await load(u.tenantId, id, tx, true);
      if (c.rowVersion !== b.rowVersion) throw conflict('Kontrak telah diubah pengguna lain — muat ulang');
      if (!['DRAFT', 'LEGAL_REVIEW'].includes(c.status)) throw unprocessable(`Kontrak berstatus ${c.status} tidak dapat diubah`);
      if (b.value !== undefined && c.quotationId) throw unprocessable('Nilai kontrak dari quotation hanya dapat diubah melalui revisi quotation');
      const { rowVersion: _r, flexguard, ...rest } = b;
      const patch: Record<string, unknown> = { ...rest };
      if (flexguard) patch.flexguard = tx.json(flexguard as never);
      const cols = Object.keys(patch).filter((k) => patch[k] !== undefined);
      if (!cols.length) throw badRequest('Tidak ada perubahan');
      await tx`UPDATE contracts SET ${tx(patch, cols)}, status = 'DRAFT', legal_reviewed_by = NULL, legal_reviewed_at = NULL, row_version = row_version + 1, updated_at = now() WHERE id = ${id}`;
      if (b.paymentTerms || b.startDate || b.endDate || b.value !== undefined) {
        const [n] = await tx`SELECT * FROM contracts WHERE id = ${id}`;
        await tx`DELETE FROM contract_obligations WHERE contract_id = ${id} AND kind = 'PAYMENT'`;
        let seq = 100;
        for (const s of paymentSchedule(n.contractType as string, n.paymentTerms as string, Number(n.value), String(n.startDate).slice(0, 10), String(n.endDate).slice(0, 10))) {
          await tx`INSERT INTO contract_obligations (tenant_id, contract_id, kind, description, due_date, amount, percent, seq) VALUES (${u.tenantId}, ${id}, 'PAYMENT', ${s.description}, ${s.dueDate}, ${s.amount}, ${s.percent}, ${++seq})`;
        }
      }
      await audit(tx, u, 'contract.update', 'contract', id, { rowVersion: c.rowVersion }, { changed: cols }, req.ip);
      return load(u.tenantId, id, tx);
    });
  });

  app.post('/api/v1/contracts/:id/submit-legal', { ...auth, preValidation: W }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const c = await load(u.tenantId, id, tx, true);
      if (c.status !== 'DRAFT') throw unprocessable(`Kontrak berstatus ${c.status}`);
      await tx`UPDATE contracts SET status = 'LEGAL_REVIEW', updated_at = now() WHERE id = ${id}`;
      const legal = await tx`SELECT id FROM users WHERE tenant_id = ${u.tenantId} AND is_active AND role = 'legal'`;
      await notify(tx, u.tenantId, legal.map((x) => x.id as string), 'CONTRACT_LEGAL_REVIEW', `Review legal kontrak ${c.number}`, c.title, `/contracts/${id}`);
      await audit(tx, u, 'contract.submit_legal', 'contract', id, { status: 'DRAFT' }, { status: 'LEGAL_REVIEW' }, req.ip);
      return { id, status: 'LEGAL_REVIEW' };
    });
  });

  /** Legal mengisi checklist; bila lengkap → otomatis diajukan ke approval DoA nilai kontrak. */
  app.post('/api/v1/contracts/:id/legal-review', { ...auth, preValidation: requirePerm('contract.legal') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ checklist: z.record(z.enum(LEGAL_CHECKLIST), z.boolean()), note: z.string().max(2000).optional(), decision: z.enum(['APPROVE', 'RETURN']) }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const c = await load(u.tenantId, id, tx, true);
      if (c.status !== 'LEGAL_REVIEW') throw unprocessable('Kontrak tidak dalam tahap legal review');
      if (c.createdBy === u.id) throw forbidden('Segregation of Duties: pembuat kontrak tidak boleh mereview legal');
      const checklist = { ...(c.legalChecklist ?? {}), ...b.checklist };
      if (b.decision === 'RETURN') {
        if (!b.note) throw badRequest('Catatan wajib saat mengembalikan');
        await tx`UPDATE contracts SET status = 'DRAFT', legal_checklist = ${tx.json(checklist as never)}, updated_at = now() WHERE id = ${id}`;
        await notify(tx, u.tenantId, [c.createdBy], 'CONTRACT_LEGAL_RETURN', `Kontrak ${c.number} dikembalikan Legal`, b.note, `/contracts/${id}`);
        await audit(tx, u, 'contract.legal_return', 'contract', id, null, { note: b.note }, req.ip);
        return { id, status: 'DRAFT' };
      }
      const missing = LEGAL_CHECKLIST.filter((k) => !checklist[k]);
      if (missing.length) throw unprocessable('Checklist legal belum lengkap', { missing });
      await tx`UPDATE contracts SET legal_checklist = ${tx.json(checklist as never)}, legal_reviewed_by = ${u.id}, legal_reviewed_at = now(), status = 'IN_APPROVAL', updated_at = now() WHERE id = ${id}`;
      const warnings: string[] = [];
      let belowFloor = 0;
      if (c.contractType === 'FLEXGUARD' && c.flexguard) {
        const pol = await loadCurrentPolicy<FlexguardPolicy>(tx, u.tenantId, 'FLEXGUARD');
        const floorPerToken = Math.round((pol.params.internalRate.senior * (1 + pol.params.overheadRatio)) / pol.params.floorMarginDivisor);
        if (Number(c.flexguard.pricePerToken) < floorPerToken) {
          belowFloor = 1;
          warnings.push(`Harga token Rp${Number(c.flexguard.pricePerToken).toLocaleString('id-ID')} di bawah floor Rp${floorPerToken.toLocaleString('id-ID')} — special commercial deal`);
        }
        if (pol.status !== 'ACTIVE') warnings.push(`Kebijakan ${pol.code} v${pol.version} berstatus ${pol.status}`);
      }
      const { request, evaluation } = await createApprovalRequest(tx, { tenantId: u.tenantId, entityType: 'contract', entityId: id, entityVersion: c.rowVersion, requestedBy: c.createdBy,
        metrics: { contractValue: Number(c.value), belowFloor } as never,
        summary: { title: `Kontrak ${c.number} — ${c.title}`, totalBeforeTax: Number(c.value), discountPct: 0, contractType: c.contractType, warnings } });
      await audit(tx, u, 'contract.legal_approved', 'contract', id, null, { approvalRequestId: request.id, requiredLevel: evaluation.requiredLevel }, req.ip);
      return { id, status: 'IN_APPROVAL', approvalRequestId: request.id, requiredLevel: evaluation.requiredLevel, steps: evaluation.steps };
    });
  });

  /** Otorisasi internal (pejabat berwenang ≥ level approval kontrak, bukan pembuat). Bukan TTE tersertifikasi. */
  app.post('/api/v1/contracts/:id/signatures/internal', { ...auth }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ signerTitle: z.string().min(2).max(120), confirm: z.literal(true) }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const c = await load(u.tenantId, id, tx, true);
      if (c.status !== 'PENDING_SIGNATURE') throw unprocessable('Kontrak belum siap ditandatangani');
      const [ar] = await tx`SELECT required_level FROM approval_requests WHERE entity_type = 'contract' AND entity_id = ${id} AND status = 'APPROVED' ORDER BY decided_at DESC LIMIT 1`;
      const { level } = await effectiveLevel(tx, u);
      if (level < Number(ar?.requiredLevel ?? 3)) throw forbidden('Penandatangan internal harus pejabat dengan level ≥ level approval kontrak');
      if (c.createdBy === u.id) throw forbidden('Segregation of Duties: pembuat kontrak tidak boleh menandatangani');
      const [dup] = await tx`SELECT 1 FROM contract_signatures WHERE contract_id = ${id} AND party = 'INTERNAL' AND status IN ('SIGNED','VERIFIED')`;
      if (dup) throw conflict('Otorisasi internal sudah ada');
      const hash = await contractHash(tx, id);
      const [s] = await tx`INSERT INTO contract_signatures (tenant_id, contract_id, party, method, signer_name, signer_title, signer_user_id, document_sha256, status, evidence, signed_at, verified_by, verified_at)
        VALUES (${u.tenantId}, ${id}, 'INTERNAL', 'INTERNAL_AUTHORIZATION', ${u.fullName}, ${b.signerTitle}, ${u.id}, ${hash}, 'VERIFIED',
                ${tx.json({ role: u.role, level, ip: req.ip, at: new Date().toISOString(), note: 'Otorisasi internal ICOP — bukan tanda tangan elektronik tersertifikasi' } as never)}, now(), ${u.id}, now()) RETURNING *`;
      await audit(tx, u, 'contract.internal_authorization', 'contract', id, null, { signatureId: s.id, hash }, req.ip);
      return s;
    });
  });

  /** Unggah kontrak bertanda tangan customer (basah/TTE lain) — wajib diverifikasi Legal. */
  app.post('/api/v1/contracts/:id/signatures/customer/upload', { ...auth, preValidation: W }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    const c = await load(u.tenantId, id);
    if (c.status !== 'PENDING_SIGNATURE') throw unprocessable('Kontrak belum siap ditandatangani');
    const out = await storeSignedUpload(req, u, c, 'internal');
    reply.code(201);
    return out;
  });

  /** Simpan PDF/gambar terkait kontrak sebagai dokumen (dedup SHA-256, replikasi storage, antre OCR). */
  async function saveContractDocument(tx: Tx | any, tenantId: string, userId: string | null, c: Record<string, any>, buf: Buffer, filename: string, mime: string, kind: string, title: string) {
    const sha = createHash('sha256').update(buf).digest('hex');
    const [existing] = await tx`SELECT id FROM documents WHERE tenant_id = ${tenantId} AND sha256 = ${sha}`;
    if (existing) return { documentId: existing.id as string, sha };
    const dir = join(DOC_DIR(), tenantId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${sha}.orig`);
    await storeFile(sql, tenantId, path, buf, app.log);
    const [d] = await tx`INSERT INTO documents (tenant_id, title, filename, mime, kind, entity_type, entity_id, confidentiality, size_original, sha256, original_path, options, uploaded_by)
      VALUES (${tenantId}, ${title}, ${filename}, ${mime}, ${kind}, 'contract', ${c.id}, 'CONFIDENTIAL', ${buf.length}, ${sha}, ${path},
              ${tx.json({ compress: 'none', ocr: 'auto' } as never)}, ${userId}) RETURNING id`;
    await enqueue(tx, tenantId, 'document_process', { documentId: d.id }, userId);
    return { documentId: d.id as string, sha };
  }

  async function readUpload(req: any) {
    const file = await req.file({ limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
    if (!file) throw badRequest('File wajib diunggah');
    const buf: Buffer = await file.toBuffer();
    if (file.file.truncated) throw new AppError(413, 'FILE_TOO_LARGE', 'Maksimal 50 MB');
    const safe = String(file.filename).replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 150);
    return { file, buf, safe, t: sniffDoc(buf, safe) };
  }

  async function storeSignedUpload(req: any, u: { id: string; tenantId: string; fullName: string }, c: Record<string, any>, channel: 'internal' | 'portal') {
    const { file, buf, safe, t } = await readUpload(req);
    const signerName = z.string().min(2).max(150).parse((file.fields.signerName as { value?: string } | undefined)?.value);
    const signerTitle = (file.fields.signerTitle as { value?: string } | undefined)?.value ?? null;
    if (!t || !['pdf', 'image'].includes(t.kind)) throw badRequest('Unggah PDF atau gambar hasil scan kontrak bertanda tangan');
    return sql.begin(async (tx) => {
      const { documentId, sha } = await saveContractDocument(tx, u.tenantId, u.id, c, buf, safe, t.mime, t.kind, `Kontrak bertanda tangan ${c.number}`);
      await tx`UPDATE contract_signatures SET status = 'REJECTED' WHERE contract_id = ${c.id} AND party = 'CUSTOMER' AND status IN ('PENDING','SIGNED')`;
      const [s] = await tx`INSERT INTO contract_signatures (tenant_id, contract_id, party, method, signer_name, signer_title, document_id, document_sha256, status, evidence, signed_at)
        VALUES (${u.tenantId}, ${c.id}, 'CUSTOMER', 'UPLOADED_SIGNED', ${signerName}, ${signerTitle}, ${documentId}, ${sha}, 'SIGNED',
                ${tx.json({ channel, uploadedBy: u.id, uploadedByName: u.fullName, ip: req.ip } as never)}, now()) RETURNING *`;
      const legal = await tx`SELECT id FROM users WHERE tenant_id = ${u.tenantId} AND is_active AND role = 'legal'`;
      await notify(tx, u.tenantId, legal.map((x) => x.id as string), 'CONTRACT_SIGNED_UPLOAD', `Verifikasi tanda tangan ${c.number}`, signerName, `/contracts/${c.id}`);
      await audit(tx, u, 'contract.customer_signed_upload', 'contract', c.id, null, { signatureId: s.id, sha256: sha, channel }, req.ip);
      return s;
    });
  }

  /** PDF kontrak final (versi yang akan ditandatangani). Hanya saat DRAFT/LEGAL_REVIEW agar ikut direview Legal; mengunci hash isi kontrak. */
  app.post('/api/v1/contracts/:id/final-document', { ...auth, preValidation: W }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    const c = await load(u.tenantId, id);
    if (!['DRAFT', 'LEGAL_REVIEW'].includes(c.status)) throw unprocessable('Dokumen final hanya dapat diganti saat DRAFT/LEGAL_REVIEW (sebelum approval & tanda tangan)');
    const { buf, safe, t } = await readUpload(req);
    if (!t || t.kind !== 'pdf') throw badRequest('Dokumen kontrak final wajib PDF');
    let pages = 0;
    try { pages = (await PDFDocument.load(buf, { ignoreEncryption: false })).getPageCount(); } catch { throw badRequest('PDF rusak atau terenkripsi'); }
    const out = await sql.begin(async (tx) => {
      const { documentId, sha } = await saveContractDocument(tx, u.tenantId, u.id, c, buf, safe, 'application/pdf', 'pdf', `Kontrak final ${c.number}`);
      await tx`UPDATE documents SET page_count = coalesce(page_count, ${pages}) WHERE id = ${documentId}`;
      await tx`UPDATE contracts SET final_document_id = ${documentId}, row_version = row_version + 1, updated_at = now() WHERE id = ${id}`;
      await audit(tx, u, 'contract.final_document', 'contract', id, { finalDocumentId: c.finalDocumentId ?? null }, { finalDocumentId: documentId, sha256: sha, pages }, req.ip);
      return { documentId, sha256: sha, pages };
    });
    reply.code(201);
    return out;
  });

  app.post('/api/v1/contracts/:id/signatures/:sid/verify', { ...auth, preValidation: requirePerm('contract.legal') }, async (req) => {
    const { id, sid } = z.object({ id: z.string().uuid(), sid: z.string().uuid() }).parse(req.params);
    const b = z.object({ decision: z.enum(['VERIFY', 'REJECT']), note: z.string().min(5).max(1000) }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const [s] = await tx`SELECT * FROM contract_signatures WHERE id = ${sid} AND contract_id = ${id} AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!s) throw notFound('Tanda tangan');
      if (s.status !== 'SIGNED') throw unprocessable(`Status tanda tangan ${s.status}`);
      if ((s.evidence as any)?.uploadedBy === u.id) throw forbidden('Maker-checker: pengunggah tidak boleh memverifikasi');
      const status = b.decision === 'VERIFY' ? 'VERIFIED' : 'REJECTED';
      const [row] = await tx`UPDATE contract_signatures SET status = ${status}, verified_by = ${u.id}, verified_at = now(),
        evidence = evidence || ${tx.json({ verificationNote: b.note } as never)} WHERE id = ${sid} RETURNING *`;
      await audit(tx, u, `contract.signature_${status.toLowerCase()}`, 'contract', id, null, { signatureId: sid, note: b.note }, req.ip);
      return row;
    });
  });

  /** Kirim ke penyedia e-sign (VIDA tersertifikasi / sandbox UAT). VIDA memakai PDF kontrak final; penanda tangan internal opsional (urutan serial). */
  app.post('/api/v1/contracts/:id/signatures/customer/esign', { ...auth, preValidation: W }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ provider: z.string(), signerName: z.string().min(2).max(150), signerEmail: z.string().email(), signerTitle: z.string().max(120).optional(),
      internalSigner: z.object({ name: z.string().min(2).max(150), email: z.string().email() }).optional() }).parse(req.body);
    const u = req.authUser;
    const p = await resolveProvider(sql, u.tenantId, b.provider);
    if (!p) throw unprocessable(`Penyedia e-sign '${b.provider}' belum dikonfigurasi/diaktifkan admin`, { providers: await availableProviders(sql, u.tenantId) });
    const c = await load(u.tenantId, id);
    if (c.status !== 'PENDING_SIGNATURE') throw unprocessable('Kontrak belum siap ditandatangani');
    const [open] = await sql`SELECT id FROM contract_signatures WHERE contract_id = ${id} AND party = 'CUSTOMER' AND status = 'PENDING'`;
    if (open) throw conflict('Masih ada permintaan tanda tangan yang menunggu — tarik status atau batalkan dulu');
    let pdf: Buffer | undefined; let pageCount: number | undefined; let filename: string | undefined;
    if (p.needsDocument) {
      if (!c.finalDocumentId) throw unprocessable('Unggah PDF kontrak final sebelum mengirim ke penyedia e-sign');
      const [d] = await sql`SELECT original_path, filename, page_count FROM documents WHERE id = ${c.finalDocumentId}`;
      pdf = await readStoredFile(sql, u.tenantId, d.originalPath as string);
      pageCount = Number(d.pageCount ?? (await PDFDocument.load(pdf)).getPageCount());
      filename = d.filename as string;
    }
    const hash = await contractHash(sql, id);
    const signers = [{ name: b.signerName, email: b.signerEmail, order: 1 }, ...(b.internalSigner ? [{ ...b.internalSigner, order: 2 }] : [])];
    const env = await p.createEnvelope({ contractNumber: c.number, title: c.title, documentSha256: hash, pdf, filename, pageCount, signers });
    return sql.begin(async (tx) => {
      const [s] = await tx`INSERT INTO contract_signatures (tenant_id, contract_id, party, method, provider, provider_ref, signer_name, signer_title, document_sha256, status, evidence)
        VALUES (${u.tenantId}, ${id}, 'CUSTOMER', 'ESIGN_PROVIDER', ${p.name}, ${env.providerRef}, ${b.signerName}, ${b.signerTitle ?? null}, ${hash}, 'PENDING',
                ${tx.json({ signerEmail: b.signerEmail, legallyBinding: env.legallyBinding, certified: p.certified, requestedBy: u.id, signingLinks: env.signingLinks,
                  providerStatus: env.status, internalSigner: b.internalSigner ?? null } as never)}) RETURNING *`;
      await audit(tx, u, 'contract.esign_requested', 'contract', id, null, { provider: p.name, providerRef: env.providerRef, signers: signers.length }, req.ip);
      return { ...s, signingUrl: env.signingUrl, signingLinks: env.signingLinks, legallyBinding: env.legallyBinding };
    });
  });

  /** Tarik status penyedia e-sign sekarang (selain polling terjadwal). */
  app.post('/api/v1/contracts/:id/signatures/:sid/refresh', { ...auth, preValidation: R }, async (req) => {
    const { id, sid } = z.object({ id: z.string().uuid(), sid: z.string().uuid() }).parse(req.params);
    const [s] = await sql`SELECT * FROM contract_signatures WHERE id = ${sid} AND contract_id = ${id} AND tenant_id = ${req.authUser.tenantId}`;
    if (!s) throw notFound('Tanda tangan');
    return pollSignature(s);
  });

  async function pollSignature(s: Record<string, any>) {
    if (s.status !== 'PENDING' || !s.provider || s.provider === 'sandbox') return { id: s.id, status: s.status, changed: false };
    const p = await resolveProvider(sql, s.tenantId as string, s.provider as string);
    if (!p?.getStatus) return { id: s.id, status: s.status, changed: false, note: 'Penyedia tidak aktif' };
    const st = await p.getStatus(s.providerRef as string);
    if (st.status === 'PENDING') {
      await sql`UPDATE contract_signatures SET evidence = evidence || ${sql.json({ providerStatus: st.providerStatus, recipients: st.recipients, lastPolledAt: new Date().toISOString() } as never)} WHERE id = ${s.id}`;
      return { id: s.id, status: 'PENDING', providerStatus: st.providerStatus, changed: false };
    }
    if (st.status === 'COMPLETED') {
      const buf = await p.downloadSigned!(s.providerRef as string);
      return sql.begin(async (tx) => {
        const [c] = await tx`SELECT * FROM contracts WHERE id = ${s.contractId}`;
        const { documentId, sha } = await saveContractDocument(tx, s.tenantId as string, null, c, buf, `${String(c.number).replace(/\//g, '-')}-signed.pdf`, 'application/pdf', 'pdf', `Kontrak bertanda tangan (${p.label}) ${c.number}`);
        const status = p.certified ? 'VERIFIED' : 'SIGNED';
        await tx`UPDATE contract_signatures SET status = ${status}, document_id = ${documentId}, signed_at = now(), verified_at = ${p.certified ? sql`now()` : null},
          evidence = evidence || ${tx.json({ providerStatus: st.providerStatus, recipients: st.recipients, signedFileSha256: sha, verifiedBy: p.certified ? `${p.label} (PSrE)` : null } as never)}
          WHERE id = ${s.id}`;
        const people = await tx`SELECT id FROM users WHERE tenant_id = ${s.tenantId} AND is_active AND (role = 'legal' OR id = ${c.createdBy})`;
        await notify(tx, s.tenantId as string, people.map((x) => x.id as string), 'CONTRACT_ESIGN_COMPLETED', `Kontrak ${c.number} ditandatangani via ${p.label}`, 'Dokumen bertanda tangan tersimpan', `/contracts/${c.id}`);
        await audit(tx, { tenantId: s.tenantId as string, id: null }, 'contract.esign_completed', 'contract', c.id as string, null, { provider: p.name, documentId, sha256: sha }, undefined);
        return { id: s.id, status, documentId, changed: true };
      });
    }
    const status = st.status === 'DECLINED' ? 'REJECTED' : 'EXPIRED';
    await sql`UPDATE contract_signatures SET status = ${status}, evidence = evidence || ${sql.json({ providerStatus: st.providerStatus, recipients: st.recipients } as never)} WHERE id = ${s.id}`;
    await audit(sql, { tenantId: s.tenantId as string, id: null }, `contract.esign_${status.toLowerCase()}`, 'contract', s.contractId as string, null, { provider: p.name, providerStatus: st.providerStatus });
    return { id: s.id, status, changed: true };
  }
  pollers.set(sql, pollSignature);

  /** Webhook penyedia e-sign (tanpa JWT; diverifikasi HMAC). */
  app.post('/api/v1/esign/webhook/:provider', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { provider } = z.object({ provider: z.string() }).parse(req.params);
    const p = getProvider(provider);
    if (!p) throw notFound('Penyedia');
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
    if (!p.verifyWebhook(raw, req.headers['x-signature'] as string | undefined)) throw new AppError(401, 'INVALID_SIGNATURE', 'Signature webhook tidak valid');
    const b = z.object({ providerRef: z.string(), event: z.enum(['SIGNED', 'DECLINED', 'EXPIRED']), signedAt: z.string().optional(), certificate: z.string().max(4000).optional() })
      .parse(typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
    return sql.begin(async (tx) => {
      const [s] = await tx`SELECT * FROM contract_signatures WHERE provider = ${provider} AND provider_ref = ${b.providerRef} FOR UPDATE`;
      if (!s) throw notFound('Envelope');
      if (s.status !== 'PENDING') return { ok: true, idempotent: true };
      const status = b.event === 'SIGNED' ? (p.certified ? 'VERIFIED' : 'SIGNED') : b.event === 'DECLINED' ? 'REJECTED' : 'EXPIRED';
      await tx`UPDATE contract_signatures SET status = ${status}, signed_at = ${b.event === 'SIGNED' ? sql`now()` : null},
        evidence = evidence || ${tx.json({ webhookEvent: b.event, certificate: b.certificate ?? null, receivedAt: new Date().toISOString() } as never)} WHERE id = ${s.id}`;
      await audit(tx, { tenantId: s.tenantId as string, id: null }, 'contract.esign_webhook', 'contract', s.contractId as string, null, { event: b.event, status }, req.ip);
      return { ok: true, status };
    });
  });

  app.post('/api/v1/contracts/:id/activate', { ...auth, preValidation: W }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    return idempotent(req, reply, 200, () => sql.begin(async (tx) => {
      const c = await load(u.tenantId, id, tx, true);
      if (c.status !== 'PENDING_SIGNATURE') throw unprocessable(`Kontrak berstatus ${c.status}`);
      const sigs = await tx`SELECT party, status, method, evidence FROM contract_signatures WHERE contract_id = ${id} AND status = 'VERIFIED'`;
      const missing = ['INTERNAL', 'CUSTOMER'].filter((p) => !sigs.some((s) => s.party === p));
      if (missing.length) throw unprocessable('Tanda tangan belum lengkap/terverifikasi', { missing });
      const hash = await contractHash(tx, id);
      const [internal] = await tx`SELECT document_sha256 FROM contract_signatures WHERE contract_id = ${id} AND party = 'INTERNAL' AND status = 'VERIFIED'`;
      if (internal.documentSha256 !== hash) throw conflict('Isi kontrak berubah setelah otorisasi internal');
      if (c.contractType === 'FLEXGUARD') {
        const [pol] = await tx`SELECT 1 FROM policies WHERE tenant_id = ${u.tenantId} AND kind = 'FLEXGUARD' AND is_current`;
        if (!pol) throw unprocessable('Kebijakan FlexGuard belum tersedia');
      }
      const res = await activate(tx, u, c);
      return { id, status: 'ACTIVE', ...res };
    }));
  });

  /* ───── Projects (handover) ───── */
  app.get('/api/v1/projects', { ...auth, preValidation: requirePerm('project.read') }, async (req) => {
    const rows = await sql`SELECT p.id, p.code, p.name, p.status, p.start_date, p.end_date, p.contract_value, p.created_at, cu.legal_name AS customer_name, u.full_name AS pm_name,
        c.number AS contract_number FROM projects p JOIN customers cu ON cu.id = p.customer_id JOIN contracts c ON c.id = p.contract_id LEFT JOIN users u ON u.id = p.pm_id
      WHERE p.tenant_id = ${req.authUser.tenantId} ORDER BY p.created_at DESC LIMIT 200`;
    return { items: rows };
  });

  app.get('/api/v1/projects/:id', { ...auth, preValidation: requirePerm('project.read') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    const [p] = await sql`SELECT p.*, cu.legal_name AS customer_name, us.full_name AS pm_name, c.number AS contract_number, c.contract_type
      FROM projects p JOIN customers cu ON cu.id = p.customer_id JOIN contracts c ON c.id = p.contract_id LEFT JOIN users us ON us.id = p.pm_id
      WHERE p.id = ${id} AND p.tenant_id = ${u.tenantId}`;
    if (!p) throw notFound('Proyek');
    const milestones = await sql`SELECT m.*, i.id AS invoice_id, i.number AS invoice_number, i.status AS invoice_status FROM project_milestones m
      LEFT JOIN invoices i ON i.milestone_id = m.id AND i.status <> 'VOID' WHERE m.project_id = ${id} ORDER BY m.seq`;
    const showCost = can(u.role, 'pricing.view_cost');
    return { project: showCost ? p : { ...p, budgetCost: undefined }, milestones };
  });

  app.patch('/api/v1/projects/:id', { ...auth, preValidation: requirePerm('project.manage') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ pmId: z.string().uuid().optional(), startDate: z.string().date().optional(), endDate: z.string().date().optional(),
      handoverItem: z.object({ key: z.string(), done: z.boolean() }).optional() }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const [p] = await tx`SELECT * FROM projects WHERE id = ${id} AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!p) throw notFound('Proyek');
      if (b.pmId) {
        const [pm] = await tx`SELECT role FROM users WHERE id = ${b.pmId} AND tenant_id = ${u.tenantId} AND is_active`;
        if (!pm || pm.role !== 'project_manager') throw badRequest('PM harus pengguna aktif dengan role project_manager');
        await tx`UPDATE projects SET pm_id = ${b.pmId} WHERE id = ${id}`;
        await notify(tx, u.tenantId, [b.pmId], 'PROJECT_ASSIGNED', `Anda PM proyek ${p.code}`, p.name as string, `/projects/${id}`);
      }
      if (b.startDate) await tx`UPDATE projects SET start_date = ${b.startDate} WHERE id = ${id}`;
      if (b.endDate) await tx`UPDATE projects SET end_date = ${b.endDate} WHERE id = ${id}`;
      if (b.handoverItem) {
        const h = p.handover as { items: { key: string; done: boolean; doneBy?: string; doneAt?: string }[] };
        const it = h.items.find((x) => x.key === b.handoverItem!.key);
        if (!it) throw notFound('Item handover');
        it.done = b.handoverItem.done; it.doneBy = u.fullName; it.doneAt = new Date().toISOString();
        await tx`UPDATE projects SET handover = ${tx.json(h as never)} WHERE id = ${id}`;
      }
      await audit(tx, u, 'project.update', 'project', id, null, b, req.ip);
      const [after] = await tx`SELECT * FROM projects WHERE id = ${id}`;
      return after;
    });
  });

  app.post('/api/v1/projects/:id/kickoff', { ...auth, preValidation: requirePerm('project.manage') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const [p] = await tx`SELECT * FROM projects WHERE id = ${id} AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!p) throw notFound('Proyek');
      if (p.status !== 'HANDOVER') throw unprocessable(`Proyek berstatus ${p.status}`);
      if (!p.pmId) throw unprocessable('Tetapkan Project Manager terlebih dahulu');
      const open = (p.handover as any).items.filter((x: any) => !x.done).map((x: any) => x.label);
      if (open.length) throw unprocessable('Checklist handover belum lengkap', { open });
      await tx`UPDATE projects SET status = 'KICKOFF', kickoff_at = now() WHERE id = ${id}`;
      await audit(tx, u, 'project.kickoff', 'project', id, { status: 'HANDOVER' }, { status: 'KICKOFF' }, req.ip);
      return { id, status: 'KICKOFF' };
    });
  });

  /* ───── Portal: kontrak milik customer ───── */
  const portal = { onRequest: [app.authenticate], preValidation: requirePerm('portal.access') };
  app.get('/api/v1/portal/contracts', portal, async (req) => {
    const u = req.authUser;
    const rows = await sql`SELECT id, number, title, contract_type, status, value, start_date, end_date FROM contracts
                           WHERE tenant_id = ${u.tenantId} AND customer_id = ${u.customerId} AND status IN ('PENDING_SIGNATURE','ACTIVE','COMPLETED','EXPIRED') ORDER BY created_at DESC`;
    return { items: rows };
  });
  app.get('/api/v1/portal/contracts/:id', portal, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    const [c] = await sql`SELECT id, number, title, contract_type, status, value, tax_rate, start_date, end_date, payment_terms, sla_terms, penalty_terms FROM contracts
                          WHERE id = ${id} AND tenant_id = ${u.tenantId} AND customer_id = ${u.customerId} AND status IN ('PENDING_SIGNATURE','ACTIVE','COMPLETED','EXPIRED')`;
    if (!c) throw notFound('Kontrak');
    const obligations = await sql`SELECT kind, description, due_date, amount, status FROM contract_obligations WHERE contract_id = ${id} AND kind IN ('PAYMENT','DELIVERABLE') ORDER BY seq`;
    const signatures = await sql`SELECT party, method, signer_name, status, signed_at FROM contract_signatures WHERE contract_id = ${id} ORDER BY created_at`;
    return { contract: c, obligations, signatures };
  });
  app.post('/api/v1/portal/contracts/:id/signed-upload', portal, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    const c = await load(u.tenantId, id);
    if (c.customerId !== u.customerId) throw notFound('Kontrak');
    if (c.status !== 'PENDING_SIGNATURE') throw unprocessable('Kontrak belum siap ditandatangani');
    const out = await storeSignedUpload(req, u, c, 'portal');
    reply.code(201);
    return { id: out.id, status: out.status };
  });
}
