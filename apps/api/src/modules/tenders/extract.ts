import { z } from 'zod';

/* ───────────────────────── Text extraction ───────────────────────── */

export interface Extracted { status: 'DONE' | 'NEEDS_OCR' | 'FAILED' | 'NOT_APPLICABLE'; pages: string[]; note?: string }

export function sniffType(buf: Buffer, filename: string): 'pdf' | 'docx' | 'txt' | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04 && /\.docx$/i.test(filename)) return 'docx';
  if (/\.(txt|md|csv)$/i.test(filename)) {
    const sample = buf.subarray(0, 4096).toString('utf8');
    if (!/[\u0000-\u0008\u000E-\u001F]/.test(sample)) return 'txt';
  }
  return null;
}

export async function extractText(buf: Buffer, type: 'pdf' | 'docx' | 'txt'): Promise<Extracted> {
  try {
    if (type === 'txt') return { status: 'DONE', pages: [buf.toString('utf8')] };
    if (type === 'docx') {
      const mammoth = await import('mammoth');
      const r = await mammoth.extractRawText({ buffer: buf });
      return { status: 'DONE', pages: [r.value] };
    }
    const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await pdfText(pdf, { mergePages: false });
    const pages = (text as string[]).map((t) => t ?? '');
    const avg = pages.reduce((s, p) => s + p.trim().length, 0) / Math.max(1, pages.length);
    if (avg < 50) {
      return { status: 'NEEDS_OCR', pages, note: 'PDF tampaknya hasil scan (teks < 50 karakter/halaman). Worker OCR belum aktif — unggah versi teks/DOCX atau aktifkan OCR (Phase 2b).' };
    }
    return { status: 'DONE', pages };
  } catch (e) {
    return { status: 'FAILED', pages: [], note: `Ekstraksi gagal: ${(e as Error).message.slice(0, 200)}` };
  }
}

/* ───────────────────────── Rule-based requirement extraction ───────────────────────── */

