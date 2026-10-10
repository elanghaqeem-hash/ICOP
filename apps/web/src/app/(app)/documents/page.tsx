'use client';
import Link from 'next/link';
import { useState } from 'react';
import { apiUpload, dt } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi, useMe } from '@/components/ui';

const mb = (n: number | null) => (n == null ? '—' : `${(n / 1048576).toFixed(n < 1048576 ? 2 : 1)} MB`);

export default function Documents() {
  const me = useMe();
  const [q, setQ] = useState('');
  const { data, error, loading, reload } = useApi(`/api/v1/documents?q=${encodeURIComponent(q)}`, [q]);
  const cap = useApi('/api/v1/documents/capabilities');
  const [file, setFile] = useState<File | null>(null);
  const [f, setF] = useState({ title: '', confidentiality: 'INTERNAL', compress: 'auto', ocr: 'auto' });
  const act = useAction();
  const max = cap.data?.maxMb ?? 50;
  const tooBig = !!file && file.size > max * 1048576;
  const upload = () => act.run(async () => {
    const fd = new FormData();
    if (f.title) fd.append('title', f.title);
    fd.append('confidentiality', f.confidentiality); fd.append('compress', f.compress); fd.append('ocr', f.ocr); fd.append('file', file!);
    await apiUpload('/api/v1/documents', fd); setFile(null); setF({ ...f, title: '' }); reload();
  });
  return (
    <>
      <PageHead title="Document Center" sub={`OCR, kompresi, dan analisis AI · maks ${cap.data?.maxPages ?? 300} halaman / ${max} MB`} />
      {me?.permissions.includes('documents.write') && (
        <div className="card">
          <h2>Unggah dokumen</h2>
          <ErrorBox error={act.error} />
          {cap.data && <p className="sub">OCR: {cap.data.ocr ? `aktif (${cap.data.ocrLanguages.join(', ')})` : 'tidak tersedia di server'} · kompresi: {[cap.data.compression.ghostscript && 'Ghostscript', cap.data.compression.qpdf && 'qpdf', cap.data.compression.raster && 'raster'].filter(Boolean).join(', ') || '—'}</p>}
          <div className="grid g2">
            <Field label={`File (${cap.data?.accepted?.join(', ') ?? 'PDF, DOCX, TXT, gambar'})`}><input type="file" accept=".pdf,.docx,.txt,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
            <Field label="Judul (opsional)"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
            <Field label="Kerahasiaan"><select value={f.confidentiality} onChange={(e) => setF({ ...f, confidentiality: e.target.value })}>
              <option value="INTERNAL">Internal</option><option value="CONFIDENTIAL">Confidential</option><option value="RESTRICTED">Restricted (tidak dikirim ke AI)</option></select></Field>
            <Field label="Kompresi"><select value={f.compress} onChange={(e) => setF({ ...f, compress: e.target.value })}>
              <option value="auto">Otomatis (lossless bila memungkinkan)</option><option value="aggressive">Agresif (scan → JPEG 150 dpi)</option><option value="none">Tanpa kompresi</option></select></Field>
            <Field label="OCR"><select value={f.ocr} onChange={(e) => setF({ ...f, ocr: e.target.value })}>
              <option value="auto">Otomatis (halaman tanpa teks)</option><option value="force">Paksa semua halaman</option><option value="off">Nonaktif</option></select></Field>
          </div>
          {tooBig && <div className="alert bad">Ukuran {mb(file!.size)} melebihi batas {max} MB</div>}
          <button className="btn" disabled={!file || tooBig || act.busy} onClick={upload}>{act.busy ? 'Mengunggah…' : 'Unggah & proses'}</button>
        </div>
      )}
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: 10 }}><input placeholder="Cari judul atau isi dokumen (termasuk hasil OCR)…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Cari dokumen" /></div>
        <ErrorBox error={error} />
        {loading ? <div style={{ padding: 10 }}><Loading /></div> : data?.items.length ? data.items.map((d: any) => (
          <Link key={d.id} href={`/documents/${d.id}`} className="list-item">
            <div className="row"><b>{d.title}</b><span className="spacer" /><Badge s={d.status} /></div>
            <div className="sub">{d.kind.toUpperCase()} · {d.pageCount ?? '—'} hal. · {mb(d.sizeOriginal)}{d.sizeStored && d.sizeStored < d.sizeOriginal ? ` → ${mb(d.sizeStored)} (−${d.compression?.ratio}%)` : ''}
              {d.textSource ? ` · teks ${d.textSource}` : ''}{d.ocrPages ? ` · OCR ${d.ocrPages} hal.` : ''} · {d.confidentiality} · {d.uploadedByName} · {dt(d.createdAt)}</div>
          </Link>)) : <div className="empty">Belum ada dokumen</div>}
      </div>
    </>
  );
}
