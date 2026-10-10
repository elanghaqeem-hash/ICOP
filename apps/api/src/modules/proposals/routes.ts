import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Tx } from '../../db.js';
import { audit, nextNumber, notify, requirePerm } from '../../lib/context.js';
import { badRequest, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { idempotent } from '../../lib/idempotency.js';
import { AiUnavailableError, complete } from '../ai/gateway.js';
import type { FetchLike } from '../ai/providers.js';
import { SECTION_DEFS, TODO, allowedContextFor, buildGroundedSections, lineDiff, unsupportedClaims, type Source } from './generate.js';
import { proposalDocx, proposalHtml } from './export.js';

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

async function snapshot(tx: Tx, tenantId: string, proposalId: string, reason: string, userId: string | null) {
  const [p] = await tx`SELECT * FROM proposals WHERE id = ${proposalId}`;
  const sections = await tx`SELECT key, title, content, sources, status FROM proposal_sections WHERE proposal_id = ${proposalId} ORDER BY seq`;
  await tx`INSERT INTO proposal_versions (tenant_id, proposal_id, version, reason, snapshot, created_by)
           VALUES (${tenantId}, ${proposalId}, ${p.version}, ${reason}, ${tx.json({ title: p.title, status: p.status, sections } as never)}, ${userId})`;
}

/** Setiap perubahan isi pada proposal REVIEWED mengembalikannya ke DRAFT dan menaikkan versi. */
async function touch(tx: Tx, proposalId: string) {
  const [p] = await tx`SELECT status FROM proposals WHERE id = ${proposalId} FOR UPDATE`;
  if (p.status === 'REVIEWED' || p.status === 'IN_REVIEW') {
    await tx`UPDATE proposals SET status = 'DRAFT', version = version + ${p.status === 'REVIEWED' ? 1 : 0}, reviewer_id = NULL, reviewed_at = NULL, updated_at = now() WHERE id = ${proposalId}`;
  } else await tx`UPDATE proposals SET updated_at = now() WHERE id = ${proposalId}`;
}

export async function proposalRoutes(app: FastifyInstance, opts: { fetchImpl?: FetchLike }) {
  const sql = app.sql;
  const auth = { onRequest: [app.authenticate] };
  const R = requirePerm('proposal.read');
  const W = requirePerm('proposal.write');

  const load = async (tenantId: string, id: string, db: any = sql) => {
    const [p] = await db`SELECT p.*, c.legal_name AS customer_name, o.code AS opportunity_code, t.code AS tender_code, ru.full_name AS reviewer_name, cu.full_name AS created_by_name
      FROM proposals p JOIN customers c ON c.id = p.customer_id JOIN opportunities o ON o.id = p.opportunity_id LEFT JOIN tenders t ON t.id = p.tender_id
      LEFT JOIN users ru ON ru.id = p.reviewer_id LEFT JOIN users cu ON cu.id = p.created_by WHERE p.id = ${id} AND p.tenant_id = ${tenantId}`;
    if (!p) throw notFound('Proposal');
    const sections = await db`SELECT s.*, u.full_name AS updated_by_name FROM proposal_sections s LEFT JOIN users u ON u.id = s.updated_by WHERE s.proposal_id = ${id} ORDER BY s.seq`;
    return { ...p, sections } as Record<string, any> & { sections: Record<string, any>[] };
  };

  const guard = async (db: any, tenantId: string, tenderId: string | null, content: string, sources: Source[]) => {
    const ctx = await allowedContextFor(db, tenantId, [{ content: '', sources }], tenderId);
    return unsupportedClaims(content, ctx);
  };

  app.get('/api/v1/proposals', { ...auth, preValidation: R }, async (req) => {
    const q = z.object({ opportunityId: z.string().uuid().optional(), tenderId: z.string().uuid().optional() }).parse(req.query);
    const rows = await sql`SELECT p.id, p.number, p.title, p.status, p.version, p.language, p.updated_at, c.legal_name AS customer_name,
        (SELECT count(*)::int FROM proposal_sections s WHERE s.proposal_id = p.id AND (s.status = 'FLAGGED' OR s.content LIKE ${'%' + TODO + '%'})) AS open_items
      FROM proposals p JOIN customers c ON c.id = p.customer_id WHERE p.tenant_id = ${req.authUser.tenantId}
        ${q.opportunityId ? sql`AND p.opportunity_id = ${q.opportunityId}` : sql``} ${q.tenderId ? sql`AND p.tender_id = ${q.tenderId}` : sql``}
      ORDER BY p.updated_at DESC LIMIT 200`;
    return { items: rows };
  });

  app.post('/api/v1/proposals', { ...auth, preValidation: W }, async (req, reply) => {
    const b = z.object({ opportunityId: z.string().uuid(), tenderId: z.string().uuid().optional(), title: z.string().min(3).max(300).optional(),
      language: z.enum(['id', 'en']).default('id') }).parse(req.body);
    const u = req.authUser;
    return idempotent(req, reply, 201, () => sql.begin(async (tx) => {
      const [o] = await tx`SELECT id, name, customer_id FROM opportunities WHERE id = ${b.opportunityId} AND tenant_id = ${u.tenantId}`;
      if (!o) throw notFound('Opportunity');
      if (b.tenderId) {
        const [t] = await tx`SELECT id, opportunity_id FROM tenders WHERE id = ${b.tenderId} AND tenant_id = ${u.tenantId}`;
        if (!t) throw notFound('Tender');
        if (t.opportunityId && t.opportunityId !== b.opportunityId) throw badRequest('Tender terhubung ke opportunity lain');
      }
      const now = new Date();
      const n = await nextNumber(tx, u.tenantId, 'PROPOSAL', String(now.getFullYear()));
      const number = `${String(n).padStart(3, '0')}/DEIT-PRP/${ROMAN[now.getMonth()]}/${now.getFullYear()}`;
      const [p] = await tx`INSERT INTO proposals (tenant_id, number, opportunity_id, tender_id, customer_id, title, language, created_by)
        VALUES (${u.tenantId}, ${number}, ${o.id}, ${b.tenderId ?? null}, ${o.customerId}, ${b.title ?? o.name}, ${b.language}, ${u.id}) RETURNING id`;
      const drafts = await buildGroundedSections(tx, u.tenantId, o.id as string, b.tenderId ?? null);
      let seq = 0;
      for (const d of drafts) {
        await tx`INSERT INTO proposal_sections (tenant_id, proposal_id, seq, key, title, required, content, sources, missing_info, status, generated_by, updated_by)
          VALUES (${u.tenantId}, ${p.id}, ${++seq}, ${d.key}, ${b.language === 'en' ? d.titleEn : d.title}, ${d.required}, ${d.content}, ${tx.json(d.sources as never)},
                  ${tx.json(d.missing as never)}, ${d.content.trim() ? 'GENERATED' : 'EMPTY'}, 'grounded-template', ${u.id})`;
      }
      await snapshot(tx, u.tenantId, p.id as string, 'generated', u.id);
      await audit(tx, u, 'proposal.create', 'proposal', p.id as string, null, { number, tenderId: b.tenderId ?? null }, req.ip);
      return load(u.tenantId, p.id as string, tx);
    }));
  });

  app.get('/api/v1/proposals/:id', { ...auth, preValidation: R }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return load(req.authUser.tenantId, id);
  });

  /** Regenerasi dari data terbaru — hanya bagian yang belum diedit manusia (kecuali force). */
  app.post('/api/v1/proposals/:id/regenerate', { ...auth, preValidation: W }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ keys: z.array(z.string()).optional(), force: z.boolean().default(false) }).parse(req.body ?? {});
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const p = await load(u.tenantId, id, tx);
      const drafts = await buildGroundedSections(tx, u.tenantId, p.opportunityId, p.tenderId);
      const updated: string[] = []; const skipped: string[] = [];
      for (const d of drafts) {
        if (b.keys && !b.keys.includes(d.key)) continue;
        const cur = p.sections.find((s) => s.key === d.key);
        if (cur && ['EDITED', 'AI_DRAFT', 'FLAGGED'].includes(cur.status) && !b.force) { skipped.push(d.key); continue; }
        await tx`UPDATE proposal_sections SET content = ${d.content}, sources = ${tx.json(d.sources as never)}, missing_info = ${tx.json(d.missing as never)}, flags = '[]',
                 status = 'GENERATED', generated_by = 'grounded-template', updated_by = ${u.id}, updated_at = now() WHERE proposal_id = ${id} AND key = ${d.key}`;
        updated.push(d.key);
      }
      if (updated.length) await touch(tx, id);
      await audit(tx, u, 'proposal.regenerate', 'proposal', id, null, { updated, skipped }, req.ip);
      return { updated, skipped };
    });
  });

  app.put('/api/v1/proposals/:id/sections/:key', { ...auth, preValidation: W }, async (req) => {
    const { id, key } = z.object({ id: z.string().uuid(), key: z.string() }).parse(req.params);
    const b = z.object({ content: z.string().max(60000) }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const p = await load(u.tenantId, id, tx);
      const s = p.sections.find((x) => x.key === key);
      if (!s) throw notFound('Bagian proposal');
      const claims = await guard(tx, u.tenantId, p.tenderId, b.content, s.sources);
      const status = claims.length ? 'FLAGGED' : b.content.trim() ? 'EDITED' : 'EMPTY';
      const [after] = await tx`UPDATE proposal_sections SET content = ${b.content}, flags = ${tx.json(claims.map((c) => `Klaim tidak terverifikasi: "${c}"`) as never)},
        status = ${status}, updated_by = ${u.id}, updated_at = now() WHERE id = ${s.id} RETURNING *`;
      await touch(tx, id);
      await audit(tx, u, 'proposal.section_edit', 'proposal', id, { key, status: s.status }, { key, status, flags: claims.length }, req.ip);
      return after;
    });
  });

  /** Rewrite bagian oleh AI — hanya dari konten & sumber bagian itu; klaim baru tanpa dasar ditandai FLAGGED. */
  app.post('/api/v1/proposals/:id/sections/:key/ai', { ...auth, preValidation: W, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id, key } = z.object({ id: z.string().uuid(), key: z.string() }).parse(req.params);
    const b = z.object({ instruction: z.string().max(2000).optional() }).parse(req.body ?? {});
    const u = req.authUser;
    const p = await load(u.tenantId, id);
    const s = p.sections.find((x) => x.key === key);
    if (!s) throw notFound('Bagian proposal');
    if (!s.content.trim()) throw unprocessable('Bagian kosong — generate dari data terlebih dahulu');
    const lang = p.language === 'en' ? 'Bahasa Inggris profesional' : 'Bahasa Indonesia profesional';
    let r;
    try {
      r = await complete({ sql, fetchImpl: opts.fetchImpl }, { tenantId: u.tenantId, userId: u.id, feature: 'proposal_section', maxTokens: 2500, user:
        `Tulis ulang bagian proposal "${s.title}" dalam ${lang}, gaya konsultan eksekutif, ringkas dan terstruktur.\n` +
        `WAJIB: gunakan HANYA fakta pada <document>; pertahankan semua angka, kode referensi, tabel, dan penanda "${TODO}"; jangan menambahkan sertifikasi, ` +
        `pengalaman, referensi klien, otorisasi vendor, harga, atau nama personel. Kembalikan hanya isi bagian (tanpa judul).` +
        `${b.instruction ? `\nInstruksi tambahan pengguna: ${b.instruction}` : ''}\n<document>\n${s.content}\n</document>\n<context>Sumber: ${s.sources.map((x: Source) => x.label).join('; ')}</context>` });
    } catch (e) {
      if (e instanceof AiUnavailableError) { reply.code(503); return { code: 'AI_UNAVAILABLE', message: e.message, attempts: e.attempts }; }
      throw e;
    }
    const text = r.text.replace(/^```[a-z]*\n?|```$/g, '').trim();
    return sql.begin(async (tx) => {
      const claims = await guard(tx, u.tenantId, p.tenderId, text, s.sources);
      const lostTodo = s.content.includes(TODO) && !text.includes(TODO);
      const flags = [...claims.map((c) => `Klaim tidak terverifikasi: "${c}"`), ...(lostTodo ? [`AI menghapus penanda ${TODO} — periksa informasi yang belum tersedia`] : [])];
      const [after] = await tx`UPDATE proposal_sections SET content = ${text}, flags = ${tx.json(flags as never)}, status = ${flags.length ? 'FLAGGED' : 'AI_DRAFT'},
        generated_by = ${`${r.provider}:${r.model}`}, updated_by = ${u.id}, updated_at = now() WHERE id = ${s.id} RETURNING *`;
      await touch(tx, id);
      await audit(tx, u, 'proposal.section_ai', 'proposal', id, { key }, { key, provider: r.provider, flags: flags.length }, req.ip);
      return { ...after, provider: r.provider, attempts: r.attempts, requiresHumanReview: true };
    });
  });

  app.post('/api/v1/proposals/:id/submit-review', { ...auth, preValidation: W }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const p = await load(u.tenantId, id, tx);
      if (p.status !== 'DRAFT') throw unprocessable(`Proposal berstatus ${p.status}`);
      const flagged = p.sections.filter((s) => s.status === 'FLAGGED').map((s) => s.title);
      if (flagged.length) throw unprocessable('Selesaikan bagian yang ditandai klaim tidak terverifikasi', { sections: flagged });
      await tx`UPDATE proposals SET status = 'IN_REVIEW', updated_at = now() WHERE id = ${id}`;
      const reviewers = await tx`SELECT id FROM users WHERE tenant_id = ${u.tenantId} AND is_active AND role IN ('presales_engineer','solution_architect') AND id <> ${u.id}`;
      await notify(tx, u.tenantId, reviewers.map((r) => r.id as string), 'PROPOSAL_REVIEW', `Review proposal ${p.number}`, p.title, `/proposals/${id}`);
      await audit(tx, u, 'proposal.submit_review', 'proposal', id, { status: 'DRAFT' }, { status: 'IN_REVIEW' }, req.ip);
      return { id, status: 'IN_REVIEW' };
    });
  });

  /** Technical reviewer sign-off (bukan pembuat). Diblokir bila ada klaim tak terverifikasi, penanda [PERLU DILENGKAPI], atau bagian wajib kosong. */
  app.post('/api/v1/proposals/:id/review', { ...auth, preValidation: requirePerm('proposal.review') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ decision: z.enum(['APPROVE', 'RETURN']), note: z.string().max(2000).optional() }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const p = await load(u.tenantId, id, tx);
      if (p.status !== 'IN_REVIEW') throw unprocessable('Proposal belum diajukan untuk review');
      if (p.createdBy === u.id) throw forbidden('Segregation of Duties: pembuat proposal tidak boleh mereview sendiri');
      if (b.decision === 'RETURN') {
        if (!b.note) throw badRequest('Catatan wajib untuk pengembalian');
        await tx`UPDATE proposals SET status = 'DRAFT', review_note = ${b.note}, updated_at = now() WHERE id = ${id}`;
        await notify(tx, u.tenantId, [p.createdBy], 'PROPOSAL_RETURNED', `Proposal ${p.number} dikembalikan`, b.note, `/proposals/${id}`);
        await audit(tx, u, 'proposal.review_return', 'proposal', id, null, { note: b.note }, req.ip);
        return { id, status: 'DRAFT' };
      }
      const blockers: string[] = [];
      for (const s of p.sections) {
        if (s.status === 'FLAGGED') blockers.push(`${s.title}: klaim tidak terverifikasi`);
        if (s.content.includes(TODO)) blockers.push(`${s.title}: masih ada ${TODO}`);
        if (s.required && !s.content.trim()) blockers.push(`${s.title}: bagian wajib kosong`);
      }
      // klaim di-recheck saat review (fakta bisa berubah status)
      for (const s of p.sections) {
        const c = await guard(tx, u.tenantId, p.tenderId, s.content, s.sources);
        if (c.length && s.status !== 'FLAGGED') blockers.push(`${s.title}: klaim tidak terverifikasi (${c.slice(0, 2).join(', ')})`);
      }
      if (blockers.length) throw unprocessable('Proposal belum layak disetujui', { blockers });
      await tx`UPDATE proposals SET status = 'REVIEWED', reviewer_id = ${u.id}, reviewed_at = now(), review_note = ${b.note ?? null}, updated_at = now() WHERE id = ${id}`;
      await snapshot(tx, u.tenantId, id, `reviewed by ${u.fullName}`, u.id);
      await audit(tx, u, 'proposal.reviewed', 'proposal', id, { status: 'IN_REVIEW' }, { status: 'REVIEWED', version: p.version }, req.ip);
      return { id, status: 'REVIEWED', version: p.version };
    });
  });

  const docOf = (p: Record<string, any>) => ({ number: p.number, title: p.title, version: p.version, status: p.status, language: p.language, customerName: p.customerName,
    reviewerName: p.reviewerName, reviewedAt: p.reviewedAt, sections: p.sections.filter((s: any) => s.content.trim()).map((s: any) => ({ seq: s.seq, key: s.key, title: s.title, content: s.content, sources: s.sources })) });

  app.get('/api/v1/proposals/:id/export.docx', { ...auth, preValidation: R }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const p = await load(req.authUser.tenantId, id);
    const buf = await proposalDocx(docOf(p));
    await audit(sql, req.authUser, 'proposal.export_docx', 'proposal', id, null, { version: p.version, status: p.status }, req.ip);
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    reply.header('content-disposition', `attachment; filename="Proposal-${String(p.number).replace(/\//g, '-')}-v${p.version}${p.status === 'REVIEWED' ? '' : '-DRAFT'}.docx"`);
    return reply.send(buf);
  });

  app.get('/api/v1/proposals/:id/document', { ...auth, preValidation: R }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const p = await load(req.authUser.tenantId, id);
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
    return proposalHtml(docOf(p));
  });

  app.get('/api/v1/proposals/:id/versions', { ...auth, preValidation: R }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const rows = await sql`SELECT v.id, v.version, v.reason, v.created_at, u.full_name AS by_name FROM proposal_versions v LEFT JOIN users u ON u.id = v.created_by
                           WHERE v.proposal_id = ${id} AND v.tenant_id = ${req.authUser.tenantId} ORDER BY v.id`;
    return { items: rows };
  });

  /** Perbandingan dokumen: snapshot versi vs snapshot lain atau isi saat ini. */
  app.get('/api/v1/proposals/:id/diff', { ...auth, preValidation: R }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = z.object({ from: z.coerce.number().int(), to: z.union([z.coerce.number().int(), z.literal('current')]).default('current') }).parse(req.query);
    const t = req.authUser.tenantId;
    const [a] = await sql`SELECT snapshot FROM proposal_versions WHERE proposal_id = ${id} AND tenant_id = ${t} AND id = ${q.from}`;
    if (!a) throw notFound('Versi asal');
    let bSections: { key: string; title: string; content: string }[];
    if (q.to === 'current') bSections = (await load(t, id)).sections as never;
    else { const [b] = await sql`SELECT snapshot FROM proposal_versions WHERE proposal_id = ${id} AND tenant_id = ${t} AND id = ${q.to}`; if (!b) throw notFound('Versi tujuan'); bSections = (b.snapshot as any).sections; }
    const aSections = (a.snapshot as any).sections as { key: string; title: string; content: string }[];
    return { sections: SECTION_DEFS.map(([key]) => {
      const x = aSections.find((s: { key: string }) => s.key === key); const y = bSections.find((s: { key: string }) => s.key === key);
      const changes = lineDiff(x?.content ?? '', y?.content ?? '');
      return { key, title: y?.title ?? x?.title ?? key, changed: changes.length > 0, changes };
    }).filter((s) => s.changed) };
  });

  /* ───── Company facts ───── */
  app.get('/api/v1/company-facts', { ...auth, preValidation: requirePerm('facts.read') }, async (req) => {
    const rows = await sql`SELECT f.*, vu.full_name AS verified_by_name FROM company_facts f LEFT JOIN users vu ON vu.id = f.verified_by
                           WHERE f.tenant_id = ${req.authUser.tenantId} ORDER BY f.kind, f.title`;
    return { items: rows };
  });
  app.post('/api/v1/company-facts', { ...auth, preValidation: requirePerm('facts.manage') }, async (req, reply) => {
    const b = z.object({ kind: z.enum(['PROFILE', 'CERTIFICATION', 'ACCREDITATION', 'VENDOR_AUTHORIZATION', 'PROJECT_REFERENCE', 'PERSONNEL', 'METHODOLOGY']),
      title: z.string().min(3).max(200), detail: z.string().min(3).max(2000), validUntil: z.string().date().optional(), evidenceRef: z.string().max(500).optional() }).parse(req.body);
    const u = req.authUser;
    const [row] = await sql`INSERT INTO company_facts (tenant_id, kind, title, detail, valid_until, evidence_ref, created_by)
                            VALUES (${u.tenantId}, ${b.kind}, ${b.title}, ${b.detail}, ${b.validUntil ?? null}, ${b.evidenceRef ?? null}, ${u.id}) RETURNING *`;
    await audit(sql, u, 'company_fact.create', 'company_fact', row.id as string, null, row, req.ip);
    reply.code(201);
    return row;
  });
  app.post('/api/v1/company-facts/:id/verify', { ...auth, preValidation: requirePerm('facts.verify') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ evidenceRef: z.string().min(3).max(500) }).parse(req.body);
    const u = req.authUser;
    const [f] = await sql`SELECT * FROM company_facts WHERE id = ${id} AND tenant_id = ${u.tenantId}`;
    if (!f) throw notFound('Fakta');
    if (f.createdBy === u.id) throw forbidden('Maker-checker: pembuat fakta tidak boleh memverifikasi sendiri');
    const [row] = await sql`UPDATE company_facts SET status = 'VERIFIED', evidence_ref = ${b.evidenceRef}, verified_by = ${u.id}, verified_at = now() WHERE id = ${id} RETURNING *`;
    await audit(sql, u, 'company_fact.verify', 'company_fact', id, { status: f.status }, { status: 'VERIFIED', evidenceRef: b.evidenceRef }, req.ip);
    return row;
  });
}