export type Category = 'ADMINISTRATIVE' | 'QUALIFICATION' | 'TECHNICAL' | 'COMMERCIAL';
export interface ExtractedReq { category: Category; requirement: string; mandatory: boolean; sourceExcerpt: string; sourcePage: number | null; riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'; origin: 'RULE' | 'AI' }

const TRIGGER = /\b(wajib|harus|diwajibkan|disyaratkan|minimal|minimum|sekurang-kurangnya|paling sedikit|memiliki|melampirkan|menyampaikan|menyerahkan|dilengkapi|mampu|bersedia|tidak boleh|dilarang|menyediakan|must|shall|required|mandatory|should)\b/i;
const OPTIONAL = /\b(dapat|opsional|diharapkan|nilai tambah|diutamakan|apabila ada|jika ada|should|may|optional|preferred)\b/i;
const MANDATORY = /\b(wajib|harus|diwajibkan|disyaratkan|minimal|minimum|sekurang-kurangnya|paling sedikit|gugur|tidak boleh|dilarang|must|shall|mandatory|required)\b/i;
const HIGH_RISK = /\b(gugur|wajib|jaminan|sertifikat|sertifikasi|denda|sanksi|blacklist|daftar hitam|penalti|penalty)\b/i;

const CAT_WORDS: Record<Category, RegExp[]> = {
  ADMINISTRATIVE: [/surat penawaran/i, /jaminan penawaran/i, /pakta integritas/i, /surat kuasa/i, /\bnpwp\b/i, /\bnib\b/i, /\bsiup\b/i, /\bakta\b/i, /\bktp\b/i,
    /domisili/i, /surat pernyataan/i, /materai|meterai/i, /formulir/i, /\bpkp\b/i, /\bspt\b/i, /dokumen penawaran/i, /tanda tangan|ditandatangani/i, /cap perusahaan/i],
  QUALIFICATION: [/pengalaman/i, /kualifikasi/i, /sertifikat|sertifikasi|certified|certification/i, /\biso\b/i, /tenaga ahli/i, /personil|personel/i, /\bcv\b|daftar riwayat/i,
    /referensi/i, /kontrak sejenis|pekerjaan sejenis/i, /\bkbli\b/i, /\bbssn\b/i, /laporan keuangan/i, /kemampuan dasar|\bkd\b/i, /\bskp\b/i, /akreditasi/i],
  COMMERCIAL: [/\bharga\b/i, /\bhps\b/i, /pembayaran|termin/i, /denda/i, /garansi/i, /jaminan pelaksanaan/i, /\bppn\b|pajak/i, /\btkdn\b/i, /masa berlaku penawaran/i,
    /rincian biaya|\bboq\b|bill of quantity/i, /\brupiah\b|\brp\b/i, /kontrak harga/i],
  TECHNICAL: [/\bsla\b/i, /\bsiem\b|\bsoc\b|\bedr\b|\bxdr\b|\bsoar\b/i, /monitoring|pemantauan/i, /penetration|pentest|\bvapt\b|vulnerability/i, /metodologi/i, /jadwal|timeline/i,
    /spesifikasi/i, /24x7|24\/7/i, /\beps\b|\blog\b/i, /laporan|report/i, /insiden|incident/i, /server|jaringan|network|aplikasi/i, /threat|ancaman/i],
};

function categorize(text: string): Category {
  const score = (c: Category) => CAT_WORDS[c].reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
  const order: Category[] = ['ADMINISTRATIVE', 'COMMERCIAL', 'QUALIFICATION', 'TECHNICAL'];
  let best: Category = 'TECHNICAL';
  let bestScore = 0;
  for (const c of order) { const s = score(c); if (s > bestScore) { best = c; bestScore = s; } }
  return best;
}

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const words = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length > 2));
export function similarity(a: string, b: string) {
  const A = words(a); const B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Pecah teks menjadi kalimat/butir kandidat, gabungkan baris yang terpotong. */
function candidates(page: string): string[] {
  const lines = page.replace(/\r/g, '').split('\n').map((l) => l.trim());
  const out: string[] = [];
  let buf = '';
  const flush = () => { if (buf) out.push(buf.trim()); buf = ''; };
  for (const l of lines) {
    if (!l) { flush(); continue; }
    const startsItem = /^([0-9]{1,2}[.)]|[a-z][.)]|[-•●▪*]|\([a-z0-9]+\))\s+/i.test(l);
    if (startsItem) { flush(); buf = l; continue; }
    buf = buf ? `${buf} ${l}` : l;
    if (/[.;:]$/.test(l)) flush();
  }
  flush();
  return out.flatMap((c) => (c.length > 600 ? c.split(/(?<=[.;])\s+/) : [c]));
}

export function ruleExtract(pages: string[]): ExtractedReq[] {
  const out: ExtractedReq[] = [];
  const seen: string[] = [];
  pages.forEach((page, i) => {
    for (const c of candidates(page)) {
      const text = c.replace(/^([0-9]{1,2}[.)]|[a-z][.)]|[-•●▪*]|\([a-z0-9]+\))\s+/i, '').replace(/\s+/g, ' ').trim();
      if (text.length < 25 || text.length > 600 || !TRIGGER.test(text)) continue;
      const n = norm(text);
      if (seen.some((s) => s === n || similarity(s, n) > 0.85)) continue;
      seen.push(n);
      const optional = OPTIONAL.test(text) && !MANDATORY.test(text);
      out.push({ category: categorize(text), requirement: text, mandatory: !optional, sourceExcerpt: text.slice(0, 400), sourcePage: pages.length > 1 ? i + 1 : null,
        riskLevel: optional ? 'LOW' : HIGH_RISK.test(text) ? 'HIGH' : 'MEDIUM', origin: 'RULE' });
      if (out.length >= 300) return;
    }
  });
  return out;
}

/* ───────────────────────── AI extraction with source verification ───────────────────────── */

export const AiReqSchema = z.array(z.object({
  category: z.enum(['ADMINISTRATIVE', 'QUALIFICATION', 'TECHNICAL', 'COMMERCIAL']),
  requirement: z.string().min(10).max(800),
  mandatory: z.boolean(),
  source_excerpt: z.string().min(10).max(800),
  page: z.number().int().positive().nullable().optional(),
})).max(300);

