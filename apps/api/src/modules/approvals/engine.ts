import type { DoaPolicy } from '../pricing/policy-defaults.js';
import { APPROVAL_LEVEL, LEVEL_LABEL } from '../../lib/rbac.js';
import type { Sql, Tx } from '../../db.js';
import { AppError, conflict, forbidden, notFound } from '../../lib/errors.js';
import { audit, notify } from '../../lib/context.js';

export interface DoaMetrics {
  grandTotalExTax: number;
  discountPct: number;
  marginHold: number; // 1 jika margin di bawah ambang hold
  belowFloor: number; // 1 jika harga di bawah floor
}

export interface DoaReason { type: string; metric: string; value: number; level: number; label: string }

/** Evaluasi semua aturan; level tertinggi = most stringent. */
export function evaluateDoa(policy: DoaPolicy, m: DoaMetrics) {
  const reasons: DoaReason[] = [];
  for (const rule of policy.rules) {
    const value = (m as unknown as Record<string, number>)[rule.metric];
    if (value === undefined) continue;
    const band = rule.bands.find((b) => b.max === null || value <= b.max);
    const level = band?.level ?? 3;
    if (level > 0) reasons.push({ type: rule.type, metric: rule.metric, value, level, label: LEVEL_LABEL[level] });
  }
  const requiredLevel = Math.max(1, ...reasons.map((r) => r.level));
  // Sequential: rantai berjenjang Manager → … → level tertinggi yang disyaratkan
  const levels = policy.sequential ? Array.from({ length: requiredLevel }, (_, i) => i + 1) : [requiredLevel];
  return { requiredLevel, reasons, steps: levels.map((level, i) => ({ seq: i + 1, level, label: LEVEL_LABEL[level] })) };
}

export async function loadCurrentPolicy<T>(db: Sql | Tx, tenantId: string, kind: 'PRICING' | 'DOA' | 'FLEXGUARD') {
  const [p] = await db`SELECT * FROM policies WHERE tenant_id = ${tenantId} AND kind = ${kind} AND is_current`;
  if (!p) throw new AppError(500, 'NO_POLICY', `Tidak ada kebijakan ${kind} yang aktif`);
  return p as unknown as { id: string; code: string; version: number; status: string; params: T };
}

export async function createApprovalRequest(
  tx: Tx,
  args: { tenantId: string; entityType: string; entityId: string; entityVersion: number; requestedBy: string;
    metrics: DoaMetrics; summary: Record<string, unknown> },
) {
  const policy = await loadCurrentPolicy<DoaPolicy>(tx, args.tenantId, 'DOA');
  const ev = evaluateDoa(policy.params, args.metrics);
  const sla = policy.params.slaHours[String(ev.requiredLevel)] ?? 48;
  const [req] = await tx`
    INSERT INTO approval_requests (tenant_id, entity_type, entity_id, entity_version, policy_id, requested_by, required_level, reasons, summary, due_at)
    VALUES (${args.tenantId}, ${args.entityType}, ${args.entityId}, ${args.entityVersion}, ${policy.id}, ${args.requestedBy},
            ${ev.requiredLevel}, ${tx.json(ev.reasons as never)},
            ${tx.json({ ...args.summary, policy: `${policy.code} v${policy.version}`, policyStatus: policy.status } as never)},
            now() + make_interval(hours => ${sla}))
    RETURNING *`;
  for (const s of ev.steps) {
    await tx`INSERT INTO approval_steps (tenant_id, request_id, seq, level, level_label) VALUES (${args.tenantId}, ${req.id}, ${s.seq}, ${s.level}, ${s.label})`;
  }
  const firstLevel = ev.steps[0].level;
  const approvers = await approversForLevel(tx, args.tenantId, firstLevel, args.requestedBy);
  await notify(tx, args.tenantId, approvers, 'APPROVAL_PENDING',
    `Approval ${LEVEL_LABEL[firstLevel]} diperlukan`, String(args.summary.title ?? args.entityType), `/approvals/${req.id}`);
  return { request: req, evaluation: ev, policy };
}

export async function supersedeOpenRequests(tx: Tx, tenantId: string, entityType: string, entityId: string) {
  const rows = await tx`
    UPDATE approval_requests SET status = 'SUPERSEDED', decided_at = now()
    WHERE tenant_id = ${tenantId} AND entity_type = ${entityType} AND entity_id = ${entityId} AND status IN ('PENDING','APPROVED')
    RETURNING id`;
  if (rows.length) {
    await tx`UPDATE approval_steps SET status = 'SUPERSEDED' WHERE request_id IN ${tx(rows.map((r) => r.id as string))} AND status = 'PENDING'`;
  }
  return rows.length;
}

