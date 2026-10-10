import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Tx } from '../../db.js';
import { audit, nextNumber, notify, requirePerm } from '../../lib/context.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { can } from '../../lib/rbac.js';
import { createApprovalRequest, registerApprovalHandler } from '../approvals/engine.js';

const r2 = (n: number) => Math.round(n * 100) / 100;
const PROJECT_FLOW: Record<string, string[]> = {
  HANDOVER: [], KICKOFF: ['IN_PROGRESS', 'ON_HOLD'], IN_PROGRESS: ['ON_HOLD', 'CLOSING'], ON_HOLD: ['IN_PROGRESS'], CLOSING: ['IN_PROGRESS', 'CLOSED'], CLOSED: [],
};

/** CR disetujui → addendum: nilai & budget proyek, jadwal, kewajiban pembayaran + milestone tagihan baru. */
registerApprovalHandler('change_request', async (tx, u, ar, finalStatus) => {
  const [cr] = await tx`SELECT * FROM change_requests WHERE id = ${ar.entityId as string} FOR UPDATE`;
  if (!cr || cr.status !== 'IN_APPROVAL') return;
  if (finalStatus !== 'APPROVED') {
    await tx`UPDATE change_requests SET status = 'REJECTED', decided_at = now() WHERE id = ${cr.id}`;
    await notify(tx, u.tenantId, [cr.createdBy as string], 'CR_DECIDED', `${cr.number} ditolak`, cr.title as string, `/projects/${cr.projectId}`);
    return;
  }
  await tx`UPDATE projects SET contract_value = contract_value + ${cr.valueDelta}, budget_md = coalesce(budget_md, 0) + ${cr.mdDelta},
           end_date = end_date + ${Number(cr.scheduleDeltaDays)}::int WHERE id = ${cr.projectId}`;
  if (Number(cr.valueDelta) > 0) {
    const [{ seq }] = await tx`SELECT coalesce(max(seq), 0) + 1 AS seq FROM contract_obligations WHERE contract_id = ${cr.contractId}`;
    const [ob] = await tx`INSERT INTO contract_obligations (tenant_id, contract_id, kind, description, amount, percent, seq)
      VALUES (${u.tenantId}, ${cr.contractId}, 'PAYMENT', ${`Addendum ${cr.number}: ${cr.title}`}, ${cr.valueDelta}, NULL, ${seq}) RETURNING id`;
    const [{ ms }] = await tx`SELECT coalesce(max(seq), 0) + 1 AS ms FROM project_milestones WHERE project_id = ${cr.projectId}`;
    await tx`INSERT INTO project_milestones (tenant_id, project_id, seq, name, billing_amount, obligation_id) VALUES (${u.tenantId}, ${cr.projectId}, ${ms}, ${`Addendum ${cr.number}: ${cr.title}`}, ${cr.valueDelta}, ${ob.id})`;
  }
  await tx`UPDATE change_requests SET status = 'APPROVED', decided_at = now() WHERE id = ${cr.id}`;
  await notify(tx, u.tenantId, [cr.createdBy as string], 'CR_DECIDED', `${cr.number} disetujui`, cr.title as string, `/projects/${cr.projectId}`);
});

