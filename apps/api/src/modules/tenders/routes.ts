import type { FastifyInstance } from 'fastify';
import { readStoredFile, storeFile } from '../../lib/storage.js';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { audit, nextNumber, notify, requirePerm } from '../../lib/context.js';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { idempotent } from '../../lib/idempotency.js';
import { createApprovalRequest, effectiveLevel, supersedeOpenRequests } from '../approvals/engine.js';
import { AiUnavailableError, complete, redact } from '../ai/gateway.js';
import type { FetchLike } from '../ai/providers.js';
import { AI_EXTRACTION_PROMPT, extractText, norm, ruleExtract, scoreRelevance, similarity, sniffType, verifyAiRequirements, type ExtractedReq } from './extract.js';
import { enqueue } from '../../lib/jobs.js';
import { MAX_PAGES, pdfPageCount } from '../documents/processing.js';
import { ACTIVE_TENDER, BID_CRITERIA, BidInput, TENDER_FLOW, readiness, scoreBid, setTenderStatus } from './service.js';

const UPLOAD_DIR = resolve(process.env.UPLOAD_DIR ?? './storage/uploads');
const MAX_UPLOAD = Number(process.env.DOC_MAX_MB ?? 50) * 1024 * 1024;
const SOURCES = ['sirup', 'spse', 'lpse', 'bumn_portal', 'private_portal', 'vendor_portal', 'email', 'tender_radar', 'manual'] as const;

