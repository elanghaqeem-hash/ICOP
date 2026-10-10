import type { FastifyInstance } from 'fastify';
import { readStoredFile, storeFile } from '../../lib/storage.js';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { audit, requirePerm } from '../../lib/context.js';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { enqueue } from '../../lib/jobs.js';
import { featureEnabled } from '../ai/gateway.js';
import { MAX_MB, MAX_PAGES, pdfPageCount, tools } from './processing.js';
import { documentAccessFilter } from './service.js';

const DOC_DIR = () => resolve(process.env.DOCUMENT_DIR ?? process.env.UPLOAD_DIR ?? './storage/uploads', 'documents');

export function sniffDoc(buf: Buffer, filename: string): { kind: 'pdf' | 'docx' | 'txt' | 'image'; mime: string } | null {
  const head = buf.subarray(0, 8).toString('latin1');
  if (head.startsWith('%PDF-')) return { kind: 'pdf', mime: 'application/pdf' };
  if (buf[0] === 0x50 && buf[1] === 0x4b && /\.docx$/i.test(filename)) return { kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  if (head.startsWith('\x89PNG')) return { kind: 'image', mime: 'image/png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'image', mime: 'image/jpeg' };
  if (head.startsWith('II*\x00') || head.startsWith('MM\x00*')) return { kind: 'image', mime: 'image/tiff' };
  if (/\.(txt|md|csv)$/i.test(filename) && !/[\u0000-\u0008\u000E-\u001F]/.test(buf.subarray(0, 4096).toString('utf8'))) return { kind: 'txt', mime: 'text/plain' };
  return null;
}

export async function documentRoutes(app: FastifyInstance) {
  const sql = app.sql;
  const auth = { onRequest: [app.authenticate] };
  const R = requirePerm('documents.read');
  const W = requirePerm('documents.write');

  const load = async (u: { tenantId: string; id: string; role: string }, id: string) => {
    const [d] = await sql`SELECT d.*, u.full_name AS uploaded_by_name FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
                          WHERE d.id = ${id} AND d.tenant_id = ${u.tenantId} ${documentAccessFilter(sql, u)}`;
    if (!d) throw notFound('Dokumen');
    return d;
  };

  app.get('/api/v1/documents/capabilities', { ...auth, preValidation: R }, async () => {
    const t = await tools();
    return { maxPages: MAX_PAGES, maxMb: MAX_MB, ocr: t.tesseract && t.pdftoppm, ocrLanguages: t.langs, compression: { ghostscript: t.gs, qpdf: t.qpdf, raster: t.pdftoppm },
      accepted: ['PDF', 'DOCX', 'TXT', 'PNG', 'JPG', 'TIFF'] };
  });

  app.post('/api/v1/documents', { ...auth, preValidation: W }, async (req, reply) => {
    const u = req.authUser;
    const file = await req.file({ limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 } });
    if (!file) throw badRequest('File wajib diunggah (multipart field "file")');
    const field = (k: string) => (file.fields[k] as { value?: string } | undefined)?.value;
    const meta = z.object({
      title: z.string().trim().min(2).max(300).optional(),
      entityType: z.enum(['customer', 'opportunity', 'tender', 'contract', 'project', 'general']).default('general'),
      entityId: z.string().uuid().optional(),
      confidentiality: z.enum(['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']).default('INTERNAL'),
      compress: z.enum(['auto', 'none', 'aggressive']).default('auto'),
      ocr: z.enum(['auto', 'force', 'off']).default('auto'),
    }).parse({ title: field('title'), entityType: field('entityType'), entityId: field('entityId') || undefined, confidentiality: field('confidentiality'), compress: field('compress'), ocr: field('ocr') });
    const buf = await file.toBuffer();
    if (file.file.truncated) throw new AppError(413, 'FILE_TOO_LARGE', `Ukuran file melebihi batas ${MAX_MB} MB`);
    const safeName = file.filename.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 150);
    const type = sniffDoc(buf, safeName);
    if (!type) throw badRequest('Tipe file tidak didukung (PDF, DOCX, TXT, PNG, JPG, TIFF)');
    let pageCount = 1;
    if (type.kind === 'pdf') {
      try { pageCount = await pdfPageCount(buf); } catch { throw badRequest('PDF rusak atau terenkripsi — tidak dapat dibuka'); }
      if (pageCount > MAX_PAGES) throw unprocessable(`Dokumen ${pageCount} halaman melebihi batas ${MAX_PAGES} halaman — pecah dokumen terlebih dahulu`, { pageCount, maxPages: MAX_PAGES });
    }
    if (meta.entityId && meta.entityType !== 'general') {
      const table = { customer: 'customers', opportunity: 'opportunities', tender: 'tenders', contract: 'contracts', project: 'projects' }[meta.entityType];
      const [e] = await sql`SELECT 1 FROM ${sql(table!)} WHERE id = ${meta.entityId} AND tenant_id = ${u.tenantId}`;
      if (!e) throw notFound('Entitas terkait');
    }
    const sha = createHash('sha256').update(buf).digest('hex');
    const [dup] = await sql`SELECT id, title FROM documents WHERE tenant_id = ${u.tenantId} AND sha256 = ${sha}`;
    if (dup) throw conflict(`File identik sudah ada: ${dup.title}`, { existingId: dup.id });
    const dir = join(DOC_DIR(), u.tenantId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${sha}.orig`);
    await storeFile(sql, u.tenantId, path, buf, req.log);
    const doc = await sql.begin(async (tx) => {
      const [d] = await tx`INSERT INTO documents (tenant_id, title, filename, mime, kind, entity_type, entity_id, confidentiality, size_original, sha256, original_path, page_count, options, uploaded_by)
        VALUES (${u.tenantId}, ${meta.title ?? safeName}, ${safeName}, ${type.mime}, ${type.kind}, ${meta.entityType}, ${meta.entityId ?? null}, ${meta.confidentiality},
                ${buf.length}, ${sha}, ${path}, ${pageCount}, ${tx.json({ compress: meta.compress, ocr: meta.ocr } as never)}, ${u.id})
        RETURNING id, title, kind, page_count, size_original, status`;
      const jobId = await enqueue(tx, u.tenantId, 'document_process', { documentId: d.id }, u.id);
      await audit(tx, u, 'document.upload', 'document', d.id as string, null, { filename: safeName, sha256: sha, pages: pageCount, size: buf.length }, req.ip);
      return { ...d, jobId };
    });
    reply.code(202);
    return doc;
  });

  app.get('/api/v1/documents', { ...auth, preValidation: R }, async (req) => {
    const q = z.object({ entityType: z.string().optional(), entityId: z.string().uuid().optional(), q: z.string().max(100).optional() }).parse(req.query);
    const u = req.authUser;
    const rows = await sql`SELECT d.id, d.title, d.filename, d.kind, d.entity_type, d.entity_id, d.confidentiality, d.size_original, d.size_stored, d.page_count, d.status,
        d.text_source, d.ocr_pages, d.ocr_confidence, d.compression, d.created_at, u.full_name AS uploaded_by_name,
        (SELECT count(*)::int FROM document_analyses a WHERE a.document_id = d.id) AS analyses
      FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.tenant_id = ${u.tenantId} ${documentAccessFilter(sql, u)}
        ${q.entityType ? sql`AND d.entity_type = ${q.entityType}` : sql``} ${q.entityId ? sql`AND d.entity_id = ${q.entityId}` : sql``}
        ${q.q ? sql`AND (d.title ILIKE ${'%' + q.q + '%'} OR EXISTS (SELECT 1 FROM document_pages p WHERE p.document_id = d.id AND p.text ILIKE ${'%' + q.q + '%'}))` : sql``}
      ORDER BY d.created_at DESC LIMIT 200`;
    return { items: rows };
  });

  app.get('/api/v1/documents/:id', { ...auth, preValidation: R }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const d = await load(req.authUser, id);
    const pages = await sql`SELECT page_no, source, confidence, length(text) AS chars, left(text, 240) AS preview FROM document_pages WHERE document_id = ${id} ORDER BY page_no`;
    const analyses = await sql`SELECT a.id, a.kind, a.question, a.status, a.created_at, a.finished_at, u.full_name AS created_by_name FROM document_analyses a
                               LEFT JOIN users u ON u.id = a.created_by WHERE a.document_id = ${id} ORDER BY a.created_at DESC`;
    const [job] = await sql`SELECT status, progress, last_error FROM jobs WHERE kind = 'document_process' AND payload->>'documentId' = ${id} ORDER BY id DESC LIMIT 1`;
    const { originalPath: _o, storedPath: _s, ...safe } = d as Record<string, unknown>;
    return { document: safe, pages, analyses, job: job ?? null };
  });

  app.get('/api/v1/documents/:id/pages/:page', { ...auth, preValidation: R }, async (req) => {
    const { id, page } = z.object({ id: z.string().uuid(), page: z.coerce.number().int().min(1) }).parse(req.params);
    await load(req.authUser, id);
    const [p] = await sql`SELECT page_no, text, source, confidence FROM document_pages WHERE document_id = ${id} AND page_no = ${page}`;
    if (!p) throw notFound('Halaman');
    return p;
  });

  app.get('/api/v1/documents/:id/file', { ...auth, preValidation: R }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = z.object({ variant: z.enum(['original', 'compressed']).default('compressed') }).parse(req.query);
    const d = await load(req.authUser, id);
    const path = q.variant === 'compressed' && d.storedPath ? d.storedPath : d.originalPath;
    const buf = await readStoredFile(sql, req.authUser.tenantId, path as string);
    await audit(sql, req.authUser, 'document.download', 'document', id, null, { variant: q.variant }, req.ip);
    reply.header('content-type', String(path).endsWith('.pdf') || d.kind === 'pdf' ? 'application/pdf' : (d.mime as string));
    reply.header('content-disposition', `attachment; filename="${String(d.filename).replace(/"/g, '')}"`);
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(buf);
  });

  app.post('/api/v1/documents/:id/reprocess', { ...auth, preValidation: W }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ ocr: z.enum(['auto', 'force', 'off']).default('force'), compress: z.enum(['auto', 'none', 'aggressive']).default('auto') }).parse(req.body ?? {});
    const u = req.authUser;
    const d = await load(u, id);
    if (d.status === 'PROCESSING' || d.status === 'QUEUED') throw conflict('Dokumen sedang diproses');
    await sql`UPDATE documents SET status = 'QUEUED', options = ${sql.json(b as never)} WHERE id = ${id}`;
    const jobId = await enqueue(sql, u.tenantId, 'document_process', { documentId: id }, u.id);
    await audit(sql, u, 'document.reprocess', 'document', id, null, b, req.ip);
    return { id, jobId, status: 'QUEUED' };
  });

  /* ───── Analisis AI ───── */
  const KIND_FEATURE = { SUMMARY: 'document_summary', RISKS: 'document_risks', EXTRACT: 'document_extract', QA: 'document_qa' } as const;
  app.post('/api/v1/documents/:id/analyses', { ...auth, preValidation: requirePerm('ai.use'), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({
      kind: z.enum(['SUMMARY', 'RISKS', 'EXTRACT', 'QA']),
      question: z.string().min(5).max(1000).optional(),
      fields: z.array(z.object({ name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/), description: z.string().max(200).optional() })).max(30).optional(),
      range: z.object({ from: z.number().int().min(1).optional(), to: z.number().int().min(1).optional() }).optional(),
    }).refine((x) => x.kind !== 'QA' || x.question, { message: 'Pertanyaan wajib untuk QA' })
      .refine((x) => x.kind !== 'EXTRACT' || (x.fields && x.fields.length), { message: 'Daftar field wajib untuk EXTRACT' }).parse(req.body);
    const u = req.authUser;
    const d = await load(u, id);
    if (d.status !== 'READY') throw unprocessable(`Dokumen belum siap (status ${d.status})`);
    if (d.confidentiality === 'RESTRICTED') throw forbidden('Dokumen RESTRICTED tidak boleh dikirim ke penyedia AI eksternal');
    if (!(await featureEnabled(sql, u.tenantId, KIND_FEATURE[b.kind]))) throw new AppError(409, 'AI_DISABLED', 'Fitur AI ini dinonaktifkan oleh admin');
    const out = await sql.begin(async (tx) => {
      const [a] = await tx`INSERT INTO document_analyses (tenant_id, document_id, kind, question, fields, created_by)
        VALUES (${u.tenantId}, ${id}, ${b.kind}, ${b.question ?? null}, ${tx.json({ fields: b.fields ?? [], range: b.range ?? null } as never)}, ${u.id}) RETURNING id, kind, status`;
      const jobId = await enqueue(tx, u.tenantId, 'document_analysis', { analysisId: a.id }, u.id, 1);
      return { ...a, jobId };
    });
    reply.code(202);
    return out;
  });

  app.get('/api/v1/documents/:id/analyses/:aid', { ...auth, preValidation: R }, async (req) => {
    const { id, aid } = z.object({ id: z.string().uuid(), aid: z.string().uuid() }).parse(req.params);
    await load(req.authUser, id);
    const [a] = await sql`SELECT a.*, j.progress FROM document_analyses a
      LEFT JOIN LATERAL (SELECT progress FROM jobs WHERE kind = 'document_analysis' AND payload->>'analysisId' = a.id::text ORDER BY id DESC LIMIT 1) j ON true
      WHERE a.id = ${aid} AND a.document_id = ${id}`;
    if (!a) throw notFound('Analisis');
    return a;
  });
}
