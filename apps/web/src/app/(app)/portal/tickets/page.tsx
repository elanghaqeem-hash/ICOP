'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, dt } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi } from '@/components/ui';

export default function PortalTickets() {
  const { data, error, loading, reload } = useApi('/api/v1/portal/tickets');
  const act = useAction();
  const [f, setF] = useState({ category: 'INCIDENT', priority: 'P3', title: '', description: '' });
  const [msg, setMsg] = useState('');
  return (
    <>
      <PageHead title="Bantuan & insiden" sub="Laporkan insiden atau permintaan layanan; tim DefendIT360 merespons sesuai target SLA" />
      <div className="card">
        <h2>Laporkan</h2>
        <ErrorBox error={act.error} />
        {msg && <div className="alert ok">{msg}</div>}
        <div className="grid g2">
          <Field label="Jenis"><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="INCIDENT">Insiden keamanan</option><option value="SERVICE_REQUEST">Permintaan layanan</option><option value="QUESTION">Pertanyaan</option></select></Field>
          <Field label="Urgensi"><select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}><option value="P1">P1 — kritis, layanan terhenti</option><option value="P2">P2 — tinggi</option><option value="P3">P3 — sedang</option><option value="P4">P4 — rendah</option></select></Field>
        </div>
        <Field label="Judul"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Uraian (kapan, sistem terdampak, gejala)"><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <button className="btn" disabled={act.busy || f.title.length < 5 || f.description.length < 10} onClick={() => act.run(async () => {
          const r = await api('/api/v1/portal/tickets', { body: f }); setMsg(`Tiket ${r.number} dibuat. Target respons: ${dt(r.responseDueAt)}`);
          setF({ ...f, title: '', description: '' }); reload();
        })}>Kirim laporan</button>
      </div>
      <ErrorBox error={error} />
      {loading ? <Loading /> : <div className="card" style={{ padding: 0 }}>
        {data?.items.length ? data.items.map((t: any) => (
          <Link key={t.id} href={`/portal/tickets/${t.id}`} className="list-item">
            <div className="row"><Badge s={t.priority} /><b className="mono">{t.number}</b><span className="spacer" /><Badge s={t.status} /></div>
            <div>{t.title}</div><div className="sub">{t.category} · {dt(t.createdAt)}</div>
          </Link>
        )) : <div className="empty">Belum ada tiket</div>}
      </div>}
    </>
  );
}
