import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Tx } from '../../db.js';
import { audit, nextNumber, notify, requirePerm } from '../../lib/context.js';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';

export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
/** Target SLA bawaan (menit) — praktik umum layanan SOC/MSSP; dapat diubah admin per tenant. */
export const DEFAULT_SLA: Record<string, { response: number; resolution: number }> = {
  P1: { response: 15, resolution: 240 }, P2: { response: 60, resolution: 480 }, P3: { response: 240, resolution: 1440 }, P4: { response: 480, resolution: 4320 },
};
const SEVERITY_TO_PRIORITY: Record<string, string> = { critical: 'P1', high: 'P2', medium: 'P3', low: 'P4', info: 'P4' };
const FLOW: Record<string, string[]> = {
  OPEN: ['IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED'], IN_PROGRESS: ['WAITING_CUSTOMER', 'RESOLVED'], WAITING_CUSTOMER: ['IN_PROGRESS', 'RESOLVED'],
  RESOLVED: ['IN_PROGRESS', 'CLOSED'], CLOSED: [],
};

async function slaFor(db: any, tenantId: string, priority: string) {
  const [r] = await db`SELECT response_minutes, resolution_minutes FROM sla_targets WHERE tenant_id = ${tenantId} AND priority = ${priority}`;
  return r ? { response: Number(r.responseMinutes), resolution: Number(r.resolutionMinutes) } : DEFAULT_SLA[priority];
}

async function createTicket(tx: Tx | any, tenantId: string, actorId: string | null, b: { customerId: string; projectId?: string | null; source: string; category: string; priority: string;
  title: string; description: string; assigneeId?: string | null; externalRef?: string | null; meta?: Record<string, unknown> }) {
  const sla = await slaFor(tx, tenantId, b.priority);
  const year = new Date().getFullYear();
  const n = await nextNumber(tx, tenantId, 'TICKET', String(year));
  const [t] = await tx`INSERT INTO tickets (tenant_id, number, customer_id, project_id, source, category, priority, title, description, assignee_id,
      response_due_at, resolution_due_at, external_ref, meta, created_by)
    VALUES (${tenantId}, ${`TCK-${year}-${String(n).padStart(5, '0')}`}, ${b.customerId}, ${b.projectId ?? null}, ${b.source}, ${b.category}, ${b.priority}, ${b.title}, ${b.description},
            ${b.assigneeId ?? null}, now() + make_interval(mins => ${sla.response}), now() + make_interval(mins => ${sla.resolution}), ${b.externalRef ?? null},
            ${tx.json((b.meta ?? {}) as never)}, ${actorId}) RETURNING *`;
  const team = b.assigneeId ? [b.assigneeId] : (await tx`SELECT id FROM users WHERE tenant_id = ${tenantId} AND is_active AND role IN ('soc_operations','project_manager')`).map((x: any) => x.id as string);
  await notify(tx, tenantId, team, 'TICKET_NEW', `${t.number} [${b.priority}] ${b.title}`, `Respons sebelum ${new Date(t.responseDueAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`, `/helpdesk/${t.id}`);
  await audit(tx, { tenantId, id: actorId }, 'ticket.create', 'ticket', t.id as string, null, { number: t.number, priority: b.priority, source: b.source });
  return t;
}

/** Status SLA saat ini (tanpa jeda WAITING_CUSTOMER — kebijakan konservatif). */
const slaView = (t: Record<string, any>) => {
  const now = Date.now();
  const responded = !!t.firstResponseAt; const resolved = !!t.resolvedAt;
  return {
    responseBreached: t.responseBreached || (!responded && now > new Date(t.responseDueAt).getTime()) || (responded && new Date(t.firstResponseAt) > new Date(t.responseDueAt)),
    resolutionBreached: t.resolutionBreached || (!resolved && now > new Date(t.resolutionDueAt).getTime()) || (resolved && new Date(t.resolvedAt) > new Date(t.resolutionDueAt)),
    minutesToResolution: resolved ? null : Math.round((new Date(t.resolutionDueAt).getTime() - now) / 60000),
  };
};

