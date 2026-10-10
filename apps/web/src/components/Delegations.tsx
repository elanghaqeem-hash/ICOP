'use client';
import { useState } from 'react';
import { api, dt } from '@/lib/api';
import { ErrorBox, Field, useAction, useApi, useMe } from './ui';

export default function Delegations() {
  const me = useMe();
  const { data, reload } = useApi('/api/v1/approvals/delegations');
  const auth = useApi('/api/v1/approvals/my-authority');
  const users = useApi('/api/v1/users');
  const [f, setF] = useState({ delegateId: '', days: 7, reason: '' });
  const act = useAction();
  const own = ({ sales_manager: 1, vp_head: 2, director: 3 } as Record<string, number>)[me?.role ?? ''] ?? 0;
  return (
    <div className="card">
      <h2>Delegasi kewenangan</h2>
      <p className="sub">Level efektif Anda: {['—', 'Manager', 'VP/Head', 'Direktur'][auth.data?.level ?? 0]}{auth.data?.delegationId ? ' (melalui delegasi)' : ''}. Delegasi maks. 30 hari, tidak melebihi level sendiri, tercatat di bukti keputusan.</p>
      <ErrorBox error={act.error} />
      {data?.items.length ? data.items.map((d: any) => (
        <div key={d.id} className="step"><span className={`badge ${d.active ? 'ok' : ''}`}>{d.active ? 'aktif' : d.revokedAt ? 'dicabut' : 'tidak aktif'}</span>
          {d.delegatorName} → <b>{d.delegateName}</b> · level {d.level} · {dt(d.validFrom)} – {dt(d.validUntil)} · {d.reason}
          {d.active && d.delegatorId === me?.id && <button className="btn bad sm" onClick={() => act.run(async () => { await api(`/api/v1/approvals/delegations/${d.id}/revoke`, { body: {} }); reload(); })}>Cabut</button>}</div>
      )) : <div className="empty">Belum ada delegasi</div>}
      {own > 0 && (
        <div className="grid g3" style={{ marginTop: 8 }}>
          <Field label="Delegasikan ke"><select value={f.delegateId} onChange={(e) => setF({ ...f, delegateId: e.target.value })}><option value="">—</option>
            {users.data?.items.filter((u: any) => u.id !== me?.id).map((u: any) => <option key={u.id} value={u.id}>{u.fullName} ({u.role.replace(/_/g, ' ')})</option>)}</select></Field>
          <Field label="Durasi (hari, maks 30)"><input type="number" min={1} max={30} value={f.days} onChange={(e) => setF({ ...f, days: Number(e.target.value) })} /></Field>
          <Field label="Alasan"><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
          <button className="btn sm" disabled={!f.delegateId || f.reason.length < 5 || act.busy} onClick={() => act.run(async () => {
            await api('/api/v1/approvals/delegations', { body: { delegateId: f.delegateId, validFrom: new Date().toISOString(), validUntil: new Date(Date.now() + f.days * 864e5).toISOString(), reason: f.reason } });
            setF({ ...f, reason: '' }); reload(); })}>Buat delegasi</button>
        </div>
      )}
    </div>
  );
}
