'use client';
import { useState } from 'react';
import { api, dt } from '@/lib/api';
import { Badge, ErrorBox, Field, useAction, useApi, useMe } from './ui';

const KINDS = ['PROFILE', 'CERTIFICATION', 'ACCREDITATION', 'VENDOR_AUTHORIZATION', 'PROJECT_REFERENCE', 'PERSONNEL', 'METHODOLOGY'];

/** Satu-satunya sumber klaim perusahaan untuk proposal. Hanya status VERIFIED yang dipakai generator. */
export default function CompanyFacts() {
  const me = useMe();
  const { data, reload } = useApi('/api/v1/company-facts');
  const [f, setF] = useState({ kind: 'CERTIFICATION', title: '', detail: '', validUntil: '', evidenceRef: '' });
  const act = useAction();
  const perms = me?.permissions ?? [];
  return (
    <div className="card">
      <h2>Company facts (sumber klaim proposal)</h2>
      <p className="sub">Generator proposal hanya memakai fakta VERIFIED. Verifikasi oleh Legal/Direktur dengan referensi bukti; pembuat tidak boleh memverifikasi sendiri.</p>
      <ErrorBox error={act.error} />
      <div className="table-wrap"><table className="t"><thead><tr><th>Jenis</th><th>Fakta</th><th>Status</th><th>Bukti</th><th></th></tr></thead><tbody>
        {data?.items.map((x: any) => (
          <tr key={x.id}><td>{x.kind}</td><td><b>{x.title}</b><div className="sub">{x.detail}</div>{x.validUntil && <div className="sub">berlaku s/d {String(x.validUntil).slice(0, 10)}</div>}</td>
            <td><Badge s={x.status} />{x.verifiedByName && <div className="sub">{x.verifiedByName} · {dt(x.verifiedAt)}</div>}</td><td className="sub">{x.evidenceRef ?? '—'}</td>
            <td>{perms.includes('facts.verify') && x.status !== 'VERIFIED' && <button className="btn ok sm" onClick={() => { const ev = window.prompt('Referensi bukti (nomor sertifikat/surat):', x.evidenceRef ?? ''); if (ev) act.run(async () => { await api(`/api/v1/company-facts/${x.id}/verify`, { body: { evidenceRef: ev } }); reload(); }); }}>Verifikasi</button>}</td></tr>))}
      </tbody></table></div>
      {perms.includes('facts.manage') && (
        <details style={{ marginTop: 8 }}><summary>+ Fakta baru</summary>
          <div className="grid g2" style={{ marginTop: 8 }}>
            <Field label="Jenis"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select></Field>
            <Field label="Judul"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
            <Field label="Detail (kalimat yang boleh dikutip di proposal)"><textarea value={f.detail} onChange={(e) => setF({ ...f, detail: e.target.value })} /></Field>
            <Field label="Berlaku s/d"><input type="date" value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} /></Field>
            <Field label="Referensi bukti"><input value={f.evidenceRef} onChange={(e) => setF({ ...f, evidenceRef: e.target.value })} /></Field>
          </div>
          <button className="btn sm" disabled={f.title.length < 3 || f.detail.length < 3 || act.busy} onClick={() => act.run(async () => {
            await api('/api/v1/company-facts', { body: Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '')) }); setF({ ...f, title: '', detail: '' }); reload(); })}>Simpan (UNVERIFIED)</button>
        </details>
      )}
    </div>
  );
}
