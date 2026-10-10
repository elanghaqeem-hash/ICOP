'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { apiUpload, dt, idr } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi } from '@/components/ui';

export default function PortalContract() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useApi(`/api/v1/portal/contracts/${id}`);
  const act = useAction();
  const [f, setF] = useState<{ file: File | null; signerName: string; signerTitle: string }>({ file: null, signerName: '', signerTitle: '' });
  const [msg, setMsg] = useState('');
  if (loading || !data) return <><ErrorBox error={error} /><Loading /></>;
  const c = data.contract;
  const customerSigned = data.signatures.some((s: any) => s.party === 'CUSTOMER' && ['SIGNED', 'VERIFIED'].includes(s.status));
  return (
    <>
      <PageHead title={c.number} crumbs={<Link href="/portal/contracts">Kontrak</Link>} sub={c.title} actions={<Badge s={c.status} />} />
      <ErrorBox error={act.error} />
      {msg && <div className="alert ok">{msg}</div>}
      <div className="card">
        <dl className="kv">
          <dt>Nilai</dt><dd>{idr(c.value)} + PPN {Number(c.taxRate)}%</dd>
          <dt>Periode</dt><dd>{String(c.startDate).slice(0, 10)} s/d {String(c.endDate).slice(0, 10)}</dd>
          <dt>Termin</dt><dd>{c.paymentTerms}</dd>
          <dt>SLA</dt><dd>{c.slaTerms ?? '—'}</dd>
          <dt>Denda</dt><dd>{c.penaltyTerms ?? '—'}</dd>
        </dl>
      </div>
      <div className="card"><h2>Jadwal</h2>
        {data.obligations.map((o: any, i: number) => <div key={i} className="row sub" style={{ padding: '3px 0' }}><span>{o.description}</span><span className="spacer" />{o.dueDate ? String(o.dueDate).slice(0, 10) : ''} {o.amount ? idr(o.amount) : ''}</div>)}
      </div>
      <div className="card"><h2>Tanda tangan</h2>
        {data.signatures.length ? data.signatures.map((s: any, i: number) => <div key={i} className="row" style={{ padding: '3px 0' }}><b>{s.party === 'INTERNAL' ? 'DefendIT360' : 'Customer'}</b><span className="sub">{s.signerName} · {dt(s.signedAt)}</span><span className="spacer" /><Badge s={s.status} /></div>) : <div className="empty">Belum ada</div>}
        {c.status === 'PENDING_SIGNATURE' && !customerSigned && (
          <div style={{ marginTop: 10 }}>
            <h3>Unggah kontrak bertanda tangan</h3>
            <p className="sub">PDF/scan kontrak yang telah ditandatangani pejabat berwenang Anda. Akan diverifikasi tim Legal kami.</p>
            <div className="grid g2">
              <Field label="Nama penandatangan"><input value={f.signerName} onChange={(e) => setF({ ...f, signerName: e.target.value })} /></Field>
              <Field label="Jabatan"><input value={f.signerTitle} onChange={(e) => setF({ ...f, signerTitle: e.target.value })} /></Field>
            </div>
            <Field label="File (maks 50 MB)"><input type="file" accept="application/pdf,image/*" onChange={(e) => setF({ ...f, file: e.target.files?.[0] ?? null })} /></Field>
            <button className="btn" disabled={act.busy || !f.file || f.signerName.length < 2} onClick={() => act.run(async () => {
              if (f.file!.size > 50 * 1024 * 1024) throw new Error('Ukuran file melebihi 50 MB');
              const fd = new FormData(); fd.append('signerName', f.signerName); if (f.signerTitle) fd.append('signerTitle', f.signerTitle); fd.append('file', f.file!);
              await apiUpload(`/api/v1/portal/contracts/${id}/signed-upload`, fd); setMsg('Terima kasih. Dokumen diterima dan sedang diverifikasi.'); reload();
            })}>Unggah</button>
          </div>
        )}
      </div>
    </>
  );
}
