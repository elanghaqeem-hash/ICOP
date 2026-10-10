'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { dt, idr } from '@/lib/api';
import { Badge, ErrorBox, Loading, PageHead, useApi } from '@/components/ui';

const ST = ['', 'DRAFT', 'IN_APPROVAL', 'APPROVED', 'ISSUED', 'SENT', 'ACCEPTED', 'REJECTED', 'REVISION_REQUESTED'];
function List() {
  const sp = useSearchParams();
  const [st, setSt] = useState(sp.get('status') ?? '');
  const { data, error, loading } = useApi(`/api/v1/quotations${st ? `?status=${st}` : ''}`, [st]);
  return (
    <>
      <PageHead title="Quotation" sub="Dibuat dari pricing scenario di Deal 360 workspace" />
      <div className="tabs">{ST.map((s) => <button key={s} className={st === s ? 'on' : ''} onClick={() => setSt(s)}>{s || 'Semua'}</button>)}</div>
      <ErrorBox error={error} />
      {loading ? <Loading /> : <div className="card" style={{ padding: 0 }}>
        {data?.items.length ? data.items.map((q: any) => (
          <Link key={q.id} href={`/quotations/${q.id}`} className="list-item">
            <div className="row"><b className="mono">{q.number}{q.revision ? ` Rev.${q.revision}` : ''}</b><span className="spacer" /><Badge s={q.status} /></div>
            <div className="sub">{q.customerName} · {q.title} · {idr(q.grandTotal)}{q.grossMarginPct != null ? ` · margin ${q.grossMarginPct}%` : ''} · {dt(q.updatedAt)}</div>
          </Link>)) : <div className="empty">Tidak ada quotation</div>}
      </div>}
    </>
  );
}
export default function Page() { return <Suspense fallback={<Loading />}><List /></Suspense>; }