export async function deliveryRoutes(app: FastifyInstance) {
  const sql = app.sql;
  const auth = { onRequest: [app.authenticate] };
  const R = requirePerm('project.read');
  const M = requirePerm('project.manage');

  const loadProject = async (tenantId: string, id: string, db: any = sql, lock = false) => {
    const [p] = lock ? await db`SELECT * FROM projects WHERE id = ${id} AND tenant_id = ${tenantId} FOR UPDATE` : await db`SELECT * FROM projects WHERE id = ${id} AND tenant_id = ${tenantId}`;
    if (!p) throw notFound('Proyek');
    return p as Record<string, any>;
  };

  /** Ringkasan delivery: WBS + realisasi MD + progres tertimbang + burn vs budget + posisi jadwal. */
  app.get('/api/v1/projects/:id/delivery', { ...auth, preValidation: R }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    const p = await loadProject(u.tenantId, id);
    const tasks = await sql`SELECT t.*, us.full_name AS assignee_name,
        coalesce((SELECT sum(md) FROM project_timesheets ts WHERE ts.task_id = t.id AND ts.status = 'APPROVED'), 0)::float AS actual_md
      FROM project_tasks t LEFT JOIN users us ON us.id = t.assignee_id WHERE t.project_id = ${id} ORDER BY string_to_array(t.wbs_code, '.')::int[]`;
    const [ts] = await sql`SELECT coalesce(sum(md) FILTER (WHERE status = 'APPROVED'), 0)::float AS approved, coalesce(sum(md) FILTER (WHERE status = 'SUBMITTED'), 0)::float AS pending
                           FROM project_timesheets WHERE project_id = ${id}`;
    const leaf = tasks.filter((t) => !tasks.some((x) => x.parentId === t.id));
    const planned = leaf.reduce((s, t) => s + Number(t.plannedMd), 0);
    const progress = planned > 0 ? r2(leaf.reduce((s, t) => s + Number(t.plannedMd) * Number(t.progressPct), 0) / planned) : (leaf.length ? r2(leaf.reduce((s, t) => s + Number(t.progressPct), 0) / leaf.length) : 0);
    const start = new Date(p.startDate).getTime(); const end = new Date(p.endDate).getTime();
    const elapsedPct = end > start ? Math.min(100, Math.max(0, r2(((Date.now() - start) / (end - start)) * 100))) : 0;
    const budgetMd = p.budgetMd === null ? null : Number(p.budgetMd);
    const crs = await sql`SELECT c.*, us.full_name AS created_by_name FROM change_requests c LEFT JOIN users us ON us.id = c.created_by WHERE c.project_id = ${id} ORDER BY c.created_at DESC`;
    return {
      tasks, changeRequests: crs,
      metrics: { plannedMd: r2(planned), budgetMd, actualMd: r2(ts.approved), pendingMd: r2(ts.pending), progressPct: progress, elapsedPct,
        burnPct: budgetMd ? r2((ts.approved / budgetMd) * 100) : null,
        scheduleVariancePct: r2(progress - elapsedPct),
        overdueTasks: tasks.filter((t) => t.status !== 'DONE' && t.dueDate && new Date(t.dueDate) < new Date()).length },
      allowedTransitions: PROJECT_FLOW[p.status as string] ?? [],
    };
  });

  app.post('/api/v1/projects/:id/status', { ...auth, preValidation: M }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ status: z.enum(['IN_PROGRESS', 'ON_HOLD', 'CLOSING', 'CLOSED']), note: z.string().max(1000).optional() }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const p = await loadProject(u.tenantId, id, tx, true);
      if (!(PROJECT_FLOW[p.status] ?? []).includes(b.status)) throw unprocessable(`Transisi ${p.status} → ${b.status} tidak diizinkan`);
      if (b.status === 'ON_HOLD' && !b.note) throw badRequest('Alasan wajib saat proyek ditunda');
      if (b.status === 'CLOSED') {
        const open = await tx`SELECT name FROM project_milestones WHERE project_id = ${id} AND status <> 'ACCEPTED'`;
        if (open.length) throw unprocessable('Semua milestone wajib diterima (BAST) sebelum proyek ditutup', { open: open.map((x) => x.name) });
        const [pendingTs] = await tx`SELECT count(*)::int AS n FROM project_timesheets WHERE project_id = ${id} AND status = 'SUBMITTED'`;
        if (pendingTs.n) throw unprocessable('Masih ada timesheet yang belum diputuskan');
      }
      await tx`UPDATE projects SET status = ${b.status} WHERE id = ${id}`;
      await audit(tx, u, 'project.status', 'project', id, { status: p.status }, { status: b.status, note: b.note ?? null }, req.ip);
      return { id, status: b.status };
    });
  });

  /* ───── WBS ───── */
  const TaskBody = z.object({ name: z.string().min(2).max(300), parentId: z.string().uuid().nullable().optional(), assigneeId: z.string().uuid().nullable().optional(),
    startDate: z.string().date().nullable().optional(), dueDate: z.string().date().nullable().optional(), plannedMd: z.number().min(0).max(5000).optional() });

  app.post('/api/v1/projects/:id/tasks', { ...auth, preValidation: M }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = TaskBody.parse(req.body);
    if (b.startDate && b.dueDate && b.dueDate < b.startDate) throw badRequest('Tanggal selesai tidak boleh sebelum tanggal mulai');
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const p = await loadProject(u.tenantId, id, tx, true);
      if (p.status === 'CLOSED') throw unprocessable('Proyek sudah ditutup');
      let wbs: string;
      if (b.parentId) {
        const [parent] = await tx`SELECT wbs_code FROM project_tasks WHERE id = ${b.parentId} AND project_id = ${id}`;
        if (!parent) throw notFound('Task induk');
        const [{ n }] = await tx`SELECT count(*)::int + 1 AS n FROM project_tasks WHERE parent_id = ${b.parentId}`;
        wbs = `${parent.wbsCode}.${n}`;
      } else {
        const [{ n }] = await tx`SELECT count(*)::int + 1 AS n FROM project_tasks WHERE project_id = ${id} AND parent_id IS NULL`;
        wbs = String(n);
      }
      if (b.assigneeId) { const [a] = await tx`SELECT 1 FROM users WHERE id = ${b.assigneeId} AND tenant_id = ${u.tenantId} AND is_active AND role <> 'customer_user'`; if (!a) throw badRequest('Penanggung jawab tidak valid'); }
      const [t] = await tx`INSERT INTO project_tasks (tenant_id, project_id, parent_id, wbs_code, name, assignee_id, start_date, due_date, planned_md, created_by)
        VALUES (${u.tenantId}, ${id}, ${b.parentId ?? null}, ${wbs}, ${b.name}, ${b.assigneeId ?? null}, ${b.startDate ?? null}, ${b.dueDate ?? null}, ${b.plannedMd ?? 0}, ${u.id}) RETURNING *`;
      if (b.assigneeId && b.assigneeId !== u.id) await notify(tx, u.tenantId, [b.assigneeId], 'TASK_ASSIGNED', `Task ${wbs} ${b.name}`, p.code as string, `/projects/${id}`);
      await audit(tx, u, 'project.task_create', 'project', id, null, { taskId: t.id, wbs }, req.ip);
      reply.code(201);
      return t;
    });
  });

  /** Ubah task: PM/manajemen semua field; penanggung jawab hanya progres & status. */
  app.patch('/api/v1/projects/:id/tasks/:tid', { ...auth, preValidation: R }, async (req) => {
    const { id, tid } = z.object({ id: z.string().uuid(), tid: z.string().uuid() }).parse(req.params);
    const b = TaskBody.partial().extend({ progressPct: z.number().int().min(0).max(100).optional(), status: z.enum(['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE']).optional() }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const [t] = await tx`SELECT * FROM project_tasks WHERE id = ${tid} AND project_id = ${id} AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!t) throw notFound('Task');
      const manager = can(u.role, 'project.manage');
      if (!manager) {
        if (t.assigneeId !== u.id) throw forbidden('Hanya PM atau penanggung jawab task');
        if (Object.keys(b).some((k) => !['progressPct', 'status'].includes(k))) throw forbidden('Penanggung jawab hanya dapat mengubah progres & status');
      }
      const patch: Record<string, unknown> = {};
      for (const k of ['name', 'assigneeId', 'startDate', 'dueDate', 'plannedMd', 'progressPct', 'status'] as const) if (b[k] !== undefined) patch[k] = b[k];
      if (b.status === 'DONE') patch.progressPct = 100;
      if (b.progressPct === 100 && !b.status) patch.status = 'DONE';
      if (!Object.keys(patch).length) throw badRequest('Tidak ada perubahan');
      const sd = (patch.startDate ?? t.startDate) as string | null; const dd = (patch.dueDate ?? t.dueDate) as string | null;
      if (sd && dd && new Date(dd) < new Date(sd)) throw badRequest('Tanggal selesai tidak boleh sebelum tanggal mulai');
      const [after] = await tx`UPDATE project_tasks SET ${tx(patch, Object.keys(patch))}, updated_at = now() WHERE id = ${tid} RETURNING *`;
      await audit(tx, u, 'project.task_update', 'project', id, { progressPct: t.progressPct, status: t.status }, patch, req.ip);
      return after;
    });
  });

  /* ───── Timesheet proyek ───── */
  app.post('/api/v1/projects/:id/timesheets', { ...auth, preValidation: requirePerm('project.timesheet') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ workDate: z.string().date(), md: z.number().positive().max(1.5), taskId: z.string().uuid().optional(), note: z.string().max(1000).optional() }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const p = await loadProject(u.tenantId, id, tx, true);
      if (!['KICKOFF', 'IN_PROGRESS', 'CLOSING'].includes(p.status)) throw unprocessable(`Timesheet tidak dapat diisi pada status proyek ${p.status}`);
      if (new Date(b.workDate) > new Date()) throw badRequest('Tanggal kerja tidak boleh di masa depan');
      if (b.taskId) { const [t] = await tx`SELECT 1 FROM project_tasks WHERE id = ${b.taskId} AND project_id = ${id}`; if (!t) throw notFound('Task'); }
      const [{ total }] = await tx`SELECT coalesce(sum(md), 0)::float AS total FROM project_timesheets WHERE user_id = ${u.id} AND work_date = ${b.workDate} AND status <> 'REJECTED'`;
      if (total + b.md > 1.5) throw unprocessable(`Total MD ${b.workDate} melebihi 1,5 (sudah ${total})`);
      try {
        const [row] = await tx`INSERT INTO project_timesheets (tenant_id, project_id, task_id, user_id, work_date, md, note) VALUES (${u.tenantId}, ${id}, ${b.taskId ?? null}, ${u.id}, ${b.workDate}, ${b.md}, ${b.note ?? null}) RETURNING *`;
        if (p.status === 'KICKOFF') await tx`UPDATE projects SET status = 'IN_PROGRESS' WHERE id = ${id}`;
        reply.code(201);
        return row;
      } catch (e) { if ((e as { code?: string }).code === '23505') throw conflict('Timesheet untuk tanggal & task ini sudah ada'); throw e; }
    });
  });

  app.get('/api/v1/projects/:id/timesheets', { ...auth, preValidation: R }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = z.object({ status: z.enum(['SUBMITTED', 'APPROVED', 'REJECTED']).optional() }).parse(req.query);
    await loadProject(req.authUser.tenantId, id);
    const rows = await sql`SELECT ts.*, us.full_name AS user_name, t.wbs_code, t.name AS task_name, a.full_name AS approved_by_name FROM project_timesheets ts
      JOIN users us ON us.id = ts.user_id LEFT JOIN project_tasks t ON t.id = ts.task_id LEFT JOIN users a ON a.id = ts.approved_by
      WHERE ts.project_id = ${id} ${q.status ? sql`AND ts.status = ${q.status}` : sql``} ORDER BY ts.work_date DESC, ts.created_at DESC LIMIT 500`;
    return { items: rows };
  });

  app.post('/api/v1/projects/:id/timesheets/:tid/decide', { ...auth, preValidation: M }, async (req) => {
    const { id, tid } = z.object({ id: z.string().uuid(), tid: z.string().uuid() }).parse(req.params);
    const b = z.object({ decision: z.enum(['APPROVE', 'REJECT']) }).parse(req.body);
    const u = req.authUser;
    const [t] = await sql`SELECT * FROM project_timesheets WHERE id = ${tid} AND project_id = ${id} AND tenant_id = ${u.tenantId}`;
    if (!t) throw notFound('Timesheet');
    if (t.userId === u.id) throw forbidden('Maker-checker: timesheet tidak boleh disetujui pembuatnya');
    if (t.status !== 'SUBMITTED') throw conflict('Timesheet sudah diputuskan');
    const [row] = await sql`UPDATE project_timesheets SET status = ${b.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED'}, approved_by = ${u.id}, approved_at = now() WHERE id = ${tid} RETURNING *`;
    await audit(sql, u, 'project.timesheet_decide', 'project', id, null, { tid, decision: b.decision }, req.ip);
    return row;
  });

  /* ───── Change request ───── */
  app.post('/api/v1/projects/:id/change-requests', { ...auth, preValidation: M }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ title: z.string().min(3).max(200), description: z.string().min(10).max(4000), reason: z.string().min(5).max(2000),
      valueDelta: z.number().min(-1e12).max(1e12).default(0), mdDelta: z.number().min(-1000).max(5000).default(0), scheduleDeltaDays: z.number().int().min(-365).max(730).default(0) }).parse(req.body);
    if (b.valueDelta === 0 && b.mdDelta === 0 && b.scheduleDeltaDays === 0) throw badRequest('CR tanpa dampak nilai, effort, atau jadwal tidak perlu diajukan');
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const p = await loadProject(u.tenantId, id, tx);
      if (p.status === 'CLOSED') throw unprocessable('Proyek sudah ditutup');
      const year = new Date().getFullYear();
      const n = await nextNumber(tx, u.tenantId, 'CHANGE_REQUEST', String(year));
      const [cr] = await tx`INSERT INTO change_requests (tenant_id, project_id, contract_id, number, title, description, reason, value_delta, md_delta, schedule_delta_days, created_by)
        VALUES (${u.tenantId}, ${id}, ${p.contractId}, ${`CR-${year}-${String(n).padStart(4, '0')}`}, ${b.title}, ${b.description}, ${b.reason}, ${b.valueDelta}, ${b.mdDelta}, ${b.scheduleDeltaDays}, ${u.id}) RETURNING *`;
      await audit(tx, u, 'change_request.create', 'change_request', cr.id as string, null, { number: cr.number, valueDelta: b.valueDelta }, req.ip);
      reply.code(201);
      return cr;
    });
  });

  /** Ajukan CR ke approval DoA (nilai = |Δ nilai|; level mengikuti kebijakan nilai kontrak). */
  app.post('/api/v1/projects/:id/change-requests/:crId/submit', { ...auth, preValidation: M }, async (req) => {
    const { id, crId } = z.object({ id: z.string().uuid(), crId: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    return sql.begin(async (tx: Tx) => {
      const [cr] = await tx`SELECT * FROM change_requests WHERE id = ${crId} AND project_id = ${id} AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!cr) throw notFound('Change request');
      if (cr.status !== 'DRAFT') throw unprocessable(`CR berstatus ${cr.status}`);
      const value = Math.abs(Number(cr.valueDelta));
      const { request, evaluation } = await createApprovalRequest(tx, { tenantId: u.tenantId, entityType: 'change_request', entityId: crId, entityVersion: 1, requestedBy: u.id,
        metrics: { contractValue: value } as never,
        summary: { title: `${cr.number} — ${cr.title}`, totalBeforeTax: Number(cr.valueDelta), discountPct: 0,
          warnings: [Number(cr.valueDelta) < 0 ? 'Pengurangan nilai kontrak' : null, Number(cr.scheduleDeltaDays) > 0 ? `Mundur ${cr.scheduleDeltaDays} hari` : null].filter(Boolean) } });
      await tx`UPDATE change_requests SET status = 'IN_APPROVAL', approval_request_id = ${request.id} WHERE id = ${crId}`;
      await audit(tx, u, 'change_request.submit', 'change_request', crId, null, { approvalRequestId: request.id, level: evaluation.requiredLevel }, req.ip);
      return { id: crId, status: 'IN_APPROVAL', approvalRequestId: request.id, requiredLevel: evaluation.requiredLevel, steps: evaluation.steps };
    });
  });
}
