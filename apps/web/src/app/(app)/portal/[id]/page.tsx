'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, idr, newKey } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi } from '@/components/ui';
export default function PortalQuotation() {
  const { id } = useParams<{ id: string }>();
  const { data: q, error, loading, reload } = useApi(`/api/v1/portal/quotations/${id}`);
  const [doc, setDoc] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [ack, setAck] = useState(false);
  const act = useAction();
  if (loading) return <Loading />;
  if (!q) return <ErrorBox error={error} />;
  const respond = (response: string) => act.run(async () => { await api(`/api/v1/portal/quotations/${id}/respond`, { body: { response, note: note || undefined, acknowledgement: response === 'ACCEPT' ? ack : undefined }, idempotencyKey: newKey() }); reload(); });
  return (
    <>
      <PageHead crumbs={<Link href="/portal">Penawaran</Link>} title={`${q.number}${q.revision ? ` Rev.${q.revision}` : ''}`} sub={q.title} actions={<Badge s={q.status} />} />
      <div className="card">
        <div className="table-wrap"><table className="t"><tbody>
          {q.lines.map((l: any) => <tr key={l.id}><td>{l.description}<div className="sub">{l.qty} {l.unit} × {idr(l.unitPrice)}</div></td><td className="r">{idr(l.amount)}</td></tr>)}
          {q.discountPct > 0 && <tr><td>Diskon {q.discountPct}%</td><td className="r">− {idr(q.discountAmount)}</td></tr>}
          <tr><td>PPN {q.taxRate}%</td><td className="r">{idr(q.taxAmount)}</td></tr>
          <tr><td><b>Total</b></td><td className="r"><b>{idr(q.grandTotal)}</b></td></tr></tbody></table></div>
        <p className="sub" style={{ marginTop: 6 }}>Berlaku {q.validityDays} hari · Termin: {q.paymentTerms}</p>
        <button className="btn sec sm" onClick={() => act.run(async () => setDoc(await api(`/api/v1/portal/quotations/${id}/document`)))}>Lihat surat penawaran</button>
      </div>
      {doc && <iframe title="Surat penawaran" sandbox="allow-same-origin" srcDoc={doc} style={{ width: '100%', height: 600, border: '1px solid var(--line)', borderRadius: 8, background: '#fff' }} />}
      {q.status === 'SENT' && (
        <div className="card">
          <h2>Respons Anda</h2>
          <ErrorBox error={act.error} />
          <Field label="Catatan"><textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <label className="check" style={{ marginBottom: 10 }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            Saya berwenang menerima penawaran ini atas nama perusahaan. Saya memahami ini adalah penerimaan komersial, bukan tanda tangan elektronik tersertifikasi; kontrak akan ditandatangani terpisah.</label>
          <div className="row">
            <button className="btn ok" disabled={!ack || act.busy} onClick={() => respond('ACCEPT')}>Terima penawaran</button>
            <button className="btn sec" disabled={act.busy} onClick={() => respond('REQUEST_REVISION')}>Minta revisi</button>
            <button className="btn bad" disabled={act.busy} onClick={() => respond('REJECT')}>Tolak</button>
          </div>
        </div>
      )}
    </>
  );
}
