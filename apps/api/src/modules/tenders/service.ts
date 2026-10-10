import { z } from 'zod';
import type { Tx } from '../../db.js';
import { audit, notify } from '../../lib/context.js';

/* ───────────────────────── Bid / No-Bid scorecard (§E3) ───────────────────────── */

export const BID_CRITERIA: { key: string; label: string; weight: number; knockoutAt?: number; hint: string }[] = [
  { key: 'strategic_fit', label: 'Strategic fit', weight: 10, hint: '5 = sektor & layanan prioritas' },
  { key: 'scope_compatibility', label: 'Kesesuaian scope', weight: 10, hint: '5 = scope sepenuhnya dalam portofolio' },
  { key: 'technical_capability', label: 'Kemampuan teknis', weight: 10, hint: '5 = pernah deliver scope identik' },
  { key: 'resource_availability', label: 'Ketersediaan resource', weight: 8, hint: '5 = tim tersedia penuh' },
  { key: 'certification_eligibility', label: 'Kelayakan sertifikasi', weight: 8, knockoutAt: 1, hint: '1 = sertifikasi wajib tidak dimiliki (gugur)' },
  { key: 'vendor_authorization', label: 'Otorisasi vendor/produk', weight: 6, knockoutAt: 1, hint: '1 = otorisasi wajib tidak bisa diperoleh' },
  { key: 'financial_viability', label: 'Kelayakan finansial', weight: 6, hint: '5 = cashflow & jaminan aman' },
  { key: 'estimated_profitability', label: 'Estimasi profitabilitas', weight: 8, hint: '5 = margin ≥ target 35%' },
  { key: 'delivery_feasibility', label: 'Kelayakan delivery', weight: 8, hint: '5 = timeline realistis' },
  { key: 'compliance_readiness', label: 'Kesiapan kepatuhan dokumen', weight: 8, hint: '5 = seluruh dokumen admin siap' },
  { key: 'competitive_position', label: 'Posisi kompetitif', weight: 6, hint: '5 = incumbent/unggul jelas' },
  { key: 'time_remaining', label: 'Waktu persiapan tersisa', weight: 4, knockoutAt: 1, hint: '1 = tidak cukup waktu menyusun dokumen' },
  { key: 'contractual_risk', label: 'Risiko kontraktual (5 = rendah)', weight: 8, hint: '1 = denda/klausul tidak wajar' },
];

export const BidInput = z.object({
  scores: z.record(z.string(), z.object({ score: z.number().int().min(1).max(5), note: z.string().max(1000).optional() })),
  conflictOfInterest: z.boolean(),
  coiNote: z.string().max(1000).optional(),
  conditions: z.string().max(2000).optional(),
});

export function scoreBid(input: z.infer<typeof BidInput>) {
  const missing = BID_CRITERIA.filter((c) => !input.scores[c.key]).map((c) => c.key);
  if (missing.length) throw new Error(`Kriteria belum dinilai: ${missing.join(', ')}`);
  let weighted = 0;
  const knockouts: string[] = [];
  for (const c of BID_CRITERIA) {
    const s = input.scores[c.key].score;
    weighted += (c.weight * (s - 1)) / 4;
    if (c.knockoutAt !== undefined && s <= c.knockoutAt) knockouts.push(`${c.label}: skor ${s} (knockout)`);
  }
  if (input.conflictOfInterest) knockouts.push('Deklarasi conflict of interest');
  weighted = Math.round(weighted * 10) / 10;
  let recommendation: 'GO' | 'CONDITIONAL_GO' | 'NO_GO' = weighted >= 70 ? 'GO' : weighted >= 50 ? 'CONDITIONAL_GO' : 'NO_GO';
  if (knockouts.length) recommendation = 'NO_GO';
  if (recommendation === 'CONDITIONAL_GO' && !input.conditions?.trim()) throw new Error('Rekomendasi Conditional Go wajib menyebut syarat/kondisi');
  return { weighted, knockouts, recommendation };
}

/* ───────────────────────── Status workflow (§E6) ───────────────────────── */

export const TENDER_FLOW: Record<string, string[]> = {
  DISCOVERED: ['SCREENING', 'NO_BID', 'CANCELLED'],
  SCREENING: ['REGISTERED', 'NO_BID', 'CANCELLED'],
  REGISTERED: ['BID_DECISION', 'CANCELLED'],
  BID_DECISION: ['CANCELLED'], // keluar via approval bid/no-bid
  PREPARING: ['INTERNAL_REVIEW', 'CANCELLED'],
  INTERNAL_REVIEW: ['APPROVED', 'PREPARING'],
  APPROVED: ['SUBMITTED', 'PREPARING'],
  SUBMITTED: ['CLARIFICATION', 'NEGOTIATION', 'AWARDED', 'LOST'],
  CLARIFICATION: ['SUBMITTED', 'NEGOTIATION', 'AWARDED', 'LOST'],
  NEGOTIATION: ['AWARDED', 'LOST'],
  AWARDED: ['CONTRACTING'],
  CONTRACTING: [], LOST: [], NO_BID: [], CANCELLED: [],
};
export const ACTIVE_TENDER = ['DISCOVERED', 'SCREENING', 'REGISTERED', 'BID_DECISION', 'PREPARING', 'INTERNAL_REVIEW', 'APPROVED'];