export type Decision = 'APPROVE' | 'REJECT' | 'REQUEST_REVISION';

/**
 * Keputusan diverifikasi ulang di server: role, level, SoD (maker≠checker),
 * urutan step, versi entitas, dan status. Tidak bergantung pada tombol UI.
 */
export async function decide(
  sql: Sql,
  user: { id: string; tenantId: string; role: string },
  requestId: string,
  decision: Decision,
  comment: string | undefined,
  ip: string,
  onFinal: (tx: Tx, req: Record<string, unknown>, finalStatus: string) => Promise<void>,
) {
  return sql.begin(async (tx) => {
    const [req] = await tx`SELECT * FROM approval_requests WHERE id = ${requestId} AND tenant_id = ${user.tenantId} FOR UPDATE`;
    if (!req) throw notFound('Approval request');
    if (req.status !== 'PENDING') throw conflict(`Approval request sudah berstatus ${req.status}`);
    if (req.requestedBy === user.id) throw forbidden('Segregation of Duties: pemohon tidak boleh menyetujui request sendiri');
    const { level: myLevel, delegationId } = await effectiveLevel(tx, user);
    if (myLevel === 0) throw forbidden('Role Anda tidak memiliki kewenangan approval');
    const [step] = await tx`SELECT * FROM approval_steps WHERE request_id = ${requestId} AND status = 'PENDING' ORDER BY seq LIMIT 1 FOR UPDATE`;
    if (!step) throw conflict('Tidak ada step approval yang tertunda');
    if (myLevel < (step.level as number)) {
      throw forbidden(`Step ini memerlukan level ${step.levelLabel}; level Anda ${LEVEL_LABEL[myLevel]}`);
    }
    // Four-eyes: satu approver tidak boleh memutus dua step dalam request yang sama
    const [prior] = await tx`SELECT 1 FROM approval_decisions WHERE request_id = ${requestId} AND decided_by = ${user.id}`;
    if (prior) throw forbidden('Four-eyes control: Anda sudah memberi keputusan pada request ini');

    // Entitas tidak boleh berubah sejak diajukan
    if (req.entityType === 'quotation') {
      const [q] = await tx`SELECT row_version, status FROM quotations WHERE id = ${req.entityId} AND tenant_id = ${user.tenantId} FOR UPDATE`;
      if (!q || q.rowVersion !== req.entityVersion || q.status !== 'IN_APPROVAL') {
        throw conflict('Quotation telah berubah sejak diajukan — approval tidak valid');
      }
    }
    if (req.entityType === 'bid_assessment') {
      const [b] = await tx`SELECT status FROM bid_assessments WHERE id = ${req.entityId} AND tenant_id = ${user.tenantId} FOR UPDATE`;
      if (!b || b.status !== 'IN_APPROVAL') throw conflict('Bid assessment tidak lagi menunggu approval');
    }

    const stepStatus = decision === 'APPROVE' ? 'APPROVED' : decision === 'REJECT' ? 'REJECTED' : 'REVISION_REQUESTED';
    await tx`UPDATE approval_steps SET status = ${stepStatus}, decided_by = ${user.id}, decided_at = now() WHERE id = ${step.id}`;
    await tx`INSERT INTO approval_decisions (tenant_id, request_id, step_id, decided_by, decision, comment, evidence)
             VALUES (${user.tenantId}, ${requestId}, ${step.id}, ${user.id}, ${decision}, ${comment ?? null},
                     ${tx.json({ role: user.role, level: myLevel, delegationId, stepLevel: step.level, entityVersion: req.entityVersion, ip, at: new Date().toISOString() } as never)})`;

    let finalStatus: string | null = null;
    if (decision !== 'APPROVE') finalStatus = stepStatus;
    else {
      const [remaining] = await tx`SELECT count(*)::int AS n FROM approval_steps WHERE request_id = ${requestId} AND status = 'PENDING'`;
      if (remaining.n === 0) finalStatus = 'APPROVED';
      else {
        const [nextStep] = await tx`SELECT level, level_label FROM approval_steps WHERE request_id = ${requestId} AND status = 'PENDING' ORDER BY seq LIMIT 1`;
        const approvers = await approversForLevel(tx, user.tenantId, nextStep.level as number, req.requestedBy as string);
        await notify(tx, user.tenantId, approvers, 'APPROVAL_PENDING',
          `Approval ${nextStep.levelLabel} diperlukan`, String((req.summary as Record<string, unknown>).title ?? ''), `/approvals/${requestId}`);
      }
    }
    if (finalStatus) {
      await tx`UPDATE approval_requests SET status = ${finalStatus}, decided_at = now() WHERE id = ${requestId}`;
      await onFinal(tx, req, finalStatus);
      await notify(tx, user.tenantId, [req.requestedBy as string], 'APPROVAL_RESULT', `Approval ${finalStatus}`,
        String((req.summary as Record<string, unknown>).title ?? ''), `/approvals/${requestId}`);
    }
    await audit(tx, user, `approval.${decision.toLowerCase()}`, 'approval_request', requestId, { status: 'PENDING', step: step.seq },
      { stepStatus, finalStatus, comment }, ip);
    return { requestId, step: step.seq, stepStatus, finalStatus: finalStatus ?? 'PENDING' };
  });
}