export async function helpdeskRoutes(app: FastifyInstance) {
  const sql = app.sql;
  const auth = { onRequest: [app.authenticate] };
  const R = requirePerm('helpdesk.read');
  const W = requirePerm('helpdesk.work');
  const portal = { onRequest: [app.authenticate], preValidation: requirePerm('portal.access') };

  const load = async (tenantId: string, id: string, db: any = sql, lock = false) => {
    const [t] = lock ? await db`SELECT * FROM tickets WHERE id = ${id} AND tenant_id = ${tenantId} FOR UPDATE`
      : await db`SELECT t.*, c.legal_name AS customer_name, a.full_name AS assignee_name, p.code AS project_code FROM tickets t JOIN customers c ON c.id = t.customer_id
                 LEFT JOIN users a ON a.id = t.assignee_id LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ${id} AND t.tenant_id = ${tenantId}`;
    if (!t) throw notFound('Tiket');
    return t as Record<string, any>;
  };

  app.get('/api/v1/helpdesk/sla', { ...auth, preValidation: R }, async (req) => {
    const out = [];
    for (const p of PRIORITIES) out.push({ priority: p, ...(await slaFor(sql, req.authUser.tenantId, p)) });
    return { items: out };
  });

  app.put('/api/v1/helpdesk/sla', { ...auth, preValidation: requirePerm('integration.admin') }, async (req) => {
    const b = z.object({ items: z.array(z.object({ priority: z.enum(PRIORITIES), response: z.number().int().min(1).max(10080), resolution: z.number().int().min(1).max(43200) })).min(1).max(4) }).parse(req.body);
    const u = req.authUser;
    for (const it of b.items) {
      if (it.resolution < it.response) throw badRequest(`${it.priority}: target resolusi harus ≥ target respons`);
      await sql`INSERT INTO sla_targets (tenant_id, priority, response_minutes, resolution_minutes) VALUES (${u.tenantId}, ${it.priority}, ${it.response}, ${it.resolution})
                ON CONFLICT (tenant_id, priority) DO UPDATE SET response_minutes = EXCLUDED.response_minutes, resolution_minutes = EXCLUDED.resolution_minutes`;
    }
    await audit(sql, u, 'sla.update', 'sla_targets', null, null, b.items, req.ip);
    return { ok: true };
  });

  app.get('/api/v1/tickets', { ...auth, preValidation: R }, async (req) => {
    const q = z.object({ status: z.string().optional(), priority: z.enum(PRIORITIES).optional(), open: z.coerce.boolean().optional(), mine: z.coerce.boolean().optional() }).parse(req.query);
    const u = req.authUser;
    const rows = await sql`SELECT t.id, t.number, t.title, t.priority, t.status, t.category, t.source, t.created_at, t.response_due_at, t.resolution_due_at, t.first_response_at, t.resolved_at,
        t.response_breached, t.resolution_breached, c.legal_name AS customer_name, a.full_name AS assignee_name
      FROM tickets t JOIN customers c ON c.id = t.customer_id LEFT JOIN users a ON a.id = t.assignee_id
      WHERE t.tenant_id = ${u.tenantId} ${q.status ? sql`AND t.status = ${q.status}` : sql``} ${q.priority ? sql`AND t.priority = ${q.priority}` : sql``}
        ${q.open ? sql`AND t.status NOT IN ('RESOLVED','CLOSED')` : sql``} ${q.mine ? sql`AND t.assignee_id = ${u.id}` : sql``}
      ORDER BY (t.status IN ('RESOLVED','CLOSED')), t.priority, t.resolution_due_at LIMIT 300`;
    const items = rows.map((t) => ({ ...t, ...slaView(t) }) as Record<string, any>);
    const open = items.filter((t) => !['RESOLVED', 'CLOSED'].includes(t.status as string));
    return { items, summary: { open: open.length, breached: open.filter((t) => t.responseBreached || t.resolutionBreached).length, p1Open: open.filter((t) => t.priority === 'P1').length } };
  });

  app.post('/api/v1/tickets', { ...auth, preValidation: W }, async (req, reply) => {
    const b = z.object({ customerId: z.string().uuid(), projectId: z.string().uuid().optional(), category: z.enum(['INCIDENT', 'SERVICE_REQUEST', 'QUESTION', 'VULNERABILITY']),
      priority: z.enum(PRIORITIES), title: z.string().min(5).max(300), description: z.string().min(5).max(8000), assigneeId: z.string().uuid().optional() }).parse(req.body);
    const u = req.authUser;
    const [c] = await sql`SELECT 1 FROM customers WHERE id = ${b.customerId} AND tenant_id = ${u.tenantId}`;
    if (!c) throw notFound('Customer');
    if (b.projectId) { const [p] = await sql`SELECT 1 FROM projects WHERE id = ${b.projectId} AND customer_id = ${b.customerId}`; if (!p) throw badRequest('Proyek bukan milik customer ini'); }
    reply.code(201);
    return sql.begin((tx) => createTicket(tx, u.tenantId, u.id, { ...b, source: 'INTERNAL' }));
  });

  app.get('/api/v1/tickets/:id', { ...auth, preValidation: R }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const t = await load(req.authUser.tenantId, id);
    const comments = await sql`SELECT c.id, c.body, c.internal, c.created_at, u.full_name AS author_name, u.role AS author_role FROM ticket_comments c LEFT JOIN users u ON u.id = c.author_id
                               WHERE c.ticket_id = ${id} ORDER BY c.id`;
    return { ticket: { ...t, ...slaView(t) }, comments, allowedTransitions: FLOW[t.status] ?? [] };
  });

  /** Ubah status/assignee/prioritas. Perubahan prioritas menghitung ulang target SLA dari waktu tiket dibuat. */
  app.patch('/api/v1/tickets/:id', { ...auth, preValidation: W }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ status: z.enum(['IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED']).optional(), assigneeId: z.string().uuid().nullable().optional(),
      priority: z.enum(PRIORITIES).optional(), resolution: z.string().min(10).max(4000).optional() }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const t = await load(u.tenantId, id, tx, true);
      if (b.status) {
        if (!(FLOW[t.status] ?? []).includes(b.status)) throw unprocessable(`Transisi ${t.status} → ${b.status} tidak diizinkan`);
        if (b.status === 'RESOLVED' && !b.resolution) throw badRequest('Ringkasan penyelesaian wajib diisi');
        await tx`UPDATE tickets SET status = ${b.status},
          first_response_at = coalesce(first_response_at, ${b.status === 'IN_PROGRESS' || b.status === 'RESOLVED' || b.status === 'WAITING_CUSTOMER' ? sql`now()` : null}),
          resolved_at = ${b.status === 'RESOLVED' ? sql`now()` : b.status === 'IN_PROGRESS' ? null : t.resolvedAt},
          closed_at = ${b.status === 'CLOSED' ? sql`now()` : null}, updated_at = now() WHERE id = ${id}`;
        if (b.resolution) await tx`INSERT INTO ticket_comments (tenant_id, ticket_id, author_id, body, internal) VALUES (${u.tenantId}, ${id}, ${u.id}, ${`Penyelesaian: ${b.resolution}`}, false)`;
      }
      if (b.assigneeId !== undefined) {
        if (b.assigneeId) { const [a] = await tx`SELECT 1 FROM users WHERE id = ${b.assigneeId} AND tenant_id = ${u.tenantId} AND is_active AND role <> 'customer_user'`; if (!a) throw badRequest('Penanggung jawab tidak valid'); }
        await tx`UPDATE tickets SET assignee_id = ${b.assigneeId}, updated_at = now() WHERE id = ${id}`;
        if (b.assigneeId) await notify(tx, u.tenantId, [b.assigneeId], 'TICKET_ASSIGNED', `${t.number} ditugaskan kepada Anda`, t.title, `/helpdesk/${id}`);
      }
      if (b.priority && b.priority !== t.priority) {
        const sla = await slaFor(tx, u.tenantId, b.priority);
        await tx`UPDATE tickets SET priority = ${b.priority}, response_due_at = created_at + make_interval(mins => ${sla.response}),
                 resolution_due_at = created_at + make_interval(mins => ${sla.resolution}), updated_at = now() WHERE id = ${id}`;
      }
      await audit(tx, u, 'ticket.update', 'ticket', id, { status: t.status, priority: t.priority, assigneeId: t.assigneeId }, b, req.ip);
      return load(u.tenantId, id, tx);
    });
  });

  app.post('/api/v1/tickets/:id/comments', { ...auth, preValidation: W }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ body: z.string().min(2).max(8000), internal: z.boolean().default(false) }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const t = await load(u.tenantId, id, tx, true);
      if (t.status === 'CLOSED') throw unprocessable('Tiket sudah ditutup');
      const [c] = await tx`INSERT INTO ticket_comments (tenant_id, ticket_id, author_id, body, internal) VALUES (${u.tenantId}, ${id}, ${u.id}, ${b.body}, ${b.internal}) RETURNING *`;
      if (!b.internal) await tx`UPDATE tickets SET first_response_at = coalesce(first_response_at, now()), status = CASE WHEN status = 'OPEN' THEN 'IN_PROGRESS' ELSE status END, updated_at = now() WHERE id = ${id}`;
      reply.code(201);
      return c;
    });
  });

  /* ───── Portal customer ───── */
  app.get('/api/v1/portal/tickets', portal, async (req) => {
    const u = req.authUser;
    const rows = await sql`SELECT id, number, title, priority, status, category, created_at, resolution_due_at, resolved_at FROM tickets
                           WHERE tenant_id = ${u.tenantId} AND customer_id = ${u.customerId} ORDER BY created_at DESC LIMIT 200`;
    return { items: rows };
  });

  app.post('/api/v1/portal/tickets', portal, async (req, reply) => {
    const b = z.object({ category: z.enum(['INCIDENT', 'SERVICE_REQUEST', 'QUESTION']), priority: z.enum(PRIORITIES).default('P3'), title: z.string().min(5).max(300),
      description: z.string().min(10).max(8000), projectId: z.string().uuid().optional() }).parse(req.body);
    const u = req.authUser;
    if (b.projectId) { const [p] = await sql`SELECT 1 FROM projects WHERE id = ${b.projectId} AND customer_id = ${u.customerId}`; if (!p) throw notFound('Proyek'); }
    reply.code(201);
    const t = await sql.begin((tx) => createTicket(tx, u.tenantId, u.id, { ...b, customerId: u.customerId!, source: 'PORTAL' }));
    return { id: t.id, number: t.number, priority: t.priority, status: t.status, responseDueAt: t.responseDueAt };
  });

  app.get('/api/v1/portal/tickets/:id', portal, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    const [t] = await sql`SELECT id, number, title, description, priority, status, category, created_at, response_due_at, resolution_due_at, first_response_at, resolved_at, closed_at
                          FROM tickets WHERE id = ${id} AND tenant_id = ${u.tenantId} AND customer_id = ${u.customerId}`;
    if (!t) throw notFound('Tiket');
    const comments = await sql`SELECT c.id, c.body, c.created_at, u.full_name AS author_name, (u.role = 'customer_user') AS from_customer FROM ticket_comments c
                               LEFT JOIN users u ON u.id = c.author_id WHERE c.ticket_id = ${id} AND NOT c.internal ORDER BY c.id`;
    return { ticket: t, comments };
  });

  app.post('/api/v1/portal/tickets/:id/comments', portal, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ body: z.string().min(2).max(8000) }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const [t] = await tx`SELECT * FROM tickets WHERE id = ${id} AND tenant_id = ${u.tenantId} AND customer_id = ${u.customerId} FOR UPDATE`;
      if (!t) throw notFound('Tiket');
      if (t.status === 'CLOSED') throw unprocessable('Tiket sudah ditutup');
      const [c] = await tx`INSERT INTO ticket_comments (tenant_id, ticket_id, author_id, body, internal) VALUES (${u.tenantId}, ${id}, ${u.id}, ${b.body}, false) RETURNING id, body, created_at`;
      if (t.status === 'WAITING_CUSTOMER') await tx`UPDATE tickets SET status = 'IN_PROGRESS', updated_at = now() WHERE id = ${id}`;
      if (t.assigneeId) await notify(tx, u.tenantId, [t.assigneeId as string], 'TICKET_REPLY', `Balasan customer ${t.number}`, b.body.slice(0, 120), `/helpdesk/${id}`);
      reply.code(201);
      return c;
    });
  });

  /** Customer mengonfirmasi penyelesaian (RESOLVED → CLOSED) atau membuka kembali. */
  app.post('/api/v1/portal/tickets/:id/:action', portal, async (req) => {
    const { id, action } = z.object({ id: z.string().uuid(), action: z.enum(['confirm', 'reopen']) }).parse(req.params);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const [t] = await tx`SELECT * FROM tickets WHERE id = ${id} AND tenant_id = ${u.tenantId} AND customer_id = ${u.customerId} FOR UPDATE`;
      if (!t) throw notFound('Tiket');
      if (t.status !== 'RESOLVED') throw unprocessable('Hanya tiket berstatus RESOLVED');
      const status = action === 'confirm' ? 'CLOSED' : 'IN_PROGRESS';
      await tx`UPDATE tickets SET status = ${status}, closed_at = ${action === 'confirm' ? sql`now()` : null}, resolved_at = ${action === 'confirm' ? t.resolvedAt : null}, updated_at = now() WHERE id = ${id}`;
      await audit(tx, u, `ticket.portal_${action}`, 'ticket', id, { status: t.status }, { status }, req.ip);
      return { id, status };
    });
  });

  /* ───── Ingest SOC / VAPT (API key layanan; tanpa JWT) ───── */
  const ingestAuth = async (req: FastifyRequest, scope: 'INGEST_SOC' | 'INGEST_VAPT') => {
    const key = String(req.headers['x-api-key'] ?? '');
    if (!/^icop_[0-9a-f]{8}_/.test(key)) throw new AppError(401, 'INVALID_API_KEY', 'API key tidak valid');
    const [k] = await sql`SELECT * FROM service_api_keys WHERE key_hash = ${createHash('sha256').update(key).digest('hex')} AND revoked_at IS NULL`;
    if (!k) throw new AppError(401, 'INVALID_API_KEY', 'API key tidak valid atau dicabut');
    if (k.scope !== scope) throw forbidden('API key tidak memiliki scope ini');
    await sql`UPDATE service_api_keys SET last_used_at = now() WHERE id = ${k.id}`;
    return k as Record<string, any>;
  };
  const IngestBody = z.object({ externalId: z.string().min(1).max(200), severity: z.enum(['critical', 'high', 'medium', 'low', 'info']), title: z.string().min(3).max(300),
    description: z.string().min(3).max(8000), customerId: z.string().uuid().optional(), asset: z.string().max(300).optional(), detectedAt: z.string().datetime({ offset: true }).optional(),
    cvss: z.number().min(0).max(10).optional(), cve: z.string().max(40).optional(), projectId: z.string().uuid().optional() });

  const ingest = (scope: 'INGEST_SOC' | 'INGEST_VAPT', source: 'SOC_INGEST' | 'VAPT_INGEST', category: 'INCIDENT' | 'VULNERABILITY') => async (req: FastifyRequest, reply: any) => {
    const k = await ingestAuth(req, scope);
    const b = IngestBody.parse(req.body);
    const customerId = (k.customerId as string | null) ?? b.customerId;
    if (!customerId) throw badRequest('customerId wajib bila API key tidak terikat ke customer');
    if (k.customerId && b.customerId && b.customerId !== k.customerId) throw forbidden('API key terikat ke customer lain');
    const [c] = await sql`SELECT 1 FROM customers WHERE id = ${customerId} AND tenant_id = ${k.tenantId}`;
    if (!c) throw notFound('Customer');
    const [dup] = await sql`SELECT id, number, priority, status FROM tickets WHERE tenant_id = ${k.tenantId} AND source = ${source} AND external_ref = ${b.externalId}`;
    if (dup) return { ticketId: dup.id, number: dup.number, priority: dup.priority, status: dup.status, duplicate: true };
    try {
      const t = await sql.begin((tx) => createTicket(tx, k.tenantId as string, null, { customerId, projectId: b.projectId ?? null, source, category,
        priority: SEVERITY_TO_PRIORITY[b.severity], title: b.title, description: b.description, externalRef: b.externalId,
        meta: { severity: b.severity, asset: b.asset ?? null, detectedAt: b.detectedAt ?? null, cvss: b.cvss ?? null, cve: b.cve ?? null, apiKey: k.keyPrefix } }));
      reply.code(201);
      return { ticketId: t.id, number: t.number, priority: t.priority, status: t.status, responseDueAt: t.responseDueAt, duplicate: false };
    } catch (e) { if ((e as { code?: string }).code === '23505') throw conflict('externalId sedang diproses'); throw e; }
  };
  app.post('/api/v1/ingest/soc-alerts', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, ingest('INGEST_SOC', 'SOC_INGEST', 'INCIDENT'));
  app.post('/api/v1/ingest/vapt-findings', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, ingest('INGEST_VAPT', 'VAPT_INGEST', 'VULNERABILITY'));
}

