'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, dt, idr, newKey } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi, useMe } from '@/components/ui';

export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const canWrite = !!me?.permissions.includes('billing.write');
  const { data, error, loading, reload } = useApi(`/api/v1/invoices/${id}`);
  const act = useAction();
  const [pay, setPay] = useState({ amount: '', paidOn: new Date().toISOString().slice(0, 10), reference: '' });
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');
  if (loading || !data) return <><ErrorBox error={error} /><Loading /></>;
  const inv = data.invoice;
  const open = ['ISSUED', 'PARTIAL'].includes(inv.status);
  const payment = () => act.run(async () => {
    const r = await api(`/api/v1/invoices/${id}/payments`, { body: { amount: Number(pay.amount), paidOn: pay.paidOn, reference: pay.reference }, idempotencyKey: newKey() });
    setMsg(`Pembayaran tercatat. Status: ${r.status}`); setPay({ ...pay, amount: '', reference: '' }); reload();
  });
  const voidInv = () => act.run(async () => { await api(`/api/v1/invoices/${id}/void`, { body: { reason } }); setMsg('Invoice dibatalkan'); reload(); });
  return (
    <>
      <PageHead title={inv.number} crumbs={<Link href="/billing">Tagihan</Link>} sub={<>{inv.customerName} · {inv.projectCode} · kontrak {inv.contractNumber}</>} actions={<Badge s={inv.effectiveStatus} />} />
      <ErrorBox error={act.error} />
      {msg && <div className="alert ok">{msg}</div>}
      <div className="card">
        <dl className="kv">
          <dt>Deskripsi</dt><dd>{inv.description}</dd>
          <dt>Nilai</dt><dd>{idr(inv.amount)}</dd>
          <dt>PPN {Number(inv.taxRate)}%</dt><dd>{idr(inv.tax)}</dd>
          <dt>Total</dt><dd><b>{idr(inv.total)}</b></dd>
          <dt>Terbayar / sisa</dt><dd>{idr(inv.paidTotal)} / <b>{idr(inv.outstanding)}</b></dd>
          <dt>Tanggal terbit</dt><dd>{String(inv.issueDate).slice(0, 10)}</dd>
          <dt>Jatuh tempo</dt><dd>{String(inv.dueDate).slice(0, 10)}</dd>
          <dt>Dibuat oleh</dt><dd>{inv.createdByName ?? '—'} · {dt(inv.createdAt)}</dd>
          {inv.voidReason && <><dt>Alasan batal</dt><dd>{inv.voidReason}</dd></>}
        </dl>
      </div>
      <div className="card">
        <h2>Riwayat pembayaran</h2>
        <div className="table-wrap"><table className="t"><thead><tr><th>Tanggal</th><th>Referensi</th><th className="r">Jumlah</th><th>Dicatat</th></tr></thead>
          <tbody>{data.payments.map((p: any) => <tr key={p.id}><td>{String(p.paidOn).slice(0, 10)}</td><td>{p.reference}</td><td className="r">{idr(p.amount)}</td><td className="sub">{p.recordedByName}</td></tr>)}
            {!data.payments.length && <tr><td colSpan={4} className="empty">Belum ada pembayaran</td></tr>}</tbody></table></div>
      </div>
      {canWrite && open && (
        <div className="card">
          <h2>Catat pembayaran</h2>
          <p className="sub">Riwayat pembayaran tidak dapat diubah. Koreksi dilakukan dengan nota koreksi.</p>
          <div className="grid g3">
            <Field label="Jumlah (Rp)"><input type="number" min={1} value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></Field>
            <Field label="Tanggal bayar"><input type="date" value={pay.paidOn} onChange={(e) => setPay({ ...pay, paidOn: e.target.value })} /></Field>
            <Field label="Referensi (no. transfer / mutasi)"><input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></Field>
          </div>
          <button className="btn ok" disabled={act.busy || !pay.amount || pay.reference.length < 3} onClick={payment}>Simpan pembayaran</button>
        </div>
      )}
      {canWrite && inv.status !== 'VOID' && Number(inv.paidTotal) === 0 && (
        <div className="card">
          <h2>Batalkan invoice</h2>
          <Field label="Alasan (min. 10 karakter)"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <button className="btn bad" disabled={act.busy || reason.length < 10} onClick={() => { if (window.confirm('Batalkan invoice ini?')) voidInv(); }}>Batalkan invoice</button>
        </div>
      )}
    </>
  );
}
