'use client';
import Link from 'next/link';
import { useState } from 'react';
import { idr, dt } from '@/lib/api';
import { Badge, ErrorBox, Loading, PageHead, useApi, useMe } from '@/components/ui';

export default function Billing() {
  const me = useMe();
  const [status, setStatus] = useState('');
  const aging = useApi('/api/v1/billing/aging');
  const list = useApi(`/api/v1/invoices${status ? `?status=${status}` : ''}`, [status]);
  return (
    <>
      <PageHead title="Tagihan & piutang" sub="Invoice dari milestone BAST, pembayaran, dan aging piutang" />
      <ErrorBox error={aging.error ?? list.error} />
      {aging.data && (
        <div className="card">
          <div className="sub">Total piutang per {aging.data.asOf}</div>
          <div className="v" style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--navy)' }}>{idr(aging.data.totalOutstanding)}</div>
          <div className="grid g4" style={{ marginTop: 8 }}>
            {aging.data.buckets.map((b: any) => (
              <div key={b.bucket} className="kpi"><div className="l">{({ CURRENT: 'Belum jatuh tempo', D1_30: '1–30 hari', D31_60: '31–60 hari', D61_90: '61–90 hari', D90_PLUS: '> 90 hari' } as Record<string, string>)[b.bucket]}</div>
                <div className="v">{idr(b.outstanding)}</div><div className="l">{b.count} invoice</div></div>
            ))}
          </div>
        </div>
      )}
      <div className="row" style={{ marginBottom: 8 }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter status" style={{ maxWidth: 240 }}>
          <option value="">Semua status</option>{['ISSUED', 'PARTIAL', 'OVERDUE', 'PAID', 'VOID'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      {list.loading ? <Loading /> : (
        <div className="card" style={{ padding: 0 }}>
          {list.data?.items.length ? list.data.items.map((i: any) => (
            <Link key={i.id} href={`/billing/${i.id}`} className="list-item">
              <div className="row"><b className="mono">{i.number}</b><span className="spacer" /><Badge s={i.status} /></div>
              <div className="sub">{i.customerName} · {i.projectCode} · {i.description}</div>
              <div className="sub">Total {idr(i.total)} · sisa {idr(i.outstanding)} · jatuh tempo {String(i.dueDate).slice(0, 10)}</div>
            </Link>
          )) : <div className="empty">Belum ada invoice{me?.permissions.includes('billing.write') ? '. Buat dari milestone proyek yang sudah diterima BAST.' : '.'}</div>}
        </div>
      )}
    </>
  );
}
