import { PDFDocument, StandardFonts } from 'pdf-lib';

export const RKS_PAGES = [
  ['RENCANA KERJA DAN SYARAT-SYARAT (RKS)', 'Pengadaan Jasa Managed SOC dan Penetration Test 2026', '', 'A. PERSYARATAN ADMINISTRASI',
    '1. Peserta wajib melampirkan NIB dan NPWP perusahaan yang masih berlaku.',
    '2. Peserta harus menyampaikan Surat Penawaran yang ditandatangani direktur dan bermaterai.',
    '3. Peserta wajib menyerahkan Jaminan Penawaran sebesar 3% dari nilai HPS.'],
  ['B. PERSYARATAN KUALIFIKASI', '4. Peserta wajib memiliki sertifikat ISO/IEC 27001 yang masih berlaku.',
    '5. Tenaga ahli minimal memiliki sertifikasi OSCP atau CEH dengan pengalaman 3 tahun.',
    '6. Peserta harus memiliki pengalaman pekerjaan sejenis minimal 2 kontrak dalam 4 tahun terakhir.', '',
    'C. PERSYARATAN TEKNIS', '7. Penyedia harus menyediakan layanan monitoring SOC 24x7 dengan SLA respons P1 maksimal 30 menit.',
    '8. Penyedia wajib melakukan penetration test terhadap 5 aplikasi web dan menyampaikan laporan akhir.',
    '9. Penyedia dapat menyediakan dashboard pemantauan berbasis web sebagai nilai tambah.', '',
    'D. PERSYARATAN KOMERSIAL', '10. Harga penawaran tidak boleh melebihi HPS dan sudah termasuk PPN.'],
];

export async function makeRksPdf(pages = RKS_PAGES): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([595, 842]);
    lines.forEach((l, i) => page.drawText(l, { x: 40, y: 800 - i * 18, size: 9, font }));
  }
  return Buffer.from(await doc.save());
}

export async function makeScannedPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}

export function multipart(fields: Record<string, string>, file: { name: string; filename: string; content: Buffer; type: string }) {
  const boundary = '----icopTest' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(file.content, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** PDF "hasil scan": halaman berupa gambar (tanpa layer teks) dari RKS demo — untuk menguji OCR nyata. */
export async function makeImageOnlyPdf(): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'icop-scan-'));
  try {
    writeFileSync(join(dir, 'src.pdf'), await makeRksPdf());
    execFileSync('pdftoppm', ['-r', '150', '-png', join(dir, 'src.pdf'), join(dir, 'pg')]);
    const doc = await PDFDocument.create();
    for (const f of readdirSync(dir).filter((x) => x.startsWith('pg') && x.endsWith('.png')).sort()) {
      const img = await doc.embedPng(readFileSync(join(dir, f)));
      const page = doc.addPage([595, 842]);
      page.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
    }
    return Buffer.from(await doc.save());
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function makeBlankPdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}
