import { readFile, writeFile } from 'node:fs/promises';
import { readStoredFile, storeFile } from '../../lib/storage.js';
import type { Sql } from '../../db.js';
import { audit, notify } from '../../lib/context.js';
import { registerJob } from '../../lib/jobs.js';
import { complete, redact } from '../ai/gateway.js';
import type { FetchLike } from '../ai/providers.js';
import { norm } from '../tenders/extract.js';
import { MIN_NATIVE_CHARS, compressPdf, nativePdfText, ocrImage, ocrLangs, ocrPdfPages, pdfPageCount, tools } from './processing.js';

export let documentAiFetch: FetchLike | undefined;
export const setDocumentAiFetch = (f?: FetchLike) => { documentAiFetch = f; };

/* ───────────────────────── Proses dokumen: kompresi → teks native → OCR ───────────────────────── */

registerJob('document_process', async (sql, job, progress) => {
  const [d] = await sql`SELECT * FROM documents WHERE id = ${job.payload.documentId}`;
  if (!d) return;
  await sql`UPDATE documents SET status = 'PROCESSING', processing_note = NULL WHERE id = ${d.id}`;
  const opts = (d.options ?? {}) as { compress?: 'auto' | 'none' | 'aggressive'; ocr?: 'auto' | 'force' | 'off' };
  const t = await tools();
  const notes: string[] = [];
  try {
    const original = await readStoredFile(sql, d.tenantId as string, d.originalPath as string);
    let pages: { no: number; text: string; source: 'NATIVE' | 'OCR'; confidence: number | null }[] = [];
    let stored: Buffer = original;
    let compression: unknown = null;

    if (d.kind === 'pdf') {
      const native = await nativePdfText(original);
      const needOcr = opts.ocr === 'off' ? [] : native.map((txt, i) => ({ i, n: txt.replace(/\s/g, '').length }))
        .filter((x) => opts.ocr === 'force' || x.n < MIN_NATIVE_CHARS).map((x) => x.i + 1);
      const scanned = needOcr.length > native.length / 2;
      if (opts.compress !== 'none') {
        await progress({ step: 'compress' });
        const c = await compressPdf(original, { aggressive: opts.compress === 'aggressive', scanned });
        compression = c.result;
        if (c.result.method !== 'none') stored = c.buf;
      }
      pages = native.map((text, i) => ({ no: i + 1, text, source: 'NATIVE' as const, confidence: null }));
      if (needOcr.length) {
        if (!t.tesseract || !t.pdftoppm) notes.push(`${needOcr.length} halaman perlu OCR tetapi tesseract/pdftoppm tidak terpasang di server`);
        else {
          const langs = await ocrLangs();
          const res = await ocrPdfPages(original, needOcr, langs, (done, total) => progress({ step: 'ocr', done, total }));
          for (const p of needOcr) if (res[p]?.text.trim()) pages[p - 1] = { no: p, text: res[p].text, source: 'OCR', confidence: res[p].confidence };
          notes.push(`OCR ${needOcr.length} halaman (bahasa ${langs})`);
        }
      }
    } else if (d.kind === 'image') {
      if (!t.tesseract) notes.push('tesseract tidak terpasang — gambar tidak dapat dibaca');
      else { const r = await ocrImage(d.originalPath as string, await ocrLangs()); pages = [{ no: 1, text: r.text, source: 'OCR', confidence: r.confidence }]; }
    } else if (d.kind === 'docx') {
      const mammoth = await import('mammoth');
      pages = [{ no: 1, text: (await mammoth.extractRawText({ buffer: original })).value, source: 'NATIVE', confidence: null }];
    } else {
      pages = [{ no: 1, text: original.toString('utf8'), source: 'NATIVE', confidence: null }];
    }

    let storedPath = d.originalPath as string;
    if (stored !== original) { storedPath = (d.originalPath as string).replace(/\.orig$/, '') + '.cmp.pdf'; await storeFile(sql, d.tenantId as string, storedPath, stored); }
    const ocrPages = pages.filter((p) => p.source === 'OCR');
    const withText = pages.filter((p) => p.text.trim().length > 0);
    const src = !withText.length ? 'NONE' : ocrPages.length === 0 ? 'NATIVE' : ocrPages.length === withText.length ? 'OCR' : 'MIXED';
    const conf = ocrPages.filter((p) => p.confidence !== null);
    await sql.begin(async (tx) => {
      await tx`DELETE FROM document_pages WHERE document_id = ${d.id}`;
      for (const p of pages) await tx`INSERT INTO document_pages (document_id, page_no, text, source, confidence) VALUES (${d.id}, ${p.no}, ${p.text}, ${p.source}, ${p.confidence})`;
      await tx`UPDATE documents SET status = ${withText.length ? 'READY' : 'FAILED'}, stored_path = ${storedPath}, size_stored = ${stored.length},
        page_count = ${pages.length}, text_source = ${src}, ocr_pages = ${ocrPages.length},
        ocr_confidence = ${conf.length ? Math.round((conf.reduce((s, p) => s + (p.confidence ?? 0), 0) / conf.length) * 100) / 100 : null},
        compression = ${compression ? tx.json(compression as never) : null},
        processing_note = ${[...notes, ...(withText.length ? [] : ['Tidak ada teks yang dapat dibaca'])].join('; ') || null}, processed_at = now() WHERE id = ${d.id}`;
    });
    if (d.uploadedBy) await notify(sql, d.tenantId as string, [d.uploadedBy as string], 'DOCUMENT_READY', `Dokumen siap: ${d.title}`,
      `${pages.length} halaman · sumber teks ${src}${ocrPages.length ? ` · OCR ${ocrPages.length} hal.` : ''}`, `/documents/${d.id}`);
  } catch (e) {
    await sql`UPDATE documents SET status = 'FAILED', processing_note = ${(e as Error).message.slice(0, 500)}, processed_at = now() WHERE id = ${d.id}`;
    throw e;
  }
});

