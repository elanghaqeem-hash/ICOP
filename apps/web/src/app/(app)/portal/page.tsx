'use client';
import Link from 'next/link';
import { dt, idr } from '@/lib/api';
import { Badge, ErrorBox, Loading, PageHead, useApi } from '@/components/ui';
export default function Portal() {
  const { data, error, loading } = useApi('/api/v1/portal/quotations');
  return (
    <>
      <PageHead title="Penawaran untuk Anda" sub="Customer Portal DefendIT360" />
      <ErrorBox error={error} />
      {loading ? <Loading /> : <div className="card" style={{ padding: 0 }}>
        {data?.items.length ? data.items.map((q: any) => (
          <Link key={q.id} href={`/portal/${q.id}`} className="list-item"><div className="row"><b className="mono">{q.number}{q.revision ? ` Rev.${q.revision}` : ''}</b><span className="spacer" /><Badge s={q.status} /></div>
            <div className="sub">{q.title} · {idr(q.grandTotal)} · dikirim {dt(q.sentAt)}</div></Link>)) : <div className="empty">Belum ada penawaran</div>}
      </div>}
    </>
  );
}
