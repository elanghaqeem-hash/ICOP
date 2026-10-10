'use client';
import { useEffect, useState } from 'react';
import { api, dt } from '@/lib/api';
import { ErrorBox, Field, Loading, useAction, useApi } from './ui';

/** Konfigurasi SMTP tenant (password terenkripsi; hanya company admin). */
export default function SmtpSettings() {
  const cfg = useApi('/api/v1/integrations/smtp');
  const act = useAction();
  const [f, setF] = useState<any>(null);
  const [pw, setPw] = useState('');
  const [testTo, setTestTo] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (!cfg.data) return;
    // Pertahankan isian yang sedang diedit; sinkronkan status tersimpan (configured, password tersimpan, waktu ubah)
    setF((prev: any) => (prev ? { ...prev, configured: cfg.data.configured, passwordMasked: cfg.data.passwordMasked, updatedAt: cfg.data.updatedAt } : { ...cfg.data, port: cfg.data.port || 587 }));
  }, [cfg.data]);
  if (cfg.loading || !f) return <div className="card"><Loading /></div>;
  const save = () => act.run(async () => {
    const body: any = { enabled: f.enabled, host: f.host, port: Number(f.port), secure: f.secure, username: f.username || null, fromName: f.fromName, fromEmail: f.fromEmail };
    if (pw) body.password = pw;
    await api('/api/v1/integrations/smtp', { method: 'PUT', body });
    setPw(''); setMsg('Konfigurasi SMTP tersimpan'); cfg.reload();
  });
  const test = () => act.run(async () => {
    const r = await api('/api/v1/integrations/smtp/test', { body: { to: testTo } });
    setMsg(`Email uji terkirim ke ${testTo} (messageId ${r.messageId || 'diterima server SMTP'})`);
  });
  return (
    <div className="card">
      <h2>Email (SMTP)</h2>
      <p className="sub">Dipakai untuk mengirim surat penawaran ke customer dan notifikasi. Password disimpan terenkripsi dan tidak pernah ditampilkan ulang.
        {f.updatedAt ? ` Terakhir diubah ${dt(f.updatedAt)}.` : ''}</p>
      <ErrorBox error={act.error} />
      {msg && <div className="alert ok">{msg}</div>}
      <label className="check" style={{ padding: '6px 0', fontWeight: 600 }}><input type="checkbox" checked={!!f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Aktifkan pengiriman email</label>
      <div className="grid g2">
        <Field label="Host SMTP"><input value={f.host ?? ''} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="smtp.office365.com" /></Field>
        <Field label="Port"><input type="number" value={f.port ?? 587} onChange={(e) => setF({ ...f, port: e.target.value })} /></Field>
        <Field label="Username"><input value={f.username ?? ''} onChange={(e) => setF({ ...f, username: e.target.value })} autoComplete="off" /></Field>
        <Field label={`Password ${f.passwordMasked ? `(tersimpan ${f.passwordMasked})` : ''}`}><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={f.passwordMasked ? 'Kosongkan bila tidak diganti' : 'Password SMTP'} autoComplete="new-password" /></Field>
        <Field label="Nama pengirim"><input value={f.fromName ?? ''} onChange={(e) => setF({ ...f, fromName: e.target.value })} /></Field>
        <Field label="Email pengirim"><input type="email" value={f.fromEmail ?? ''} onChange={(e) => setF({ ...f, fromEmail: e.target.value })} /></Field>
      </div>
      <label className="check" style={{ padding: '4px 0' }}><input type="checkbox" checked={!!f.secure} onChange={(e) => setF({ ...f, secure: e.target.checked })} /> SMTPS langsung (port 465). Nonaktif = STARTTLS bila tersedia</label>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn" disabled={act.busy || !f.host || !f.fromEmail} onClick={save}>Simpan</button>
      </div>
      <Field label="Uji koneksi — kirim email uji ke"><input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="admin@perusahaan.co.id" /></Field>
      <button className="btn sec" disabled={act.busy || !f.configured || !testTo.includes('@')} onClick={test}>Kirim email uji</button>
    </div>
  );
}