/** OCR dokumen tender hasil scan (NEEDS_OCR) → teks per halaman untuk ekstraksi persyaratan. */
registerJob('tender_ocr', async (sql, job) => {
  const [d] = await sql`SELECT * FROM tender_documents WHERE id = ${job.payload.documentId}`;
  if (!d) return;
  const t = await tools();
  if (!t.tesseract || !t.pdftoppm) {
    await sql`UPDATE tender_documents SET extraction_status = 'NEEDS_OCR', extraction_note = 'tesseract/pdftoppm tidak terpasang di server' WHERE id = ${d.id}`;
    return;
  }
  await sql`UPDATE tender_documents SET extraction_status = 'OCR_RUNNING' WHERE id = ${d.id}`;
  const buf = await readStoredFile(sql, d.tenantId as string, d.storagePath as string);
  const native = d.mime === 'application/pdf' ? await nativePdfText(buf) : [];
  const targets = native.map((x, i) => ({ i, n: x.replace(/\s/g, '').length })).filter((x) => x.n < MIN_NATIVE_CHARS).map((x) => x.i + 1);
  const res = await ocrPdfPages(buf, targets, await ocrLangs());
  const pages = native.map((txt, i) => res[i + 1]?.text?.trim() ? res[i + 1].text : txt);
  const chars = pages.join('').replace(/\s/g, '').length;
  await sql`UPDATE tender_documents SET extraction_status = ${chars > 50 ? 'DONE' : 'FAILED'}, extracted_text = ${chars > 50 ? pages.join('\f') : null},
    text_source = 'OCR', extraction_note = ${chars > 50 ? `OCR ${targets.length} halaman` : 'OCR tidak menemukan teks yang terbaca'} WHERE id = ${d.id}`;
  if (d.uploadedBy) await notify(sql, d.tenantId as string, [d.uploadedBy as string], 'TENDER_OCR_DONE', `OCR ${d.filename}: ${chars > 50 ? 'selesai' : 'gagal'}`, '', `/tenders/${d.tenderId}`);
});