/** Level efektif = max(level role, delegasi aktif yang diterima). */
export async function effectiveLevel(db: Sql | Tx, user: { id: string; tenantId: string; role: string }) {
  const own = APPROVAL_LEVEL[user.role] ?? 0;
  const [d] = await db`SELECT id, level FROM approval_delegations WHERE tenant_id = ${user.tenantId} AND delegate_id = ${user.id}
                       AND revoked_at IS NULL AND now() BETWEEN valid_from AND valid_until ORDER BY level DESC LIMIT 1`;
  if (d && (d.level as number) > own) return { level: d.level as number, delegationId: d.id as string };
  return { level: own, delegationId: null as string | null };
}

/** Pengguna yang berwenang pada level tertentu (role atau delegasi aktif), selain pemohon. */
export async function approversForLevel(db: Sql | Tx, tenantId: string, level: number, exclude: string) {
  const roles = Object.entries(APPROVAL_LEVEL).filter(([, l]) => l === level).map(([r]) => r);
  const rows = await db`SELECT id FROM users WHERE tenant_id = ${tenantId} AND is_active AND id <> ${exclude} AND role IN ${db(roles)}
    UNION SELECT delegate_id AS id FROM approval_delegations WHERE tenant_id = ${tenantId} AND level >= ${level} AND revoked_at IS NULL
      AND now() BETWEEN valid_from AND valid_until AND delegate_id <> ${exclude}`;
  return rows.map((r) => r.id as string);
}

/**
 * Eskalasi SLA: request PENDING yang melewati due_at diberitahukan ke level di atas step aktif
 * (level lebih tinggi berwenang memutus step di bawahnya). Tidak mengubah kebutuhan approval.
 */
export async function escalateOverdue(sql: Sql) {
  const rows = await sql`
    SELECT ar.id, ar.tenant_id, ar.requested_by, ar.summary, ar.escalation_level, st.level AS step_level
    FROM approval_requests ar
    JOIN LATERAL (SELECT level FROM approval_steps s WHERE s.request_id = ar.id AND s.status = 'PENDING' ORDER BY s.seq LIMIT 1) st ON true
    WHERE ar.status = 'PENDING' AND ar.due_at < now() AND ar.escalation_level < 2`;
  let escalated = 0;
  for (const r of rows) {
    const target = Math.min(3, (r.stepLevel as number) + (r.escalationLevel as number) + 1);
    await sql.begin(async (tx) => {
      const ids = await approversForLevel(tx, r.tenantId as string, target, r.requestedBy as string);
      await notify(tx, r.tenantId as string, ids, 'APPROVAL_ESCALATED', `Eskalasi SLA → ${LEVEL_LABEL[target]}`,
        String((r.summary as Record<string, unknown>).title ?? ''), `/approvals/${r.id}`);
      await tx`UPDATE approval_requests SET escalated_at = now(), escalation_level = escalation_level + 1,
               due_at = now() + interval '24 hours' WHERE id = ${r.id}`;
      await audit(tx, { tenantId: r.tenantId as string, id: null }, 'approval.escalated', 'approval_request', r.id as string,
        { escalationLevel: r.escalationLevel }, { notifiedLevel: target, recipients: ids.length });
    });
    escalated++;
  }
  return { escalated };
}

/** Registry handler keputusan final per jenis entitas (kontrak, FlexGuard, dsb.). */
export type FinalHandler = (tx: Tx, user: { id: string; tenantId: string; role: string }, req: Record<string, unknown>, finalStatus: string) => Promise<void>;
const finalHandlers = new Map<string, FinalHandler>();
export const registerApprovalHandler = (entityType: string, fn: FinalHandler) => finalHandlers.set(entityType, fn);
export const approvalHandler = (entityType: string) => finalHandlers.get(entityType);
