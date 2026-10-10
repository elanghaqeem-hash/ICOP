import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, requirePerm } from '../../lib/context.js';
import { notFound } from '../../lib/errors.js';
import { loadQuotation } from '../quotations/routes.js';
import { TEMPLATES, templateByCode } from './catalog.js';
import { renderTemplate } from './render.js';

const idr = (n: number) => `Rp ${Number(n).toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;

export async function templateRoutes(app: FastifyInstance) {
  const sql = app.sql;
  const auth = { onRequest: [app.authenticate] };
  const R = requirePerm('template.read');

  const statusOf = async (tenantId: string, code: string) => {
    const [s] = await sql`SELECT status, version, approved_at, approved_by, note FROM template_status WHERE tenant_id = ${tenantId} AND code = ${code}`;
    return s ? { status: s.status as string, version: Number(s.version), approvedAt: s.approvedAt, approvedBy: s.approvedBy as string | null, note: s.note as string | null }
      : { status: 'PENDING_LEGAL', version: 1, approvedAt: null, approvedBy: null, note: null };
  };

  app.get('/api/v1/templates', { ...auth, preValidation: R }, async (req) => {
    const rows = await sql`SELECT code, status, version, approved_at FROM template_status WHERE tenant_id = ${req.authUser.tenantId}`;
    const map = new Map(rows.map((r) => [r.code as string, r]));
    return { items: TEMPLATES.map((t) => { const s = map.get(t.code); return { code: t.code, title: t.title, category: t.category, legalBasis: t.legalBasis,
      status: (s?.status as string) ?? 'PENDING_LEGAL', version: Number(s?.version ?? 1), approvedAt: s?.approvedAt ?? null, fields: t.fields }; }) };
  });

  app.post('/api/v1/templates/:code/render', { ...auth, preValidation: R }, async (req) => {
    const { code } = z.object({ code: z.string() }).parse(req.params);
    const t = templateByCode(code);
    if (!t) throw notFound('Template');
    const b = z.object({ values: z.record(z.string().max(4000)).default({}), quotationId: z.string().uuid().optional() }).parse(req.body ?? {});
    const values: Record<string, string> = { kotaTanggal: `Jakarta, ${new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' })}`, ...b.values };
    if (b.quotationId) {
      const q = await loadQuotation(sql, req.authUser.tenantId, b.quotationId);
      values.namaPenerima ??= q.customerName as string;
      values.namaProyek ??= q.title as string;
      values.nilaiPenawaran ??= `${idr(Number(q.totalBeforeTax))} (belum termasuk PPN)`;
      values.nomorSurat ??= q.number as string;
    }
    const st = await statusOf(req.authUser.tenantId, code);
    const out = renderTemplate(t, values, st.status === 'APPROVED', { number: values.nomorSurat });
    await audit(sql, req.authUser, 'template.render', 'template', code, null, { missing: out.missing, quotationId: b.quotationId ?? null, approved: st.status === 'APPROVED' }, req.ip);
    return { code, status: st.status, html: out.html, missing: out.missing };
  });

  /** Pengesahan template oleh Legal (bukan pembuat: legal review hanya oleh role legal). */
  app.post('/api/v1/templates/:code/approve', { ...auth, preValidation: requirePerm('template.approve') }, async (req) => {
    const { code } = z.object({ code: z.string() }).parse(req.params);
    if (!templateByCode(code)) throw notFound('Template');
    const b = z.object({ note: z.string().min(10).max(1000) }).parse(req.body);
    const u = req.authUser;
    const [row] = await sql`INSERT INTO template_status (tenant_id, code, version, status, approved_by, approved_at, note)
      VALUES (${u.tenantId}, ${code}, 1, 'APPROVED', ${u.id}, now(), ${b.note})
      ON CONFLICT (tenant_id, code) DO UPDATE SET status = 'APPROVED', approved_by = ${u.id}, approved_at = now(), note = ${b.note}
      RETURNING code, status, version, approved_at`;
    await audit(sql, u, 'template.approve', 'template', code, null, { note: b.note }, req.ip);
    return row;
  });
}