/* ───────────────────────── Analisis dokumen berbasis AI ───────────────────────── */

const CHUNK_CHARS = Number(process.env.DOC_AI_CHUNK_CHARS ?? 12000);
const MAX_CHUNKS = Number(process.env.DOC_AI_MAX_CHUNKS ?? 60);

export function chunkPages(pages: { pageNo: number; text: string }[]) {
  const chunks: { pages: number[]; text: string }[] = [];
  let cur: { pages: number[]; text: string } = { pages: [], text: '' };
  for (const p of pages) {
    const block = `[Hal. ${p.pageNo}]\n${p.text.trim()}\n`;
    if (cur.text.length + block.length > CHUNK_CHARS && cur.pages.length) { chunks.push(cur); cur = { pages: [], text: '' }; }
    // halaman sangat panjang dipotong (jarang)
    cur.pages.push(p.pageNo); cur.text += block.slice(0, CHUNK_CHARS);
  }
  if (cur.pages.length) chunks.push(cur);
  return chunks;
}

const parseJson = (raw: string) => {
  const s = raw.replace(/^```(json)?/m, '').replace(/```\s*$/m, '');
  const a = Math.min(...['[', '{'].map((c) => (s.indexOf(c) < 0 ? Infinity : s.indexOf(c))));
  const z = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
  if (!isFinite(a) || z < a) throw new Error('Output AI bukan JSON');
  return JSON.parse(s.slice(a, z + 1));
};

/** Kutipan dianggap valid bila (setelah normalisasi) ada di teks halaman yang dirujuk (atau dokumen). */
export function verifyQuote(quote: string | undefined, page: number | undefined, pages: Map<number, string>) {
  if (!quote || norm(quote).length < 8) return { verified: false, page: page ?? null };
  const q = norm(quote);
  const check = (t: string) => norm(t).includes(q) || norm(redact(t).text).includes(q);
  if (page && pages.has(page) && check(pages.get(page)!)) return { verified: true, page };
  for (const [no, t] of pages) if (check(t)) return { verified: true, page: no };
  return { verified: false, page: page ?? null };
}

const SEVERITY = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