/** Job: tandai pelanggaran SLA & eskalasi (sekali per jenis pelanggaran). */
export async function slaBreachCheck(sql: any) {
  const resp = await sql`UPDATE tickets SET response_breached = true WHERE NOT response_breached AND first_response_at IS NULL AND response_due_at < now()
                         AND status NOT IN ('RESOLVED','CLOSED') RETURNING id, tenant_id, number, priority, title, assignee_id`;
  const reso = await sql`UPDATE tickets SET resolution_breached = true WHERE NOT resolution_breached AND resolved_at IS NULL AND resolution_due_at < now()
                         AND status NOT IN ('RESOLVED','CLOSED') RETURNING id, tenant_id, number, priority, title, assignee_id`;
  for (const [rows, kind] of [[resp, 'respons'], [reso, 'resolusi']] as const) {
    for (const t of rows) {
      const mgrs = await sql`SELECT id FROM users WHERE tenant_id = ${t.tenantId} AND is_active AND role IN ('vp_head','project_manager'${t.priority === 'P1' ? sql`, 'director'` : sql``})`;
      const to = [...new Set([...(t.assigneeId ? [t.assigneeId] : []), ...mgrs.map((m: any) => m.id)])] as string[];
      await notify(sql, t.tenantId, to, 'SLA_BREACH', `Pelanggaran SLA ${kind} ${t.number} [${t.priority}]`, t.title, `/helpdesk/${t.id}`);
    }
  }
  return { slaResponseBreached: resp.length, slaResolutionBreached: reso.length };
}