export const AI_EXTRACTION_PROMPT = `Ekstrak SEMUA persyaratan dari dokumen pengadaan (RKS/KAK/TOR) di blok <document>.
Kembalikan HANYA JSON array tanpa teks lain, format:
[{"category":"ADMINISTRATIVE|QUALIFICATION|TECHNICAL|COMMERCIAL","requirement":"ringkasan persyaratan","mandatory":true,"source_excerpt":"kutipan PERSIS dari dokumen (10-300 karakter)","page":1}]
Aturan: source_excerpt wajib disalin persis dari dokumen; jangan menambah persyaratan yang tidak tertulis; mandatory=false hanya bila dokumen menyebut opsional/nilai tambah.`;

/** Parse output AI; buang item yang kutipannya TIDAK ditemukan di dokumen (anti-halusinasi). */
export function verifyAiRequirements(raw: string, pages: string[], redactedPages?: string[]) {
  const jsonStart = raw.indexOf('[');
  const jsonEnd = raw.lastIndexOf(']');
  if (jsonStart < 0 || jsonEnd <= jsonStart) return { accepted: [] as ExtractedReq[], rejected: 0, error: 'Output AI bukan JSON array' };
  let parsed;
  try { parsed = AiReqSchema.parse(JSON.parse(raw.slice(jsonStart, jsonEnd + 1))); } catch (e) {
    return { accepted: [] as ExtractedReq[], rejected: 0, error: `Output AI tidak valid: ${(e as Error).message.slice(0, 120)}` };
  }
  const corpus = norm(pages.join(' '));
  const corpusRed = redactedPages ? norm(redactedPages.join(' ')) : corpus;
  const accepted: ExtractedReq[] = [];
  let rejected = 0;
  for (const it of parsed) {
    const ex = norm(it.source_excerpt);
    if (ex.length < 10 || (!corpus.includes(ex) && !corpusRed.includes(ex))) { rejected++; continue; }
    const pageIdx = pages.findIndex((p) => norm(p).includes(ex));
    accepted.push({ category: it.category, requirement: it.requirement.trim(), mandatory: it.mandatory, sourceExcerpt: it.source_excerpt.trim(),
      sourcePage: pageIdx >= 0 && pages.length > 1 ? pageIdx + 1 : (it.page ?? null), riskLevel: !it.mandatory ? 'LOW' : HIGH_RISK.test(it.requirement) ? 'HIGH' : 'MEDIUM', origin: 'AI' });
  }
  return { accepted, rejected, error: null as string | null };
}

/* ───────────────────────── Tender relevance (discovery) ───────────────────────── */

const RELEVANCE: [RegExp, number, string][] = [
  [/keamanan siber|cyber ?security|keamanan informasi|information security/i, 30, 'cybersecurity'],
  [/\bsoc\b|security operation|siem|\bmdr\b|managed security/i, 30, 'soc'],
  [/penetration|pentest|\bvapt\b|vulnerability assessment|uji penetrasi|ethical hacking/i, 30, 'vapt'],
  [/threat intelligence|\bcti\b|dark ?web|brand protection/i, 25, 'cti'],
  [/iso ?27001|sistem manajemen keamanan|smki|\bisms\b/i, 25, 'iso'],
  [/pelindungan data|perlindungan data|\bpdp\b|data privacy|\bdpo\b/i, 20, 'pdp'],
  [/forensi|incident response|\bdfir\b|penanganan insiden/i, 25, 'dfir'],
  [/\bcsirt\b|\bcert\b|awareness|kesadaran keamanan/i, 15, 'csirt'],
  [/edr|xdr|endpoint|firewall|waf|antivirus/i, 15, 'security_product'],
  [/audit ti|it audit|tata kelola ti|cobit|\bbcp\b|\bdrp\b|business continuity/i, 15, 'grc'],
  [/jaringan|network|server|data center|cloud|infrastruktur ti|lisensi perangkat lunak|software/i, 8, 'it'],
];

export function scoreRelevance(text: string) {
  let score = 0;
  const matched: string[] = [];
  for (const [re, w, tag] of RELEVANCE) if (re.test(text)) { score += w; matched.push(tag); }
  score = Math.min(100, score);
  const classification = matched.some((m) => !['it'].includes(m)) ? 'CYBERSECURITY' : matched.includes('it') ? 'IT' : 'NON_IT';
  return { score, matched, classification };
}
