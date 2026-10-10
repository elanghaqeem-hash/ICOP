'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, dt } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi, useMe } from '@/components/ui';

const sla = (t: any) => t.responseBreached || t.resolutionBreached ? <span className="badge bad">SLA terlewati</span>
  : t.minutesToResolution !== null && t.minutesToResolution < 60 ? <span className="badge warn">{Math.max(0, t.minutesToResolution)} mnt lagi</span> : null;

export default function Helpdesk() {
  const me = useMe();
  const [filter, setFilter] = useState({ open: true, priority: '', mine: false });
  const qs = new URLSearchParams({ ...(filter.open ? { open: 'true' } : {}), ...(filter.priority ? { priority: filter.priority } : {}), ...(filter.mine ? { mine: 'true' } : {}) }).toString();
  const list = useApi(`/api/v1/tickets${qs ? `?${qs}` : ''}`, [qs]);
  const customers = useApi(me?.permissions.includes('helpdesk.work') ? '/api/v1/customers?limit=100' : null);
  const act = useAction();
  const [f, setF] = useState({ customerId: '', category: 'INCIDENT', priority: 'P3', title: '', description: '' });
  const [show, setShow] = useState(false);
  return (
    <>
      <PageHead title="Helpdesk" sub="Tiket insiden, permintaan layanan & temuan VAPT dengan target SLA" actions={me?.permissions.includes('helpdesk.work') && <button className="btn" onClick={() => setShow(!show)}>+ Tiket</button>} />
      {list.data && <div className="grid g3" style={{ marginBottom: 10 }}>
        <div className="card kpi"><div className="l">Tiket terbuka</div><div className="v">{list.data.summary.open}</div></div>
        <div className="card kpi"><div className="l">SLA terlewati</div><div className="v" style={{ color: list.data.summary.breached ? '#b42318' : undefined }}>{list.data.summary.breached}</div></div>
        <div className="card kpi"><div className="l">P1 terbuka</div><div className="v">{list.data.summary.p1Open}</div></div>
      </div>}
      {show && (
        <div className="card">
          <h2>Tiket baru</h2>
          <ErrorBox error={act.error} />
          <div className="grid g3">
            <Field label="Customer"><select value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })}><option value="">Pilih…</option>{customers.data?.items?.map((c: any) => <option key={c.id} value={c.id}>{c.legalName}</option>)}</select></Field>
            <Field label="Kategori"><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{['INCIDENT', 'SERVICE_REQUEST', 'QUESTION', 'VULNERABILITY'].map((c) => <option key={c}>{c}</option>)}</select></Field>
            <Field label="Prioritas"><select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{['P1', 'P2', 'P3', 'P4'].map((c) => <option key={c}>{c}</option>)}</select></Field>
          </div>
          <Field label="Judul"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Deskripsi"><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <button className="btn" disabled={act.busy || !f.customerId || f.title.length < 5 || f.description.length < 5} onClick={() => act.run(async () => {
            const t = await api('/api/v1/tickets', { body: f }); window.location.href = `/helpdesk/${t.id}`;
          })}>Buat tiket</button>
        </div>
      )}
      <div className="row" style={{ marginBottom: 8 }}>
        <label className="check"><input type="checkbox" checked={filter.open} onChange={(e) => setFilter({ ...filter, open: e.target.checked })} /> Hanya terbuka</label>
        <label className="check"><input type="checkbox" checked={filter.mine} onChange={(e) => setFilter({ ...filter, mine: e.target.checked })} /> Ditugaskan ke saya</label>
        <select value={filter.priority} onChange={(e) => setFilter({ ...filter, priority: e.target.value })} aria-label="Prioritas" style={{ maxWidth: 140 }}><option value="">Semua prioritas</option>{['P1', 'P2', 'P3', 'P4'].map((p) => <option key={p}>{p}</option>)}</select>
      </div>
      <ErrorBox error={list.error} />
      {list.loading ? <Loading /> : <div className="card" style={{ padding: 0 }}>
        {list.data?.items.length ? list.data.items.map((t: any) => (
          <Link key={t.id} href={`/helpdesk/${t.id}`} className="list-item">
            <div className="row"><Badge s={t.priority} /><b className="mono">{t.number}</b>{sla(t)}<span className="spacer" /><Badge s={t.status} /></div>
            <div>{t.title}</div>
            <div className="sub">{t.customerName} · {t.category} · {t.source} · {t.assigneeName ?? 'belum ditugaskan'} · {dt(t.createdAt)}</div>
          </Link>
        )) : <div className="empty">Tidak ada tiket</div>}
      </div>}
    </>
  );
}
