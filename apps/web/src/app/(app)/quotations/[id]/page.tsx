'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, dt, idr, newKey } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi, useMe } from '@/components/ui';
import CreateContract from '@/components/CreateContract';
import SendEmail from '@/components/SendEmail';

export default function QuotationPage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const { data: q, error, loading, reload } = useApi(`/api/v1/quotations/${id}`);
  const revs = useApi(`/api/v1/quotations/${id}/revisions`);
  const [edit, setEdit] = useState<any>(null);
  const [doc, setDoc] = useState<string | null>(null);
  const act = useAction();
  useEffect(() => { if (q) setEdit(null); }, [q]);
  if (loading) return <Loading />;
  if (!q) return <ErrorBox error={error} />;
  const perms = me?.permissions ?? [];
  const editable = ['DRAFT', 'REVISION_REQUESTED', 'APPROVED', 'REJECTED'].includes(q.status) && perms.includes('quotation.write');
  const startEdit = () => setEdit({ title: q.title, discountPct: q.discountPct, validityDays: q.validityDays, paymentTerms: q.paymentTerms, deliveryTerms: q.deliveryTerms ?? '', exclusions: q.exclusions ?? '',
    lines: q.lines.map((l: any) => ({ description: l.description, qty: l.qty, unit: l.unit, unitPrice: l.unitPrice })) });
  const saveEdit = () => act.run(async () => {
    const body = { ...edit, rowVersion: q.rowVersion, deliveryTerms: edit.deliveryTerms || undefined, exclusions: edit.exclusions || undefined };
    await api(`/api/v1/quotations/${id}`, { method: 'PUT', body }); reload(); revs.reload();
  });
  const call = (path: string, body: any = {}) => act.run(async () => { await api(`/api/v1/quotations/${id}/${path}`, { body, idempotencyKey: newKey() }); reload(); revs.reload(); });
  const showDoc = () => act.run(async () => setDoc(await api(`/api/v1/quotations/${id}/document`)));
  const subtotal = edit ? edit.lines.reduce((s: number, l: any) => s + Number(l.qty) * Number(l.unitPrice), 0) : 0;

  return (
    <>
      <PageHead crumbs={<><Link href="/quotations">Quotation</Link> / <Link href={`/opportunities/${q.opportunityId}`}>{q.opportunityCode}</Link></>}
        title={`${q.number}${q.revision ? ` Rev.${q.revision}` : ''}`} sub={`${q.customerName} · ${q.title}`} actions={<Badge s={q.status} />} />
      <ErrorBox error={act.error} />
      {q.status === 'APPROVED' && <div className="alert info">Sudah disetujui. Perubahan apa pun akan mengembalikan ke DRAFT dan memerlukan approval ulang.</div>}
      {q.grossMarginPct != null && q.grossMarginPct < 25 && <div className="alert warn">Gross margin {q.grossMarginPct}% di bawah target 25%.</div>}
      <div className="row" style={{ marginBottom: 10 }}>
        {editable && !edit && <button className="btn sec" onClick={startEdit}>Edit</button>}
        {['DRAFT', 'REVISION_REQUESTED'].includes(q.status) && perms.includes('quotation.submit') && !edit && <button className="btn pur" disabled={act.busy} onClick={() => call('submit')}>Ajukan approval</button>}
        {q.status === 'APPROVED' && perms.includes('quotation.submit') && <button className="btn ok" disabled={act.busy} onClick={() => call('issue')}>Terbitkan</button>}
        {q.status === 'ISSUED' && perms.includes('quotation.submit') && <button className="btn pur" disabled={act.busy} onClick={() => call('mark-sent', { channel: 'portal' })}>Kirim ke portal customer</button>}
        <button className="btn sec" onClick={showDoc}>Lihat surat penawaran</button>
        {q.status === 'ACCEPTED' && perms.includes('contract.write') && <CreateContract quotationId={id} value={Number(q.totalBeforeTax)} />}
      </div>

      {['ISSUED', 'SENT'].includes(q.status) && perms.includes('quotation.submit') && <SendEmail quotationId={id} />}

      {edit ? (
        <div className="card">
          <h2>Edit quotation</h2>
          <Field label="Judul"><input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
          <h3>Baris</h3>
          {edit.lines.map((l: any, i: number) => {
            const setL = (p: any) => { const lines = [...edit.lines]; lines[i] = { ...l, ...p }; setEdit({ ...edit, lines }); };
            return (
              <div key={i} className="card" style={{ background: '#fafbfd', padding: 10 }}>
                <Field label="Uraian"><input value={l.description} onChange={(e) => setL({ description: e.target.value })} /></Field>
                <div className="grid g3">
                  <Field label="Qty"><input type="number" min={0.01} step="any" value={l.qty} onChange={(e) => setL({ qty: Number(e.target.value) })} /></Field>
                  <Field label="Satuan"><input value={l.unit} onChange={(e) => setL({ unit: e.target.value })} /></Field>
                  <Field label="Harga satuan"><input type="number" min={0} value={l.unitPrice} onChange={(e) => setL({ unitPrice: Number(e.target.value) })} /></Field>
                </div>
                {edit.lines.length > 1 && <button className="btn bad sm" onClick={() => setEdit({ ...edit, lines: edit.lines.filter((_: any, j: number) => j !== i) })}>Hapus baris</button>}
              </div>
            );
          })}
          <button className="btn sec sm" onClick={() => setEdit({ ...edit, lines: [...edit.lines, { description: '', qty: 1, unit: 'paket', unitPrice: 0 }] })}>+ Baris</button>
          <div className="grid g3" style={{ marginTop: 10 }}>
            <Field label="Diskon (%)"><input type="number" min={0} max={99} step={0.5} value={edit.discountPct} onChange={(e) => setEdit({ ...edit, discountPct: Number(e.target.value) })} /></Field>
            <Field label="Masa berlaku (hari)"><input type="number" min={7} max={180} value={edit.validityDays} onChange={(e) => setEdit({ ...edit, validityDays: Number(e.target.value) })} /></Field>
            <Field label="Termin pembayaran"><input value={edit.paymentTerms} onChange={(e) => setEdit({ ...edit, paymentTerms: e.target.value })} /></Field>
          </div>
          <Field label="Ketentuan pelaksanaan"><textarea value={edit.deliveryTerms} onChange={(e) => setEdit({ ...edit, deliveryTerms: e.target.value })} /></Field>
          <Field label="Pengecualian (exclusions)"><textarea value={edit.exclusions} onChange={(e) => setEdit({ ...edit, exclusions: e.target.value })} /></Field>
          <p>Subtotal {idr(subtotal)} → setelah diskon {idr(subtotal * (1 - edit.discountPct / 100))}</p>
          <div className="row"><button className="btn" disabled={act.busy} onClick={saveEdit}>Simpan</button><button className="btn sec" onClick={() => setEdit(null)}>Batal</button></div>
        </div>
      ) : (
        <div className="grid g2">
          <div className="card">
            <h3>Rincian</h3>
            <div className="quote-desktop-lines"><div className="table-wrap"><table className="t"><thead><tr><th>#</th><th>Uraian</th><th className="r">Qty</th><th className="r">Jumlah</th></tr></thead><tbody>
              {q.lines.map((l: any) => <tr key={l.id}><td>{l.lineNo}</td><td>{l.description}<div className="sub">{idr(l.unitPrice)} / {l.unit}</div></td><td className="r">{l.qty}</td><td className="r">{idr(l.amount)}</td></tr>)}
              <tr><td colSpan={3}>Subtotal</td><td className="r">{idr(q.subtotal)}</td></tr>
              {q.discountPct > 0 && <tr><td colSpan={3}>Diskon {q.discountPct}%</td><td className="r">− {idr(q.discountAmount)}</td></tr>}
              <tr><td colSpan={3}>Total ex-PPN</td><td className="r">{idr(q.totalBeforeTax)}</td></tr>
              <tr><td colSpan={3}>PPN {q.taxRate}%</td><td className="r">{idr(q.taxAmount)}</td></tr>
              <tr><td colSpan={3}><b>Total</b></td><td className="r"><b>{idr(q.grandTotal)}</b></td></tr>
            </tbody></table></div></div>
            <div className="quote-mobile-lines">
              {q.lines.map((l: any) => (
                <article key={l.id} className="quote-mobile-item">
                  <div className="quote-mobile-description">
                    <span className="sub">Item {l.lineNo}</span>
                    <strong>{l.description}</strong>
                  </div>
                  <dl className="quote-mobile-facts">
                    <div><dt>Volume</dt><dd>{l.qty} {l.unit}</dd></div>
                    <div><dt>Harga satuan</dt><dd>{idr(l.unitPrice)}</dd></div>
                  </dl>
                  <div className="quote-mobile-item-total"><span>Jumlah</span><b>{idr(l.amount)}</b></div>
                </article>
              ))}
              <dl className="quote-mobile-summary">
                <div><dt>Subtotal</dt><dd>{idr(q.subtotal)}</dd></div>
                {q.discountPct > 0 && <div><dt>Diskon {q.discountPct}%</dt><dd>− {idr(q.discountAmount)}</dd></div>}
                <div><dt>Total sebelum PPN</dt><dd>{idr(q.totalBeforeTax)}</dd></div>
                <div><dt>PPN {q.taxRate}%</dt><dd>{idr(q.taxAmount)}</dd></div>
                <div className="grand"><dt>Total</dt><dd>{idr(q.grandTotal)}</dd></div>
              </dl>
            </div>
            {q.internalCost != null && <div className="alert info" style={{ marginTop: 8 }}>Internal: biaya {idr(q.internalCost)} · floor {idr(q.floorPrice)} · margin {q.grossMarginPct ?? '—'}%</div>}
          </div>
          <div className="card">
            <h3>Ketentuan</h3>
            <dl className="kv"><dt>Masa berlaku</dt><dd>{q.validityDays} hari</dd><dt>Pembayaran</dt><dd>{q.paymentTerms}</dd>
              <dt>Pelaksanaan</dt><dd>{q.deliveryTerms ?? '—'}</dd><dt>Exclusions</dt><dd>{q.exclusions ?? '—'}</dd>
              <dt>Diterbitkan</dt><dd>{dt(q.issuedAt)} {q.issuedByName ? `· ${q.issuedByName}` : ''}</dd><dt>Dikirim</dt><dd>{dt(q.sentAt)}</dd>
              {q.customerRespondedAt && <><dt>Respons customer</dt><dd>{dt(q.customerRespondedAt)} — {q.customerResponse ?? ''}</dd></>}</dl>
          </div>
          <div className="card">
            <h3>Approval</h3>
            {q.approvals.length ? q.approvals.map((a: any) => (
              <Link key={a.id} href={`/approvals/${a.id}`} className="list-item"><div className="row"><Badge s={a.status} /><span className="sub">{dt(a.createdAt)}</span></div>
                {a.steps?.map((s: any) => <div key={s.seq} className="step"><Badge s={s.status} /> {s.levelLabel} {s.decidedByName ? `· ${s.decidedByName}` : ''}</div>)}</Link>
            )) : <div className="empty">Belum diajukan</div>}
          </div>
          <div className="card">
            <h3>Riwayat revisi</h3>
            {revs.data?.items.map((r: any) => <div key={r.id} className="step"><span className="badge">Rev.{r.revision} v{r.rowVersion}</span> {r.reason}<span className="sub">{dt(r.createdAt)} · {r.byName}</span></div>)}
          </div>
        </div>
      )}
      {doc && (
        <div className="card">
          <div className="row"><h3 style={{ margin: 0 }}>Pratinjau surat penawaran</h3><span className="spacer" />
            <button className="btn sec sm" onClick={() => { const w = window.open('', '_blank'); if (w) { w.document.open(); w.document.write(doc); w.document.close(); } }}>Buka penuh</button>
            <button className="btn sec sm" onClick={() => { const w = window.open('', '_blank'); if (w) { w.document.open(); w.document.write(doc); w.document.close(); w.focus(); w.print(); } }}>Cetak / PDF</button>
            <button className="btn sec sm" onClick={() => setDoc(null)}>Tutup</button></div>
          <p className="sub quote-preview-tip">Pratinjau menyesuaikan lebar layar. Gunakan Cetak / PDF untuk format dokumen A4.</p>
          <iframe className="quote-preview-iframe" title="Surat penawaran" sandbox="allow-same-origin allow-modals" srcDoc={doc} />
        </div>
      )}
    </>
  );
}
