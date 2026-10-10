'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError, dt, idr, newKey } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi, useMe } from '@/components/ui';

export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const canWrite = !!me?.permissions.includes('billing.write');
  const canApprove = !!me?.permissions.includes('billing.approve');
  const { data, error, loading, reload } = useApi(`/api/v1/invoices/${id}`);
  const act = useAction();
  const [pay, setPay] = useState({ amount: '', paidOn: new Date().toISOString().slice(0, 10), reference: '' });
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');
  const [cn, setCn] = useState({ amount: '', reason: '' });
  const [approvalPending, setApprovalPending] = useState<{ id: string; decision: 'APPROVE' | 'REJECT' } | null>(null);
  const [otp, setOtp] = useState('');
  const makeCreditNote = () => act.run(async () => {
    await api(`/api/v1/invoices/${id}/credit-notes`, {
      body: { amount: Number(cn.amount), reason: cn.reason },
    });
    setCn({ amount: '', reason: '' });
    setMsg('Draft nota kredit diajukan. Persetujuan pihak lain diperlukan.');
    reload();
  });
  const decideCn = (creditId: string, decision: 'APPROVE' | 'REJECT') => act.run(async () => {
    try {
      const result = await api(`/api/v1/credit-notes/${creditId}/decide`, { body: { decision } });
      setApprovalPending(null); setOtp('');
      setMsg(decision === 'APPROVE' ? `Nota kredit ${result.number} terbit. Refund: ${idr(result.refundDue)}.` : 'Nota kredit ditolak');
      reload();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'MFA_STEP_UP_REQUIRED') {
        setApprovalPending({ id: creditId, decision });
        return;
      }
      throw error;
    }
  });
  const stepUpAndDecide = () => act.run(async () => {
    if (!approvalPending || !/^[0-9]{6}$/.test(otp)) return;
    await api('/api/v1/auth/mfa/step-up', { body: { code: otp } });
    const result = await api(`/api/v1/credit-notes/${approvalPending.id}/decide`, {
      body: { decision: approvalPending.decision },
    });
    setMsg(`Keputusan tercatat untuk nota kredit ${result.number ?? ''}`);
    setOtp(''); setApprovalPending(null); reload();
  });
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
          {Number(inv.creditedTotal) > 0 && <><dt>Nota kredit diterbitkan</dt><dd>{idr(inv.creditedTotal)}</dd></>}
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
      <div className="card">
        <h2>Nota kredit</h2>
        <p className="sub">Koreksi DPP dan PPN. Pembuat tidak boleh menyetujui nota kreditnya sendiri. Kelebihan kredit dari sisa tagihan dicatat sebagai kewajiban pengembalian dana.</p>
        <div className="table-wrap"><table className="t">
          <thead><tr><th>Nomor / alasan</th><th>DPP</th><th>PPN</th><th>Total</th><th>Refund</th><th>Status</th><th>Keputusan</th></tr></thead>
          <tbody>
            {(data.creditNotes ?? []).map((note: any) => <tr key={note.id}>
              <td>{note.number ?? 'Draft'}<div className="sub">{note.reason}</div></td>
              <td>{idr(note.amount)}</td><td>{idr(note.tax)}</td><td>{idr(note.total)}</td>
              <td>{Number(note.refundDue) ? idr(note.refundDue) : '—'}</td>
              <td><Badge s={note.status}/></td>
              <td>{note.status === 'DRAFT' && canApprove && note.createdBy !== me?.id
                ? <div className="row">
                    <button type="button" className="btn ok sm" disabled={act.busy} onClick={() => decideCn(note.id,'APPROVE')}>Setujui</button>
                    <button type="button" className="btn bad sm" disabled={act.busy} onClick={() => decideCn(note.id,'REJECT')}>Tolak</button>
                  </div> : '—'}</td>
            </tr>)}
            {!data.creditNotes?.length && <tr><td colSpan={7} className="empty">Belum ada nota kredit.</td></tr>}
          </tbody>
        </table></div>
        {approvalPending && <div className="alert warn">
          <strong>MFA tambahan diperlukan</strong>
          <p>Masukkan kode autentikator baru untuk keputusan {approvalPending.decision}.</p>
          <Field label="Kode enam digit"><input inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
            value={otp} onChange={(e) => setOtp(e.target.value.replace(/[^0-9]/g, '').slice(0,6))}/></Field>
          <div className="row">
            <button className="btn" disabled={act.busy || otp.length !== 6} onClick={stepUpAndDecide}>Verifikasi & putuskan</button>
            <button className="btn sec" onClick={() => { setApprovalPending(null); setOtp(''); }}>Batal</button>
          </div>
        </div>}
        {canWrite && inv.status !== 'VOID' && <div className="grid g3">
          <Field label={`DPP dikreditkan (Rp, PPN ${inv.taxRate}%)`}>
            <input type="number" min={1} value={cn.amount} onChange={(e) => setCn({ ...cn, amount: e.target.value })}/>
          </Field>
          <Field label="Alasan koreksi (minimal 10 karakter)">
            <input value={cn.reason} onChange={(e) => setCn({ ...cn, reason: e.target.value })}/>
          </Field>
          <div style={{ alignSelf: 'end' }}>
            <button className="btn" disabled={act.busy || !Number(cn.amount) || cn.reason.trim().length < 10}
              onClick={makeCreditNote}>Ajukan draft nota kredit</button>
          </div>
        </div>}
      </div>
      {canWrite && inv.status !== 'VOID' && Number(inv.paidTotal) === 0 && Number(inv.creditedTotal) === 0 && (
        <div className="card">
          <h2>Batalkan invoice</h2>
          <Field label="Alasan (min. 10 karakter)"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <button className="btn bad" disabled={act.busy || reason.length < 10} onClick={() => { if (window.confirm('Batalkan invoice ini?')) voidInv(); }}>Batalkan invoice</button>
        </div>
      )}
    </>
  );
}
