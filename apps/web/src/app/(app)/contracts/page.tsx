'use client';
import Link from 'next/link';
import { useState } from 'react';
import { idr } from '@/lib/api';
import { Badge, ErrorBox, Loading, PageHead, useApi } from '@/components/ui';

export default function Contracts() {
  const [status, setStatus] = useState('');
  const { data, error, loading } = useApi(`/api/v1/contracts${status ? `?status=${status}` : ''}`, [status]);
  return (
    <>
      <PageHead title="Kontrak" sub="Dibuat dari quotation ACCEPTED (tombol di detail quotation) atau tender AWARDED" />
      <div className="row" style={{ marginBottom: 8 }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter status" style={{ maxWidth: 240 }}>
          <option value="">Semua status</option>{['DRAFT', 'LEGAL_REVIEW', 'IN_APPROVAL', 'PENDING_SIGNATURE', 'ACTIVE', 'COMPLETED', 'CANCELLED'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
      </div>
      <ErrorBox error={error} />
      {loading ? <Loading /> : <div className="card" style={{ padding: 0 }}>
        {data?.items.length ? data.items.map((c: any) => (
          <Link key={c.id} href={`/contracts/${c.id}`} className="list-item">
            <div className="row"><b className="mono">{c.number}</b><span className="badge">{c.contractType}</span><span className="spacer" /><Badge s={c.status} /></div>
            <div className="sub">{c.title} · {c.customerName}</div>
            <div className="sub">{idr(c.value)} · {String(c.startDate).slice(0, 10)} s/d {String(c.endDate).slice(0, 10)}{c.projectCode ? ` · proyek ${c.projectCode}` : ''}</div>
          </Link>
        )) : <div className="empty">Belum ada kontrak</div>}
      </div>}
    </>
  );
}
