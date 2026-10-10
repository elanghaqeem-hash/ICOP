'use client';
import { useState } from 'react';
import { api, idr, newKey } from '@/lib/api';
import { ErrorBox, Field, useAction } from './ui';

const plusMonths = (m: number) => { const d = new Date(); d.setMonth(d.getMonth() + m); return d.toISOString().slice(0, 10); };

/** Buat kontrak dari quotation ACCEPTED (PROJECT / MANAGED_SERVICE / FLEXGUARD / LICENSE). */
export default function CreateContract({ quotationId, value }: { quotationId: string; value: number }) {
  const act = useAction();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ contractType: 'PROJECT', startDate: new Date().toISOString().slice(0, 10), endDate: plusMonths(12), slaTerms: '', tokens: '', pricePerToken: '' });
  if (!open) return <button className="btn ok" onClick={() => setOpen(true)}>Buat kontrak</button>;
  const fg = f.contractType === 'FLEXGUARD';
  const submit = () => act.run(async () => {
    const body: any = { contractType: f.contractType, startDate: f.startDate, endDate: f.endDate, slaTerms: f.slaTerms || undefined };
    if (fg) body.flexguard = { tokens: Number(f.tokens), pricePerToken: Number(f.pricePerToken) };
    const c = await api(`/api/v1/contracts/from-quotation/${quotationId}`, { body, idempotencyKey: newKey() });
    window.location.href = `/contracts/${c.id}`;
  });
  return (
    <div className="card" style={{ width: '100%' }}>
      <h2>Buat kontrak</h2>
      <p className="sub">Nilai mengikuti quotation ({idr(value)}). Jadwal pembayaran dibentuk dari termin quotation.</p>
      <ErrorBox error={act.error} />
      <div className="grid g3">
        <Field label="Jenis"><select value={f.contractType} onChange={(e) => setF({ ...f, contractType: e.target.value })}>
          <option value="PROJECT">Proyek</option><option value="MANAGED_SERVICE">Managed service (MRC)</option><option value="FLEXGUARD">FlexGuard token</option><option value="LICENSE">Lisensi</option></select></Field>
        <Field label="Mulai"><input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
        <Field label="Selesai"><input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
        {fg && <Field label="Jumlah token"><input type="number" value={f.tokens} onChange={(e) => setF({ ...f, tokens: e.target.value })} /></Field>}
        {fg && <Field label="Harga/token"><input type="number" value={f.pricePerToken} onChange={(e) => setF({ ...f, pricePerToken: e.target.value })} /></Field>}
      </div>
      {fg && f.tokens && f.pricePerToken && Math.abs(Number(f.tokens) * Number(f.pricePerToken) - value) > 1 && <div className="alert warn">Token × harga = {idr(Number(f.tokens) * Number(f.pricePerToken))} harus sama dengan nilai quotation.</div>}
      <Field label="SLA (opsional)"><textarea value={f.slaTerms} onChange={(e) => setF({ ...f, slaTerms: e.target.value })} /></Field>
      <div className="row"><button className="btn" disabled={act.busy} onClick={submit}>Buat draft kontrak</button><button className="btn sec" onClick={() => setOpen(false)}>Batal</button></div>
    </div>
  );
}