export async function setTenderStatus(tx: Tx, u: { tenantId: string; id: string | null }, tenderId: string, from: string, to: string, note?: string) {
  await tx`UPDATE tenders SET status = ${to}, row_version = row_version + 1, updated_at = now() WHERE id = ${tenderId}`;
  await tx`INSERT INTO tender_status_history (tenant_id, tender_id, from_status, to_status, note, changed_by) VALUES (${u.tenantId}, ${tenderId}, ${from}, ${to}, ${note ?? null}, ${u.id})`;
  await audit(tx, u, 'tender.status', 'tender', tenderId, { status: from }, { status: to, note });
}

/** Dipanggil approval engine saat keputusan final bid/no-bid. */
export async function onBidDecision(tx: Tx, u: { tenantId: string; id: string }, ar: Record<string, unknown>, finalStatus: string) {
  const [b] = await tx`SELECT * FROM bid_assessments WHERE id = ${ar.entityId as string} FOR UPDATE`;
  const [t] = await tx`SELECT * FROM tenders WHERE id = ${b.tenderId} FOR UPDATE`;
  if (finalStatus === 'APPROVED') {
    await tx`UPDATE bid_assessments SET status = 'APPROVED', final_decision = recommendation WHERE id = ${b.id}`;
    const to = b.recommendation === 'NO_GO' ? 'NO_BID' : 'PREPARING';
    await setTenderStatus(tx, u, t.id as string, t.status as string, to, `Keputusan ${b.recommendation} disetujui (approval ${ar.id})`);
    if (t.ownerId) await notify(tx, u.tenantId, [t.ownerId as string], 'TENDER_BID_DECISION', `${t.code}: ${b.recommendation} disetujui`, t.title as string, `/tenders/${t.id}`);
  } else {
    await tx`UPDATE bid_assessments SET status = ${finalStatus === 'REJECTED' ? 'REJECTED' : 'REVISION_REQUESTED'} WHERE id = ${b.id}`;
    if (t.ownerId) await notify(tx, u.tenantId, [t.ownerId as string], 'TENDER_BID_DECISION', `${t.code}: bid assessment ${finalStatus}`, t.title as string, `/tenders/${t.id}`);
  }
}

/** Ringkasan kesiapan submission. */
export async function readiness(tx: Tx | import('../../db.js').Sql, tenderId: string) {
  const reqs = await tx`SELECT category, mandatory, compliance_status FROM tender_requirements WHERE tender_id = ${tenderId}`;
  const docs = await tx`SELECT kind FROM tender_documents WHERE tender_id = ${tenderId}`;
  const [bid] = await tx`SELECT status, final_decision FROM bid_assessments WHERE tender_id = ${tenderId} ORDER BY created_at DESC LIMIT 1`;
  const [prop] = await tx`SELECT count(*) FILTER (WHERE status = 'REVIEWED')::int AS reviewed, count(*)::int AS total FROM proposals WHERE tender_id = ${tenderId}`;
  const [t] = await tx`SELECT submission_deadline FROM tenders WHERE id = ${tenderId}`;
  const mand = reqs.filter((r) => r.mandatory);
  const ok = mand.filter((r) => ['COMPLY', 'NOT_APPLICABLE'].includes(r.complianceStatus as string)).length;
  const byCat = Object.fromEntries(['ADMINISTRATIVE', 'QUALIFICATION', 'TECHNICAL', 'COMMERCIAL'].map((c) => {
    const rs = reqs.filter((r) => r.category === c);
    return [c, { total: rs.length, comply: rs.filter((r) => r.complianceStatus === 'COMPLY').length, unreviewed: rs.filter((r) => r.complianceStatus === 'UNREVIEWED').length,
      nonComply: rs.filter((r) => r.complianceStatus === 'NON_COMPLY').length }];
  }));
  const blockers: string[] = [];
  const nonComplyMand = mand.filter((r) => r.complianceStatus === 'NON_COMPLY').length;
  const unreviewedMand = mand.filter((r) => r.complianceStatus === 'UNREVIEWED').length;
  const clarify = reqs.filter((r) => r.complianceStatus === 'CLARIFY').length;
  if (!reqs.length) blockers.push('Belum ada persyaratan — unggah RKS/KAK dan jalankan ekstraksi');
  if (unreviewedMand) blockers.push(`${unreviewedMand} persyaratan wajib belum direview`);
  if (nonComplyMand) blockers.push(`${nonComplyMand} persyaratan wajib NON-COMPLY (risiko gugur)`);
  if (clarify) blockers.push(`${clarify} persyaratan menunggu klarifikasi`);
  if (!bid || bid.status !== 'APPROVED') blockers.push('Keputusan bid/no-bid belum disetujui');
  if (!prop.reviewed) blockers.push('Belum ada proposal teknis yang direview');
  const deadline = t.submissionDeadline ? new Date(t.submissionDeadline as string) : null;
  const hoursLeft = deadline ? Math.round((deadline.getTime() - Date.now()) / 36e5) : null;
  if (hoursLeft !== null && hoursLeft < 0) blockers.push('Batas waktu submission telah lewat');
  return {
    mandatoryTotal: mand.length, mandatoryReady: ok, percent: mand.length ? Math.round((ok / mand.length) * 100) : 0,
    byCategory: byCat, documents: [...new Set(docs.map((d) => d.kind as string))], bidStatus: bid?.status ?? null, bidDecision: bid?.finalDecision ?? null,
    proposals: prop, hoursLeft, blockers, ready: blockers.length === 0,
  };
}