registerJob('document_analysis', async (sql, job, progress) => {
  const [a] = await sql`SELECT a.*, d.title, d.page_count FROM document_analyses a JOIN documents d ON d.id = a.document_id WHERE a.id = ${job.payload.analysisId}`;
  if (!a) return;
  await sql`UPDATE document_analyses SET status = 'RUNNING' WHERE id = ${a.id}`;
  const range = (a.fields as any)?.range as { from?: number; to?: number } | undefined;
  const rows = (await sql`SELECT page_no, text FROM document_pages WHERE document_id = ${a.documentId}
    ${range?.from ? sql`AND page_no >= ${range.from}` : sql``} ${range?.to ? sql`AND page_no <= ${range.to}` : sql``} ORDER BY page_no`) as unknown as { pageNo: number; text: string }[];
  const pageMap = new Map(rows.map((r) => [r.pageNo, r.text]));
  const providers: string[] = [];
  const ask = async (feature: string, prompt: string, maxTokens = 1500) => {
    const r = await complete({ sql, fetchImpl: documentAiFetch }, { tenantId: a.tenantId as string, userId: (a.createdBy as string) ?? null, feature, user: prompt, maxTokens, temperature: 0 });
    providers.push(`${r.provider}:${r.model}`);
    return r.text;
  };
  const fail = async (msg: string) => {
    await sql`UPDATE document_analyses SET status = 'FAILED', error = ${msg}, providers = ${sql.json(providers as never)}, finished_at = now() WHERE id = ${a.id}`;
  };
  try {
    if (!rows.length) return fail('Dokumen tidak memiliki teks (jalankan OCR terlebih dahulu)');
    const chunks = chunkPages(rows);
    let result: unknown; let verification: unknown = null;

    if (a.kind === 'SUMMARY') {
      if (chunks.length > MAX_CHUNKS) return fail(`Dokumen terlalu panjang untuk diringkas sekaligus (${chunks.length} bagian > ${MAX_CHUNKS}). Pilih rentang halaman.`);
      const partials: string[] = [];
      for (const [i, c] of chunks.entries()) {
        partials.push(chunks.length === 1 ? '' : await ask('document_summary', `Ringkas bagian dokumen berikut dalam maksimal 180 kata, poin-poin, sertakan rujukan halaman [Hal. N] untuk setiap poin penting.\n<document>\n${c.text}\n</document>`, 700));
        await progress({ step: 'map', done: i + 1, total: chunks.length });
      }
      const body = chunks.length === 1 ? chunks[0].text : partials.map((p, i) => `### Bagian ${i + 1} (hal. ${chunks[i].pages[0]}–${chunks[i].pages.at(-1)})\n${p}`).join('\n\n');
      const text = await ask('document_summary', `Susun ringkasan eksekutif dokumen "${a.title}" dalam Bahasa Indonesia: (1) tujuan & ruang lingkup, (2) poin kunci, (3) angka/tanggal penting, (4) hal yang perlu ditindaklanjuti. Sertakan rujukan [Hal. N]. Gunakan HANYA isi berikut.\n<document>\n${body}\n</document>`, 1800);
      const cited = [...new Set([...text.matchAll(/Hal\.\s*(\d+)/g)].map((m) => Number(m[1])))];
      result = { summary: text, chunks: chunks.length, pagesCovered: rows.length };
      verification = { citedPages: cited, invalidPageRefs: cited.filter((p) => !pageMap.has(p)) };
    }

    if (a.kind === 'RISKS') {
      if (chunks.length > MAX_CHUNKS) return fail(`Dokumen terlalu panjang (${chunks.length} bagian). Pilih rentang halaman.`);
      const items: any[] = []; let rejected = 0;
      for (const [i, c] of chunks.entries()) {
        const raw = await ask('document_risks', `Identifikasi KEWAJIBAN, TENGGAT, PEMBAYARAN, DENDA/SANKSI, SLA, dan RISIKO dalam teks berikut. Kembalikan HANYA JSON array:
[{"category":"OBLIGATION|DEADLINE|PAYMENT|PENALTY|SLA|RISK","statement":"ringkasan","severity":"LOW|MEDIUM|HIGH|CRITICAL","quote":"kutipan PERSIS dari teks","page":N}]
Jangan menambah hal yang tidak tertulis.\n<document>\n${c.text}\n</document>`, 2500);
        let arr: any[] = [];
        try { arr = parseJson(raw); if (!Array.isArray(arr)) arr = []; } catch { arr = []; }
        for (const it of arr.slice(0, 80)) {
          const v = verifyQuote(String(it.quote ?? ''), Number(it.page) || undefined, pageMap);
          if (!v.verified) { rejected++; continue; }
          items.push({ category: String(it.category ?? 'RISK').toUpperCase(), statement: String(it.statement ?? '').slice(0, 500),
            severity: SEVERITY.includes(String(it.severity).toUpperCase()) ? String(it.severity).toUpperCase() : 'MEDIUM', quote: String(it.quote).slice(0, 500), page: v.page });
        }
        await progress({ step: 'map', done: i + 1, total: chunks.length });
      }
      items.sort((x, y) => SEVERITY.indexOf(y.severity) - SEVERITY.indexOf(x.severity));
      result = { items, counts: items.reduce((m: Record<string, number>, x) => ({ ...m, [x.category]: (m[x.category] ?? 0) + 1 }), {}) };
      verification = { accepted: items.length, rejectedUnverified: rejected };
    }

    if (a.kind === 'EXTRACT') {
      const fields = ((a.fields as any)?.fields ?? []) as { name: string; description?: string }[];
      const found: Record<string, { value: unknown; quote: string; page: number | null; verified: boolean } | null> = Object.fromEntries(fields.map((f) => [f.name, null]));
      let rejected = 0;
      for (const [i, c] of chunks.slice(0, MAX_CHUNKS).entries()) {
        const missing = fields.filter((f) => !found[f.name]);
        if (!missing.length) break;
        const raw = await ask('document_extract', `Ekstrak field berikut dari teks. Kembalikan HANYA JSON object {"<nama_field>":{"value":...,"quote":"kutipan PERSIS","page":N}} dan isi null bila tidak ditemukan.
Field: ${JSON.stringify(missing)}\n<document>\n${c.text}\n</document>`, 1500);
        let obj: any = {};
        try { obj = parseJson(raw); } catch { obj = {}; }
        for (const f of missing) {
          const it = obj?.[f.name];
          if (!it || it.value === null || it.value === undefined) continue;
          const v = verifyQuote(String(it.quote ?? ''), Number(it.page) || undefined, pageMap);
          if (!v.verified) { rejected++; continue; }
          found[f.name] = { value: it.value, quote: String(it.quote).slice(0, 400), page: v.page, verified: true };
        }
        await progress({ step: 'map', done: i + 1, total: chunks.length });
      }
      result = { fields: found };
      verification = { found: Object.values(found).filter(Boolean).length, notFound: Object.entries(found).filter(([, v]) => !v).map(([k]) => k), rejectedUnverified: rejected };
    }

    if (a.kind === 'QA') {
      const q = String(a.question ?? '');
      const terms = [...new Set(norm(q).split(' ').filter((w) => w.length > 2))];
      const scored = rows.map((r) => { const t = norm(r.text); return { r, s: terms.reduce((n, w) => n + (t.split(w).length - 1), 0) }; })
        .filter((x) => x.s > 0).sort((x, y) => y.s - x.s).slice(0, 6).sort((x, y) => x.r.pageNo - y.r.pageNo);
      if (!scored.length) { result = { answer: 'Informasi tidak ditemukan di dokumen.', citations: [] }; verification = { grounded: false }; }
      else {
        const ctx = scored.map((x) => `[Hal. ${x.r.pageNo}]\n${x.r.text.slice(0, 4000)}`).join('\n');
        const raw = await ask('document_qa', `Jawab pertanyaan HANYA berdasarkan <document>. Bila tidak ada jawabannya, katakan tidak ditemukan.
Kembalikan HANYA JSON: {"answer":"...","citations":[{"page":N,"quote":"kutipan PERSIS"}]}\nPertanyaan: ${q}\n<document>\n${ctx}\n</document>`, 1200);
        let obj: any;
        try { obj = parseJson(raw); } catch { obj = { answer: raw, citations: [] }; }
        const citations = (Array.isArray(obj.citations) ? obj.citations : []).slice(0, 10).map((c: any) => ({ ...verifyQuote(String(c.quote ?? ''), Number(c.page) || undefined, pageMap), quote: String(c.quote ?? '').slice(0, 400) }));
        const grounded = citations.some((c: any) => c.verified);
        result = { answer: String(obj.answer ?? ''), citations, retrievedPages: scored.map((x) => x.r.pageNo) };
        verification = { grounded, verifiedCitations: citations.filter((c: any) => c.verified).length, note: grounded ? null : 'Jawaban tidak memiliki kutipan yang terverifikasi — perlakukan sebagai tidak pasti' };
      }
    }

    await sql`UPDATE document_analyses SET status = 'DONE', result = ${sql.json(result as never)}, verification = ${sql.json(verification as never)},
      providers = ${sql.json(providers as never)}, finished_at = now() WHERE id = ${a.id}`;
    await audit(sql, { tenantId: a.tenantId as string, id: (a.createdBy as string) ?? null }, 'document.analysis_done', 'document', a.documentId as string, null, { kind: a.kind, analysisId: a.id });
  } catch (e) {
    await fail((e as Error).message.slice(0, 500));
  }
});

export function documentAccessFilter(sql: Sql, u: { tenantId: string; id: string; role: string }) {
  const privileged = ['company_admin', 'super_admin', 'director', 'auditor'].includes(u.role);
  return privileged ? sql`` : sql`AND (d.confidentiality <> 'RESTRICTED' OR d.uploaded_by = ${u.id})`;
}
