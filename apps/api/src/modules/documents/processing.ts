import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';

const run = promisify(execFile);
export const MAX_PAGES = Number(process.env.DOC_MAX_PAGES ?? 300);
export const MAX_MB = Number(process.env.DOC_MAX_MB ?? 50);
const OCR_DPI = Number(process.env.OCR_DPI ?? 200);
const MIN_NATIVE_CHARS = 40; // halaman dengan teks < ambang dianggap hasil scan → OCR

async function has(bin: string) {
  try { await run('sh', ['-c', `command -v ${bin}`]); return true; } catch { return false; }
}
let toolCache: { tesseract: boolean; gs: boolean; qpdf: boolean; pdftoppm: boolean; langs: string[] } | null = null;
export async function tools() {
  if (toolCache) return toolCache;
  const [tesseract, gs, qpdf, pdftoppm] = await Promise.all([has('tesseract'), has('gs'), has('qpdf'), has('pdftoppm')]);
  let langs: string[] = [];
  if (tesseract) {
    try { const { stdout } = await run('tesseract', ['--list-langs']); langs = stdout.split('\n').slice(1).map((l) => l.trim()).filter((l) => l && l !== 'osd'); } catch { /* ignore */ }
  }
  toolCache = { tesseract, gs, qpdf, pdftoppm, langs };
  return toolCache;
}

/** Bahasa OCR = irisan OCR_LANGS (default ind+eng) dengan model yang terpasang. */
export async function ocrLangs() {
  const wanted = (process.env.OCR_LANGS ?? 'ind+eng').split('+');
  const t = await tools();
  const ok = wanted.filter((l) => t.langs.includes(l));
  return ok.length ? ok.join('+') : (t.langs[0] ?? 'eng');
}

export async function pdfPageCount(buf: Buffer): Promise<number> {
  const doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
  return doc.getPageCount();
}

export interface CompressResult { method: string; before: number; after: number; ratio: number; lossy: boolean; note?: string }

/**
 * Kompresi PDF berjenjang:
 *  1) Ghostscript /ebook (bila tersedia) — downsample gambar 150 dpi;
 *  2) qpdf lossless — object streams + recompress flate + optimasi gambar;
 *  3) (opsional, mode 'aggressive' & dokumen hasil scan) rasterisasi ulang JPEG grayscale 150 dpi.
 * Hasil hanya dipakai bila lebih kecil dari input.
 */
export async function compressPdf(input: Buffer, opts: { aggressive?: boolean; scanned?: boolean } = {}): Promise<{ buf: Buffer; result: CompressResult }> {
  const t = await tools();
  const dir = await mkdtemp(join(tmpdir(), 'icop-cmp-'));
  try {
    const inPath = join(dir, 'in.pdf');
    await writeFile(inPath, input);
    let best = { buf: input, method: 'none', lossy: false };
    const tryOut = async (method: string, lossy: boolean, fn: (out: string) => Promise<unknown>) => {
      const out = join(dir, `${method}.pdf`);
      try {
        await fn(out);
        const b = await readFile(out);
        if (b.length > 0 && b.length < best.buf.length) {
          await pdfPageCount(b); // validasi hasil dapat dibuka
          best = { buf: b, method, lossy };
        }
      } catch { /* metode gagal → lewati */ }
    };
    if (t.gs) await tryOut('ghostscript-ebook', true, (o) => run('gs', ['-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.5', '-dPDFSETTINGS=/ebook', '-dNOPAUSE', '-dQUIET', '-dBATCH', '-dSAFER', `-sOutputFile=${o}`, inPath], { timeout: 300_000 }));
    if (t.qpdf) await tryOut('qpdf-lossless', false, (o) => run('qpdf', ['--object-streams=generate', '--compress-streams=y', '--recompress-flate', '--compression-level=9', '--optimize-images', '--', inPath, o], { timeout: 300_000 }).catch((e) => {
      // qpdf exit code 3 = berhasil dengan peringatan
      if ((e as { code?: number }).code !== 3) throw e;
    }));
    if (opts.aggressive && opts.scanned && t.pdftoppm) {
      await tryOut('raster-jpeg-150', true, async (o) => {
        await run('pdftoppm', ['-r', '150', '-gray', '-jpeg', '-jpegopt', 'quality=60', inPath, join(dir, 'pg')], { timeout: 600_000 });
        const files = (await readdir(dir)).filter((f) => f.startsWith('pg') && f.endsWith('.jpg')).sort();
        const doc = await PDFDocument.create();
        for (const f of files) {
          const img = await doc.embedJpg(await readFile(join(dir, f)));
          const page = doc.addPage([img.width * 72 / 150, img.height * 72 / 150]);
          page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
        }
        await writeFile(o, await doc.save());
      });
    }
    const before = input.length;
    const after = best.buf.length;
    return { buf: best.buf, result: { method: best.method, before, after, ratio: Math.round((1 - after / before) * 1000) / 10, lossy: best.lossy,
      note: best.method === 'none' ? 'File sudah optimal / tidak ada metode yang menghasilkan ukuran lebih kecil' : undefined } };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Teks native per halaman via unpdf. */
export async function nativePdfText(buf: Buffer): Promise<string[]> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: false });
  return (text as string[]).map((x) => x ?? '');
}

/** OCR satu file gambar (PNG/JPG/TIFF). Mengembalikan teks & confidence rata-rata kata. */
export async function ocrImage(path: string, langs: string): Promise<{ text: string; confidence: number | null }> {
  const { stdout } = await run('tesseract', [path, 'stdout', '-l', langs, '--psm', '3', 'tsv'], { maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
  const rows = stdout.split('\n').slice(1).map((l) => l.split('\t')).filter((c) => c.length >= 12);
  const words = rows.filter((c) => c[11]?.trim() && Number(c[10]) >= 0);
  const confidence = words.length ? Math.round((words.reduce((s, c) => s + Number(c[10]), 0) / words.length) * 100) / 100 : null;
  // Rekonstruksi baris dari TSV (block/par/line)
  const lines = new Map<string, string[]>();
  for (const c of words) { const k = `${c[2]}-${c[3]}-${c[4]}`; lines.set(k, [...(lines.get(k) ?? []), c[11]]); }
  return { text: [...lines.values()].map((w) => w.join(' ')).join('\n'), confidence };
}

/** OCR halaman PDF tertentu (1-based) → rasterisasi pdftoppm lalu tesseract. */
export async function ocrPdfPages(buf: Buffer, pages: number[], langs: string, onPage?: (done: number, total: number) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'icop-ocr-'));
  try {
    const inPath = join(dir, 'in.pdf');
    await writeFile(inPath, buf);
    const out: Record<number, { text: string; confidence: number | null }> = {};
    let done = 0;
    for (const p of pages) {
      const prefix = join(dir, `p${p}`);
      await run('pdftoppm', ['-r', String(OCR_DPI), '-gray', '-png', '-f', String(p), '-l', String(p), '-singlefile', inPath, prefix], { timeout: 120_000 });
      out[p] = await ocrImage(`${prefix}.png`, langs);
      await rm(`${prefix}.png`, { force: true });
      done++;
      if (onPage && (done % 5 === 0 || done === pages.length)) await onPage(done, pages.length);
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const fileSize = async (p: string) => (await stat(p)).size;
export { MIN_NATIVE_CHARS };
