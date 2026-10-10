'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { ErrorBox, Field, useAction } from './ui';

/** Kirim surat penawaran (quotation terbit) ke alamat customer via SMTP tenant. */
export default function SendEmail({ quotationId }: { quotationId: string }) {
  const act = useAction();
  const [to, setTo] = useState('');
  const [msg, setMsg] = useState('');
  const emails = to.split(/[,;\s]+/).filter(Boolean);
  const send = () => act.run(async () => {
    const r = await api(`/api/v1/quotations/${quotationId}/send-email`, { body: { to: emails } });
    setMsg(`Surat terkirim ke ${r.accepted.length} alamat`); setTo('');
  });
  return (
    <div className="card">
      <h2>Kirim surat penawaran via email</h2>
      <p className="sub">Surat dikirim dari email perusahaan (SMTP tenant). Biaya & margin internal tidak disertakan.</p>
      <ErrorBox error={act.error} />
      {msg && <div className="alert ok">{msg}</div>}
      <Field label="Alamat tujuan (pisahkan dengan koma)"><input value={to} onChange={(e) => setTo(e.target.value)} placeholder="pic@customer.co.id" /></Field>
      <button className="btn pur" disabled={act.busy || emails.length === 0} onClick={send}>Kirim email</button>
    </div>
  );
}