export const TenderBody = z.object({
  title: z.string().trim().min(5).max(400),
  procuringEntity: z.string().trim().min(2).max(300),
  customerId: z.string().uuid().optional(),
  source: z.enum(SOURCES).default('manual'),
  sourceRef: z.string().max(200).optional(),
  sourceUrl: z.string().url().refine((u) => /^https?:\/\//.test(u)).optional(),
  procurementMethod: z.string().max(120).optional(),
  serviceCategory: z.string().max(60).optional(),
  hpsValue: z.number().min(0).optional(),
  paguValue: z.number().min(0).optional(),
  estimatedValue: z.number().min(0).optional(),
  announceDate: z.string().date().optional(),
  aanwijzingAt: z.string().datetime({ offset: true }).optional(),
  submissionDeadline: z.string().datetime({ offset: true }).optional(),
  openingAt: z.string().datetime({ offset: true }).optional(),
  competitors: z.array(z.string().max(120)).max(30).default([]),
  ownerId: z.string().uuid().optional(),
});

const RequirementPatch = z.object({
  complianceStatus: z.enum(['UNREVIEWED', 'COMPLY', 'PARTIAL', 'NON_COMPLY', 'NOT_APPLICABLE', 'CLARIFY']).optional(),
  response: z.string().max(4000).optional(),
  evidence: z.string().max(2000).optional(),
  picId: z.string().uuid().nullable().optional(),
  dueDate: z.string().date().nullable().optional(),
  mandatory: z.boolean().optional(),
  category: z.enum(['ADMINISTRATIVE', 'QUALIFICATION', 'TECHNICAL', 'COMMERCIAL']).optional(),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  requirement: z.string().min(5).max(2000).optional(),
});

async function insertTender(tx: any, u: { tenantId: string; id: string }, b: z.infer<typeof TenderBody>) {
  const rel = scoreRelevance(`${b.title} ${b.serviceCategory ?? ''}`);
  const year = new Date().getFullYear();
  const n = await nextNumber(tx, u.tenantId, 'TENDER', String(year));
  const code = `TND-${year}-${String(n).padStart(4, '0')}`;
  const [t] = await tx`INSERT INTO tenders (tenant_id, code, title, procuring_entity, customer_id, source, source_ref, source_url, procurement_method, service_category,
      hps_value, pagu_value, estimated_value, announce_date, aanwijzing_at, submission_deadline, opening_at, relevance_score, classification, matched_keywords,
      competitors, owner_id, created_by)
    VALUES (${u.tenantId}, ${code}, ${b.title}, ${b.procuringEntity}, ${b.customerId ?? null}, ${b.source}, ${b.sourceRef ?? null}, ${b.sourceUrl ?? null},
      ${b.procurementMethod ?? null}, ${b.serviceCategory ?? null}, ${b.hpsValue ?? null}, ${b.paguValue ?? null}, ${b.estimatedValue ?? b.hpsValue ?? b.paguValue ?? null},
      ${b.announceDate ?? null}, ${b.aanwijzingAt ?? null}, ${b.submissionDeadline ?? null}, ${b.openingAt ?? null}, ${rel.score}, ${rel.classification},
      ${rel.matched}, ${b.competitors}, ${b.ownerId ?? u.id}, ${u.id}) RETURNING *`;
  await tx`INSERT INTO tender_status_history (tenant_id, tender_id, from_status, to_status, changed_by) VALUES (${u.tenantId}, ${t.id}, NULL, 'DISCOVERED', ${u.id})`;
  await audit(tx, u, 'tender.create', 'tender', t.id as string, null, { code, source: b.source, relevance: rel.score });
  return t;
}

async function findDuplicate(sql: any, tenantId: string, b: { title: string; procuringEntity: string; source: string; sourceRef?: string }) {
  if (b.sourceRef) {
    const [d] = await sql`SELECT id, code, title FROM tenders WHERE tenant_id = ${tenantId} AND source = ${b.source} AND source_ref = ${b.sourceRef}`;
    if (d) return d;
  }
  const cands = await sql`SELECT id, code, title, procuring_entity FROM tenders WHERE tenant_id = ${tenantId} AND lower(procuring_entity) = lower(${b.procuringEntity})
                          AND created_at > now() - interval '365 days'`;
  return cands.find((c: any) => similarity(c.title, b.title) > 0.8) ?? null;
}

async function storeRequirements(tx: any, u: { tenantId: string; id: string }, tenderId: string, documentId: string, reqs: ExtractedReq[], prefix: string) {
  const existing = await tx`SELECT id, ref_code, requirement FROM tender_requirements WHERE tender_id = ${tenderId}`;
  const [{ n }] = await tx`SELECT count(*)::int AS n FROM tender_requirements WHERE tender_id = ${tenderId} AND ref_code LIKE ${prefix + '-%'}`;
  let i = n;
  const added: string[] = [];
  const impacted: { newRef: string; existingRef: string; similarity: number }[] = [];
  for (const r of reqs) {
    const dup = existing.find((e: any) => similarity(e.requirement, r.requirement) > 0.85);
    if (dup) continue;
    const near = existing.map((e: any) => ({ e, s: similarity(e.requirement, r.requirement) })).filter((x: any) => x.s > 0.45).sort((a: any, b: any) => b.s - a.s)[0];
    const ref = `${prefix}-${String(++i).padStart(3, '0')}`;
    await tx`INSERT INTO tender_requirements (tenant_id, tender_id, document_id, ref_code, category, requirement, mandatory, source_excerpt, source_page, origin, risk_level, updated_by)
      VALUES (${u.tenantId}, ${tenderId}, ${documentId}, ${ref}, ${r.category}, ${r.requirement}, ${r.mandatory}, ${r.sourceExcerpt}, ${r.sourcePage}, ${r.origin}, ${r.riskLevel}, ${u.id})`;
    existing.push({ id: null, ref_code: ref, requirement: r.requirement });
    added.push(ref);
    if (near) impacted.push({ newRef: ref, existingRef: near.e.refCode ?? near.e.ref_code, similarity: Math.round(near.s * 100) / 100 });
  }
  return { added, impacted };
}

/** Impor tender (dipakai endpoint impor manual & konektor feed): skor relevansi, dedup, notifikasi tender relevan. */
export async function importTenders(sql: any, u: { tenantId: string; id: string }, items: z.infer<typeof TenderBody>[], minRelevance = 15) {
  const out = { created: [] as string[], duplicates: [] as string[], skippedIrrelevant: [] as string[] };
  for (const it of items) {
    const rel = scoreRelevance(`${it.title} ${it.serviceCategory ?? ''}`);
    if (rel.score < minRelevance) { out.skippedIrrelevant.push(it.title); continue; }
    if (await findDuplicate(sql, u.tenantId, it)) { out.duplicates.push(it.title); continue; }
    const t = await sql.begin((tx: any) => insertTender(tx, u, it));
    out.created.push(t.code as string);
    if (rel.score >= 60) {
      const officers = await sql`SELECT id FROM users WHERE tenant_id = ${u.tenantId} AND is_active AND role IN ('tender_officer','sales_manager')`;
      await notify(sql, u.tenantId, officers.map((o: any) => o.id as string), 'TENDER_RELEVANT', `Tender relevan (${rel.score}): ${t.code}`, it.title, `/tenders/${t.id}`);
    }
  }
  return out;
}

export async function tenderRoutes(app: FastifyInstance, opts: { fetchImpl?: FetchLike }) {
  const sql = app.sql;
  const auth = { onRequest: [app.authenticate] };
  const R = requirePerm('tender.read');
  const W = requirePerm('tender.write');
  const loadTender = async (tenantId: string, id: string, lock = false, tx: any = sql) => {
    const [t] = lock ? await tx`SELECT * FROM tenders WHERE id = ${id} AND tenant_id = ${tenantId} FOR UPDATE`
      : await tx`SELECT * FROM tenders WHERE id = ${id} AND tenant_id = ${tenantId}`;
    if (!t) throw notFound('Tender');
    return t;
  };

  app.get('/api/v1/tenders', { ...auth, preValidation: R }, async (req) => {
    const q = z.object({ status: z.string().optional(), active: z.coerce.boolean().optional(), dueDays: z.coerce.number().int().min(1).max(90).optional(),
      minRelevance: z.coerce.number().int().min(0).max(100).optional(), q: z.string().max(100).optional() }).parse(req.query);
    const t = req.authUser.tenantId;
    const rows = await sql`SELECT t.id, t.code, t.title, t.procuring_entity, t.source, t.status, t.hps_value, t.pagu_value, t.estimated_value, t.submission_deadline,
        t.relevance_score, t.classification, t.matched_keywords, t.updated_at, u.full_name AS owner_name,
        extract(epoch FROM t.submission_deadline - now())/3600 AS hours_left,
        (SELECT count(*)::int FROM tender_requirements r WHERE r.tender_id = t.id) AS requirement_count
      FROM tenders t LEFT JOIN users u ON u.id = t.owner_id WHERE t.tenant_id = ${t}
        ${q.status ? sql`AND t.status = ${q.status}` : sql``}
        ${q.active ? sql`AND t.status IN ${sql(ACTIVE_TENDER)}` : sql``}
        ${q.dueDays ? sql`AND t.submission_deadline BETWEEN now() AND now() + make_interval(days => ${q.dueDays})` : sql``}
        ${q.minRelevance !== undefined ? sql`AND t.relevance_score >= ${q.minRelevance}` : sql``}
        ${q.q ? sql`AND (t.title ILIKE ${'%' + q.q + '%'} OR t.procuring_entity ILIKE ${'%' + q.q + '%'} OR t.code ILIKE ${'%' + q.q + '%'})` : sql``}
      ORDER BY t.submission_deadline ASC NULLS LAST, t.updated_at DESC LIMIT 300`;
    return { items: rows.map((r) => ({ ...r, hoursLeft: r.hoursLeft === null ? null : Math.round(Number(r.hoursLeft)) })) };
  });

  app.post('/api/v1/tenders', { ...auth, preValidation: W }, async (req, reply) => {
    const b = TenderBody.parse(req.body);
    const u = req.authUser;
    const dup = await findDuplicate(sql, u.tenantId, b);
    if (dup) throw conflict('Tender duplikat terdeteksi', { existing: dup });
    if (b.customerId) { const [c] = await sql`SELECT 1 FROM customers WHERE id = ${b.customerId} AND tenant_id = ${u.tenantId}`; if (!c) throw notFound('Customer'); }
    const t = await sql.begin((tx) => insertTender(tx, u, b));
    reply.code(201);
    return t;
  });

  /** Impor dari sumber sah (export Cyber Tender Radar / SiRUP / portal) — tanpa scraping yang melewati kontrol portal. */
  app.post('/api/v1/tenders/import', { ...auth, preValidation: W }, async (req) => {
    const b = z.object({ items: z.array(TenderBody).min(1).max(500), minRelevance: z.number().int().min(0).max(100).default(15) }).parse(req.body);
    return importTenders(sql, req.authUser, b.items, b.minRelevance);
  });

  app.get('/api/v1/tenders/:id', { ...auth, preValidation: R }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    const t = await loadTender(u.tenantId, id);
    const [history, documents, requirements, bids, clarifications, proposals, customer] = await Promise.all([
      sql`SELECT h.*, u.full_name AS changed_by_name FROM tender_status_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.tender_id = ${id} ORDER BY h.id`,
      sql`SELECT id, kind, filename, mime, size_bytes, version, extraction_status, extraction_note, page_count, created_at, length(extracted_text) AS text_length
          FROM tender_documents WHERE tender_id = ${id} ORDER BY created_at`,
      sql`SELECT r.*, u.full_name AS pic_name FROM tender_requirements r LEFT JOIN users u ON u.id = r.pic_id WHERE r.tender_id = ${id} ORDER BY r.category, r.ref_code`,
      sql`SELECT b.*, u.full_name AS created_by_name FROM bid_assessments b LEFT JOIN users u ON u.id = b.created_by WHERE b.tender_id = ${id} ORDER BY b.created_at DESC`,
      sql`SELECT * FROM tender_clarifications WHERE tender_id = ${id} ORDER BY created_at`,
      sql`SELECT id, number, title, status, version, updated_at FROM proposals WHERE tender_id = ${id} ORDER BY created_at DESC`,
      t.customerId ? sql`SELECT id, legal_name, client_tier FROM customers WHERE id = ${t.customerId}` : Promise.resolve([]),
    ]);
    return { tender: t, customer: customer[0] ?? null, history, documents, requirements, bids, clarifications, proposals,
      readiness: await readiness(sql as any, id), allowedTransitions: TENDER_FLOW[t.status as string], criteria: BID_CRITERIA };
  });

  app.patch('/api/v1/tenders/:id', { ...auth, preValidation: W }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = TenderBody.partial().extend({ rowVersion: z.number().int() }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const t = await loadTender(u.tenantId, id, true, tx);
      if (t.rowVersion !== b.rowVersion) throw conflict('Tender telah diubah pengguna lain — muat ulang');
      const { rowVersion: _r, ...rest } = b;
      const cols = Object.keys(rest).filter((k) => (rest as any)[k] !== undefined);
      if (!cols.length) throw badRequest('Tidak ada perubahan');
      if (rest.customerId) { const [c] = await tx`SELECT 1 FROM customers WHERE id = ${rest.customerId} AND tenant_id = ${u.tenantId}`; if (!c) throw notFound('Customer'); }
      const [after] = await tx`UPDATE tenders SET ${tx(rest as Record<string, unknown>, cols)}, row_version = row_version + 1, updated_at = now() WHERE id = ${id} RETURNING *`;
      await audit(tx, u, 'tender.update', 'tender', id, t, after, req.ip);
      return after;
    });
  });

  /** Transisi status dengan gate entry/exit criteria. */
  app.post('/api/v1/tenders/:id/status', { ...auth, preValidation: W }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ to: z.string(), note: z.string().max(2000).optional() }).parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const t = await loadTender(u.tenantId, id, true, tx);
      const from = t.status as string;
      if (!TENDER_FLOW[from]?.includes(b.to)) throw unprocessable(`Transisi ${from} → ${b.to} tidak diizinkan`, { allowed: TENDER_FLOW[from] });
      if (['NO_BID', 'CANCELLED', 'LOST'].includes(b.to) && !b.note) throw badRequest('Alasan wajib diisi');
      if (b.to === 'REGISTERED') {
        if (!t.customerId) throw unprocessable('Hubungkan tender ke customer (instansi pengadaan) sebelum registrasi');
        if (!t.opportunityId) {
          const year = new Date().getFullYear();
          const n = await nextNumber(tx, u.tenantId, 'OPPORTUNITY', String(year));
          const [o] = await tx`INSERT INTO opportunities (tenant_id, code, customer_id, name, service_category, amount_estimate, probability, source, is_tender, owner_id, created_by, expected_close)
            VALUES (${u.tenantId}, ${`OPP-${year}-${String(n).padStart(4, '0')}`}, ${t.customerId}, ${t.title.slice(0, 200)}, ${t.serviceCategory ?? 'OTHER'},
                    ${t.hpsValue ?? t.estimatedValue ?? 0}, 25, 'tender', true, ${t.ownerId ?? u.id}, ${u.id}, ${t.submissionDeadline ? String(t.submissionDeadline).slice(0, 10) : null}) RETURNING id`;
          await tx`INSERT INTO opportunity_stage_history (tenant_id, opportunity_id, from_stage, to_stage, changed_by) VALUES (${u.tenantId}, ${o.id}, NULL, 'LEAD', ${u.id})`;
          await tx`UPDATE tenders SET opportunity_id = ${o.id} WHERE id = ${id}`;
        }
      }
      if (b.to === 'INTERNAL_REVIEW') {
        const r = await readiness(tx, id);
        const hard = r.blockers.filter((x) => !/klarifikasi|proposal/i.test(x));
        if (hard.length) throw unprocessable('Belum siap internal review', { blockers: hard });
      }
      if (b.to === 'APPROVED') {
        const { level } = await effectiveLevel(tx, u);
        const need = Number(t.hpsValue ?? t.estimatedValue ?? 0) > 1_000_000_000 ? 3 : 2;
        if (level < need) throw forbidden(`Persetujuan dokumen tender memerlukan level ${need === 3 ? 'Direktur (> Rp1 M)' : 'VP/Head'}`);
        if (t.ownerId === u.id || t.createdBy === u.id) throw forbidden('Segregation of Duties: owner tender tidak boleh menyetujui sendiri');
        const r = await readiness(tx, id);
        if (!r.ready) throw unprocessable('Submission readiness belum terpenuhi', { blockers: r.blockers });
      }
      if (b.to === 'SUBMITTED') {
        const [proof] = await tx`SELECT 1 FROM tender_documents WHERE tender_id = ${id} AND kind = 'SUBMISSION_PROOF'`;
        if (!proof) throw unprocessable('Unggah bukti submission (SUBMISSION_PROOF) — pengiriman ke portal dilakukan oleh user sesuai aturan portal');
      }
      if (b.to === 'LOST' && !b.note) throw badRequest('Alasan kalah wajib diisi');
      if (b.to === 'CONTRACTING') {
        const [award] = await tx`SELECT 1 FROM tender_documents WHERE tender_id = ${id} AND kind = 'AWARD_LETTER'`;
        if (!award) throw unprocessable('Unggah surat penunjukan/award letter terlebih dahulu');
      }
      await setTenderStatus(tx, u, id, from, b.to, b.note);
      if (['LOST', 'NO_BID', 'CANCELLED'].includes(b.to)) await tx`UPDATE tenders SET outcome_note = ${b.note ?? null} WHERE id = ${id}`;
      if (b.to === 'AWARDED' || b.to === 'CONTRACTING') {
        const legal = await tx`SELECT id FROM users WHERE tenant_id = ${u.tenantId} AND is_active AND role IN ('legal','sales_manager','project_manager')`;
        await notify(tx, u.tenantId, legal.map((x) => x.id as string), 'TENDER_AWARDED', `${t.code} ${b.to === 'AWARDED' ? 'MENANG' : 'masuk contracting'}`, t.title as string, `/tenders/${id}`);
      }
      if (b.to === 'LOST' && t.opportunityId) {
        await tx`UPDATE opportunities SET stage = 'LOST', probability = 0, lost_reason = ${'Tender: ' + b.note}, stage_changed_at = now(), updated_at = now()
                 WHERE id = ${t.opportunityId} AND stage NOT IN ('WON','LOST')`;
      }
      return { id, from, to: b.to };
    });
  });

  /* ───── Documents ───── */
  app.post('/api/v1/tenders/:id/documents', { ...auth, preValidation: W }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    const t = await loadTender(u.tenantId, id);
    const file = await req.file({ limits: { fileSize: MAX_UPLOAD, files: 1 } });
    if (!file) throw badRequest('File wajib diunggah (multipart field "file")');
    const kind = z.enum(['RKS', 'KAK', 'TOR', 'ADDENDUM', 'AANWIJZING_MOM', 'SUBMISSION_PROOF', 'EVALUATION', 'AWARD_LETTER', 'OTHER'])
      .parse((file.fields.kind as { value?: string } | undefined)?.value ?? 'RKS');
    const buf = await file.toBuffer();
    if (file.file.truncated) throw new AppError(413, 'FILE_TOO_LARGE', `Maksimal ${MAX_UPLOAD / 1048576} MB`);
    const safeName = file.filename.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 150);
    const type = sniffType(buf, safeName);
    const isImage = /^\xFF\xD8\xFF|^\x89PNG/.test(buf.subarray(0, 4).toString('latin1'));
    if (!type && !(isImage && ['SUBMISSION_PROOF', 'AWARD_LETTER', 'EVALUATION', 'OTHER'].includes(kind))) {
      throw badRequest('Tipe file tidak diizinkan (PDF, DOCX, TXT; gambar JPG/PNG hanya untuk bukti/award)');
    }
    if (type === 'pdf') {
      let pages = 0;
      try { pages = await pdfPageCount(buf); } catch { throw badRequest('PDF rusak atau terenkripsi'); }
      if (pages > MAX_PAGES) throw unprocessable(`Dokumen ${pages} halaman melebihi batas ${MAX_PAGES} halaman`);
    }
    const sha = createHash('sha256').update(buf).digest('hex');
    const [dup] = await sql`SELECT id, filename FROM tender_documents WHERE tender_id = ${id} AND sha256 = ${sha}`;
    if (dup) throw conflict(`File identik sudah diunggah (${dup.filename})`);
    const dir = join(UPLOAD_DIR, u.tenantId, id);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${sha}${type ? '.' + type : isImage ? '.img' : ''}`);
    await storeFile(sql, u.tenantId, path, buf, req.log);
    const extractable = ['RKS', 'KAK', 'TOR', 'ADDENDUM', 'AANWIJZING_MOM'].includes(kind) && type;
    const ex = extractable ? await extractText(buf, type!) : { status: 'NOT_APPLICABLE' as const, pages: [] as string[], note: undefined };
    const [{ v }] = await sql`SELECT coalesce(max(version), 0) + 1 AS v FROM tender_documents WHERE tender_id = ${id} AND kind = ${kind}`;
    const ocrQueued = ex.status === 'NEEDS_OCR';
    const [doc] = await sql`INSERT INTO tender_documents (tenant_id, tender_id, kind, filename, mime, size_bytes, sha256, storage_path, version, extraction_status,
        extracted_text, page_count, extraction_note, uploaded_by)
      VALUES (${u.tenantId}, ${id}, ${kind}, ${safeName}, ${type === 'pdf' ? 'application/pdf' : type === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : type === 'txt' ? 'text/plain' : 'image/*'},
        ${buf.length}, ${sha}, ${path}, ${v}, ${ocrQueued ? 'OCR_QUEUED' : ex.status}, ${ex.pages.length && !ocrQueued ? ex.pages.join('\f') : null}, ${ex.pages.length || null},
        ${ocrQueued ? 'PDF hasil scan — OCR otomatis dijadwalkan' : ex.note ?? null}, ${u.id})
      RETURNING id, kind, filename, version, extraction_status, extraction_note, page_count`;
    if (ocrQueued) await enqueue(sql, u.tenantId, 'tender_ocr', { documentId: doc.id }, u.id);
    await audit(sql, u, 'tender.document_upload', 'tender', id, null, { documentId: doc.id, kind, filename: safeName, sha256: sha }, req.ip);
    if (kind === 'ADDENDUM' && t.ownerId) await notify(sql, u.tenantId, [t.ownerId as string], 'TENDER_ADDENDUM', `${t.code}: addendum diunggah`, 'Jalankan ekstraksi & analisis dampak', `/tenders/${id}`);
    reply.code(201);
    return doc;
  });

  /** Jalankan ulang OCR untuk dokumen tender hasil scan. */
  app.post('/api/v1/tenders/:id/documents/:docId/ocr', { ...auth, preValidation: W }, async (req) => {
    const { id, docId } = z.object({ id: z.string().uuid(), docId: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    const [d] = await sql`SELECT * FROM tender_documents WHERE id = ${docId} AND tender_id = ${id} AND tenant_id = ${u.tenantId}`;
    if (!d) throw notFound('Dokumen');
    if (d.mime !== 'application/pdf') throw unprocessable('OCR dokumen tender hanya untuk PDF');
    if (['OCR_QUEUED', 'OCR_RUNNING'].includes(d.extractionStatus as string)) throw conflict('OCR sedang berjalan');
    await sql`UPDATE tender_documents SET extraction_status = 'OCR_QUEUED' WHERE id = ${docId}`;
    const jobId = await enqueue(sql, u.tenantId, 'tender_ocr', { documentId: docId }, u.id);
    return { id: docId, status: 'OCR_QUEUED', jobId };
  });

  app.get('/api/v1/tenders/:id/documents/:docId/file', { ...auth, preValidation: R }, async (req, reply) => {
    const { id, docId } = z.object({ id: z.string().uuid(), docId: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    const [d] = await sql`SELECT * FROM tender_documents WHERE id = ${docId} AND tender_id = ${id} AND tenant_id = ${u.tenantId}`;
    if (!d) throw notFound('Dokumen');
    const buf = await readStoredFile(sql, u.tenantId, d.storagePath as string);
    await audit(sql, u, 'tender.document_download', 'tender', id, null, { documentId: docId }, req.ip);
    reply.header('content-type', d.mime === 'image/*' ? 'application/octet-stream' : (d.mime as string));
    reply.header('content-disposition', `attachment; filename="${String(d.filename).replace(/"/g, '')}"`);
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(buf);
  });

  /** Ekstraksi persyaratan: rule-based (selalu) + AI (opsional) dengan verifikasi kutipan sumber. */
  app.post('/api/v1/tenders/:id/documents/:docId/extract', { ...auth, preValidation: W, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { id, docId } = z.object({ id: z.string().uuid(), docId: z.string().uuid() }).parse(req.params);
    const b = z.object({ useAi: z.boolean().default(true) }).parse(req.body ?? {});
    const u = req.authUser;
    await loadTender(u.tenantId, id);
    const [d] = await sql`SELECT * FROM tender_documents WHERE id = ${docId} AND tender_id = ${id} AND tenant_id = ${u.tenantId}`;
    if (!d) throw notFound('Dokumen');
    if (d.extractionStatus !== 'DONE' || !d.extractedText) throw unprocessable(`Teks dokumen tidak tersedia (status ${d.extractionStatus})${d.extractionNote ? ': ' + d.extractionNote : ''}`);
    const pages = String(d.extractedText).split('\f');
    const rule = ruleExtract(pages);
    let ai: { accepted: ExtractedReq[]; rejected: number; error: string | null; provider?: string } = { accepted: [], rejected: 0, error: null };
    if (b.useAi) {
      const docText = pages.map((p, i) => `--- Halaman ${i + 1} ---\n${p}`).join('\n').slice(0, 60000);
      try {
        const r = await complete({ sql, fetchImpl: opts.fetchImpl }, { tenantId: u.tenantId, userId: u.id, feature: 'rks_extraction',
          user: `${AI_EXTRACTION_PROMPT}\n\n<document>\n${docText}\n</document>`, maxTokens: 6000, temperature: 0 });
        ai = { ...verifyAiRequirements(r.text, pages, pages.map((p) => redact(p).text)), provider: r.provider };
      } catch (e) {
        ai.error = e instanceof AiUnavailableError ? 'AI tidak tersedia — hanya ekstraksi rule-based' : (e as Error).message;
      }
    }
    const merged = [...rule];
    for (const a of ai.accepted) if (!merged.some((m) => similarity(m.requirement, a.requirement) > 0.6 || norm(m.sourceExcerpt).includes(norm(a.sourceExcerpt)))) merged.push(a);
    const prefix = d.kind === 'ADDENDUM' ? `ADD${d.version}` : ({ RKS: 'RKS', KAK: 'KAK', TOR: 'TOR', AANWIJZING_MOM: 'AWZ' } as Record<string, string>)[d.kind as string] ?? 'REQ';
    const res = await sql.begin((tx) => storeRequirements(tx, u, id, docId, merged, prefix));
    await audit(sql, u, 'tender.requirements_extracted', 'tender', id, null, { documentId: docId, rule: rule.length, aiAccepted: ai.accepted.length, aiRejected: ai.rejected, added: res.added.length }, req.ip);
    return { rule: rule.length, ai: { accepted: ai.accepted.length, rejectedUnverified: ai.rejected, error: ai.error, provider: ai.provider ?? null },
      added: res.added.length, addedRefs: res.added, addendumImpact: d.kind === 'ADDENDUM' ? res.impacted : undefined };
  });

  /* ───── Requirements / compliance matrix ───── */
  app.post('/api/v1/tenders/:id/requirements', { ...auth, preValidation: W }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ category: z.enum(['ADMINISTRATIVE', 'QUALIFICATION', 'TECHNICAL', 'COMMERCIAL']), requirement: z.string().min(5).max(2000),
      mandatory: z.boolean().default(true), sourcePage: z.number().int().positive().optional() }).parse(req.body);
    const u = req.authUser;
    await loadTender(u.tenantId, id);
    const out = await sql.begin((tx) => storeRequirements(tx, u, id, null as never, [{ ...b, sourceExcerpt: '', sourcePage: b.sourcePage ?? null, riskLevel: 'MEDIUM', origin: 'MANUAL' as never }], 'MAN'));
    if (!out.added.length) throw conflict('Persyaratan serupa sudah ada');
    reply.code(201);
    return out;
  });

  app.patch('/api/v1/tenders/:id/requirements/:reqId', { ...auth, preValidation: W }, async (req) => {
    const { id, reqId } = z.object({ id: z.string().uuid(), reqId: z.string().uuid() }).parse(req.params);
    const b = RequirementPatch.parse(req.body);
    const u = req.authUser;
    return sql.begin(async (tx) => {
      const [r] = await tx`SELECT * FROM tender_requirements WHERE id = ${reqId} AND tender_id = ${id} AND tenant_id = ${u.tenantId} FOR UPDATE`;
      if (!r) throw notFound('Persyaratan');
      if (b.complianceStatus === 'COMPLY' && !(b.evidence ?? r.evidence) && r.mandatory && ['ADMINISTRATIVE', 'QUALIFICATION'].includes(r.category as string)) {
        throw badRequest('Persyaratan administrasi/kualifikasi wajib berstatus COMPLY harus disertai referensi bukti (evidence)');
      }
      if (b.picId) { const [p] = await tx`SELECT 1 FROM users WHERE id = ${b.picId} AND tenant_id = ${u.tenantId}`; if (!p) throw notFound('PIC'); }
      const cols = Object.keys(b).filter((k) => (b as any)[k] !== undefined);
      if (!cols.length) throw badRequest('Tidak ada perubahan');
      const [after] = await tx`UPDATE tender_requirements SET ${tx(b as Record<string, unknown>, cols)}, updated_by = ${u.id}, updated_at = now() WHERE id = ${reqId} RETURNING *`;
      await audit(tx, u, 'tender.requirement_update', 'tender', id, { ref: r.refCode, status: r.complianceStatus }, { ref: r.refCode, ...b }, req.ip);
      return after;
    });
  });

  app.get('/api/v1/tenders/:id/compliance-matrix.csv', { ...auth, preValidation: R }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const t = await loadTender(req.authUser.tenantId, id);
    const rows = await sql`SELECT r.ref_code, r.category, r.requirement, r.mandatory, r.compliance_status, r.response, r.evidence, r.source_page, u.full_name AS pic
                           FROM tender_requirements r LEFT JOIN users u ON u.id = r.pic_id WHERE r.tender_id = ${id} ORDER BY r.category, r.ref_code`;
    const esc = (v: unknown) => { const s = String(v ?? ''); const safe = /^[=+\-@]/.test(s) ? `'${s}` : s; return `"${safe.replace(/"/g, '""')}"`; };
    const csv = ['Ref,Kategori,Persyaratan,Wajib,Status,Tanggapan,Bukti,Halaman,PIC',
      ...rows.map((r) => [r.refCode, r.category, r.requirement, r.mandatory ? 'Ya' : 'Tidak', r.complianceStatus, r.response, r.evidence, r.sourcePage, r.pic].map(esc).join(','))].join('\r\n');
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="compliance-matrix-${t.code}.csv"`);
    return '﻿' + csv;
  });

  /* ───── Bid / No-Bid ───── */
  app.post('/api/v1/tenders/:id/bid-assessment', { ...auth, preValidation: W }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = BidInput.parse(req.body);
    const u = req.authUser;
    let s;
    try { s = scoreBid(b); } catch (e) { throw badRequest((e as Error).message); }
    return idempotent(req, reply, 201, () => sql.begin(async (tx) => {
      const t = await loadTender(u.tenantId, id, true, tx);
      if (!['REGISTERED', 'BID_DECISION'].includes(t.status as string)) throw unprocessable('Bid assessment hanya untuk tender REGISTERED / BID_DECISION');
      const prev = await tx`UPDATE bid_assessments SET status = 'SUPERSEDED' WHERE tender_id = ${id} AND status IN ('DRAFT','IN_APPROVAL','REJECTED','REVISION_REQUESTED') RETURNING id`;
      for (const p of prev) await supersedeOpenRequests(tx, u.tenantId, 'bid_assessment', p.id as string);
      const [ba] = await tx`INSERT INTO bid_assessments (tenant_id, tender_id, scores, weighted_score, knockouts, recommendation, conditions, conflict_of_interest, coi_note, status, created_by)
        VALUES (${u.tenantId}, ${id}, ${tx.json(b.scores as never)}, ${s.weighted}, ${tx.json(s.knockouts as never)}, ${s.recommendation}, ${b.conditions ?? null},
                ${b.conflictOfInterest}, ${b.coiNote ?? null}, 'IN_APPROVAL', ${u.id}) RETURNING *`;
      const value = Number(t.hpsValue ?? t.estimatedValue ?? t.paguValue ?? 0);
      const { request, evaluation } = await createApprovalRequest(tx, { tenantId: u.tenantId, entityType: 'bid_assessment', entityId: ba.id as string, entityVersion: 1,
        requestedBy: u.id, metrics: { tenderValue: value } as never,
        summary: { title: `${t.code} Bid/No-Bid: ${s.recommendation} (${s.weighted})`, tenderCode: t.code, tenderTitle: t.title, recommendation: s.recommendation,
          weightedScore: s.weighted, knockouts: s.knockouts, totalBeforeTax: value, discountPct: 0, warnings: s.knockouts } });
      if (t.status === 'REGISTERED') await setTenderStatus(tx, u, id, 'REGISTERED', 'BID_DECISION', `Bid assessment ${s.recommendation}`);
      await audit(tx, u, 'tender.bid_assessment', 'tender', id, null, { bidId: ba.id, ...s }, req.ip);
      return { bidAssessment: ba, approvalRequestId: request.id, requiredLevel: evaluation.requiredLevel, steps: evaluation.steps };
    }));
  });

  /* ───── Clarifications / aanwijzing ───── */
  app.post('/api/v1/tenders/:id/clarifications', { ...auth, preValidation: W }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ question: z.string().min(10).max(2000), requirementId: z.string().uuid().optional() }).parse(req.body);
    const u = req.authUser;
    await loadTender(u.tenantId, id);
    const [row] = await sql`INSERT INTO tender_clarifications (tenant_id, tender_id, requirement_id, question, created_by)
                            VALUES (${u.tenantId}, ${id}, ${b.requirementId ?? null}, ${b.question}, ${u.id}) RETURNING *`;
    reply.code(201);
    return row;
  });

  app.patch('/api/v1/tenders/:id/clarifications/:cid', { ...auth, preValidation: W }, async (req) => {
    const { id, cid } = z.object({ id: z.string().uuid(), cid: z.string().uuid() }).parse(req.params);
    const b = z.object({ question: z.string().min(10).max(2000).optional(), status: z.enum(['DRAFT', 'SUBMITTED', 'ANSWERED', 'WITHDRAWN']).optional(),
      answer: z.string().max(4000).optional() }).parse(req.body);
    const u = req.authUser;
    if (b.status === 'ANSWERED' && !b.answer) throw badRequest('Jawaban panitia wajib diisi');
    const cols = Object.keys(b).filter((k) => (b as any)[k] !== undefined);
    const [row] = await sql`UPDATE tender_clarifications SET ${sql(b as Record<string, unknown>, cols)}, updated_at = now()
                            WHERE id = ${cid} AND tender_id = ${id} AND tenant_id = ${u.tenantId} RETURNING *`;
    if (!row) throw notFound('Klarifikasi');
    await audit(sql, u, 'tender.clarification_update', 'tender', id, null, { cid, ...b }, req.ip);
    return row;
  });

  /** Draft pertanyaan aanwijzing oleh AI untuk persyaratan CLARIFY/PARTIAL (disimpan sebagai DRAFT — wajib ditinjau). */
  app.post('/api/v1/tenders/:id/clarifications/ai-draft', { ...auth, preValidation: W, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = req.authUser;
    const t = await loadTender(u.tenantId, id);
    const reqs = await sql`SELECT id, ref_code, requirement, compliance_status, response FROM tender_requirements
                           WHERE tender_id = ${id} AND compliance_status IN ('CLARIFY','PARTIAL') ORDER BY ref_code LIMIT 30`;
    if (!reqs.length) throw unprocessable('Tidak ada persyaratan berstatus CLARIFY/PARTIAL');
    const ctx = reqs.map((r) => `${r.refCode}: ${r.requirement}${r.response ? ` (catatan internal: ${r.response})` : ''}`).join('\n');
    try {
      const r = await complete({ sql, fetchImpl: opts.fetchImpl }, { tenantId: u.tenantId, userId: u.id, feature: 'aanwijzing_questions',
        user: `Susun pertanyaan klarifikasi aanwijzing yang sopan dan spesifik untuk tender "${t.title}". Satu pertanyaan per baris, diawali kode ref persis seperti di data, format "REF: pertanyaan".\n<context>\n${ctx}\n</context>`, maxTokens: 1500 });
      const created = [];
      for (const line of r.text.split('\n')) {
        const m = line.match(/^\s*[-*]?\s*([A-Z0-9]+-\d{3})\s*[:\-–]\s*(.{10,})$/);
        if (!m) continue;
        const target = reqs.find((x) => x.refCode === m[1]);
        if (!target) continue; // tolak ref yang tidak ada
        const [c] = await sql`INSERT INTO tender_clarifications (tenant_id, tender_id, requirement_id, question, origin, created_by)
                              VALUES (${u.tenantId}, ${id}, ${target.id}, ${m[2].trim().slice(0, 2000)}, 'AI', ${u.id}) RETURNING *`;
        created.push(c);
      }
      reply.code(201);
      return { created, provider: r.provider, requiresHumanReview: true };
    } catch (e) {
      if (e instanceof AiUnavailableError) { reply.code(503); return { code: 'AI_UNAVAILABLE', message: e.message, attempts: e.attempts }; }
      throw e;
    }
  });

  /** Checklist pengemasan dokumen (dari persyaratan administrasi & kualifikasi). */
  app.get('/api/v1/tenders/:id/packaging-checklist', { ...auth, preValidation: R }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const t = await loadTender(req.authUser.tenantId, id);
    const rows = await sql`SELECT ref_code, category, requirement, mandatory, compliance_status, evidence FROM tender_requirements
                           WHERE tender_id = ${id} AND category IN ('ADMINISTRATIVE','QUALIFICATION','COMMERCIAL') ORDER BY category, ref_code`;
    return { tender: { code: t.code, title: t.title, deadline: t.submissionDeadline },
      items: rows.map((r) => ({ ...r, ready: ['COMPLY', 'NOT_APPLICABLE'].includes(r.complianceStatus as string) && (!r.mandatory || r.category === 'COMMERCIAL' || !!r.evidence) })),
      note: 'Template surat legal (surat penawaran, pernyataan, pakta integritas) hanya dihasilkan dari template perusahaan yang telah disahkan — unggah template di Phase 2b.' };
  });
}
