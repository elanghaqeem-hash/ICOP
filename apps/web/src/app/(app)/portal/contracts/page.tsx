'use client';
import Link from 'next/link';
import { idr } from '@/lib/api';
import { Badge, ErrorBox, Loading, PageHead, useApi } from '@/components/ui';

export default function PortalContracts() {
  const { data, error, loading } = useApi('/api/v1/portal/contracts');
  return (
    <>
      <PageHead title="Kontrak" sub="Kontrak Anda dengan DefendIT360" />
      <ErrorBox error={error} />
      {loading ? <Loading /> : <div className="card" style={{ padding: 0 }}>
        {data?.items.length ? data.items.map((c: any) => (
          <Link key={c.id} href={`/portal/contracts/${c.id}`} className="list-item">
            <div className="row"><b className="mono">{c.number}</b><span className="spacer" /><Badge s={c.status} /></div>
            <div className="sub">{c.title} · {idr(c.value)} · {String(c.startDate).slice(0, 10)} s/d {String(c.endDate).slice(0, 10)}</div>
          </Link>
        )) : <div className="empty">Belum ada kontrak</div>}
      </div>}
    </>
  );
}
